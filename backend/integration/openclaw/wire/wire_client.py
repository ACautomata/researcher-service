"""OpenClaw 长连接对话客户端——路径4 收敛后的唯一 OpenClawWire 实现（#231 / ADR 0004）。

历史为 chat.chat_client.OpenClawChatClient（issue #41 / spec §8.2，承载 #152/#154/#214/#219/#220
的 dead/transmitted 硬化语义）。ADR 0004 收敛停滞的路径4 strangler：本类迁入防腐层为唯一实现，
删除停滞的 OpenClawWireAdapter；chat.chat_client 保留**同对象 alias**（strangler 零改名，既有
chat 测试 / pool / consumers 导入不动，alias 清理列 deferred）。

每容器一条已配对长连接（deviceToken 作 auth.token，spec §8.1 step5）。chat.send → ack(runId) →
chat 事件按 runId 经 ChatEventTranslator 翻译，路由到发起方 on_event 回调；done/error 收尾后清路由；
discard 供 consumer 断开时移除路由避免推已关闭连接。

#271/#275 门面化：本类退为**门面（Facade）**，5 类独立职责各归内部协作者（同包公开类，构造
注入、单向依赖 门面→协作者、协作者互不引用）：
- ``ConnectionCore``（connection_core.py）：ws 连接生命周期（握手/challenge/看门狗/dead/4000/aclose），
  唯一 I/O（ws 收发）独占；
- ``RequestRouter``（request_router.py）：请求-回执路由（双表 + transmitted 判定 + 有界等待）；
- ``RunEventRouter``（run_event_router.py）：runId 事件路由 + 翻译 + 终态清理 + 缓冲按就绪过滤；
- ``RecoveryCoordinator``（recovery.py）：断线重连恢复协调；
- ``ApprovalFanout``（approval.py）：连接级审批订阅 fan-out。

门面方法（Port 16 方法 / 恢复面 4 方法 / 委托 property）缩为线性委托，跨桶接缝由门面编排、协作者
回返值对象（``AckOutcome`` / ``RouteDecision``）。对外签名、``OpenClawChatClient`` alias、Port
接口、isomorph 守卫全部不变；现有测试零改动（委托 property ``_routes``/``_pending_resolves``/
``_recv_task``/``_dead``/``_ws``/``_policy`` 保住直读私有成员的既有测试）。

transport 注入（默认 websockets.connect）；connect_frame_builder 注入（握手帧格式 spec §8.1 step5
标待实测，默认 deviceToken 直连，可替换）。测试用 FakeChatTransport。
"""
from __future__ import annotations

from collections.abc import Callable

from chat.event_translate import ChatEventTranslator
from integration.openclaw.wire import (
    AGENT_ID as _AGENT_ID,
)
from integration.openclaw.wire import (
    GatewayPolicy,
)
from integration.openclaw.wire.approval import ApprovalFanout
from integration.openclaw.wire.connection_core import ConnectionCore
from integration.openclaw.wire.recovery import RecoveryCoordinator
from integration.openclaw.wire.request_router import RequestRouter
from integration.openclaw.wire.run_event_router import RunEventRouter
from integration.openclaw.wire.values import (
    OnEvent,
)


