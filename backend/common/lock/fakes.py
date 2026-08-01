"""common.lock 的内存 fake（issue #251 / parent #243）。

``FakeLock`` 同构 DistributedLock Port 全契约：内存 dict 模拟 TTL/持有者、记录调用，
复刻 integration/openclaw/fakes.py 的 FakeOpenClawWire 先例（#98 范式）。测试经
``LockFleet.override(FakeLock)``（locator，下游 #253）或构造注入使用，不依赖真 Redis。

同构契约（租约语义折叠进 TTL+renew）：acquire / try_acquire / renew / release。
- 租约存 ``_held: dict[LockResource, _LeaseEntry(expires_at, handle)]``——expires_at 单一
  真值源在 entry，handle 只持身份（同一 lock 下 entry.handle is self 方为持有者）；
- 租约随 TTL 到期自动失效（不 resurrect）；
- acquire 阻塞：被他人持有则等待释放/过期后再获取（以 event-loop yield 轮询）；
- try_acquire 非阻塞：被持有（未过期）返回 None；
- release 幂等且只释放自己的租约；renew 未持有 / 已过期 / 已被新 handle 顶替 no-op；
- 闭锁 LockResource tagged union——只收 ``(ProvisionResource, PairingResource)`` 变体，
  裸 string / int / 其它带 kind 标记的类一律抛 TypeError（防 KV 逃逸口 #246 Q6，闭合性
  落到具体变体而非结构 Protocol——新增资源变体须同步登记到此闭合元组，否则测试即红）。
"""
from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from datetime import timedelta

from common.lock.ports import (
    LeaseHandle,
    LockResource,
    PairingResource,
    ProvisionResource,
    SyncLeaseHandle,
)

# 闭合 tagged union 的具体变体集合：FakeLock 运行时只认这两个（防 KV 逃逸口 #246 Q6）。
# 新增资源用途（新增 LockResource 变体）须同步登记到此元组，否则 FakeLock 抛 TypeError。
_RESOURCE_VARIANTS = (ProvisionResource, PairingResource)


@dataclass
class _LeaseEntry:
    """一条持有中的租约：TTL 到期时间 + 持有 handle（expires_at 单一真值源）。"""

    expires_at: float
    handle: FakeLeaseHandle


class FakeLeaseHandle:
    """LeaseHandle Port 的内存 fake：续约/释放转发到 FakeLock 并记录到 lock 上。"""

    def __init__(self, lock: FakeLock, resource: LockResource) -> None:
        self._lock = lock
        self._resource = resource
        self._released = False

    async def renew(self, new_ttl: timedelta) -> None:
        """续租：仍持有且未过期则延长 TTL；否则 no-op（不 resurrect 锁）。"""
        if not self._released and self._lock._is_held(self._resource, self):
            entry = self._lock._held[self._resource]
            entry.expires_at = self._lock._now() + new_ttl.total_seconds()
        self._lock.renew_calls.append((self._resource, new_ttl))

    async def release(self) -> None:
        """释放租约（幂等）；只释放自己的租约，不误伤已被新 handle 顶替的条目。"""
        already_released = self._released
        if not already_released:
            self._released = True
            entry = self._lock._held.get(self._resource)
            if entry is not None and entry.handle is self:
                self._lock._held.pop(self._resource, None)
        self._lock.release_calls.append((self._resource, already_released))


