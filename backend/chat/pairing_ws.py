"""chat.pairing_ws —— 配对握手 WS 客户端（issue #40 / spec §8.1）。

一次性握手（docs/research/r40-device-pairing-protocol.md §4）：
1. 连 ws://<host>:<port>/，等 connect.challenge（event，payload.nonce）。
2. connect（req）：device 签名块 + auth.token(bootstrap GATEWAY_TOKEN) + role:operator +
   scopes[operator.*] + caps[tool-events]。
3. hello-ok = connect 的 res（ok，payload.auth.deviceToken+scopes）→ PairingResult；
   PAIRING_REQUIRED（res not ok，error.code）→ PairingRequired(requestId)；
   其它错误 → PairingError。

transport 注入（默认 websockets.connect）以便 fake 测试，无需真网关。
"""
from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field

import websockets

from chat.device_crypto import DeviceIdentity
from integration.openclaw.wire import (
    REQUIRED_SCOPES as _REQUIRED_SCOPES,
)
from integration.openclaw.wire import (
    ConnectFrameBuilder as _ConnectFrameBuilder,
)


@dataclass(frozen=True)
class PairingResult:
    """hello-ok 成功：持久化 deviceToken + 协商 scopes。"""

    device_token: str
    scopes: list[str] = field(default_factory=list)


class PairingRequired(Exception):
    """网关返回 PAIRING_REQUIRED：需宿主 openclaw devices approve <requestId>。"""

    def __init__(self, request_id: str) -> None:
        super().__init__(f'pairing required, approve request {request_id!r} on host')
        self.request_id = request_id


class PairingError(Exception):
    """配对握手其它失败（网络/协议/认证错误）。

    retryable=True 表示网关显式标为瞬态恢复（errorShape retryable:true，如冷启动期
    ``gateway starting; retry shortly``），调用方应稍后重试而非判定失败。retry_after_ms
    为网关建议的等待毫秒（仅 retryable 时有意义），未下发时为 None。
    """

    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        retry_after_ms: int | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.retry_after_ms = retry_after_ms


class PairingHandshake:
    """对单个容器网关执行一次配对握手。"""

    def __init__(self, transport=None, timeout: float = 10.0) -> None:
        # transport: connect(url) → async CM 产出 ws（send/recv/close）。默认 websockets。
        self._connect = transport or websockets.connect
        self._timeout = timeout

    def _build_connect_frame(self, identity: DeviceIdentity, token: str, nonce: str) -> dict:
        """构造配对手 connect 帧，委托给单一来源 ConnectFrameBuilder.pairing()。

        与 PairingHandshake.pair() 协同：pair() 负责按 id 收发握手（recv/send/res 匹配），
        Builder 负责帧体契约（协议 v4/scopes/caps/device 签名块）——关注点分离。
        """
        req_id = uuid.uuid4().hex
        return _ConnectFrameBuilder.pairing(req_id=req_id, identity=identity, token=token, nonce=nonce)

    async def pair(
        self, *, url: str, token: str, identity: DeviceIdentity,
    ) -> PairingResult:
        """执行一次配对握手。三分支：PairingResult / PairingRequired / PairingError。"""
        try:
            async with self._connect(url) as ws:
                deadline = asyncio.get_event_loop().time() + self._timeout
                # 1. 等 connect.challenge（event）取 nonce（忽略其间无关帧）
                nonce = await self._await_nonce(ws, deadline)
                # 2. 发 connect（device 签名 + bootstrap token），等其 res（按 id 匹配）
                frame = self._build_connect_frame(identity, token, nonce)
                await ws.send(json.dumps(frame))
                return await self._await_connect_res(ws, frame['id'], deadline)
        except (PairingRequired, PairingError):
            raise
        except Exception as e:  # 网络/协议/超时等一切意外 → PairingError
            raise PairingError(str(e)) from e

    async def _recv_until(self, ws, deadline: float, predicate, describe: str) -> dict:
        """循环读帧直到 predicate 命中或超时；忽略无关帧（乱序 event/stray res 容错）。"""
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise PairingError(f'timeout waiting for {describe}')
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            msg = json.loads(raw)
            if predicate(msg):
                return msg

    async def _await_nonce(self, ws, deadline: float) -> str:
        msg = await self._recv_until(
            ws, deadline,
            lambda m: m.get('type') == 'event' and m.get('event') == 'connect.challenge',
            'connect.challenge',
        )
        nonce = (msg.get('payload') or {}).get('nonce')
        if not nonce:
            raise PairingError('connect.challenge missing nonce')
        return nonce

    async def _await_connect_res(self, ws, req_id: str, deadline: float) -> PairingResult:
        # 只接受 id 匹配的 connect res；忽略 stray res / 乱序 event
        msg = await self._recv_until(
            ws, deadline,
            lambda m: m.get('type') == 'res' and m.get('id') == req_id,
            f'connect res (id={req_id})',
        )
        if msg.get('ok'):
            auth = (msg.get('payload') or {}).get('auth') or {}
            device_token = auth.get('deviceToken')
            if not device_token:
                raise PairingError('hello-ok missing auth.deviceToken')
            scopes = auth.get('scopes') or []
            missing = _REQUIRED_SCOPES - set(scopes)
            if missing:
                raise PairingError(f'hello-ok missing required scopes: {sorted(missing)}')
            return PairingResult(device_token=device_token, scopes=list(scopes))
        error = msg.get('error') or {}
        # ghcr 2026.6.34 官方镜像（ADR 0003）返回两段嵌套 code：外层 NOT_PAIRED，
        # 内层 details.code=PAIRING_REQUIRED（requestId 也在 details 内）。先按内层码
        # 判，兼容外层码直接是 PAIRING_REQUIRED 的旧实现与 fork 镜像。
        code = error.get('code', '')
        details = error.get('details') or {}
        inner_code = details.get('code', '') if isinstance(details, dict) else ''
        if code == 'PAIRING_REQUIRED' or inner_code == 'PAIRING_REQUIRED':
            request_id = details.get('requestId', '')
            if not isinstance(request_id, str) or not request_id:
                raise PairingError('PAIRING_REQUIRED response missing requestId')
            raise PairingRequired(request_id)
        raise PairingError(
            error.get('message') or error.get('code') or 'connect failed',
            # gateway 冷启动期返回 ``gateway starting; retry shortly``（errorShape
            # retryable:true, retryAfterMs:500）——显式瞬态恢复信号，透传给调用方重试，
            # 而非当确定失败。见 message-handler-*.js isStartupPending 分支。
            retryable=bool(error.get('retryable', False)),
            retry_after_ms=error.get('retryAfterMs'),
        )
