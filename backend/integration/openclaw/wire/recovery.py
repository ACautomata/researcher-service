"""断线重连恢复协作者（issue #271/#273/#275，parent #217）。

``RecoveryCoordinator``：connect() 握手成功后按序执行重连恢复（sessions.subscribe →
（有活跃会话）messages.subscribe → chat.history → 回放投影 + 采用 inFlightRun 重建路由）。
由原 ``_RecoveryCoordinator`` 正名（#272，去下划线符合「禁下划线私有类」约定）。#273 改为
**构造注入**（rpc/routes/translator/flush 回调），不再反向引用 ``OpenClawWireClient`` ——单向
依赖 门面→协作者，本模块不 import 门面。

#275 收尾：删除 ``RecoveryState`` 共享容器，恢复域状态（活跃会话集合 / 会话回调 / 恢复路由）
**直接收进本类**（状态与行为同处一类）——原经 ``state.xxx`` 单点访问的散置字段归位；泵期缓冲
（``connect_buffered``/``recovery_buffered``/``recovering`` 窗口标志）移入 ``RunEventRouter``
（缓冲按就绪过滤行为所在），本类经注入的 ``flush_connect_buffered``/``flush_recovery_buffered``
回调触发回放、经 ``set_recovering`` 回调置 resume 窗口——不直接读写缓冲。
"""
from __future__ import annotations

from chat.event_translate import ChatEventTranslator
from integration.openclaw.wire.values import HISTORY_RUN_ID, OnEvent, RecoveredRun