class FakeLock:
    """DistributedLock Port 的内存 fake：dict 模拟 TTL/持有者 + 记录全部四类调用。

    测试经 ``lock.acquire_calls`` / ``try_acquire_calls`` / ``renew_calls`` /
    ``release_calls`` 断言调用与参数（对齐 FakeOpenClawWire 的调用记录先例）。
    """

    def __init__(self) -> None:
        self._held: dict[LockResource, _LeaseEntry] = {}
        # 测试可读的调用记录：acquire/try_acquire/renew 为 (resource, ttl) 对；
        # release 为 (resource, was_already_released) 对。
        self.acquire_calls: list[tuple[LockResource, timedelta]] = []
        self.try_acquire_calls: list[tuple[LockResource, timedelta]] = []
        self.renew_calls: list[tuple[LockResource, timedelta]] = []
        self.release_calls: list[tuple[LockResource, bool]] = []

    @staticmethod
    def _now() -> float:
        return asyncio.get_running_loop().time()

    @staticmethod
    def _validate_resource(resource: LockResource) -> None:
        """防 KV 逃逸口（#246 Q6）：只收闭合 tagged union 的具体变体，绝收裸 string。

        用 ``type(resource)`` 精确变体检查（非 isinstance）——子类也拒绝，与生产
        adapter 的 ``_KEY_BUILDERS.get(type(resource))`` 对齐（codex P2）。
        """
        if type(resource) not in _RESOURCE_VARIANTS:
            raise TypeError(
                'resource 必须为闭合 LockResource tagged union'
                f'（{"/".join(v.__name__ for v in _RESOURCE_VARIANTS)}），'
                f'收到 {type(resource).__name__}',
            )

    def _is_held(self, resource: LockResource, handle: FakeLeaseHandle) -> bool:
        entry = self._held.get(resource)
        return entry is not None and entry.handle is handle and entry.expires_at > self._now()

    def _claim(self, resource: LockResource, ttl: timedelta) -> FakeLeaseHandle:
        handle = FakeLeaseHandle(self, resource)
        self._held[resource] = _LeaseEntry(self._now() + ttl.total_seconds(), handle)
        return handle

    async def acquire(self, resource: LockResource, ttl: timedelta) -> LeaseHandle:
        """阻塞获取租约：被他人持有（未过期）则等待释放/过期后再获取。"""
        self._validate_resource(resource)
        self.acquire_calls.append((resource, ttl))
        while True:
            entry = self._held.get(resource)
            if entry is None or entry.expires_at <= self._now():
                break
            await asyncio.sleep(0)  # 让出事件循环，等持有方 release/租约过期
        return self._claim(resource, ttl)

    async def try_acquire(self, resource: LockResource, ttl: timedelta) -> LeaseHandle | None:
        """非阻塞获取租约：已被持有（未过期）返回 None。"""
        self._validate_resource(resource)
        self.try_acquire_calls.append((resource, ttl))
        entry = self._held.get(resource)
        if entry is not None and entry.expires_at > self._now():
            return None
        return self._claim(resource, ttl)


class FakeLockSync:
    """DistributedLock Port 的**线程安全**内存 fake（sync 形态，issue #254）。

    #254 裁决：sync 侧是同一 Port 契约的 threading 形态，不做独立契约——acquire 阻塞
    语义用 ``threading.Event``（有界等待，非空转轮询）；租约随 TTL 自动过期、不 resurrect；
    renew 无返回值（对齐 async renew 契约）；release 幂等且只释放自己的租约。
    与 FakeLock 同构：内存 dict 模拟 TTL/持有者 + 记录调用。测试经
    ``LockFleet.override(FakeLockSync, sync=True)`` 或构造注入使用。
    """

    def __init__(self) -> None:
        self._mutex = threading.RLock()
        self._held: dict[LockResource, tuple[float, FakeLockSyncLease]] = {}
        self.acquire_calls: list[tuple[LockResource, timedelta]] = []
        self.try_acquire_calls: list[tuple[LockResource, timedelta]] = []
        self.renew_calls: list[tuple[LockResource, timedelta]] = []
        self.release_calls: list[tuple[LockResource, bool]] = []

    @staticmethod
    def _now() -> float:
        return time.monotonic()

    @staticmethod
    def _validate_resource(resource: LockResource) -> None:
        """防 KV 逃逸口（#246 Q6）：只收闭合 tagged union 的具体变体，绝收裸 string。

        用 ``type(resource)`` 精确变体检查（非 isinstance）——子类也拒绝，与生产
        adapter 的 ``_KEY_BUILDERS.get(type(resource))`` 对齐（codex P2）。
        """
        if type(resource) not in _RESOURCE_VARIANTS:
            raise TypeError(
                'resource 必须为闭合 LockResource tagged union'
                f'（{"/".join(v.__name__ for v in _RESOURCE_VARIANTS)}），'
                f'收到 {type(resource).__name__}',
            )

    def _entry_live(self, entry) -> bool:
        return entry[0] > self._now()

    def _is_held(self, resource: LockResource, handle) -> bool:
        """身份 + 过期检查（供 renew 的修前竞态复现测试 monkeypatch，见 test_contract.py）。

        renew 现已在持 ``_mutex`` 时原子完成身份 + 过期检查（#254 / codex P2），本方法
        不再被生产路径调用；保留为 test_contract.py 中 codex #4 红测试的 monkeypatch
        目标（模拟「锁外判定通过、锁内已过期」的修前 TOCTOU 窗口）。
        """
        entry = self._held.get(resource)
        return entry is not None and entry[1] is handle and self._entry_live(entry)

    def _claim(self, resource: LockResource, ttl: timedelta) -> FakeLockSyncLease:
        handle = FakeLockSyncLease(self, resource)
        self._held[resource] = (self._now() + ttl.total_seconds(), handle)
        return handle

    def acquire(self, resource: LockResource, ttl: timedelta) -> SyncLeaseHandle:
        """阻塞获取租约：被他人持有（未过期）则等待释放/过期后再获取（Event 有界等待）。

        等待上限取**当前持有租约的剩余生命周期**（``entry.expires_at - now``），而非
        contender 请求 TTL（#254 / codex P2）：持有者剩余 20ms、contender 请求 60s 时，
        等满 60s 会让锁已过期仍阻塞——与 Redis adapter（按持有者剩余轮询）背离、测试
        挂死。``max(0.05, ...)`` 保底防 0 超时忙转；显式 release 仍经 Event 即时唤醒。

        ``_waiters`` 集合的所有访问（add/discard/迭代）都在持 ``_mutex`` 时完成（#254 /
        codex P2）：修前 finally 里锁外 ``discard`` 与 ``release`` 锁外 ``list()`` 并发会
        ``RuntimeError: Set changed size during iteration``（线程安全 fake 的 release 失败）。
        """
        self._validate_resource(resource)
        with self._mutex:
            self.acquire_calls.append((resource, ttl))
        while True:
            with self._mutex:
                entry = self._held.get(resource)
                if entry is None or not self._entry_live(entry):
                    return self._claim(resource, ttl)
                waiter = threading.Event()
                entry[1]._waiters.add(waiter)
                # 剩余生命周期（此刻起的绝对等待上限）；release 会提前 set 唤醒
                wait_timeout = max(0.05, entry[0] - self._now())
            try:
                if not waiter.wait(timeout=wait_timeout):
                    continue  # 等待超时（未 release）→ 重查（租约可能已过期）
            finally:
                with self._mutex:
                    entry[1]._waiters.discard(waiter)

    def try_acquire(self, resource: LockResource, ttl: timedelta) -> SyncLeaseHandle | None:
        """非阻塞获取租约：已被持有（未过期）返回 None。"""
        self._validate_resource(resource)
        with self._mutex:
            self.try_acquire_calls.append((resource, ttl))
            entry = self._held.get(resource)
            if entry is not None and self._entry_live(entry):
                return None
            return self._claim(resource, ttl)


