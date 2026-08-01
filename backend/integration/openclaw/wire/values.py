"""OpenClaw wire 客户端共享类型与值对象（issue #271/#273）。

``wire_client`` 门面与其内部协作者（``RecoveryCoordinator`` / ``ApprovalFanout``）共享的类型
收口本模块（叶子，无反向依赖）——避免协作者拆到独立模块后与门面互相 import 成环。包名
``wire`` 无下划线，符合「包名禁下划线」约定（呼应 ``OpenClawWire`` Port）。

内容：on_event 回调契约（``OnEvent``）、history 投影命名空间（``HISTORY_RUN_ID``）、
inFlightRun 投影值对象（``RecoveredRun``）、以及 #273 引入的跨桶决定值对象
（``AckOutcome`` / ``RouteDecision``，frozen dataclass）——门面 ``_resolve_ack`` / ``_handle``
先算决定、后接线，为后续段把计算移进 ``RequestRouter`` / ``RunEventRouter`` 铺平。
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

# on_event 回调契约：接收翻译后的前端契约帧（text/done/error）
OnEvent = Callable[[dict], Awaitable[None]]

# #217 T4：恢复回放时 history 投影用的 runId 命名空间——与真实 runId 隔离，前端按
# 「historyRunId → 整段替换」应用（replace 语义），不与进行中 run 的 runId 冲突。
HISTORY_RUN_ID = '__history__'


@dataclass(frozen=True)
class RecoveredRun:
    """#217 步3 采用的进行中 run 投影（不可变值对象）。

    ``text`` 为网关缓冲的已产文本（**即使为空也采用**——空 text 也重建路由恢复事件流）；
    ``plan`` 为可选 systemRunPlan（透传，前端展示计划卡）。"""
    run_id: str
    text: str
    plan: dict | None


@dataclass(frozen=True)
class AckOutcome:
    """chat.send ack 的跨桶决定（值对象骨架，issue #271/#273）。

    #273 拆出 RequestRouter 前先立骨架：``_resolve_ack`` 先经 ``_ack_outcome`` 算出本值对象
    （决定段），门面据其接线（回执 future / 注册路由 / 触发恢复桶 flush）。RequestRouter
    拆出后由它回返本对象、门面接线——解开 ``_resolve_ack`` 死结的载体。

    ``run_id`` 非空 = ack ok 且带 runId（路由已可注册）；``error`` 非空 = 网关拒绝 / ack 缺
    runId（set_exception）；两者皆空 = 不应发生（防御性 no-op）。
    """
    run_id: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class RouteDecision:
    """入站 chat 事件帧的路由决定（值对象骨架，issue #271/#273）。

    #273 拆出 RunEventRouter 前先立骨架：``_handle`` 先经 ``_classify_incoming`` 算出本值对象
    （决定段），门面据 ``kind`` 接线（审批 fan-out / 恢复窗口缓冲 / runId 路由分发 / 丢弃）。
    RunEventRouter 拆出后由它回返本对象、门面接线——解开 ``_handle`` 死结的载体。

    ``kind``：
    - ``'approval'``：连接级审批帧（``frames`` 为翻译后审批卡，fan-out 不需路由）
    - ``'buffered'``：恢复窗口期 run-scoped 帧且路由未就绪（缓冲待路由重建后回放）
    - ``'routed'``：runId 路由分发 + 终态清理（``frames`` 为翻译后帧）
    - ``'dropped'``：不可翻译 / 路由已 discard（丢弃整批）
    """
    kind: str
    frames: tuple[dict, ...] = ()
    run_id: str | None = None
