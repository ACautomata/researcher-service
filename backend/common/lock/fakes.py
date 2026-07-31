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
from dataclasses import dataclass
from datetime import timedelta

from common.lock.ports import LeaseHandle, LockResource, PairingResource, ProvisionResource

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
        """防 KV 逃逸口（#246 Q6）：只收闭合 tagged union 的具体变体，绝收裸 string。"""
        if not isinstance(resource, _RESOURCE_VARIANTS):
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