class FakeLockSyncLease:
    """LeaseHandle Port 的 sync fake：续约/释放转发到 FakeLockSync 并记录调用。

    持一个 ``threading.Event`` 集合（``_waiters``）：release 时 set 唤醒阻塞 acquire。
    """

    def __init__(self, lock: FakeLockSync, resource: LockResource) -> None:
        self._lock = lock
        self._resource = resource
        self._released = False
        self._waiters: set[threading.Event] = set()

    def renew(self, new_ttl: timedelta) -> None:
        """续租：仍持有且未过期则延长 TTL；否则 no-op（不 resurrect 锁）。

        **身份 + 过期检查在持 ``_mutex`` 时一次完成**（#254 / codex P2）：修前先锁外
        ``_is_held()`` 再锁内只做身份检查——两检查间租约过期且无竞争者替换 entry 时，
        会在过期后 renew 成功（违反不 resurrect 契约）。原子化后过期租约绝不被复活。
        """
        with self._lock._mutex:
            entry = self._lock._held.get(self._resource)
            if (
                not self._released
                and entry is not None
                and entry[1] is self
                and self._lock._entry_live(entry)
            ):
                self._lock._held[self._resource] = (
                    self._lock._now() + new_ttl.total_seconds(), self,
                )
        self._lock.renew_calls.append((self._resource, new_ttl))

    def release(self) -> None:
        """释放租约（幂等）；只释放自己的租约，并唤醒所有阻塞 acquire。

        ``_waiters`` 快照与移除都在持 ``_mutex`` 时完成（#254 / codex P2）：修前锁外
        ``list(self._waiters)`` 迭代与 ``acquire`` 超时锁外 ``discard`` 并发会
        ``RuntimeError: Set changed size during iteration``。
        """
        already_released = self._released
        if not already_released:
            self._released = True
            with self._lock._mutex:
                entry = self._lock._held.get(self._resource)
                if entry is not None and entry[1] is self:
                    self._lock._held.pop(self._resource, None)
                # 锁内快照 + 清空：唤醒列表与并发 acquire 的 add/discard 互斥
                waiters = list(self._waiters)
                self._waiters.clear()
            for waiter in waiters:
                waiter.set()
        self._lock.release_calls.append((self._resource, already_released))
