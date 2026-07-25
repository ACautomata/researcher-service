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
        # 连接级审批订阅者集合（T06，spec §8.2 / codex P1）：exec/plugin.approval.requested 不挂 runId，
        # 是连接级广播 → 多 consumer 共享同一 pooled client 时须 fan-out 到所有订阅者（不可单槽覆盖）。
        # consumer start 时 add_approval_subscriber 注册、disconnect 时 remove_approval_subscriber 独立退订。
        self._approval_subscribers: list[OnEvent] = []
        self._ws = None
        self._cm = None
        self._recv_task: asyncio.Task | None = None
        self._pending_acks: dict[str, tuple[asyncio.Future, OnEvent]] = {}
        self._pending_resolves: dict[str, asyncio.Future] = {}
        self._routes: dict[str, OnEvent] = {}
        self._closed = False
        self._dead = False  # recv loop 退出（连接断开）→ pool 据此驱逐重建

    def add_approval_subscriber(self, cb: OnEvent) -> None:
        """注册连接级审批订阅者（T06 / codex P1）：多 consumer 共享 client 时各自独立注册。"""
        if cb not in self._approval_subscribers:
            self._approval_subscribers.append(cb)

    def remove_approval_subscriber(self, cb: OnEvent) -> None:
        """退订指定订阅者（codex P1）：只移除自己，不误伤同 client 其他 consumer 的订阅。"""
        if cb in self._approval_subscribers:
            self._approval_subscribers.remove(cb)

    async def _fanout_approval(self, frame: dict) -> None:
        """把一帧连接级审批帧 fan-out 到所有订阅者；隔离单订阅者回调失败（不杀 recv loop / 不互伤）。"""
        for cb in list(self._approval_subscribers):
            try:
                await cb(frame)
            except Exception:
                pass

    async def broadcast_approval_resolved(self, approval_id: str, decision: str) -> None:
        """把一次权威 resolve 结果 fan-out 到全部订阅者（codex R2 P2）：共享 client 的各 consumer 卡片一致收敛。

        仅广播**真实发生**的 resolve 回执（权威 decision），不伪造网关 resolved 事件；REST 路径经
        pool client 调本方法，WS 路径由 consumer 在 resolve 成功后调，保证所有渲染副本同步落定。
        """
        await self._fanout_approval({'type': 'approvalResolved', 'id': approval_id, 'decision': decision})


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
        frames = self._translator.translate(msg)
        if not frames:
            return
        run_id = frames[0].get('runId')
        if run_id is None:
            # 连接级帧（T06 审批卡 + 网关 resolved 事件）：不挂 runId,fan-out 到所有审批订阅者,不进 runId 路由
            for translated in frames:
                if translated.get('type') not in ('approval', 'approvalResolved'):
                    continue
                await self._fanout_approval(translated)
            return
        cb = self._routes.get(run_id)
        if cb is None:
            return  # route 已 discard，丢弃整批帧
        terminal = False
        for translated in frames:
            try:
                await cb(translated)
            except Exception:
                pass  # 隔离单 route 回调失败，避免杀整个 recv loop 影响同 client 其他 route
            if translated.get('type') in ('done', 'error'):
                terminal = True
        if terminal:
            self._routes.pop(run_id, None)

    def _resolve_ack(self, msg: dict) -> None:
        rid = msg.get('id')
        # approval.resolve 的回执（T06）：与 chat.send ack 用同一 res 帧，按 id 分发
        resolve_fut = self._pending_resolves.pop(rid, None)
        if resolve_fut is not None:
            if not resolve_fut.done():
                if msg.get('ok'):
                    resolve_fut.set_result(msg.get('payload'))
                else:
                    err = msg.get('error') or {}
                    resolve_fut.set_exception(
                        ChatSendError(err.get('message') or err.get('code') or 'approval.resolve failed'))
            return
        entry = self._pending_acks.pop(rid, None)
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

    async def resolve_approval(self, approval_id: str, kind: str, decision: str) -> dict:
        """回覆一次权限审批（T06，spec §8.2）：发 approval.resolve(id,kind,decision)，有界等 res。

        返回网关 res 的 payload——approval.resolve 是 first-answer-wins，权威记录的 decision 可能
        与本请求的 decision 不同（另一 operator 已答）；调用方须用 payload 里的权威结果，不能回声
        本请求的 decision（codex P1）。需 operator.approvals scope；网关拒绝抛 ChatSendError。
        """
        if self._ws is None:
            raise ChatClientError('client not connected')
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {
            'type': 'req', 'id': req_id, 'method': 'approval.resolve',
            'params': {'id': approval_id, 'kind': kind, 'decision': decision},
        }
        try:
            # codex R3 P2：死连接（_ws 非 None 但已断）下 send 会 raise；须与等 ack 共用清理路径，
            # 否则重试会在 _pending_resolves 无限累积 future（内存泄漏 + 永不回执）
            await self._ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except asyncio.TimeoutError:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError('approval.resolve ack timeout')
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            raise
        return payload or {}

    async def list_pending_approvals(self) -> list[dict]:
        """查询网关当前待审批列表（codex P2 断线恢复），翻译成审批卡帧列表。

        best-effort：绝不抛异常打断 consumer 的 ready 流程。复用 _approval_card 单项翻译（kind 从事件族
        派生，此处无事件名，按 payload.kind 或缺省 exec）。

        方法名（codex R3 P1 / issue 验收③）：r26 §1 文档已证 exec/plugin 族各有 `.list`（查全部待审批），
        通用 `approval` 族仅 `get`/`resolve`、**无 `approval.list`**。故本方法用文档已证的
        `exec.approval.list`（exec 是 elevated 命令审批主路径，本特性正针对它）。
        **刻意不做 exec+plugin 双查合并**（收窄 codex R3 P1）：①同一审批极可能被两族各返一次致重复出卡；
        ②`.list` 响应 schema 同样「待实测」，双查合并 + 按 id 去重是把待实测路径复杂化成另一套未经证实的
        死扣；③plugin 审批远少于 exec。若实测表明须双查或响应键非 `approvals`，按实测改此处与 fakes。
        """
        if self._ws is None:
            return []
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {'type': 'req', 'id': req_id, 'method': 'exec.approval.list', 'params': {}}
        try:
            await self._ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            return []
        items = (payload or {}).get('approvals')
        if items is None:
            single = (payload or {}).get('approval')
            items = [single] if isinstance(single, dict) else []
        if not isinstance(items, list):
            return []
        cards = []
        for item in items:
            if not isinstance(item, dict):
                continue
            card = ChatEventTranslator._approval_card('exec.approval.requested', item)
            if card is not None:
                cards.append(card)
        return cards

    async def list_commands(self) -> dict:
        """拉取该 agent 工作区的斜杠命令清单（T07，spec §8.2）：发 commands.list，有界等 res。

        与 resolve_approval 同构的「req→res 回执」RPC（复用 _pending_resolves，按 req id 分发）。
        请求参数按 r26 §2：agentId="main"、scope="both"（text+native 全量）、includeArgs=True
        （保留参数元数据供前端后续展示；**响应原样透传**，外层键名 `commands` 与 includeArgs
        元数据字段名「待实测」由 REST 层解析/校准，client 不做键名假设）。
        未连接 → 返回 {}（对齐 list_pending_approvals 的 best-effort）；网关拒绝（缺 operator.read）/
        ack 超时 → 抛 ChatSendError（上层 REST 映射 502）。
        """
        if self._ws is None:
            return {}
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {
            'type': 'req', 'id': req_id, 'method': 'commands.list',
            'params': {'agentId': _AGENT_ID, 'scope': 'both', 'includeArgs': True},
        }
        try:
            await self._ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except asyncio.TimeoutError:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError('commands.list ack timeout')
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            raise
        return payload or {}

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

    def _fail_pending_resolves(self, message: str) -> None:
        """连接断开/关闭：reject 所有未决 approval.resolve，避免 resolve_approval 调用方挂起。"""
        for fut in list(self._pending_resolves.values()):
            if not fut.done():
                fut.set_exception(ChatClientError(message))
        self._pending_resolves.clear()

    async def _notify_all_error(self, message: str) -> None:
        self._fail_pending_acks(message)
        self._fail_pending_resolves(message)
        for run_id, cb in list(self._routes.items()):
            try:
                await cb({'type': 'error', 'runId': run_id, 'message': message})
            except Exception:
                pass
        self._routes.clear()

    async def aclose(self) -> None:
        self._closed = True
        self._fail_pending_acks('client closed')
        self._fail_pending_resolves('client closed')
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