class RecoveryCoordinator:
    """#217 T4：connect() 握手成功后按序执行重连恢复（门面内部协作者，组合非继承）。

    #272 正名：由原 ``_RecoveryCoordinator``（下划线私有类）去下划线公开——符合项目
    「禁下划线私有类」约定（issue #271）。#273 改为构造注入——不再反向引用门面，经注入的
    ``rpc`` / ``routes`` / ``translator`` / flush 回调完成恢复序列（单向依赖 门面→协作者）。
    #275 恢复域状态收进本类，``RecoveryState`` 共享容器删除。

    序列（每次 connect，含首连与 pool 主动重连）：sessions.subscribe →（有活跃会话）
    sessions.messages.subscribe → chat.history → 回放投影 + 采用 inFlightRun 重建路由。
    ``includeApprovals`` 暂不下发——连接级审批 fan-out（T06 add_approval_subscriber）已独立覆盖，
    且该 opt-in 需 operator.admin/approvals 逐次订阅生效（待实测，#217 边界不引入）。
    """

    def __init__(
        self,
        *,
        rpc,
        routes: dict[str, OnEvent],
        translator: ChatEventTranslator,
        flush_connect_buffered,
        flush_recovery_buffered,
        set_recovering,
    ) -> None:
        self._rpc = rpc
        self._routes = routes
        self._translator = translator
        self._flush_connect_buffered = flush_connect_buffered
        self._flush_recovery_buffered = flush_recovery_buffered
        self._set_recovering = set_recovering
        # 记住的活跃会话集合（consumer 注册，重连后逐会话恢复投影）。codex #236 R2 P1-223：
        # **按会话记忆**（不再单一全局 slot）——多 consumer 共享池化 client 各自用不同 sessionKey 时，
        # 逐会话记住 + 逐会话恢复，不互相覆盖丢失。
        self._active_session_keys: set[str] = set()
        # 会话 → 恢复回调**列表**（codex #236 R3 P1-242：同一会话多 consumer 各持自己的 on_event，
        # 共享池化 client 时单槽覆盖会让后注册者顶掉前者、断连只清最后一个——改列表 fan-out，
        # 对齐 _approval_subscribers 多订阅者模式）；仅提供回调的会话才回放投影/重建路由，
        # key-only 会话仍 subscribe+chat.history 但不回放（对齐 record_active_session on_event=None 语义）。
        self._session_callbacks: dict[str, list[OnEvent]] = {}
        # 恢复重建的 runId → 所属 sessionKey（codex #236 R2 P2-96）：unregister 时按会话清这些重建
        # 路由——adopted run 不进 consumer._active_runids，disconnect 不 discard，须在此对称清，
        # 防已关闭 consumer 被池化 client 保留并续接该 run 事件。
        self._recovery_routes: dict[str, str] = {}

    @property
    def active_session_keys(self) -> list[str]:
        """只读视图：当前记住的活跃会话 key 列表（副本）。#272 委托 property——既有测试
        （test_chat_client.py 断言 ``'s1' in c._active_session_keys``）直读门面本成员保持全绿；
        实际状态所有权在本协作者。"""
        return list(self._active_session_keys)

    async def run(self) -> None:
        """执行恢复序列：sessions.subscribe（步1）后，对**每个**记住的活跃会话逐条恢复（步2-4）。

        codex #236 R2 P1-223：多 consumer 共享池化 client 各自记住不同 sessionKey——逐会话
        messages.subscribe + chat.history + 采用 inFlightRun，不再只恢复最近一条（否则其余
        consumer 的进行中 run 丢路由、续流丢失）。key-only 会话（无回调）仍 subscribe+chat.history，
        只是不回放投影/重建路由（_replay_projection 内 on_event None 跳过）。
        """
        await self._rpc('sessions.subscribe', {})
        for session_key in list(self._active_session_keys):
            await self._rpc('sessions.messages.subscribe', {'key': session_key})
            history = await self._rpc('chat.history', {'sessionKey': session_key})
            await self._replay_projection(session_key, history or {})

    async def resume_live_session(self, session_key: str) -> None:
        """Rebuild one session's subscription and in-flight route on an already-live wire.

        A browser reconnect can reuse the pooled OpenClaw connection, so ``connect()`` (and
        therefore :meth:`run`) is not invoked.  Repeating the two session-scoped RPCs gives us
        the authoritative in-flight run and lets the replacement consumer receive subsequent
        deltas.  The browser reloads persisted history separately, so do not replay completed
        history here; only adopt/replay the in-flight buffer and rebuild its route.
        """
        await self._rpc('sessions.messages.subscribe', {'key': session_key})
        history = await self._rpc('chat.history', {'sessionKey': session_key})
        await self._replay_projection(session_key, history or {}, replay_history=False)

    async def _replay_projection(
        self, session_key: str, history: dict, *, replay_history: bool = True,
    ) -> None:
        """步2-4：回放 history 投影（replace）+ 按 sessionInfo 归属采用 inFlightRun 重建路由。

        codex #236 R3 P1-242：同会话多订阅者时 history 投影与 inFlightRun 缓冲 text **fan-out** 到
        全部回调（列表），重建的 runId 路由经 ``_recovery_fanout`` 续流到**当前**全部订阅者——
        单槽覆盖会让后注册 consumer 顶掉前者、续流只投最后一个。
        """
        callbacks = list(self._session_callbacks.get(session_key, []))
        if callbacks and replay_history:
            for frame in self._history_frames(history.get('messages')):
                for on_event in callbacks:
                    # codex #236 R4 P2：恢复投影回调 per-callback 异常隔离——任一订阅者抛错（如
                    # 浏览器在回调传播后、新 client 发布前断开）不得中止本协程让 connect() 对共享
                    # pool 的全部 consumer 判失败；对齐 _fanout_approval / _recovery_fanout 模式。
                    try:
                        await on_event(frame)
                    except Exception:  # pylint: disable=broad-exception-caught
                        pass
        recovered = self._adopt_inflight_run(history)
        if recovered is None or not callbacks:
            return
        self._routes[recovered.run_id] = self._recovery_fanout(session_key)  # 步3：重建 runId 路由
        # codex #236 R2 P2-96：记 adopted runId→sessionKey——adopted run 不进 consumer._active_runids，
        # disconnect 不 discard；unregister_active_session 按会话对称清这些重建路由。
        self._recovery_routes[recovered.run_id] = session_key
        if recovered.text:
            # codex #236 R3 P1-108：先 seed 翻译器累积器再回放——恢复 text 已投前端（replace），
            # 网关后续 final 快照须以它为基线只补尾部，否则整段重发（"Hello"+"Hello world"→"HelloHello world"）。
            self._translator.seed_sent(recovered.run_id, recovered.text)
            for on_event in callbacks:
                # codex #236 R4 P2：inFlightRun 缓冲 text 回放同做异常隔离（对齐 history 投影分支）。
                try:
                    await on_event({
                        'type': 'text', 'runId': recovered.run_id,
                        'delta': recovered.text, 'replace': True,
                    })
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
        # codex #236 P2-104：plan（systemRunPlan）采用进 RecoveredRun 但**暂不下发**——前端 ws.ts 尚无
        # plan ChatFrame 类型/handleMessage 分支，发即静默丢弃；#217 边界为后端恢复，前端 plan 卡属
        # #198。RecoveredRun.plan 保留该值供 #198 接线时取用。
        # 步3 路由已重建：回放恢复泵期缓冲的 event 帧（重连期到达的进行中 run 事件不丢，路由到本 run）。
        self._flush_connect_buffered()
        # codex #249 R5 (id 3690750256)：live-wire resume 窗口缓冲的 run-scoped 帧此刻路由已装好，
        # 回放（对齐 _flush_connect_buffered；无缓冲则 no-op）。
        self._flush_recovery_buffered()

    def _history_frames(self, messages) -> list[dict]:
        """history messages[] → __history__ 命名空间的 text 帧：**首个产出帧** replace=True 整段锚定，
        后续追加（前端按 historyRunId 累积重解析）。空/非 list → []。

        codex #236 P2-120：content 多态（user=字符串 / assistant=list，ADR 0003）经
        ``extract_history_text`` 校准——复用 _extract_text 会把 user 字符串 content 归 ''（user turn
        从投影消失）。replace 锚定**首个产出帧**而非 index==0：index 0 消息 text 为空（如纯工具 turn）
        被跳过时，原实现会让首个实际产出帧缺 replace=True，前端无法整段锚定。
        """
        if not isinstance(messages, list):
            return []
        frames: list[dict] = []
        for message in messages:
            text = self._translator.extract_history_text(message)
            if not text:
                continue
            frame = {'type': 'text', 'runId': HISTORY_RUN_ID, 'delta': text}
            if not frames:
                frame['replace'] = True
            frames.append(frame)
        return frames

    @staticmethod
    def _adopt_inflight_run(history: dict) -> RecoveredRun | None:
        """步3-4：采用 inFlightRun（取 runId + 缓冲 text[即使为空] + 可选 plan）。

        步4 归属判定：sessionInfo.hasActiveRun=true 且给了 activeRunIds 列表时，runId 须是
        其成员才采用——否则该 run 属另一活跃投影（hasActiveRun 无成员匹配），网关不会在本
        连接续流，不重建保留路由。activeRunIds 缺省（None）时按 inFlightRun 存在即采用。
        """
        inflight = history.get('inFlightRun')
        if not isinstance(inflight, dict):
            return None
        run_id = inflight.get('runId')
        if not run_id:
            return None
        session_info = history.get('sessionInfo') or {}
        active_ids = session_info.get('activeRunIds')
        if session_info.get('hasActiveRun') and active_ids is not None and run_id not in active_ids:
            return None
        plan = inflight.get('plan')
        return RecoveredRun(run_id=run_id, text=inflight.get('text') or '',
                            plan=plan if isinstance(plan, dict) else None)

    def _recovery_fanout(self, session_key: str) -> OnEvent:
        """#217 / codex #236 R3 P1-242：恢复重建的 runId 路由回调——把该 run 的每帧续流 fan-out 到
        **当前**全部订阅该会话的 consumer（调用时查 state.session_callbacks，非建路由时快照）。

        共享池化 client 同一会话多 consumer 时，续流须投给每个仍订阅者；consumer 断开（unregister）
        后自然从列表移除、不再续流，而仍连接的 peer 不受影响（单槽覆盖会把续流只投给最后一个
        注册者）。单订阅者回调失败隔离（对齐 _fanout_approval），不杀 recv loop / 不互伤。
        """
        async def _dispatch(frame: dict) -> None:
            for cb in list(self._session_callbacks.get(session_key, [])):
                try:
                    await cb(frame)
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
        return _dispatch

    # ── 恢复面 4 方法（门面薄委托，对外签名不变）──

    def record_active_session(self, session_key: str, on_event: OnEvent | None = None) -> None:
        """#196 T4 / #217：记住一个活跃 sessionKey（+其恢复回调），供每次 connect 后重连恢复。

        consumer 在对话 start / 切换会话时调用。``on_event`` 是该会话恢复投影（history replace 回放、
        inFlightRun 缓冲 text、重建路由后该 runId 后续事件）的投递目标；为 None 时仅记住 sessionKey
        （仍发 subscribe + chat.history，但不回放/不重建路由）。同 key 再调更新回调；**多 key 共存**
        （codex #236 R2 P1：不再覆盖单一 slot）——共享 client 的每 consumer 各自记住自己的会话。
        """
        self._active_session_keys.add(session_key)
        if on_event is None:
            self._session_callbacks.pop(session_key, None)
        elif on_event not in self._session_callbacks.setdefault(session_key, []):
            # codex #236 R3 P1-242：同一会话多 consumer 各注册自己的回调（列表 append，非覆盖）；
            # 幂等去重（同回调重复 record 不重复回放）。
            self._session_callbacks[session_key].append(on_event)

    async def resume_active_session(self, session_key: str, on_event: OnEvent) -> None:
        """Register a replacement consumer and restore its live route without reconnecting.

        ``record_active_session`` alone is storage-only.  This method is the browser-reconnect
        path for a healthy pooled connection: it also queries the current in-flight run and
        rebuilds ``routes`` so future gateway events reach the new consumer.

        codex #249 R5 (id 3690750256)：恢复 RPC 期间 _recv_loop 持续消费入站帧，而重建路由要等
        chat.history 返回后才安装——期间到达的该会话 in-flight run 帧（含终态）若直接经 handle
        路由会被静默丢弃。故恢复窗口置 recovering（经注入的 set_recovering 回调通知 RunEventRouter）
        缓冲 run-scoped 帧，_replay_projection 装好路由后回放（对齐 connect() 恢复泵 connect_buffered
        的同一不丢帧语义）。
        """
        self.record_active_session(session_key, on_event)
        self._set_recovering(True)
        try:
            await self.resume_live_session(session_key)
        finally:
            self._set_recovering(False)

    def recovery_sessions(self) -> list[tuple[str, list[OnEvent]]]:
        """#196 T4 / #217：返回**全部**记住的活跃会话 ``[(session_key, [on_event, ...]), ...]``（可空）。

        pool 换 client（_reconnect_once / reacquire / get_or_create 死路径）建替换 client 前读旧
        client 的记住会话，逐条 propagate 到新 client——否则 remembered session 随旧 client 丢弃，
        重连恢复永不携带（Spec 步1「client 记住上次活跃 sessionKey」跨重连失效）。codex #236 R2 P1：
        多会话逐条返回。codex #236 R3 P1-242：同一会话多订阅者**全部**返回（列表副本），非只回最近
        一个——pool 重建后每 consumer 的恢复回调都被带到新 client。key-only 会话（无回调）为 ``[]``。
        """
        return [(key, list(self._session_callbacks.get(key, [])))
                for key in self._active_session_keys]

    def unregister_active_session(self, session_key: str, on_event: OnEvent | None = None) -> None:
        """#217 / codex #236 P2-261：注销 ``record_active_session`` 记住的恢复回调（consumer 断开 /
        切容器时调用），防池化 client 后续重连把恢复投影投到已关闭 consumer（输出丢失 + 回调异常
        连累 connect），并释放对 consumer 的引用保留。

        **匹配才清**（codex #236 R2 P2-251 用**相等**非恒等——bound method 每次求值建新对象，``is``
        恒假会让注销静默失效；``==`` 按 __self__+__func__ 判等）。codex #236 R3 P1-242：同一会话
        多订阅者时只移除**本 consumer** 的回调，其余订阅者保留会话与重建路由；本 consumer 未注册
        此会话（别的 consumer 的同名会话）时 no-op，不误清。仅当回调列表清空（或 key-only 会话 /
        显式 on_event=None）才整体移除会话 + 该会话恢复重建的 runId 路由（R2 P2-96）。
        """
        if session_key not in self._active_session_keys:
            return
        callbacks = self._session_callbacks.get(session_key)
        if on_event is not None and callbacks:
            if on_event not in callbacks:
                return  # 本 consumer 未注册此会话：不误清别的 consumer 的订阅
            callbacks.remove(on_event)
            if callbacks:
                return  # 仍有其他订阅者：会话与恢复路由保留，续流继续投给 peer
        self._active_session_keys.discard(session_key)
        self._session_callbacks.pop(session_key, None)
        for run_id, owner in [kv for kv in self._recovery_routes.items() if kv[1] == session_key]:
            self._recovery_routes.pop(run_id, None)
            self._routes.pop(run_id, None)