class OpenClawWireClient:  # pylint: disable=too-many-arguments,too-many-public-methods
    """对单个已配对容器维持一条长连接，发 chat.send 并按 runId 路由 chat 事件。

    门面：仅持有 5 个内部协作者 + 编排方法，无散置职责状态（issue #275 验收——单类实例属性
    收敛到 ≤10，符合项目「单类 ≤10 实例属性」约定）。
    """

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
        # 签名路径一体前提校验（codex #150 P2）：identity 非空则 scopes 必须非空，否则
        # ConnectFrameBuilder.session() 会在握手半途 `','.join(None)` TypeError。构造期
        # fail-fast（优于让坏配置连上网关后才崩）。identity=None 走旧路径（不签名）。
        if identity is not None and not scopes:
            raise ValueError('signed connect path requires non-empty scopes when identity is provided')
        translator = translator or ChatEventTranslator()
        # 连接级审批订阅 fan-out（T06）：消费端 add/remove、门面 _handle 接线。无独立 I/O。
        self._approval_fanout = ApprovalFanout()
        # 请求-回执路由（#274）：双表 + ack_timeout，门面 _resolve_ack/send_message/RPC 委托。
        self._request_router = RequestRouter(ack_timeout=ack_timeout)
        # runId 事件路由 + 翻译 + 缓冲过滤（#275）：_handle/_classify_incoming/_flush_* 收口。
        self._run_event_router = RunEventRouter(
            translator=translator,
            fanout=self._fanout_approval,
            dispatch_frames=self._replay_connect_buffered,
        )
        # 断线重连恢复协调（#273/#275）：恢复域状态收口本协作者，flush/set_recovering 经回调注入。
        self._recovery = RecoveryCoordinator(
            rpc=self._rpc,
            routes=self._run_event_router.routes,
            translator=translator,
            flush_connect_buffered=self._run_event_router.flush_connect_buffered,
            flush_recovery_buffered=self._run_event_router.flush_recovery_buffered,
            set_recovering=self._run_event_router.set_recovering,
        )
        # ws 连接生命周期（#275）：唯一 I/O 独占，owner=self 供 on_dead 上报携带门面身份。
        self._connection = ConnectionCore(
            url=url, device_token=device_token, owner=self,
            identity=identity, scopes=scopes,
            transport=transport, connect_frame_builder=connect_frame_builder,
            connect_timeout=connect_timeout, on_dead=on_dead,
            run_recovery=self._recovery.run,
            on_res=self._resolve_ack,
            buffer_event=self._run_event_router.buffer_connect_event,
            handle_event=self._run_event_router.handle,
            flush_connection_level=self._run_event_router.flush_connection_level_buffered,
            notify_all_error=self._notify_all_error,
        )

    # ── 委托 property：保住直读私有成员的既有测试（状态所有权在各协作者）──

    @property
    def _routes(self) -> dict[str, OnEvent]:
        """runId 路由表（#275 委托 property）——既有测试（test_chat_client.py / test_chat_client_
        transmitted.py 断言 ``'adopted-run' in c._routes`` / ``c._routes == {}``）直读本成员保持
        全绿；实际状态所有权在 ``RunEventRouter``。"""
        return self._run_event_router.routes

    @property
    def _pending_acks(self) -> dict:
        """发送 ack 注册表（#274 委托 property）——既有测试断言 ``c._pending_acks == {}`` 保持全绿。"""
        return self._request_router.pending_acks

    @property
    def _pending_resolves(self) -> dict:
        """审批 resolve 注册表（#274 委托 property）——既有测试断言 ``not c._pending_resolves`` 保持全绿。"""
        return self._request_router.pending_resolves

    @property
    def _active_session_keys(self) -> list[str]:
        """只读视图：当前记住的活跃会话 key 列表（副本）。#272 委托 property——既有测试断言
        ``'s1' in c._active_session_keys`` 保持全绿；实际状态所有权在 ``RecoveryCoordinator``。"""
        return self._recovery.active_session_keys

    @property
    def _recv_task(self):
        """recv loop 任务（#275 委托 property）——既有测试直读 ``c._recv_task.cancel()`` 保持全绿；
        实际状态所有权在 ``ConnectionCore``。"""
        return self._connection.recv_task

    @property
    def _dead(self) -> bool:
        """连接是否已标 dead（#275 委托 property，可直写）——既有测试直写 ``c._dead = True`` 保持
        全绿；实际状态所有权在 ``ConnectionCore``（recv loop / send 死窗口共享）。"""
        return self._connection.dead

    @_dead.setter
    def _dead(self, value: bool) -> None:
        self._connection.dead = value

    @property
    def _ws(self):
        """当前连接 socket（#275 委托 property，可直写）——既有测试直写 ``c._ws = _DeadWs()`` /
        ``c._ws.send = closed_send`` 保持全绿；实际状态所有权在 ``ConnectionCore``（唯一 I/O）。"""
        return self._connection.ws

    @_ws.setter
    def _ws(self, value) -> None:
        self._connection.ws = value

    @property
    def _policy(self) -> GatewayPolicy:
        """当前生效网关 policy（#275 委托 property，可直写）——既有测试直写 ``c._policy =
        GatewayPolicy(...)`` 保持全绿；实际状态所有权在 ``ConnectionCore``（hello-ok 解析）。"""
        return self._connection.policy

    @_policy.setter
    def _policy(self, value: GatewayPolicy) -> None:
        self._connection.policy = value

    @property
    def _on_dead(self):
        """dead 回调（#275 委托 property）——test_codex221_repro 直读 ``c._on_dead(c)`` 保持全绿。"""
        return self._connection.on_dead

    @property
    def _url(self) -> str:
        """连接目标 URL（#275 委托 property）——test_pool.py 直读 ``c._url`` 保持全绿；
        实际状态所有权在 ``ConnectionCore``。"""
        return self._connection.url

    @property
    def _device_token(self) -> str:
        """配对 deviceToken（#275 委托 property）——test_pool.py 直读 ``c._device_token`` 保持全绿；
        实际状态所有权在 ``ConnectionCore``。"""
        return self._connection.device_token

    @property
    def _translator(self) -> ChatEventTranslator:
        """事件翻译器（门面 _notify_all_error / recovery 共享；实际所有权在 RunEventRouter）。"""
        return self._run_event_router.translator

    # ── 恢复面 4 方法（薄委托，对外签名不变）──

    def record_active_session(self, session_key: str, on_event: OnEvent | None = None) -> None:
        """#196 T4 / #217：记住一个活跃 sessionKey（+其恢复回调），供每次 connect 后重连恢复。

        #273 薄委托：行为在 RecoveryCoordinator.record_active_session。
        """
        self._recovery.record_active_session(session_key, on_event)

    async def resume_active_session(self, session_key: str, on_event: OnEvent) -> None:
        """Register a replacement consumer and restore its live route without reconnecting.

        #273 薄委托：行为在 RecoveryCoordinator.resume_active_session。
        """
        await self._recovery.resume_active_session(session_key, on_event)

    def recovery_sessions(self) -> list[tuple[str, list[OnEvent]]]:
        """#196 T4 / #217：返回**全部**记住的活跃会话。

        #273 薄委托：行为在 RecoveryCoordinator.recovery_sessions。
        """
        return self._recovery.recovery_sessions()

    def unregister_active_session(self, session_key: str, on_event: OnEvent | None = None) -> None:
        """#217 / codex #236 P2-261：注销记住的恢复回调（consumer 断开时调用）。

        #273 薄委托：行为在 RecoveryCoordinator.unregister_active_session。
        """
        self._recovery.unregister_active_session(session_key, on_event)

    # ── 审批订阅 fan-out（薄委托，T06 / codex P1）──

    def add_approval_subscriber(self, cb: OnEvent) -> None:
        """注册连接级审批订阅者。"""
        self._approval_fanout.add(cb)

    def remove_approval_subscriber(self, cb: OnEvent) -> None:
        """退订指定订阅者（只移除自己）。"""
        self._approval_fanout.remove(cb)

    def approval_subscribers(self) -> list[OnEvent]:
        """返回当前全部审批订阅者的副本（codex #219 P2：共享 client 自愈迁移用）。"""
        return self._approval_fanout.subscribers()

    async def _fanout_approval(self, frame: dict) -> None:
        """把一帧连接级审批帧 fan-out 到所有订阅者（RunEventRouter 经注入调用）。"""
        await self._approval_fanout.fanout(frame)

    async def broadcast_approval_resolved(self, approval_id: str, decision: str) -> None:
        """把一次权威 resolve 结果 fan-out 到全部订阅者（codex R2 P2）。"""
        await self._approval_fanout.broadcast_resolved(approval_id, decision)

    # ── 只读公开 property ──

    @property
    def dead(self) -> bool:
        """连接是否已不可用（recv loop 退出或被显式关闭）；pool 据此不复用。"""
        return self._connection.is_closed_or_dead

    @property
    def policy(self) -> GatewayPolicy:
        """当前生效的网关 policy（hello-ok 解析；握手前 / 缺字段为协议默认）。#196 T1 / #213。"""
        return self._connection.policy

    @property
    def identity(self):
        """本连接的 DeviceIdentity（#215：pool 主动重连复用同份材料重建，无需重读配对）。"""
        return self._connection.identity

    @property
    def scopes(self):
        """本连接的已批准 scopes（#215：pool 主动重连复用重建）。"""
        return self._connection.scopes

    # ── 连接生命周期（薄委托到 ConnectionCore）──

    async def connect(self) -> None:
        """建立长连接并启动 recv loop（握手/恢复泵在 ConnectionCore）。"""
        await self._connection.connect()

    # recv loop 由 ConnectionCore.connect() 起 task（self._connection.recv_task）；门面不再
    # 单独暴露 _recv_loop——connect 内 create_task 即启动，测试经 _recv_task 委托取消。

    # ── 入站分发（门面编排，跨桶接线）──

    async def _handle(self, msg: dict) -> None:
        """一帧入站帧的分发：res 帧走回执结算（RequestRouter 桶），event 帧走 RunEventRouter。"""
        if msg.get('type') == 'res':
            self._resolve_ack(msg)
            return
        await self._run_event_router.handle(msg)

    def _resolve_ack(self, msg: dict) -> None:
        """回执（res 帧）→「回执→路由→恢复」三桶编排（#274/#275）。

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
        self._run_event_router.flush_connect_buffered()
        # codex #249 R5 (id 3690750256)：本 ack 也可能解封 live-wire resume 窗口缓冲的帧
        # （多 consumer 共享 client：A resume 期间 B 的 send ack 在途，B 的 run 帧被缓冲到
        # recovery_buffered）——路由刚装好即一并回放，避免缓冲帧滞留到无关的未来 send。
        self._run_event_router.flush_recovery_buffered()

    async def _replay_connect_buffered(self, buffered: list[dict]) -> None:
        """缓冲回放的异步分发（RunEventRouter 经注入调用，逐帧经 _handle 路由）。"""
        for msg in buffered:
            await self._handle(msg)

    async def _notify_all_error(self, message: str) -> None:
        """连接断开/关闭：fail 全部挂起请求 + 活跃路由推终态 error 帧 + 清空路由表。

        codex #219 七轮 P1：用终态 error（含 fail 活跃 _routes）替代仅 fail pending
        acks/resolves——evidence-based 重取（ConnectionClosed 竞态，recv loop 尚未跑清理）经
        pool.reacquire aclose 旧 client 时，别的 consumer 在该共享连接上的 in-progress run 须
        收到终态 error（否则浏览器消息永久 pending）。与 recv-loop 清理幂等（_routes.clear()，
        重复调空集合无操作）。
        """
        self._request_router.fail_pending_acks(message)
        self._request_router.fail_pending_resolves(message)
        for run_id, cb in self._run_event_router.snapshot_routes():
            try:
                await cb({'type': 'error', 'runId': run_id, 'message': message})
            except Exception:  # pylint: disable=broad-exception-caught
                pass
        self._routes.clear()

    # ── 请求-回执（薄委托到 RequestRouter）──

    async def resolve_approval(self, approval_id: str, kind: str, decision: str) -> dict:
        """回覆一次权限审批（T06，spec §8.2）：发 {kind}.approval.resolve(id,decision)，有界等 res。

        #274 薄委托：行为在 RequestRouter.resolve_approval。
        """
        return await self._request_router.resolve_approval(
            approval_id, kind, decision, ws=self._ws, dead=self.dead)

    async def list_pending_approvals(self) -> list[dict]:
        """查询网关当前待审批列表（codex P2 断线恢复），翻译成审批卡帧列表。

        #274 薄委托：行为在 RequestRouter.list_pending_approvals。
        """
        return await self._request_router.list_pending_approvals(ws=self._ws)

    async def request_approval(self, command: str, *, session_key: str | None = None) -> dict:
        """确定性创建 exec 审批请求（codex P2 #168）：发 exec.approval.request，有界等 res。

        #274 薄委托：行为在 RequestRouter.rpc。
        """
        params: dict = {'command': command}
        if session_key is not None:
            params['sessionKey'] = session_key
        return await self._rpc('exec.approval.request', params)

    async def list_commands(self) -> dict:
        """拉取该 agent 工作区的斜杠命令清单（T07，spec §8.2）：发 commands.list，有界等 res。

        #274 薄委托：行为在 RequestRouter.list_commands。
        """
        return await self._request_router.list_commands(ws=self._ws)

    async def _rpc(self, method: str, params: dict) -> dict:
        """通用 req→res 回执 RPC（issue #80 T1）：sessions.list / chat.history / sessions.create /
        sessions.delete 共用。

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
        """列出该 agent 网关中真实存在的会话（spec #76）：发 sessions.list，有界等 res。"""
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
        """读取某会话完整聊天记录（spec #76）：发 chat.history，有界等 res。"""
        params: dict = {'sessionKey': session_key}
        if limit is not None:
            params['limit'] = limit
        if message_id is not None:
            params['messageId'] = message_id
        return await self._rpc('chat.history', params)

    async def create_session(self, key: str, *, label: str | None = None) -> dict:
        """新建会话（spec #76）：发 sessions.create{key,label}，有界等 res。"""
        params: dict = {'key': key}
        if label is not None:
            params['label'] = label
        return await self._rpc('sessions.create', params)

    async def delete_session(self, session_key: str) -> dict:
        """删除会话（spec #76，**admin 级提升权限操作**）：发 sessions.delete，有界等 res。"""
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
        self._run_event_router.drop(run_id)

    # ── 收尾（薄委托到 ConnectionCore）──

    async def aclose(self) -> None:
        """关闭连接（幂等清理在 ConnectionCore）。"""
        await self._connection.aclose()
