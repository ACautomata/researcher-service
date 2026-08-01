"""连接级审批订阅 fan-out 协作者（issue #271/#273，T06 / spec §8.2）。

exec/plugin.approval.requested 不挂 runId，是**连接级广播**——多 consumer 共享同一 pooled
client 时须 fan-out 到所有订阅者（不可单槽覆盖）。consumer start 时 add 注册、disconnect 时
remove 独立退订（codex P1）。门面构造注入本协作者，审批面方法（注册/退订/枚举/广播）在门面
改为薄委托；协作者只持订阅集合 + fan-out 分发，不引用门面（单向依赖 门面→协作者）。
"""
from __future__ import annotations

from integration.openclaw.wire.values import OnEvent


class ApprovalFanout:
    """连接级审批订阅者集合的 fan-out（codex P1，多订阅者不可单槽覆盖）。"""

    def __init__(self) -> None:
        self._subscribers: list[OnEvent] = []

    def add(self, cb: OnEvent) -> None:
        """注册连接级审批订阅者（codex P1）：多 consumer 共享 client 时各自独立注册。"""
        if cb not in self._subscribers:
            self._subscribers.append(cb)

    def remove(self, cb: OnEvent) -> None:
        """退订指定订阅者（codex P1）：只移除自己，不误伤同 client 其他 consumer 的订阅。"""
        if cb in self._subscribers:
            self._subscribers.remove(cb)

    def subscribers(self) -> list[OnEvent]:
        """返回当前全部审批订阅者的副本（codex #219 P2：共享 client 自愈迁移用）。

        consumer 自愈换 client 时须把**所有**订阅者（不止触发自愈的那个 consumer）迁到
        新 client，否则被动 consumer 仍挂在死 client 上、错过新连接上的审批。返回副本
        防调用方直接改内部列表。
        """
        return list(self._subscribers)

    async def fanout(self, frame: dict) -> None:
        """把一帧连接级审批帧 fan-out 到所有订阅者；隔离单订阅者回调失败（不杀 recv loop / 不互伤）。"""
        for cb in list(self._subscribers):
            try:
                await cb(frame)
            except Exception:  # pylint: disable=broad-exception-caught
                pass

    async def broadcast_resolved(self, approval_id: str, decision: str) -> None:
        """把一次权威 resolve 结果 fan-out 到全部订阅者（codex R2 P2）：共享 client 的各 consumer 卡片一致收敛。

        仅广播**真实发生**的 resolve 回执（权威 decision），不伪造网关 resolved 事件；REST 路径经
        pool client 调本方法，WS 路径由 consumer 在 resolve 成功后调，保证所有渲染副本同步落定。
        """
        await self.fanout({'type': 'approvalResolved', 'id': approval_id, 'decision': decision})
