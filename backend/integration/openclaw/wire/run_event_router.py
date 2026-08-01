"""runId 事件路由 + 翻译协作者（issue #271/#275，parent #214 / #217）。

``RunEventRouter``：入站 chat 事件帧的 runId 路由表、翻译器、终态清理、恢复期缓冲按就绪过滤
（原门面 ``_routes`` / ``_translator`` / ``_classify_incoming`` / ``_handle`` / ``_flush_connect_buffered``
/ ``_flush_recovery_buffered`` / ``_flush_connection_level_buffered`` 收口）。门面内部组合，组合非继承；
单向依赖 门面→协作者，本模块不 import 门面。

状态与行为同处一类：路由表（``_routes``）与翻译器（``_translator``）为路由单源；恢复泵期缓冲
（``_connect_buffered``）与 live-wire resume 窗口缓冲（``_recovery_buffered``）及其 ``_recovering``
窗口标志随「按就绪过滤」行为一并收口——原散在 ``RecoveryState`` 的这三个字段（#272/#273）移入，
行为与状态不再分家。

跨桶通信经构造注入（不反向引用门面、不引用其他协作者类）：
- ``fanout``：连接级审批帧 fan-out 回调（门面传 ``ApprovalFanout.fanout``）——审批桶不回引本类；
- ``dispatch_frames``：缓冲回放的异步分发回调（门面传 ``_replay_connect_buffered`` 形态）——
  回放经 ``asyncio.ensure_future`` 异步进行，回调隔离在分发协程内。
"""
from __future__ import annotations

import asyncio

from chat.event_translate import ChatEventTranslator
from integration.openclaw.wire.values import OnEvent, RouteDecision


