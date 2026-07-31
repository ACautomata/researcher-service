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

from redis.asyncio import from_url as _redis_from_url

from common.lock.adapters import AsyncRedisLockAdapter
from common.lock.ports import DistributedLock


class LockFleet:
    """``DistributedLock`` 单例 service locator（调用点经 get() 取锁；测试用 override 注入 fake）。

    lazy 构造（首个 get 才读 settings + 建共享 client），import 期无 IO/无 Redis 连接。
    """

    _lock: DistributedLock | None = None
    # 共享 redis.asyncio client（懒建；默认路径持有）。override 注入替身时不清它——已建 client
    # 留待 aclose() 关闭，防 override-after-get 泄漏真连接。
    _client = None

    @classmethod
    def get(cls) -> DistributedLock:
        """取 ``DistributedLock``（默认装配 ``AsyncRedisLockAdapter`` + 懒共享 client）。"""
        if cls._lock is None:
            cls._lock = cls._build_default()
        return cls._lock

    @classmethod
    def override(cls, lock: DistributedLock) -> None:
        """测试注入替身（FakeLock）。

        注入路径不构造新默认 client；但保留任何先前已建共享 client 在 ``_client`` 上，
        由 ``aclose()`` 负责关闭——防 override-after-get 把真连接丢成孤儿。
        """
        cls._lock = lock

    @classmethod
    def reset(cls) -> None:
        """复原单例（不关闭已共享 client——关 client 走 aclose()；测试先行 aclose 再 reset）。"""
        cls._lock = None
        cls._client = None

    @classmethod
    async def aclose(cls) -> None:
        """关闭共享 client 并复原单例。**仅测试 teardown 调用**（生产不挂全局 shutdown 钩子）。

        幂等：未 get（无共享 client）或 override 注入替身（无共享 client）时为 no-op。
        """
        client, cls._client, cls._lock = cls._client, None, None
        if client is not None:
            await client.aclose()

    @classmethod
    def _build_default(cls) -> DistributedLock:
        """懒构造默认 ``AsyncRedisLockAdapter`` + 单个共享 client（settings.REDIS_URL 唯一读取处）。

        ``redis.asyncio.from_url`` 只建连接池、不握手——**import/reset 期零 IO**，首个 get 才建
        （连接池到首个 Redis 命令才触网）。单节点**无需 Redlock**（#248）。
        """
        from django.conf import settings

        cls._client = _redis_from_url(settings.REDIS_URL)
        return AsyncRedisLockAdapter(cls._client)
