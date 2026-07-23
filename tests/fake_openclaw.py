"""fake OpenClaw WS 服务器替身 —— 测试进程内的最小 WS 服务。

在 openclaw_service 与真实网关之间挡下游网络（issue #15 Testing Decisions 的唯一接缝替身）。
模拟 protocol v4 握手：connect.challenge → connect(auth.token) → hello-ok，
随后对每次 chat.send 回 ack(runId) 并按预设脚本推送 chat 事件帧。

只实现测试所需的协议子集，不追求完备。
"""
import asyncio
import json

import websockets.asyncio.server as ws_server

CHALLENGE = {"type": "event", "event": "connect.challenge", "payload": {"nonce": "n"}}


class FakeOpenClawServer:
    """一个可编程的 OpenClaw 网关 WS 替身。

    用法：
        server = await FakeOpenClawServer.start(token="tok")
        server.enqueue_chat([
            {"state": "delta", "deltaText": "你"},
            {"state": "delta", "deltaText": "好"},
            {"state": "final", "usage": {"total": 2}},
        ])
        ... 被测代码连 server.url 并 chat.send ...
        await server.close()
    """

    def __init__(self, token: str):
        self.token = token
        self._script: list[dict] = []          # 待推送的 chat payload 队列（FIFO）
        self._server = None
        self.port = None
        self.received_connect: dict | None = None   # 记录 connect 帧 params，供握手断言
        self.received_sends: list[dict] = []        # 记录每次 chat.send 的 params

    @classmethod
    async def start(cls, token: str = "test-token") -> "FakeOpenClawServer":
        self = cls(token)
        self._server = await ws_server.serve(self._handler, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/"

    def enqueue_chat(self, payloads: list[dict]) -> None:
        """追加一组 chat 事件 payload（state/deltaText/...），下一次 chat.send 后依次推送。"""
        self._script.extend(payloads)

    async def _handler(self, ws) -> None:
        # 1. 主动发 challenge
        await ws.send(json.dumps(CHALLENGE))
        async for raw in ws:
            frame = json.loads(raw)
            if frame.get("type") != "req":
                continue
            method = frame.get("method")
            params = frame.get("params", {})
            if method == "connect":
                self.received_connect = params
                token = (params.get("auth") or {}).get("token")
                if token != self.token:
                    await ws.send(json.dumps({
                        "type": "res", "id": frame["id"], "ok": False,
                        "error": {"code": "unauthorized", "message": "bad token"},
                    }))
                    continue
                await ws.send(json.dumps({
                    "type": "res", "id": frame["id"], "ok": True,
                    "payload": {"type": "hello-ok", "policy": {"tickIntervalMs": 15000}},
                }))
            elif method == "chat.send":
                self.received_sends.append(params)
                run_id = "run-" + str(len(self.received_sends))
                await ws.send(json.dumps({
                    "type": "res", "id": frame["id"], "ok": True,
                    "payload": {"runId": run_id, "status": "started"},
                }))
                # 依次推送脚本化 chat 事件（包一层事件外壳，带 runId）
                for p in self._drain_script():
                    payload = {"runId": run_id, "sessionKey": params.get("sessionKey"), **p}
                    await ws.send(json.dumps({
                        "type": "event", "event": "chat", "payload": payload, "seq": 0,
                    }))

    def _drain_script(self) -> list[dict]:
        script, self._script = self._script, []
        return script

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
