"""common/lock 的 composition root / service locator（issue #253 / parent #243）。

``LockFleet`` 是 ``DistributedLock`` 的装配根：镜像 ``orchestrator.py`` 的 ``Fleet``
先例（``get``/``override``/``reset``），供调用点取锁、测试注入 ``FakeLock``。

**生命周期约束（#247 D2/D6）：**
- ``_build_default()`` 懒构造**单个共享 client**（``redis.asyncio.from_url(settings.REDIS_URL)``）
  注入 ``AsyncRedisLockAdapter``；**import 期零 IO**——``from_url`` 只建连接池不握手，且仅在
  首个 ``get()`` 才调（复刻 ``Fleet``「import 期无 IO」惯例）。
- **不用 ASGI lifespan 钩子**（repo 无 lifespan、``ProtocolTypeRouter`` 默认无 lifespan 协议、
  违背 lazy 惯例）、生产不挂全局 shutdown 钩子（懒创建 + 进程退出即释放，对齐
  ``ChatConnectionPool.aclose_all()`` 现状）。
- ``aclose()`` 关共享 client 并复原单例，**仅测试 fixture/teardown 调用**。

**测试注入（#253 AC4）：** ``override(FakeLock)`` 后 ``get()`` 返回替身、``reset()`` 复原；
CI/单测默认**无真 Redis**——行为测试全走 FakeLock，真 Redis 仅可选集成 smoke。
"""
from __future__ import annotations

import threading

from redis import Redis as _Redis
from redis.asyncio import from_url as _redis_from_url

from common.lock.adapters import AsyncRedisLockAdapter, SyncRedisLockAdapter
from common.lock.ports import DistributedLock, SyncDistributedLock


class LockFleet:
    """``DistributedLock`` / ``SyncDistributedLock`` 单例 service locator（镜像 ``Fleet`` 先例）。

    **两个独立槽位**（issue #254 / parent #243）：
    - async 槽：``get()`` / ``override(lock)``——chat/pool/consumers 用（AsyncRedisLockAdapter）；
    - sync 槽：``get(sync=True)`` / ``override(lock, sync=True)``——orchestrator/pairing
      threadpool 用（SyncRedisLockAdapter）。**不互耦**：各自懒建共享 client（async 走
      redis.asyncio、sync 走 redis.Redis），override 只换对应槽位、不串扰另一侧。

    生命周期约束（#247 D2/D6）：lazy 构造（首个 get 才读 settings + 建共享 client），
    import 期零 IO、无 lifespan/全局 shutdown 钩子；``aclose()`` 关全部共享 client 并复原
    单例，仅测试 teardown 调用。
    """

    _lock: DistributedLock | None = None
    _sync_lock: SyncDistributedLock | None = None
    # 共享 client（懒建；默认路径持有）。override 注入替身时不清——已建 client 留待
    # aclose() 关闭，防 override-after-get 泄漏真连接。async 与 sync 各一。
    _client = None
    _sync_client = None
    # sync 懒构造的线程安全 once（#254 / codex P2）：threadpool 调用方并发首个
    # get(sync=True) 时，双检锁保证只建一个共享 client，`_sync_lock`/`_sync_client`
    # 始终指向同一实例（async 槽由事件循环单线程访问，无需此锁）。aclose()/reset()
    # 不复位此锁——它们仅测试 teardown 调用（不并发生产 get），持锁重查可容忍
    # 清空后的重建。
    _sync_init_lock = threading.Lock()

    @classmethod
    def get(cls, *, sync: bool = False) -> DistributedLock | SyncDistributedLock:
        """取 ``DistributedLock``（默认 async；sync=True 取 sync 形态的锁）。

        async 槽默认装配 ``AsyncRedisLockAdapter`` + 懒共享 redis.asyncio client；
        sync 槽默认装配 ``SyncRedisLockAdapter`` + 懒共享 redis.Redis client。
        """
        if sync:
            if cls._sync_lock is None:
                # 双检锁（#254 / codex P2）：threadpool 并发首个构造时，持锁重查避免
                # 各建一个 client。锁只保护构造；已建后走无锁快路径（get 高频）。
                with cls._sync_init_lock:
                    if cls._sync_lock is None:
                        cls._sync_lock = cls._build_sync_default()
            return cls._sync_lock
        if cls._lock is None:
            cls._lock = cls._build_default()
        return cls._lock

    @classmethod
    def override(cls, lock, *, sync: bool = False) -> None:
        """测试注入替身（FakeLock 走 sync=False；FakeLockSync 走 sync=True）。

        注入路径不构造新默认 client；但保留任何先前已建共享 client 在对应槽位上，
        由 ``aclose()`` 负责关闭——防 override-after-get 把真连接丢成孤儿。
        """
        if sync:
            cls._sync_lock = lock
        else:
            cls._lock = lock

    @classmethod
    def reset(cls) -> None:
        """复原单例（不关闭已共享 client——关 client 走 aclose()；测试先行 aclose 再 reset）。"""
        cls._lock = None
        cls._sync_lock = None
        cls._client = None
        cls._sync_client = None

    @classmethod
    async def aclose(cls) -> None:
        """关闭全部共享 client 并复原单例。**仅测试 teardown 调用**（生产不挂全局钩子）。

        幂等：未 get（无共享 client）或 override 注入替身（无共享 client）时为 no-op。

        **分槽关闭（#254 / codex P2）：** async client（``redis.asyncio.Redis``）走
        ``await aclose()``，sync client（``redis.Redis``）走 ``close()``——统一
        ``aclose()`` 会让真 sync client 抛 ``AttributeError`` 且连接池泄漏。
        """
        # 先清单例再关 client：aclose 途中并发 get 不会拿到「已标记关闭」的 client。
        cls._lock = None
        cls._sync_lock = None
        async_client = cls._client
        sync_client = cls._sync_client
        cls._client = None
        cls._sync_client = None
        if async_client is not None:
            await async_client.aclose()
        if sync_client is not None:
            sync_client.close()

    @classmethod
    def _build_default(cls) -> DistributedLock:
        """懒构造 async 默认 adapter + 单个共享 redis.asyncio client（settings.REDIS_URL 读取处）。

        ``redis.asyncio.from_url`` 只建连接池、不握手——**import/reset 期零 IO**，首个 get
        才建（连接池到首个 Redis 命令才触网）。单节点**无需 Redlock**（#248）。
        """
        from django.conf import settings

        cls._client = _redis_from_url(settings.REDIS_URL)
        return AsyncRedisLockAdapter(cls._client)

    @classmethod
    def _build_sync_default(cls) -> SyncDistributedLock:
        """懒构造 sync 默认 adapter + 单个共享 redis.Redis client（settings.REDIS_URL 读取处）。

        ``Redis.from_url`` 只建连接池、不握手——**import/reset 期零 IO**，首个 get
        才建。单节点**无需 Redlock**（#248）。
        """
        from django.conf import settings

        cls._sync_client = _Redis.from_url(settings.REDIS_URL)
        return SyncRedisLockAdapter(cls._sync_client)
