"""common/lock 的真 Redis Adapter（issue #253 / parent #243）。

``AsyncRedisLockAdapter`` 经 ``redis.asyncio`` 自带 asyncio Lock（SET NX PX + Lua 安全
释放，#248；单节点**无需 Redlock**）实现 T1 定义的窄 ``DistributedLock`` Port（#246 唯一
Port）。**async-only**（#247 D3）：仅供 async 上下文（chat/pool/consumers）；sync 调用点
（orchestrator/pairing threadpool）桥接由 T4（#254）另行设计——不设双 sync+async adapter。

**防 KV 逃逸口（两层都要，#246 Q6）：**
1. 类型化 resource：只收闭合 ``LockResource`` tagged union 的具体变体，绝收裸 string——
   运行时分派 ``kind`` tag 构造 Redis 键；外来类/裸串抛 ``TypeError``。
2. 窄 lock-only 签名：Port 面仅 ``acquire``/``try_acquire``（``renew``/``release`` 在
   ``LeaseHandle`` 上），无 get/set/通用 KV；Redis 键由 ``_key_for`` 内部构造、永不外泄给调用方。

**注入式 client**：构造收一个 ``redis.asyncio.Redis``-compatible client（只用其 ``lock()``
工厂面），由 ``LockFleet`` 懒共享注入；本模块自身**不连网**——``lock()`` 只是构造 Lock
对象，首个 Redis 命令（acquire 的 SET NX PX）才触网。
"""
from __future__ import annotations

from datetime import timedelta

from redis.exceptions import LockError, LockNotOwnedError

from common.lock.ports import LeaseHandle, LockResource, PairingResource, ProvisionResource

# 闭合 tagged union 的运行时键构造表（防 KV 逃逸口 #246 Q6）：变体 → 取键函数
# （``lock:<kind>:<identifier>``）。adapter 运行时只认这两个具体变体——新增资源用途（新增
# LockResource 变体）须在此登记一行，否则 adapter 抛 TypeError（闭合性落到具体变体而非结构
# Protocol，与 fakes.py 同约定）。键是 adapter 内部细节，不外泄给调用方。
_KEY_BUILDERS = {
    ProvisionResource: lambda r: f'lock:provision:{r.container_name}',
    PairingResource: lambda r: f'lock:pairing:{r.instance_id}',
}


class _RedisLeaseHandle:
    """LeaseHandle Port 的 Redis 实现：compose 一个 redis.asyncio Lock（持有方 token）。

    续约/释放转发到底层 Lock 的 Lua CAS 原语：
    - ``renew(new_ttl)`` → ``extend(new_ttl, replace_ttl=True)`` 仍持有才重置 TTL；过期/被
      顶替抛 ``LockNotOwnedError``，吞掉成 no-op（不 resurrect 锁）；
    - ``release()`` → ``release()`` Lua 安全释放（CAS 比对 token，只释放自己的锁）；过期被
      顶替抛 ``LockNotOwnedError``，吞掉成幂等 no-op。幂等由本 handle 的 ``_released`` 标记
      保证二次调用不再触网。
    """

    def __init__(self, redis_lock) -> None:
        self._redis_lock = redis_lock
        self._released = False

    async def renew(self, new_ttl: timedelta) -> None:
        """续租：仍持有则把 TTL 重置为 ``new_ttl``；过期/被顶替 no-op（不 resurrect）。"""
        if self._released:
            return
        try:
            await self._redis_lock.extend(
                new_ttl.total_seconds(), replace_ttl=True,
            )
        except (LockNotOwnedError, LockError):
            # 锁已过期 / 已被他人顶替 / 已不持有：不 resurrect（对齐 FakeLock 语义）。
            pass

    async def release(self) -> None:
        """释放租约（幂等）；Lua 安全释放只删自己 token，过期被顶替不误删新持有者。"""
        if self._released:
            return
        self._released = True
        try:
            await self._redis_lock.release()
        except (LockNotOwnedError, LockError):
            # 已过期被顶替 / 已不持有：幂等 no-op（不抛给调用方）。
            pass


class AsyncRedisLockAdapter:
    """``DistributedLock`` Port 的真 Redis Adapter（async-only，#247 D3）。

    收一个 ``redis.asyncio.Redis``-compatible client（只用 ``lock()`` 工厂面），经
    ``client.lock(name, timeout=ttl)`` 取自带 asyncio Lock 实现 SET NX PX + Lua 安全释放。
    键由 ``_key_for`` 内部构造（``lock:<kind>:<id>``）、永不外泄；无 get/set/通用 KV。
    """

    def __init__(self, client) -> None:
        self._client = client

    @staticmethod
    def _key_for(resource: LockResource) -> str:
        """由资源构造 Redis 键（``lock:<kind>:<identifier>``）；键是内部细节，不外泄。

        查 ``_KEY_BUILDERS`` 闭合表——未登记的变体（裸 string / 外来类）抛 ``TypeError``
        （防 KV 逃逸口 #246 Q6）。
        """
        build = _KEY_BUILDERS.get(type(resource))
        if build is None:
            variants = '/'.join(v.__name__ for v in _KEY_BUILDERS)
            raise TypeError(
                f'resource 必须为闭合 LockResource tagged union（{variants}），'
                f'收到 {type(resource).__name__}',
            )
        return build(resource)

    async def acquire(self, resource: LockResource, ttl: timedelta) -> LeaseHandle:
        """阻塞获取租约（SET NX PX 重试至取得）；TTL 崩溃自动过期、释放互斥。"""
        redis_lock = self._client.lock(
            self._key_for(resource), timeout=ttl.total_seconds(),
        )
        await redis_lock.acquire()  # blocking=True 默认：SET NX PX 重试至取得
        return _RedisLeaseHandle(redis_lock)

    async def try_acquire(self, resource: LockResource, ttl: timedelta) -> LeaseHandle | None:
        """非阻塞获取租约：已被他人持有（未过期）返回 None。"""
        redis_lock = self._client.lock(
            self._key_for(resource), timeout=ttl.total_seconds(),
        )
        acquired = await redis_lock.acquire(blocking=False)
        if not acquired:
            return None
        return _RedisLeaseHandle(redis_lock)
