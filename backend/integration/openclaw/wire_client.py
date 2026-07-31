"""OpenClaw 长连接对话客户端——路径4 收敛后的唯一 OpenClawWire 实现（#231 / ADR 0004）。

历史为 chat.chat_client.OpenClawChatClient（issue #41 / spec §8.2，承载 #152/#154/#214/#219/#220
的 dead/transmitted 硬化语义）。ADR 0004 收敛停滞的路径4 strangler：本类迁入防腐层为唯一实现，
删除停滞的 OpenClawWireAdapter；chat.chat_client 保留**同对象 alias**（strangler 零改名，既有
chat 测试 / pool / consumers 导入不动，alias 清理列 deferred）。

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
from collections.abc import Awaitable, Callable

import websockets
from websockets.exceptions import ConnectionClosed

from chat.event_translate import ChatEventTranslator
from integration.openclaw.wire import (
    AGENT_ID as _AGENT_ID,
)
from integration.openclaw.wire import (
    ChatClientError,
    ChatConnectError,
    ChatPayloadTooLargeError,
    ChatSendError,
    ChatSendTransmittedError,
    GatewayPolicy,
)
from integration.openclaw.wire import (
    ConnectFrameBuilder as _ConnectFrameBuilder,
)

# on_event 回调契约：接收翻译后的前端契约帧（text/done/error）
OnEvent = Callable[[dict], Awaitable[None]]


class OpenClawWireClient:  # pylint: disable=too-many-instance-attributes,too-many-arguments
    """对单个已配对容器维持一条长连接，发 chat.send 并按 runId 路由 chat 事件。"""

    def __init__(
        self,
        url: str,
        device_token: str,
        *,
        identity=None,
        scopes=None,
        transport=None,
        translator: ChatEventTranslator | None = None,
        connect_frame_builder=None,
        connect_timeout: float = 10.0,
        ack_timeout: float = 10.0,
        on_dead: Callable[[], None] | None = None,
    ) -> None:
        self._url = url
        self._device_token = device_token
        # session connect 帧 device 签名块所需（issue #139/#140）：identity 为 DeviceIdentity、
        # scopes 为配对时网关批准的 scopes（#141 pool 从 Pairing 注入）。两者可选——缺省（identity=None）
        # 走旧路径：不签名，仅 gateway_token + device_token（向后兼容）。nonce 不再构造注入，
        # 由 connect() 等 connect.challenge 动态提取（#140）。
        # codex #150 P2：identity 与 scopes 是签名路径的**一体**前提——给了 identity 就必须给非空
        # scopes，否则 ConnectFrameBuilder.session() 会在握手半途 `','.join(None)` TypeError。
        # 构造期 fail-fast 校验（优于让坏配置连上网关后才崩），与「identity=None 才走旧路径」对齐。
        if identity is not None and not scopes:
            raise ValueError('signed connect path requires non-empty scopes when identity is provided')
        self._identity = identity
        self._scopes = scopes
        self._nonce = ''  # #140：connect() 等 challenge 提取后填入，供默认 builder 读（seam 保持 2 参）
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
        # #196 T1 / #213：网关 policy（hello-ok 解析；握手前为协议默认）。tick_interval_ms 驱动静默看门狗。
        self._policy = GatewayPolicy.default()
        # #196 T3 / #215：标 dead 时回调（pool 注入以触发主动重连；None = 不触发，如单测直建 client）。
        self._on_dead = on_dead

    def add_approval_subscriber(self, cb: OnEvent) -> None:
        """注册连接级审批订阅者（T06 / codex P1）：多 consumer 共享 client 时各自独立注册。"""
        if cb not in self._approval_subscribers:
            self._approval_subscribers.append(cb)

    def remove_approval_subscriber(self, cb: OnEvent) -> None:
        """退订指定订阅者（codex P1）：只移除自己，不误伤同 client 其他 consumer 的订阅。"""
        if cb in self._approval_subscribers:
            self._approval_subscribers.remove(cb)

    def approval_subscribers(self) -> list[OnEvent]:
        """返回当前全部审批订阅者的副本（codex #219 P2：共享 client 自愈迁移用）。

        consumer 自愈换 client 时须把**所有**订阅者（不止触发自愈的那个 consumer）迁到
        新 client，否则被动 consumer 仍挂在死 client 上、错过新连接上的审批。返回副本
        防调用方直接改内部列表。
        """
        return list(self._approval_subscribers)

    async def _fanout_approval(self, frame: dict) -> None:
        """把一帧连接级审批帧 fan-out 到所有订阅者；隔离单订阅者回调失败（不杀 recv loop / 不互伤）。"""
        for cb in list(self._approval_subscribers):
            try:
                await cb(frame)
            except Exception:  # pylint: disable=broad-exception-caught
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

    @property
    def policy(self) -> GatewayPolicy:
        """当前生效的网关 policy（hello-ok 解析；握手前 / 缺字段为协议默认）。#196 T1 / #213。"""
        return self._policy

    @property
    def identity(self):
        """本连接的 DeviceIdentity（#215：pool 主动重连复用同份材料重建，无需重读配对）。"""
        return self._identity

    @property
    def scopes(self):
        """本连接的已批准 scopes（#215：pool 主动重连复用重建）。"""
        return self._scopes

    def _default_connect_frame(self, req_id: str, device_token: str) -> dict:
        """已配对长连接帧：委托给单一来源 ConnectFrameBuilder.session()（issue #102 / #139 / #140）。

        spec §8.1 step5 + #139：配对后用 deviceToken 直连（auth.token）并附 Ed25519 device 签名块
        （identity/scopes 构造期注入；nonce 由 connect() 等 connect.challenge 提取后写入 self._nonce，#140）。
        identity 为 None（未配对/旧路径）时不签名——返回仅 gateway_token + device_token 的
        connect 帧（无 device 块，向后兼容）。

        codex #150 P2：本 builder 与注入的 connect_frame_builder 共用 (req_id, device_token) 两参契约
        ——nonce 经 self._nonce 实例态传入（connect() 提取后填），不在 seam 上加第三参，保持自定义
        两参 builder 可继续注入。
        """
        if self._identity is None:
            return {
                'type': 'req',
                'id': req_id,
                'method': 'connect',
                'params': {'auth': {'token': device_token}},
            }
        return _ConnectFrameBuilder.session(
            req_id=req_id, identity=self._identity, device_token=device_token,
            nonce=self._nonce, scopes=self._scopes,
        )

    async def connect(self) -> None:
        try:
            self._cm = self._connect(self._url)
            self._ws = await self._cm.__aenter__()  # pylint: disable=unnecessary-dunder-call
            req_id = uuid.uuid4().hex
            # 握手期独占 recv。codex #150 P2：challenge + connect res 共享**一份** connect_timeout
            # 预算——算一个 deadline，两段各用剩余时长，避免 challenge 卡到边界后 res 又拿整份
            # 预算（最坏 ~2× connect_timeout），拖慢 pool.get_or_create() 对慢/坏网关的感知。
            deadline = asyncio.get_running_loop().time() + self._connect_timeout
            try:
                if self._identity is not None:
                    # issue #140：先等 connect.challenge 提取 nonce，用 DeviceIdentity 签名后才发帧
                    self._nonce = await asyncio.wait_for(
                        self._await_challenge(), timeout=self._remaining(deadline),
                    )
                # 向后兼容：无 device_identity 走旧路径——不等 challenge、不签名、立即发帧。
                # 统一两参调用（builder seam 契约）；签名所需 nonce 已由默认 builder 读 self._nonce。
                frame = self._build_connect(req_id, self._device_token)
                await self._ws.send(json.dumps(frame))
                hello_ok = await asyncio.wait_for(
                    self._await_res(req_id), timeout=self._remaining(deadline),
                )
                # #213：解析 hello-ok payload.policy（驱动静默看门狗 2×tick）；缺字段由 from_hello_ok 回退默认
                self._policy = GatewayPolicy.from_hello_ok(hello_ok.get('payload'))
            except TimeoutError as exc:
                raise ChatConnectError('connect handshake timeout') from exc
        except BaseException:
            await self.aclose()
            raise
        self._recv_task = asyncio.create_task(self._recv_loop())

    @staticmethod
    def _remaining(deadline: float) -> float:
        """deadline 前剩余秒数（codex #150 P2 共享预算）。已过期时返回 0——wait_for(0) 立即
        TimeoutError → connect() 归一为 ChatConnectError，而非对负 timeout 抛 ValueError。"""
        return max(0.0, deadline - asyncio.get_running_loop().time())

    async def _recv_until(self, predicate, describe: str) -> dict:
        """循环读帧直到 predicate 命中；忽略无关帧（乱序 event/stray res 容错，对齐 pairing_ws）。"""
        while True:
            raw = await self._ws.recv()
            msg = json.loads(raw)
            if predicate(msg):
                return msg

    async def _await_challenge(self) -> str:
        """等网关 connect.challenge 事件并提取 nonce（issue #140，对齐 pairing_ws._await_nonce）。"""
        msg = await self._recv_until(
            lambda m: m.get('type') == 'event' and m.get('event') == 'connect.challenge',
            'connect.challenge',
        )
        nonce = (msg.get('payload') or {}).get('nonce')
        if not nonce:
            raise ChatConnectError('connect.challenge missing nonce')
        return nonce

    async def _await_res(self, req_id: str) -> dict:
        msg = await self._recv_until(
            lambda m: m.get('type') == 'res' and m.get('id') == req_id,
            f'connect res (id={req_id})',
        )
        if not msg.get('ok'):
            raise ChatConnectError('connect handshake rejected by gateway')
        return msg

    async def _recv_loop(self) -> None:
        # #196 T1 / #213：静默看门狗——连续静默 > 2×tickIntervalMs 即按契约 close code 4000 语义
        # 关闭、置 _dead、拒全部挂起请求（不重放）。tickIntervalMs 取自 hello-ok policy（缺省 30s → 60s）。
        # 每收到一帧 wait_for 重置，等价于「最后一次收帧后起算」的静默计时；半开连接（recv 永久挂起）
        # 超时即走断连收尾，让 pool 驱逐重建——修复原裸 recv() 永久挂起、_dead 永不置位、连接永不自愈。
        silence_timeout = self._policy.tick_interval_ms * 2 / 1000
        try:
            while True:
                raw = await asyncio.wait_for(self._ws.recv(), timeout=silence_timeout)
                await self._handle(json.loads(raw))
        except asyncio.CancelledError:  # pylint: disable=try-except-raise
            # #196 T1 / #213：task 取消即连接不可用（REST 跨 loop 清理 / 服务关闭竞态）。原分支只 raise
            # 不置位 → pool 快路径（not client.dead）无限复用假活 client，该容器聊天永久变砖。
            self._mark_dead()
            raise
        except Exception:  # pylint: disable=broad-exception-caught
            # 连接断开 / 静默超时（含看门狗 TimeoutError）：标记 dead 供 pool 驱逐重建，拒全部挂起请求
            # （不重放），按契约 close code 4000 语义关闭套接字（best-effort；pool 重建时 aclose 兜底）。
            self._mark_dead()
            if not self._closed:
                await self._notify_all_error('容器连接断开')
            if self._ws is not None:
                try:
                    await self._ws.close(4000)
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
            return

    def _mark_dead(self) -> None:
        """置 dead 并触发 on_dead 回调（#215 pool 注入以启动主动重连）。回调 best-effort 不杀 recv loop。
        传入 self（codex #221 P1）：pool 按「报告方是否仍是池中当前值」判定，且能在 client 于
        connect() 后、放入 pool 前死亡时不丢通知（回调可直接携带报告方身份）。"""
        self._dead = True
        if self._on_dead is not None:
            try:
                self._on_dead(self)
            except Exception:  # pylint: disable=broad-exception-caught
                pass

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
            except Exception:  # pylint: disable=broad-exception-caught
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
        """回覆一次权限审批（T06，spec §8.2）：发 {kind}.approval.resolve(id,decision)，有界等 res。

        issue #154 实测（ghcr 2026.6.34 / ADR 0003）：method 按族为 exec.approval.resolve /
        plugin.approval.resolve（非通用 approval.resolve，后者 unknown method）。
        params 为 {id, decision}（无 kind），decision 值 allow-once/allow-always/deny。

        返回网关 res 的 payload——approval.resolve 是 first-answer-wins，权威记录的 decision 可能
        与本请求的 decision 不同（另一 operator 已答）；调用方须用 payload 里的权威结果，不能回声
        本请求的 decision（codex P1）。需 operator.approvals scope；网关拒绝抛 ChatSendError。
        """
        if self._ws is None or self.dead:
            # codex #219 十一轮 P2-319：closing/recv 死期间拒发 approval RPC——同 send_message 的
            # 死窗口（_notify_all_error 快照后 await 回调、_ws 未置 None），新 resolve 的 future
            # 注册后网关或已接受审批，但 ack/resolved 事件随死连接丢失 → 超时把已执行的卡误复位
            # pending。dead（_dead or _closed）视为已断连拒发，consumer 走 dead 重取换健康 client。
            raise ChatClientError('client not connected')
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {
            'type': 'req', 'id': req_id, 'method': f'{kind}.approval.resolve',
            'params': {'id': approval_id, 'decision': decision},
        }
        try:
            # codex R3 P2：死连接（_ws 非 None 但已断）下 send 会 raise；须与等 ack 共用清理路径，
            # 否则重试会在 _pending_resolves 无限累积 future（内存泄漏 + 永不回执）
            await self._ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError('approval.resolve ack timeout') from exc
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
        except BaseException:  # pylint: disable=broad-exception-caught
            self._pending_resolves.pop(req_id, None)
            return []
        # 实测校准（spike ghcr 2026.6.34-browser, 2026-07-27）：payload 可能直接是 list
        # （空 [] / 非空 [{...}]），也可能是 dict {approvals:[...]}。list 上调 .get 会崩，先判类型。
        if isinstance(payload, list):
            items = payload
        elif isinstance(payload, dict):
            items = payload.get('approvals')
            if items is None:
                single = payload.get('approval')
                items = [single] if isinstance(single, dict) else []
        else:
            items = []
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

    async def request_approval(self, command: str, *, session_key: str | None = None) -> dict:
        """确定性创建 exec 审批请求（codex P2 #168）：发 exec.approval.request，有界等 res。

        LLM prompt 触发审批（agent 是否调 exec + 网关 elevated 判断）不稳定——curl 有时被允许直接
        执行、有时触发审批。本方法用文档已证的 exec.approval.request RPC 直接创建 pending approval，
        对集成测试完全确定性。需 operator.approvals scope；网关拒绝抛 ChatSendError。

        返回网关 res payload——至少含 id 字段（审批 id），供后续 resolve/list 使用。
        """
        params: dict = {'command': command}
        if session_key is not None:
            params['sessionKey'] = session_key
        return await self._rpc('exec.approval.request', params)

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
        except TimeoutError as exc:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError('commands.list ack timeout') from exc
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            raise
        return payload or {}

    async def _rpc(self, method: str, params: dict) -> dict:
        """通用 req→res 回执 RPC（issue #80 T1）：sessions.list / chat.history / sessions.create /
        sessions.delete 共用。复用 _pending_resolves 注册表，按 req id 经 _resolve_ack 分发 res。

        未连接抛 ChatClientError（会话管理是 REST 主动调用，须报错让上层映射 502/409，区别于
        list_commands/list_pending_approvals 的 best-effort 静默返回）；网关拒绝（res not ok）/ ack
        超时抛 ChatSendError。原样透传网关 payload，不做字段翻译（集中在 REST 解析层 T2）。
        """
        if self._ws is None or self.dead:
            # codex #219 十一轮 P2-319：closing/recv 死期间拒发 RPC（同 resolve_approval/send_message
            # 死窗口）——future 注册后 ack 随死连接丢失会让调用方空等超时。dead 视为已断连拒发。
            raise ChatClientError('client not connected')
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {'type': 'req', 'id': req_id, 'method': method, 'params': params}
        try:
            await self._ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError(f'{method} ack timeout') from exc
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            raise
        return payload or {}

    async def list_sessions(
        self,
        agent_id: str = _AGENT_ID,
        *,
        include_derived_titles: bool = True,
        limit: int | None = None,
    ) -> dict:
        """列出该 agent 网关中真实存在的会话（spec #76）：发 sessions.list，有界等 res。

        参数（wire camelCase，对齐 r26 已证契约）：agentId（默认 main）、includeDerivedTitles=True
        （读每会话 transcript 前 8KB 派生标题，替代旧手填 title）、可选 limit（控大 store 派生标题的
        文件读）。原样透传 payload——sessions 列表逐字段名「待实测」由 REST 解析层校准（对齐
        CommandListView._parse_commands 模式，issue 明示翻译集中在 T2）。
        """
        params: dict = {'agentId': agent_id, 'includeDerivedTitles': include_derived_titles}
        if limit is not None:
            params['limit'] = limit
        return await self._rpc('sessions.list', params)

    async def get_history(
        self,
        session_key: str,
        *,
        limit: int | None = None,
        message_id: str | None = None,
    ) -> dict:
        """读取某会话完整聊天记录（spec #76）：发 chat.history，有界等 res。

        参数（wire camelCase）：sessionKey（必传）、可选 limit、可选 messageId（分页锚点，向回翻页）。
        网关已 display-normalized 的 messages[] 原样透传；hasMore/nextOffset/messageId 精确名「待实测」
        由 REST 解析层校准。需 operator.read scope。
        """
        params: dict = {'sessionKey': session_key}
        if limit is not None:
            params['limit'] = limit
        if message_id is not None:
            params['messageId'] = message_id
        return await self._rpc('chat.history', params)

    async def create_session(self, key: str, *, label: str | None = None) -> dict:
        """新建会话（spec #76）：发 sessions.create{key,label}，有界等 res。

        「建会话即命名」路径——label 可选（免标题新建时由网关后续派生，spec 免预建选项）。需
        operator.write scope。
        """
        params: dict = {'key': key}
        if label is not None:
            params['label'] = label
        return await self._rpc('sessions.create', params)

    async def delete_session(self, session_key: str) -> dict:
        """删除会话（spec #76，**admin 级提升权限操作**）：发 sessions.delete，有界等 res。

        网关先写压缩归档（*.jsonl.deleted.<ts>.zst）再删，可恢复。需 operator.admin scope（本连接
        已声明 admin）；权限实际由网关侧 scope 强制。REST 层文档须标注「提升权限操作」。

        wire 字段是 ``key``（codex #96 P1）：上游 ``SessionsDeleteParamsSchema``（closedObject）
        ``key`` 必填、无 ``sessionKey``；与同族 ``sessions.create``/``sessions.send`` 的 ``key`` 一致，
        区别于 ``chat.*`` 族（``chat.send``/``chat.history`` 用 ``sessionKey``）。
        """
        return await self._rpc('sessions.delete', {'key': session_key})

    async def send_message(self, session_key: str, message: str, *, on_event: OnEvent,
                           idempotency_key: str | None = None) -> str:
        """发送 chat.send 并有界等 ack，返回 runId。

        ``idempotency_key`` 可选：缺省每次调用生成新 key（普通发送）。调用方（consumer
        自愈重试，issue #214 / codex P1）对**同一逻辑发送**在初次与有界重试间复用同一
        key——若网关已收下原 chat.send 但 ack 在连接死亡前丢失，重试带同 key 让网关按
        幂等去重，避免起两个 run、工具被执行两次。
        """
        if self._ws is None or self.dead:
            # codex #219 九轮 P2-999：aclose 已置 _closed、_notify_all_error 正清空 _routes 期间，
            # _ws 尚未置 None——若只查 _ws，共享 client 的另一 consumer 可在此窗口进入 send_message，
            # 其 route 在 _notify_all_error 快照后安装、随后被 clear 却无终态 error → 浏览器永久
            # pending。_closed 一并视为不可发送，closing 期间拒绝新 send（抛错由 consumer 走既有
            # dead/evidence 重取换到健康 client）。
            # codex #219 十轮 P2-631：guard 再扩到 _dead（dead=_dead or _closed）——recv loop 置
            # _dead=True 后、_notify_all_error await 回调并关 _ws 前的窗口内，_ws 仍非 None、_closed
            # 仍 False；此时新 send 的帧或达网关，但 recv loop 已无法处理 ack/事件 → run 空跑、输出
            # 丢失。dead 视为已断连，consumer 据此走重取换到健康 client 再发。
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
                'idempotencyKey': idempotency_key or uuid.uuid4().hex,
            },
        }
        # codex #219 十轮 P1-930：send **前**快照 dead——await 让渡期间 recv loop 可能置 dead。
        # 若待 catch 里才采样 self._dead，「send 刷帧中途 recv loop 置 dead」的竞态会读到 True，
        # 误判为「发送前已死、帧确定未发出」而保留原生 ConnectionClosed（consumer 据此安全重试）
        # ——但字节可能已部分到达网关（网关或已起 run），盲重试重复执行工具。发送前已死才可断
        # 「确定未传输」；发送尝试中抛出的 close 一律归 transmitted（不确定，consumer 不盲发）。
        dead_before_send = self._dead
        frame_json = json.dumps(frame)
        # #196 T5 / #216：发送侧帧大小自律——按 hello-ok policy.maxPayload（缺省 25MB）预检。超限在
        # _ws.send 之前本地拒绝（不发出该帧、不触发网关协议断连），避免超长粘贴连累同连接其他在途
        # run、避免用户看到莫名「容器连接断开」。须先移除已注册的 pending ack：本地拒绝后既不发帧也
        # 无回执，不清会让该 future/dict 项悬挂泄漏（孤儿 entry，永不回执）。
        frame_bytes = frame_json.encode('utf-8')
        if len(frame_bytes) > self._policy.max_payload_bytes:
            self._pending_acks.pop(req_id, None)
            limit_mb = self._policy.max_payload_bytes / (1024 * 1024)
            raise ChatPayloadTooLargeError(f'消息超过网关帧大小上限 {limit_mb:g} MB，请分段发送')
        try:
            # codex #220 P1：send 必须传 str——bytes 会让 websockets 发二进制帧，而 OpenClaw 协议
            # （与其他 RPC 一致）走 JSON 文本帧，二进制帧会被网关拒绝/断连。
            await self._ws.send(frame_json)
        except ConnectionClosed as exc:
            self._pending_acks.pop(req_id, None)
            if dead_before_send:
                # send 前已知连接死（#213 看门狗/CancelledError 已置位）：帧确定未发出，
                # 保留原生 ConnectionClosed——consumer 据此作 decisive evidence 安全重试。
                raise
            # codex #219 八轮 P1：竞态——recv task 尚未置 dead（或 send 中途才置，十轮 P1-930），
            # 但 send 刷帧中途 socket 关闭。帧字节可能已部分/全部到达网关（网关或已起 run），传输
            # 结果**未知**，归 transmitted 让 consumer 不盲重发（盲重试被幂等去重到死连接 runId）。
            raise ChatSendTransmittedError('chat.send socket closed mid-send') from exc
        try:
            # 有界等待 ack：网关连着但 ack 丢失/不回时不应让 consumer 永久挂起
            run_id = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_acks.pop(req_id, None)
            # codex #219 P1：帧已发出、ack 超时——网关可能已起 run；不可盲重试（丢事件流）
            raise ChatSendTransmittedError('chat.send ack timeout') from exc
        except ChatSendError:
            # 网关显式拒绝（ack ok:false，如 rate limit）或 ack 缺 runId——确定未起 run，
            # 原样上抛（非 transmitted），consumer 走既有重试/error 路径。
            self._pending_acks.pop(req_id, None)
            raise
        except BaseException as exc:
            self._pending_acks.pop(req_id, None)
            # codex #219 P1：帧已发出后 recv loop 死（_fail_pending_acks 置 ChatClientError）
            # ——可能已起 run；包装为 ChatSendTransmittedError 让 consumer 判不可盲重试。
            if isinstance(exc, ChatClientError):
                raise ChatSendTransmittedError(str(exc)) from exc
            raise
        # codex #219 十二轮 P2-921：此处**不再**重装 route——_resolve_ack 在 recv loop 里收到
        # ok ack 时已先装 route 再 set_result（chat_client.py:362-363），wait_for 返回 run_id 必
        # 意味着 route 已就绪。若在此由发送协程恢复后重装，两 consumer 共享 client 时：ack 后、
        # 本协程恢复前另一 consumer 触发自愈 aclose，_notify_all_error 已 fail+clear 该 route，
        # 本行会在已关闭/已清空的 client 上重新装入 route → 浏览器收不到终态帧永久 pending。
        # route 生命周期单源化：recv loop（_resolve_ack）安装、aclose/_notify_all_error fail+clear、
        # discard/事件终态清除，发送协程不再触碰。
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
            except Exception:  # pylint: disable=broad-exception-caught
                pass
        self._routes.clear()

    async def aclose(self) -> None:
        self._closed = True
        # codex #219 七轮 P1：用 _notify_all_error（含 fail 活跃 _routes 推终态 error 帧）替代
        # 仅 fail pending acks/resolves——evidence-based 重取（ConnectionClosed 竞态，recv loop
        # 尚未跑 298-299 清理）经 pool.reacquire aclose 旧 client 时，别的 consumer 在该共享连接
        # 上的 in-progress run 须收到终态 error（否则浏览器消息永久 pending）。与 recv-loop 清理
        # 幂等（_routes.clear()，重复调空集合无操作）。
        await self._notify_all_error('client closed')
        if self._recv_task is not None:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except (asyncio.CancelledError, Exception):  # pylint: disable=broad-exception-caught
                pass
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # pylint: disable=broad-exception-caught
                pass
        if self._cm is not None:
            try:
                await self._cm.__aexit__(None, None, None)
            except Exception:  # pylint: disable=broad-exception-caught
                pass
