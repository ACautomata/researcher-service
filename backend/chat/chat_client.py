"""chat.chat_client —— OpenClaw 长连接对话客户端（issue #41 / spec §8.2）。

每容器一条已配对长连接（deviceToken 作 auth.token，spec §8.1 step5）。chat.send → ack(runId) →
chat 事件按 runId 经 ChatEventTranslator 翻译，路由到发起方 on_event 回调；done/error 收尾后清路由；
discard 供 consumer 断开时移除路由避免推已关闭连接。

transport 注入（默认 websockets.connect）；connect_frame_builder 注入（握手帧格式 spec §8.1 step5
标待实测，默认 deviceToken 直连，可替换）。测试用 FakeChatTransport。
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Awaitable, Callable

import websockets

from chat.event_translate import ChatEventTranslator

_AGENT_ID = 'main'
_PROTOCOL = 4
_CLIENT_ID = 'gateway-client'
_SCOPES = ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals']
_CAPS = ['tool-events']

# on_event 回调契约：接收翻译后的前端契约帧（text/done/error）
OnEvent = Callable[[dict], Awaitable[None]]


class ChatClientError(Exception):
    """对话客户端基础错误。"""


class ChatConnectError(ChatClientError):
    """长连接握手失败（connect res not ok / 网络）。"""


class ChatSendError(ChatClientError):
    """chat.send 被网关拒绝（ack not ok）或 ack 缺 runId。"""


class OpenClawChatClient:
    """对单个已配对容器维持一条长连接，发 chat.send 并按 runId 路由 chat 事件。"""

    def __init__(
        self,
        url: str,
        device_token: str,
        *,
        transport=None,
        translator: ChatEventTranslator | None = None,
        connect_frame_builder=None,
        connect_timeout: float = 10.0,
        ack_timeout: float = 10.0,
    ) -> None:
        self._url = url
        self._device_token = device_token
        self._connect = transport or websockets.connect
        self._translator = translator or ChatEventTranslator()
        self._build_connect = connect_frame_builder or self._default_connect_frame
        self._connect_timeout = connect_timeout
        self._ack_timeout = ack_timeout
        self._ws = None
        self._cm = None
        self._recv_task: asyncio.Task | None = None
        self._pending_acks: dict[str, tuple[asyncio.Future, OnEvent]] = {}
        self._routes: dict[str, OnEvent] = {}
        self._closed = False
        self._dead = False  # recv loop 退出（连接断开）→ pool 据此驱逐重建

    @property
    def dead(self) -> bool:
        """连接是否已不可用（recv loop 退出或被显式关闭）；pool 据此不复用。"""
        return self._dead or self._closed

    @staticmethod
    def _default_connect_frame(req_id: str, device_token: str) -> dict:
        # spec §8.1 step5：配对后用 deviceToken 直连（auth.token）。确切握手帧（是否仍需
        # challenge/签名）spec 标待实测 → 可经 connect_frame_builder 注入替换。
        return {
            'type': 'req', 'id': req_id, 'method': 'connect',
            'params': {
                'minProtocol': _PROTOCOL, 'maxProtocol': _PROTOCOL,
                'client': {'id': _CLIENT_ID, 'version': '1.0', 'platform': 'linux', 'mode': 'backend'},
                'role': 'operator',
                'scopes': _SCOPES,
                'caps': _CAPS,
                'auth': {'token': device_token},
            },
        }

    async def connect(self) -> None:
        try:
            self._cm = self._connect(self._url)
            self._ws = await self._cm.__aenter__()
            req_id = uuid.uuid4().hex
            await self._ws.send(json.dumps(self._build_connect(req_id, self._device_token)))
            # 握手期独占 recv，等 connect res；有界等待，避免坏网关升级 WS 后不回 res 永久挂起
            try:
                await asyncio.wait_for(self._await_res(req_id), timeout=self._connect_timeout)
            except asyncio.TimeoutError:
                raise ChatConnectError('connect handshake timeout')
        except BaseException:
            await self.aclose()
            raise
        self._recv_task = asyncio.create_task(self._recv_loop())

    async def _await_res(self, req_id: str) -> dict:
        while True:
            raw = await self._ws.recv()
            msg = json.loads(raw)
            if msg.get('type') == 'res' and msg.get('id') == req_id:
                if not msg.get('ok'):
                    raise ChatConnectError('connect handshake rejected by gateway')
                return msg

    async def _recv_loop(self) -> None:
        try:
            while True:
                raw = await self._ws.recv()
                await self._handle(json.loads(raw))
        except asyncio.CancelledError:
            raise
        except Exception:
            self._dead = True  # 连接断开：标记 dead 供 pool 驱逐重建
            if not self._closed:
                await self._notify_all_error('容器连接断开')
            return

    async def _handle(self, msg: dict) -> None:
        if msg.get('type') == 'res':
            self._resolve_ack(msg)
            return
        translated = self._translator.translate(msg)
        if translated is None:
            return
        run_id = translated.get('runId')
        cb = self._routes.get(run_id)
        if cb is None:
            return
        try:
            await cb(translated)
        except Exception:
            pass  # 隔离单 route 回调失败，避免杀整个 recv loop 影响同 client 其他 route
        if translated.get('type') in ('done', 'error'):
            self._routes.pop(run_id, None)

    def _resolve_ack(self, msg: dict) -> None:
        entry = self._pending_acks.pop(msg.get('id'), None)
        if entry is None:
            return
        fut, on_event = entry
        if fut.done():
            return
        if msg.get('ok'):
            run_id = (msg.get('payload') or {}).get('runId')
            if run_id:
                # 紧接 ack 注册路由（同 recv 循环内），保证后续事件到达前 route 已就绪
                self._routes[run_id] = on_event
                fut.set_result(run_id)
            else:
                fut.set_exception(ChatSendError('chat.send ack missing runId'))
        else:
            err = msg.get('error') or {}
            fut.set_exception(ChatSendError(err.get('message') or err.get('code') or 'chat.send failed'))

    async def send_message(self, session_key: str, message: str, *, on_event: OnEvent) -> str:
        if self._ws is None:
            raise ChatClientError('client not connected')
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_acks[req_id] = (fut, on_event)
        frame = {
            'type': 'req', 'id': req_id, 'method': 'chat.send',
            'params': {
                'sessionKey': session_key,
                'message': message,
                'agentId': _AGENT_ID,
                'idempotencyKey': uuid.uuid4().hex,
            },
        }
        await self._ws.send(json.dumps(frame))
        try:
            # 有界等待 ack：网关连着但 ack 丢失/不回时不应让 consumer 永久挂起
            run_id = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except asyncio.TimeoutError:
            self._pending_acks.pop(req_id, None)
            raise ChatSendError('chat.send ack timeout')
        except BaseException:
            self._pending_acks.pop(req_id, None)
            raise
        self._routes[run_id] = on_event
        return run_id

    def discard(self, run_id: str) -> None:
        self._routes.pop(run_id, None)

    def _fail_pending_acks(self, message: str) -> None:
        """连接断开/关闭：reject 所有未决 ack，避免 send_message 调用方永久挂起。"""
        for entry in list(self._pending_acks.values()):
            fut = entry[0]
            if not fut.done():
                fut.set_exception(ChatClientError(message))
        self._pending_acks.clear()

    async def _notify_all_error(self, message: str) -> None:
        self._fail_pending_acks(message)
        for run_id, cb in list(self._routes.items()):
            try:
                await cb({'type': 'error', 'runId': run_id, 'message': message})
            except Exception:
                pass
        self._routes.clear()

    async def aclose(self) -> None:
        self._closed = True
        self._fail_pending_acks('client closed')
        if self._recv_task is not None:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._cm is not None:
            try:
                await self._cm.__aexit__(None, None, None)
            except Exception:
                pass
