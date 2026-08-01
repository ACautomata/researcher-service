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
from collections.abc import Callable

import websockets

from chat.event_translate import ChatEventTranslator
from integration.openclaw.wire import (
    AGENT_ID as _AGENT_ID,
)
from integration.openclaw.wire import (
    ChatConnectError,
    GatewayPolicy,
)
from integration.openclaw.wire import (
    ConnectFrameBuilder as _ConnectFrameBuilder,
)
from integration.openclaw.wire.approval import ApprovalFanout
from integration.openclaw.wire.recovery import RecoveryCoordinator, RecoveryState
from integration.openclaw.wire.request_router import RequestRouter
from integration.openclaw.wire.values import (
    OnEvent,
    RouteDecision,
)


class OpenClawWireClient:  # pylint: disable=too-many-instance-attributes,too-many-arguments,too-many-public-methods
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
        # #273：拆出内部协作者（ApprovalFanout / RecoveryCoordinator），经构造注入组合、单向依赖
        # （门面→协作者，协作者互不引用）——连接级审批订阅 fan-out 与断线重连恢复协调各归其类。
        # #274：请求-回执路由收进 RequestRouter（双表 + ack_timeout），门面委托、不反向引用。
        self._approval_fanout = ApprovalFanout()
        self._routes: dict[str, OnEvent] = {}
        self._recovery_state = RecoveryState()
        self._request_router = RequestRouter(ack_timeout=ack_timeout)
        self._recovery = RecoveryCoordinator(
            state=self._recovery_state,
            rpc=self._rpc,
            routes=self._routes,
            translator=self._translator,
            flush_connect_buffered=self._flush_connect_buffered,
            flush_recovery_buffered=self._flush_recovery_buffered,
        )
        self._ws = None
        self._cm = None
        self._recv_task: asyncio.Task | None = None
        self._closed = False
        self._dead = False  # recv loop 退出（连接断开）→ pool 据此驱逐重建
        # #196 T1 / #213：网关 policy（hello-ok 解析；握手前为协议默认）。tick_interval_ms 驱动静默看门狗。
        self._policy = GatewayPolicy.default()
        # #196 T3 / #215：标 dead 时回调（pool 注入以触发主动重连；None = 不触发，如单测直建 client）。
        self._on_dead = on_dead

    @property
    def _active_session_keys(self) -> list[str]:
        """只读视图：当前记住的活跃会话 key 列表（副本）。#272 委托 property——既有测试
        （test_chat_client.py 断言 ``'s1' in c._active_session_keys``）直读本成员保持全绿；
        实际状态所有权在 ``RecoveryState``（经 ``self._recovery_state.active_session_keys``）。"""
        return list(self._recovery_state.active_session_keys)

    @property
    def _pending_acks(self) -> dict[str, tuple[asyncio.Future, OnEvent]]:
        """发送 ack 注册表（#274 委托 property）——既有测试（test_chat_client.py 断言
        ``c._pending_acks == {}``）直读本成员保持全绿；实际状态所有权在 ``RequestRouter``。"""
        return self._request_router.pending_acks

    @property
    def _pending_resolves(self) -> dict[str, asyncio.Future]:
        """审批 resolve 注册表（#274 委托 property）——既有测试（test_chat_client.py /
        test_commands_client.py 断言 ``not c._pending_resolves``）直读本成员保持全绿；
        实际状态所有权在 ``RequestRouter``。"""
        return self._request_router.pending_resolves

    def record_active_session(self, session_key: str, on_event: OnEvent | None = None) -> None:
        """#196 T4 / #217：记住一个活跃 sessionKey（+其恢复回调），供每次 connect 后重连恢复。

        consumer 在对话 start / 切换会话时调用。``on_event`` 是该会话恢复投影（history replace 回放、
        inFlightRun 缓冲 text、重建路由后该 runId 后续事件）的投递目标；为 None 时仅记住 sessionKey
        （仍发 subscribe + chat.history，但不回放/不重建路由）。同 key 再调更新回调；**多 key 共存**
        （codex #236 R2 P1：不再覆盖单一 slot）——共享 client 的每 consumer 各自记住自己的会话。

        #273 薄委托：行为在 RecoveryCoordinator.record_active_session（恢复面 4 方法收口）。
        """
        self._recovery.record_active_session(session_key, on_event)

    async def resume_active_session(self, session_key: str, on_event: OnEvent) -> None:
        """Register a replacement consumer and restore its live route without reconnecting.

        ``record_active_session`` alone is storage-only.  This method is the browser-reconnect
        path for a healthy pooled connection: it also queries the current in-flight run and
        rebuilds ``_routes`` so future gateway events reach the new consumer.

        codex #249 R5 (id 3690750256)：恢复 RPC 期间 _recv_loop 持续消费入站帧，而重建路由要等
        chat.history 返回后才安装——期间到达的该会话 in-flight run 帧（含终态）若直接经 _handle
        路由会被静默丢弃。故恢复窗口置 _recovering 缓冲 run-scoped 帧，_replay_projection 装好
        路由后回放（对齐 connect() 恢复泵 _connect_buffered 的同一不丢帧语义）。

        #273 薄委托：行为在 RecoveryCoordinator.resume_active_session。
        """
        await self._recovery.resume_active_session(session_key, on_event)

    def recovery_sessions(self) -> list[tuple[str, list[OnEvent]]]:
        """#196 T4 / #217：返回**全部**记住的活跃会话 ``[(session_key, [on_event, ...]), ...]``（可空）。

        pool 换 client（_reconnect_once / reacquire / get_or_create 死路径）建替换 client 前读旧
        client 的记住会话，逐条 propagate 到新 client——否则 remembered session 随旧 client 丢弃，
        重连恢复永不携带（Spec 步1「client 记住上次活跃 sessionKey」跨重连失效）。codex #236 R2 P1：
        多会话逐条返回。codex #236 R3 P1-242：同一会话多订阅者**全部**返回（列表副本），非只回最近
        一个——pool 重建后每 consumer 的恢复回调都被带到新 client。key-only 会话（无回调）为 ``[]``。

        #273 薄委托：行为在 RecoveryCoordinator.recovery_sessions。
        """
        return self._recovery.recovery_sessions()

    def unregister_active_session(self, session_key: str, on_event: OnEvent | None = None) -> None:
        """#217 / codex #236 P2-261：注销 ``record_active_session`` 记住的恢复回调（consumer 断开 /
        切容器时调用），防池化 client 后续重连把恢复投影投到已关闭 consumer（输出丢失 + 回调异常
        连累 connect），并释放对 consumer 的引用保留。

        **匹配才清**（codex #236 R2 P2-251 用**相等**非恒等——bound method 每次求值建新对象，``is``
        恒假会让注销静默失效；``==`` 按 __self__+__func__ 判等）。codex #236 R3 P1-242：同一会话
        多订阅者时只移除**本 consumer** 的回调，其余订阅者保留会话与重建路由；本 consumer 未注册
        此会话（别的 consumer 的同名会话）时 no-op，不误清。仅当回调列表清空（或 key-only 会话 /
        显式 on_event=None）才整体移除会话 + 该会话恢复重建的 runId 路由（R2 P2-96）。

        #273 薄委托：行为在 RecoveryCoordinator.unregister_active_session。
        """
        self._recovery.unregister_active_session(session_key, on_event)

    def add_approval_subscriber(self, cb: OnEvent) -> None:
        """注册连接级审批订阅者（T06 / codex P1）：多 consumer 共享 client 时各自独立注册。

        #273 薄委托：行为在 ApprovalFanout.add。
        """
        self._approval_fanout.add(cb)

    def remove_approval_subscriber(self, cb: OnEvent) -> None:
        """退订指定订阅者（codex P1）：只移除自己，不误伤同 client 其他 consumer 的订阅。

        #273 薄委托：行为在 ApprovalFanout.remove。
        """
        self._approval_fanout.remove(cb)

    def approval_subscribers(self) -> list[OnEvent]:
        """返回当前全部审批订阅者的副本（codex #219 P2：共享 client 自愈迁移用）。

        consumer 自愈换 client 时须把**所有**订阅者（不止触发自愈的那个 consumer）迁到
        新 client，否则被动 consumer 仍挂在死 client 上、错过新连接上的审批。返回副本
        防调用方直接改内部列表。

        #273 薄委托：行为在 ApprovalFanout.subscribers。
        """
        return self._approval_fanout.subscribers()

    async def _fanout_approval(self, frame: dict) -> None:
        """把一帧连接级审批帧 fan-out 到所有订阅者；隔离单订阅者回调失败（不杀 recv loop / 不互伤）。

        #273 薄委托：行为在 ApprovalFanout.fanout。
        """
        await self._approval_fanout.fanout(frame)

    async def broadcast_approval_resolved(self, approval_id: str, decision: str) -> None:
        """把一次权威 resolve 结果 fan-out 到全部订阅者（codex R2 P2）：共享 client 的各 consumer 卡片一致收敛。

        仅广播**真实发生**的 resolve 回执（权威 decision），不伪造网关 resolved 事件；REST 路径经
        pool client 调本方法，WS 路径由 consumer 在 resolve 成功后调，保证所有渲染副本同步落定。

        #273 薄委托：行为在 ApprovalFanout.broadcast_resolved。
        """
        await self._approval_fanout.broadcast_resolved(approval_id, decision)


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
                # #196 T4 / #217：握手成功后（首连与每次重连）按契约恢复——sessions.subscribe →
                # （有活跃会话）messages.subscribe + chat.history + 采用 inFlightRun 重建路由。
                # 恢复经 _rpc 发 RPC 等 res，而握手期无 _recv_loop 收帧——connect 在恢复完成前持续
                # recv 并经 _handle_incoming 分发（含 _rpc res 解析），恢复完成置 _connect_done 停泵
                # 交棒给 _recv_loop（防双 reader）。失败按建连失败处理（下方 BaseException → aclose + raise）。
                self._recovery_state.connect_done = asyncio.Event()
                try:
                    await asyncio.wait_for(
                        self._run_until(self._recovery.run()),
                        timeout=self._remaining(deadline),
                    )
                finally:
                    self._recovery_state.connect_done.set()  # 停泵：无论恢复成败，交棒给 _recv_loop（或 aclose）
                    # codex #236 P2-419：恢复完成后兜底回放泵期缓冲的**连接级** event 帧（approval /
                    # approvalResolved 无 runId、fan-out 不需路由）——否则无活跃会话 / 无可采用 run 时
                    # 它们滞留到无关的未来 send 才浮现。run-scoped 帧不在此弹（路由未就绪回放即被
                    # _handle 丢弃），留待路由注册（send ack / inFlightRun 重建）时回放，不丢帧。
                    self._flush_connection_level_buffered()
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

    async def _run_until(self, work) -> None:
        """跑 ``work``（connect 期恢复协程）并持续 recv 分发入站帧，直到 work 完成（#217）。

        握手期 _recv_loop 未起，work 内 _rpc 发的 req 需有人 recv 其 res——本泵即临时 reader，
        逐帧经 _handle_incoming 分发（res 解析 pending RPC）。**event 帧缓冲**（_connect_buffered）：
        恢复期到达的事件路由尚未由 _recv_loop 接管，直接分发会丢（route 未就绪）；缓冲后由
        _recv_loop 启动时回放，不丢帧。recv 用**短轮询**（10ms 超时重试）而非长阻塞：work 完成
        最后一帧 res 分发后即 done，泵下一轮轮询见 task.done() 即退出，不空等（真网关静默 / fake
        挂起队列都不卡死）。work 完成（或失败）即返回；connect 在 finally 置 _connect_done 后由
        _recv_loop 接管（防双 reader）。
        """
        task = asyncio.ensure_future(work)
        try:
            while not task.done():
                try:
                    raw = await asyncio.wait_for(self._ws.recv(), timeout=0.01)
                except TimeoutError:
                    continue  # 暂无入站帧：复查 work 是否完成
                msg = json.loads(raw)
                if msg.get('type') == 'res':
                    await self._handle_incoming(msg)
                    # 让渡：恢复协程收到最后一帧 res 需一拍才标 done——让渡让其完成，下轮 while
                    # 见 task.done() 即退出，不多读一帧。
                    await asyncio.sleep(0)
                else:
                    # event：泵期路由未就绪（恢复重建的 inFlightRun / send_message 注册的 route 尚未
                    # 就位），缓冲待路由注册时由 _resolve_ack 回放——重连期进行中 run 事件不丢。
                    self._recovery_state.connect_buffered.append(msg)
        finally:
            if not task.done():
                task.cancel()
            # 传播 work 的异常（恢复失败 → connect 失败）；取消泵自身不吞 work 结果。
            await asyncio.gather(task, return_exceptions=False)

    async def _handle_incoming(self, msg: dict) -> None:
        """connect 恢复泵期的入站分发：res 解析 pending RPC（_rpc 回执）；event 复用 _handle 翻译/路由。

        恢复的 inFlightRun 路由在 connect 内已重建（RecoveryCoordinator 写 _routes），故恢复后立即
        到达的 run 事件经 _handle 正常路由——connect 泵与 _recv_loop 共用同一份 _handle 分发逻辑。
        """
        if msg.get('type') == 'res':
            self._resolve_ack(msg)
            return
        await self._handle(msg)

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
        decision = self._classify_incoming(msg)
        if decision.kind == 'approval':
            # 连接级帧（T06 审批卡 + 网关 resolved 事件）：不挂 runId,fan-out 到所有审批订阅者,不进 runId 路由
            for translated in decision.frames:
                if translated.get('type') not in ('approval', 'approvalResolved'):
                    continue
                await self._fanout_approval(translated)
            return
        if decision.kind == 'buffered':
            # codex #249 R5 (id 3690750256)：live-wire resume 恢复窗口（路由重建前），该 run 的帧
            # 不能经 _handle 分发——route 未就绪即被静默丢弃（终态帧被丢则 run 永无完成帧）。缓冲，
            # 待 _replay_projection 安装路由后由 _flush_recovery_buffered 回放（对齐 _connect_buffered
            # 的同一不丢帧语义）。窗口内仅 run-scoped 帧缓冲；连接级帧已走上方 fan-out，不经此分支。
            self._recovery_state.recovery_buffered.append(msg)
            return
        if decision.kind == 'dropped':
            return  # 不可翻译 / route 已 discard，丢弃整批帧
        # routed：runId 路由分发 + 终态清理。cb 一次性捕获（_classify_incoming 已验路由存在），
        # await 回调期间路由可能被 aclose/discard 移除——沿用 cb 引用避免二次索引 KeyError。
        cb = self._routes[decision.run_id]
        terminal = False
        for translated in decision.frames:
            try:
                await cb(translated)
            except Exception:  # pylint: disable=broad-exception-caught
                pass  # 隔离单 route 回调失败，避免杀整个 recv loop 影响同 client 其他 route
            if translated.get('type') in ('done', 'error'):
                terminal = True
        if terminal:
            self._routes.pop(decision.run_id, None)

    def _classify_incoming(self, msg: dict) -> RouteDecision:
        """入站 chat 事件帧 → 路由决定（值对象骨架，issue #271/#273，RunEventRouter 拆出前）。

        决定段与执行段分离：本方法只算 ``RouteDecision``（不读写路由/缓冲状态），门面 ``_handle``
        据 ``kind`` 接线（审批 fan-out / 恢复窗口缓冲 / runId 路由分发 / 丢弃）。RunEventRouter
        拆出后由它承载本计算、门面接线。
        """
        frames = self._translator.translate(msg)
        if not frames:
            return RouteDecision(kind='dropped')
        run_id = frames[0].get('runId')
        if run_id is None:
            # 连接级帧（T06 审批卡 + 网关 resolved 事件）：不挂 runId,fan-out 到所有审批订阅者,不进 runId 路由
            return RouteDecision(kind='approval', frames=tuple(frames))
        if self._recovery_state.recovering and run_id not in self._routes:
            return RouteDecision(kind='buffered', run_id=run_id)
        if run_id not in self._routes:
            return RouteDecision(kind='dropped', run_id=run_id)  # route 已 discard，丢弃整批帧
        return RouteDecision(kind='routed', frames=tuple(frames), run_id=run_id)

    def _resolve_ack(self, msg: dict) -> None:
        """回执（res 帧）→「回执→路由→恢复」三桶编排（issue #274：#273 骨架的执段与决定段分离）。

        决定段在 ``RequestRouter.resolve_ack``（结算双表 future、回返 ``AckOutcome``）；门面据此
        接线**执行段**——ack 成功（run_id 非空）时紧接装路由（同 recv 循环内，保证后续事件到达前
        route 已就绪）+ 回放恢复泵期缓冲（重连期到达的进行中 run 事件可路由）。resolve 回执与
        无匹配 entry 由协作者结算后回返 None，门面 no-op。
        """
        outcome = self._request_router.resolve_ack(msg)
        if outcome is None or outcome.run_id is None:
            return  # resolve 回执 / 无匹配 / ack 失败（已 set_exception），无需装路由
        # 紧接 ack 注册路由（同 recv 循环内），保证后续事件到达前 route 已就绪
        self._routes[outcome.run_id] = outcome.on_event
        # #217：回放恢复泵期缓冲的 event 帧——路由已注册，重连期到达的进行中 run 事件可路由。
        self._flush_connect_buffered()
        # codex #249 R5 (id 3690750256)：本 ack 也可能解封 live-wire resume 窗口缓冲的帧
        # （多 consumer 共享 client：A resume 期间 B 的 send ack 在途，B 的 run 帧被缓冲到
        # _recovery_buffered）——路由刚装好即一并回放，避免缓冲帧滞留到无关的未来 send。
        self._flush_recovery_buffered()

    def _flush_connect_buffered(self) -> None:
        """#217：把恢复泵期缓冲的 event 帧逐个交 _handle 路由（路由已注册后调用）。

        缓冲帧可能属恢复重建的 inFlightRun 或本次 send_message 的 runId——路由就绪后回放不丢帧。
        同步取快照清空后由调用方 await 分发（_resolve_ack 是同步方法，回放经 _flush_task 异步）。

        codex #236 R4 P1：**按路由就绪过滤**再回放——多会话恢复时，第一会话采用 inFlightRun 后
        flush 若清空整个连接级缓冲，会把第二会话已到达、路由尚未重建的 run 事件一并弹给 _handle
        （cb is None 永久丢弃）。故只弹「路由已注册的 run 事件 + 连接级事件（fan-out 不需路由）」，
        其余保留缓冲，等其路由重建（后续会话 _replay_projection / 后续 send ack）时再 flush。
        """
        if not self._recovery_state.connect_buffered:
            return
        keep: list[dict] = []
        drain: list[dict] = []
        for msg in self._recovery_state.connect_buffered:
            frames = self._translator.translate(msg)
            # 不可翻译帧（frames 空）归 drain——_handle 对它们本来就是 no-op（translate 确定性，
            # 现在不可翻译以后也不可翻译），与旧行为一致地消费掉；连接级帧（runId None）同 drain。
            run_id = frames[0].get('runId') if frames else None
            if run_id is None or run_id in self._routes:
                drain.append(msg)  # 连接级帧 / 不可翻译帧 / 路由已就绪：立即可回放
            else:
                keep.append(msg)  # 路由未重建（如第二会话）：保留待其就绪后回放
        self._recovery_state.connect_buffered = keep
        if drain:
            asyncio.ensure_future(self._replay_connect_buffered(drain))

    def _flush_recovery_buffered(self) -> None:
        """codex #249 R5 (id 3690750256)：回放 live-wire resume 窗口缓冲的 run-scoped 帧。

        resume_active_session 恢复窗口内 _handle 把路由未就绪的 run 帧缓冲到 _recovery_buffered；
        本方法在 _replay_projection 装好路由后调用，经 _handle 分发（路由已注册 → 正常路由）。
        连接级帧不走此缓冲（_handle 已 fan-out）；缓冲帧路由仍未就绪则保留等下次 flush（对齐
        _flush_connect_buffered 的按就绪过滤）。异步回放不阻塞调用方（对齐 _replay_connect_buffered）。
        """
        if not self._recovery_state.recovery_buffered:
            return
        keep: list[dict] = []
        drain: list[dict] = []
        for msg in self._recovery_state.recovery_buffered:
            frames = self._translator.translate(msg)
            run_id = frames[0].get('runId') if frames else None
            if run_id in self._routes:
                drain.append(msg)
            else:
                keep.append(msg)
        self._recovery_state.recovery_buffered = keep
        if drain:
            asyncio.ensure_future(self._replay_connect_buffered(drain))

    def _flush_connection_level_buffered(self) -> None:
        """#217 / codex #236 P2-419：恢复完成后回放泵期缓冲的**连接级** event 帧（approval /
        approvalResolved——fan-out 到审批订阅者，不需 runId 路由）。

        原先缓冲仅「采用 inFlightRun」或「后续 send ack 注册路由」两路回放——无活跃会话 / 无可采用
        run 时连接级帧滞留到无关的未来 send 才浮现（审批卡迟到/丢失）。此处兜底只弹**连接级**帧；
        **run-scoped 帧留在缓冲**待路由注册（send ack / inFlightRun 重建）时回放——否则恢复完成后
        路由未就绪即回放会被 _handle 丢弃（cb is None），重连期进行中 run 的输出反被本兜底弄丢。
        """
        if not self._recovery_state.connect_buffered:
            return
        keep: list[dict] = []
        drain: list[dict] = []
        for msg in self._recovery_state.connect_buffered:
            frames = self._translator.translate(msg)
            (drain if frames and frames[0].get('runId') is None else keep).append(msg)
        self._recovery_state.connect_buffered = keep
        if drain:
            asyncio.ensure_future(self._replay_connect_buffered(drain))

    async def _replay_connect_buffered(self, buffered: list[dict]) -> None:
        for msg in buffered:
            await self._handle(msg)

    async def resolve_approval(self, approval_id: str, kind: str, decision: str) -> dict:
        """回覆一次权限审批（T06，spec §8.2）：发 {kind}.approval.resolve(id,decision)，有界等 res。

        issue #154 实测（ghcr 2026.6.34 / ADR 0003）：method 按族为 exec.approval.resolve /
        plugin.approval.resolve（非通用 approval.resolve，后者 unknown method）。
        params 为 {id, decision}（无 kind），decision 值 allow-once/allow-always/deny。

        返回网关 res 的 payload——approval.resolve 是 first-answer-wins，权威记录的 decision 可能
        与本请求的 decision 不同（另一 operator 已答）；调用方须用 payload 里的权威结果，不能回声
        本请求的 decision（codex P1）。需 operator.approvals scope；网关拒绝抛 ChatSendError。

        #274 薄委托：行为在 RequestRouter.resolve_approval（请求-回执路由收口）。
        """
        return await self._request_router.resolve_approval(
            approval_id, kind, decision, ws=self._ws, dead=self.dead)

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

        #274 薄委托：行为在 RequestRouter.list_pending_approvals。
        """
        return await self._request_router.list_pending_approvals(ws=self._ws)

    async def request_approval(self, command: str, *, session_key: str | None = None) -> dict:
        """确定性创建 exec 审批请求（codex P2 #168）：发 exec.approval.request，有界等 res。

        LLM prompt 触发审批（agent 是否调 exec + 网关 elevated 判断）不稳定——curl 有时被允许直接
        执行、有时触发审批。本方法用文档已证的 exec.approval.request RPC 直接创建 pending approval，
        对集成测试完全确定性。需 operator.approvals scope；网关拒绝抛 ChatSendError。

        返回网关 res payload——至少含 id 字段（审批 id），供后续 resolve/list 使用。

        #274 薄委托：行为在 RequestRouter.rpc。
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

        #274 薄委托：行为在 RequestRouter.list_commands。
        """
        return await self._request_router.list_commands(ws=self._ws)

    async def _rpc(self, method: str, params: dict) -> dict:
        """通用 req→res 回执 RPC（issue #80 T1）：sessions.list / chat.history / sessions.create /
        sessions.delete 共用。复用 _pending_resolves 注册表，按 req id 经 _resolve_ack 分发 res。

        未连接抛 ChatClientError（会话管理是 REST 主动调用，须报错让上层映射 502/409，区别于
        list_commands/list_pending_approvals 的 best-effort 静默返回）；网关拒绝（res not ok）/ ack
        超时抛 ChatSendError。原样透传网关 payload，不做字段翻译（集中在 REST 解析层 T2）。

        #274 薄委托：行为在 RequestRouter.rpc。
        """
        return await self._request_router.rpc(method, params, ws=self._ws, dead=self.dead)

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

        #274 薄委托：行为在 RequestRouter.send_message（注册/有界等待/transmitted 判定/payload
        预检收口）。``dead_before_send`` 快照由门面在委托前读取（self._dead）——协作者不反向
        引用门面状态；快照语义：发送前已死才断「确定未传输」，发送中才死归 transmitted。
        """
        return await self._request_router.send_message(
            session_key, message, on_event=on_event, idempotency_key=idempotency_key,
            ws=self._ws, policy=self._policy, dead=self.dead, dead_before_send=self._dead)

    def discard(self, run_id: str) -> None:
        self._routes.pop(run_id, None)

    def _fail_pending_acks(self, message: str) -> None:
        """连接断开/关闭：reject 所有未决 ack，避免 send_message 调用方永久挂起。

        #274 薄委托：行为在 RequestRouter.fail_pending_acks。
        """
        self._request_router.fail_pending_acks(message)

    def _fail_pending_resolves(self, message: str) -> None:
        """连接断开/关闭：reject 所有未决 approval.resolve，避免 resolve_approval 调用方挂起。

        #274 薄委托：行为在 RequestRouter.fail_pending_resolves。
        """
        self._request_router.fail_pending_resolves(message)

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