class RunEventRouter:
    """runId 事件路由 + 翻译 + 终态清理 + 缓冲按就绪过滤（门面内部组合，单向依赖 门面→协作者）。

    入站帧先经 :meth:`classify` 得 ``RouteDecision``（决定段，不回读写路由/缓冲），门面据
    ``kind`` 接线执行（审批 fan-out / runId 分发 / 恢复窗口缓冲 / 丢弃）；跨桶执行段由门面编排。
    """

    def __init__(
        self,
        *,
        translator: ChatEventTranslator,
        fanout,
        dispatch_frames,
    ) -> None:
        self._routes: dict[str, OnEvent] = {}
        self._translator = translator
        # 连接级审批帧 fan-out 回调（ApprovalFanout.fanout，构造注入避免协作者互引）。
        self._fanout = fanout
        # 缓冲回放的异步分发回调（_replay_connect_buffered 形态：逐帧经 _handle 分发）。
        self._dispatch_frames = dispatch_frames
        # 恢复泵期缓冲的 event 帧——泵只消费 res，event 缓冲待路由就绪后由 _resolve_ack 注册路由时回放
        # （重连期到达的进行中 run 事件不丢）。
        self._connect_buffered: list[dict] = []
        # live-wire resume（resume_active_session）恢复窗口标志。浏览器腿重连复用**存活池化 client**
        # （不经 connect()，无恢复泵）时，_recv_loop 持续消费入站帧；恢复 RPC（messages.subscribe +
        # chat.history）完成前该会话 in-flight run 的路由尚未安装，dequeued 的 run-scoped 帧会被
        # 本类以「route 未就绪」静默丢弃（终态帧被丢则 run 永无完成帧）。窗口内 run-scoped 帧改走
        # recovery_buffered 缓冲，路由重建后由 flush_recovery_buffered 回放。
        self._recovering: bool = False
        # live-wire resume 窗口缓冲的 run-scoped 帧。
        self._recovery_buffered: list[dict] = []

    @property
    def routes(self) -> dict[str, OnEvent]:
        """runId 路由表（门面经委托 property ``_routes`` 直读；RecoveryCoordinator 经注入重建路由）。"""
        return self._routes

    @property
    def translator(self) -> ChatEventTranslator:
        """事件翻译器（RecoveryCoordinator 经注入做 seed_sent / extract_history_text）。"""
        return self._translator

    def set_recovering(self, flag: bool) -> None:
        """置 live-wire resume 恢复窗口标志（RecoveryCoordinator 经注入回调置位）。"""
        self._recovering = flag

    def buffer_connect_event(self, msg: dict) -> None:
        """恢复泵期缓冲一帧 event（路由未就绪，待路由注册时回放）。"""
        self._connect_buffered.append(msg)

    def classify(self, msg: dict) -> RouteDecision:
        """入站 chat 事件帧 → 路由决定（原门面 ``_classify_incoming``，#271/#273 值对象骨架）。

        决定段与执行段分离：本方法只算 ``RouteDecision``（不读写路由/缓冲状态），门面据 ``kind``
        接线（审批 fan-out / 恢复窗口缓冲 / runId 路由分发 / 丢弃）。
        """
        frames = self._translator.translate(msg)
        if not frames:
            return RouteDecision(kind='dropped')
        run_id = frames[0].get('runId')
        if run_id is None:
            # 连接级帧（T06 审批卡 + 网关 resolved 事件）：不挂 runId,fan-out 到所有审批订阅者,不进 runId 路由
            return RouteDecision(kind='approval', frames=tuple(frames))
        if self._recovering and run_id not in self._routes:
            return RouteDecision(kind='buffered', run_id=run_id)
        if run_id not in self._routes:
            return RouteDecision(kind='dropped', run_id=run_id)  # route 已 discard，丢弃整批帧
        return RouteDecision(kind='routed', frames=tuple(frames), run_id=run_id)

    async def handle(self, msg: dict) -> None:
        """一帧入站 **event** 帧的完整路由（原门面 ``_handle`` 的 event 分支）：classify → 按 kind 接线。

        ``res`` 帧走回执结算，由门面 ``_handle`` 分流到 ``_resolve_ack``（RequestRouter 桶），不经
        本方法——recv_loop 与 connect 泵共用本方法分发事件。
        """
        decision = self.classify(msg)
        if decision.kind == 'approval':
            # 连接级帧（T06 审批卡 + 网关 resolved 事件）：不挂 runId,fan-out 到所有审批订阅者,不进 runId 路由
            for translated in decision.frames:
                if translated.get('type') not in ('approval', 'approvalResolved'):
                    continue
                await self._fanout(translated)
            return
        if decision.kind == 'buffered':
            # codex #249 R5 (id 3690750256)：live-wire resume 恢复窗口（路由重建前），该 run 的帧
            # 不能分发——route 未就绪即被静默丢弃（终态帧被丢则 run 永无完成帧）。缓冲，
            # 待 _replay_projection 安装路由后由 flush_recovery_buffered 回放（对齐 connect_buffered
            # 的同一不丢帧语义）。窗口内仅 run-scoped 帧缓冲；连接级帧已走上方 fan-out，不经此分支。
            self._recovery_buffered.append(msg)
            return
        if decision.kind == 'dropped':
            return  # 不可翻译 / route 已 discard，丢弃整批帧
        # routed：runId 路由分发 + 终态清理。cb 一次性捕获（classify 已验路由存在），
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

    def drop(self, run_id: str) -> None:
        """discard：移除 runId 路由（consumer 断开时调用）。"""
        self._routes.pop(run_id, None)

    def snapshot_routes(self) -> list[tuple[str, OnEvent]]:
        """返回 runId 路由表快照（不修改路由表）——aclose 推终态 error 帧用。

        原门面 ``_notify_all_error`` 先 ``list(self._routes.items())`` 遍历后 ``clear()``；快照
        与清空分离，清空由调用方经 ``routes.clear()`` 完成（与 recv-loop 清理幂等）。
        """
        return list(self._routes.items())

    def flush_connect_buffered(self) -> None:
        """#217：把恢复泵期缓冲的 event 帧逐个分发（路由已注册后调用）。

        缓冲帧可能属恢复重建的 inFlightRun 或本次 send_message 的 runId——路由就绪后回放不丢帧。
        同步取快照清空后由调用方异步分发（_resolve_ack 是同步方法，回放经 asyncio.ensure_future）。

        codex #236 R4 P1：**按路由就绪过滤**再回放——多会话恢复时，第一会话采用 inFlightRun 后
        flush 若清空整个连接级缓冲，会把第二会话已到达、路由尚未重建的 run 事件一并弹给 handle
        （cb is None 永久丢弃）。故只弹「路由已注册的 run 事件 + 连接级事件（fan-out 不需路由）」，
        其余保留缓冲，等其路由重建（后续会话 _replay_projection / 后续 send ack）时再 flush。
        """
        if not self._connect_buffered:
            return
        keep: list[dict] = []
        drain: list[dict] = []
        for msg in self._connect_buffered:
            frames = self._translator.translate(msg)
            # 不可翻译帧（frames 空）归 drain——handle 对它们本来就是 no-op（translate 确定性，
            # 现在不可翻译以后也不可翻译），与旧行为一致地消费掉；连接级帧（runId None）同 drain。
            run_id = frames[0].get('runId') if frames else None
            if run_id is None or run_id in self._routes:
                drain.append(msg)  # 连接级帧 / 不可翻译帧 / 路由已就绪：立即可回放
            else:
                keep.append(msg)  # 路由未重建（如第二会话）：保留待其就绪后回放
        self._connect_buffered = keep
        if drain:
            asyncio.ensure_future(self._dispatch_frames(drain))

    def flush_recovery_buffered(self) -> None:
        """codex #249 R5 (id 3690750256)：回放 live-wire resume 窗口缓冲的 run-scoped 帧。

        resume_active_session 恢复窗口内 handle 把路由未就绪的 run 帧缓冲到 recovery_buffered；
        本方法在 _replay_projection 装好路由后调用，经 handle 分发（路由已注册 → 正常路由）。
        连接级帧不走此缓冲（handle 已 fan-out）；缓冲帧路由仍未就绪则保留等下次 flush（对齐
        flush_connect_buffered 的按就绪过滤）。异步回放不阻塞调用方。
        """
        if not self._recovery_buffered:
            return
        keep: list[dict] = []
        drain: list[dict] = []
        for msg in self._recovery_buffered:
            frames = self._translator.translate(msg)
            run_id = frames[0].get('runId') if frames else None
            if run_id in self._routes:
                drain.append(msg)
            else:
                keep.append(msg)
        self._recovery_buffered = keep
        if drain:
            asyncio.ensure_future(self._dispatch_frames(drain))

    def flush_connection_level_buffered(self) -> None:
        """#217 / codex #236 P2-419：恢复完成后回放泵期缓冲的**连接级** event 帧（approval /
        approvalResolved——fan-out 到审批订阅者，不需 runId 路由）。

        原先缓冲仅「采用 inFlightRun」或「后续 send ack 注册路由」两路回放——无活跃会话 / 无可采用
        run 时连接级帧滞留到无关的未来 send 才浮现（审批卡迟到/丢失）。此处兜底只弹**连接级**帧；
        **run-scoped 帧留在缓冲**待路由注册（send ack / inFlightRun 重建）时回放——否则恢复完成后
        路由未就绪即回放会被 handle 丢弃（cb is None），重连期进行中 run 的输出反被本兜底弄丢。
        """
        if not self._connect_buffered:
            return
        keep: list[dict] = []
        drain: list[dict] = []
        for msg in self._connect_buffered:
            frames = self._translator.translate(msg)
            (drain if frames and frames[0].get('runId') is None else keep).append(msg)
        self._connect_buffered = keep
        if drain:
            asyncio.ensure_future(self._dispatch_frames(drain))
