"""OpenClaw 网关 WebSocket 客户端 —— protocol v4（connect.challenge→connect→hello-ok）。

单条持久连接多路复用多个并发 chat.send run（按 runId 路由事件）；懒连接 + 断线重连。
依据 docs/research/r13-ws-protocol.md。凭据经注入的 provider 解析，便于测试指向 fake 替身。
"""
import asyncio
import json
import uuid
from typing import AsyncGenerator, Awaitable, Callable, Optional

import websockets.asyncio.client as ws_client
from websockets.exceptions import ConnectionClosed

# 凭据提供者：async () -> (gateway_url, gateway_token, api_key)
CredsProvider = Callable[[], Awaitable[tuple]]

# 重连退避（秒）：1, 2, 4, ... 封顶 30
_BACKOFF_START = 1.0
_BACKOFF_MAX = 30.0
# 单个 run 等待下一帧事件的超时（秒）；超时抛错而非永久挂起，保证 SSE 能收尾
_RUN_EVENT_TIMEOUT = 120.0


class OpenClawWsClient:
    """与单个 OpenClaw 网关的一条 WS 长连接（懒建连 + 重连 + runId 路由）。"""

    def __init__(self, creds_provider: CredsProvider):
        self._creds_provider = creds_provider
        self._ws = None
        self._pending: dict[str, asyncio.Future] = {}   # req id -> Future
        self._runs: dict[str, asyncio.Queue] = {}        # runId -> 事件队列
        self._pending_events: dict[str, list] = {}       # runId -> 订阅前到达的事件暂存
        self._reader: Optional[asyncio.Task] = None
        self._connect_lock = asyncio.Lock()
        self._closed = False

    # ── 连接生命周期 ──────────────────────────────────────

    async def _ensure_connected(self) -> None:
        async with self._connect_lock:
            if self._ws is not None:
                return
            await self._connect_once()

    async def _connect_once(self) -> None:
        url, token, _ = await self._creds_provider()
        ws_url = self._to_ws_url(url)
        ws = await ws_client.connect(ws_url, ping_interval=20)
        try:
            # 1. 等 challenge
            challenge = json.loads(await ws.recv())
            if challenge.get("event") != "connect.challenge":
                raise RuntimeError(f"OpenClaw 握手异常：未收到 challenge（{challenge}）")
            # 2. 回 connect（带 token），hello-ok 由 _request 的 res 返回
            hello = await self._request_over(ws, "connect", {
                "minProtocol": 4, "maxProtocol": 4,
                "client": {"id": "gateway-client", "version": "1.0",
                           "platform": "linux", "mode": "backend"},
                "role": "operator",
                "scopes": ["operator.read", "operator.write"],
                "caps": [], "commands": [], "permissions": {},
                "auth": {"token": token},
                "locale": "zh-CN", "userAgent": "ai-research-pipeline/1.0",
            })
        except Exception:
            await ws.close()
            raise
        self._ws = ws
        self._reader = asyncio.create_task(self._read_loop())

    @staticmethod
    def _to_ws_url(url: str) -> str:
        """把 http(s)://host:port[/...] 归一为 ws(s)://host:port/（根路径多路复用）。"""
        u = url.strip().rstrip("/")
        if u.startswith("ws://") or u.startswith("wss://"):
            return u + "/"
        if u.startswith("https://"):
            return "wss://" + u[len("https://"):] + "/"
        if u.startswith("http://"):
            return "ws://" + u[len("http://"):] + "/"
        return "ws://" + u + "/"

    async def close(self) -> None:
        self._closed = True
        async with self._connect_lock:
            await self._teardown()

    async def _teardown(self) -> None:
        ws, reader = self._ws, self._reader
        self._ws = None
        self._reader = None
        if reader is not None:
            reader.cancel()
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass
        self._fail_all_runs(RuntimeError("OpenClaw 连接已关闭"))

    def _fail_all_runs(self, err: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(err)
        self._pending.clear()
        for q in self._runs.values():
            q.put_nowait({"state": "error", "errorMessage": str(err)})
        self._runs.clear()

    # ── 底层 RPC ─────────────────────────────────────────

    async def _request_over(self, ws, method: str, params: dict) -> dict:
        """在指定连接上发 req 并等 res（握手期使用，reader 尚未启动，故直接 recv）。"""
        rid = uuid.uuid4().hex
        await ws.send(json.dumps({"type": "req", "id": rid, "method": method, "params": params}))
        raw = await ws.recv()
        frame = json.loads(raw)
        if not frame.get("ok", False):
            raise RuntimeError(f"OpenClaw {method} 失败: {frame.get('error')}")
        return frame.get("payload", {})

    async def _request(self, method: str, params: dict) -> dict:
        """在已建立连接上发 req，经 reader 协程路由 res 到对应 Future。"""
        await self._ensure_connected()
        rid = uuid.uuid4().hex
        fut = asyncio.get_event_loop().create_future()
        self._pending[rid] = fut
        await self._ws.send(json.dumps({"type": "req", "id": rid, "method": method, "params": params}))
        payload = await fut
        return payload

    async def _read_loop(self) -> None:
        backoff = _BACKOFF_START
        try:
            async for raw in self._ws:
                self._dispatch(raw)
        except (ConnectionClosed, asyncio.CancelledError):
            pass
        finally:
            # 连接失效：进行中的 run 无法恢复（runId 是连接级的），发 error 收尾
            self._ws = None
            self._fail_all_runs(RuntimeError("OpenClaw 连接断开"))
        # 非主动关闭则指数退避重连（后台，不阻塞调用方）
        if not self._closed:
            await self._reconnect(backoff)

    def _dispatch(self, raw: str) -> None:
        try:
            frame = json.loads(raw)
        except json.JSONDecodeError:
            return
        ftype = frame.get("type")
        if ftype == "res":
            fut = self._pending.pop(frame.get("id"), None)
            if fut is not None and not fut.done():
                if frame.get("ok", False):
                    fut.set_result(frame.get("payload", {}))
                else:
                    err = frame.get("error")
                    fut.set_exception(RuntimeError(f"OpenClaw RPC 错误: {err}"))
        elif ftype == "event" and frame.get("event") == "chat":
            payload = frame.get("payload", {})
            run_id = payload.get("runId")
            q = self._runs.get(run_id)
            if q is not None:
                q.put_nowait(payload)
            elif run_id:
                # 事件先于订阅到达（reader 异步投递的固有时序）：暂存，订阅时回放
                self._pending_events.setdefault(run_id, []).append(payload)

    async def _reconnect(self, backoff: float) -> None:
        while not self._closed:
            await asyncio.sleep(backoff)
            try:
                async with self._connect_lock:
                    if self._ws is None and not self._closed:
                        await self._connect_once()
                return
            except Exception:
                backoff = min(backoff * 2, _BACKOFF_MAX)

    # ── 聊天 ─────────────────────────────────────────────

    async def chat_stream(
        self,
        session_key: str,
        message: str,
        agent_id: Optional[str] = None,
        attachments: Optional[list] = None,
    ) -> AsyncGenerator[dict, None]:
        """chat.send 并按 runId 路由 chat 事件，yield 事件 payload（state/deltaText/...）。"""
        params = {
            "sessionKey": session_key,
            "message": message,
            "idempotencyKey": uuid.uuid4().hex,
        }
        if agent_id:
            params["agentId"] = agent_id
        if attachments:
            params["attachments"] = attachments

        ack = await self._request("chat.send", params)
        run_id = ack.get("runId")
        if not run_id:
            raise RuntimeError(f"OpenClaw chat.send 未返回 runId: {ack}")

        queue: asyncio.Queue = asyncio.Queue()
        self._runs[run_id] = queue
        try:
            # 先回放订阅前到达的事件（事件可能先于注册入队）
            for early in self._pending_events.pop(run_id, []):
                yield early
                if early.get("state") in ("final", "error", "aborted"):
                    return
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=_RUN_EVENT_TIMEOUT)
                except asyncio.TimeoutError:
                    raise RuntimeError("OpenClaw 会话超时：长时间未收到事件")
                yield payload
                if payload.get("state") in ("final", "error", "aborted"):
                    break
        finally:
            self._runs.pop(run_id, None)
            self._pending_events.pop(run_id, None)


class WsClientRegistry:
    """进程级 OpenClawWsClient 单例持有者（懒建；测试可 reset / 换凭据源）。"""

    def __init__(self, creds_provider: CredsProvider):
        self._creds_provider = creds_provider
        self._client: Optional[OpenClawWsClient] = None

    def set_creds_provider(self, provider: CredsProvider) -> None:
        """替换凭据源并丢弃现有连接（下次 get() 时用新源重建）。"""
        self._creds_provider = provider
        self._client = None

    def get(self) -> OpenClawWsClient:
        if self._client is None:
            self._client = OpenClawWsClient(self._creds_provider)
        return self._client

    async def reset(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.close()
