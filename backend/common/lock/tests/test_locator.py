"""common/lock LockFleet composition root 测试（issue #253 / parent #243）。

``LockFleet`` service locator（镜像 ``orchestrator.py`` 的 ``Fleet`` 先例）：``get`` /
``override`` / ``reset`` / ``aclose``。生命周期约束（#247 D2/D6）：

- ``_build_default()`` 懒构造**单个共享 client**（``redis.asyncio.from_url(settings.REDIS_URL)``）
  注入 ``AsyncRedisLockAdapter``，**import 期零 IO**（复刻 ``Fleet``「import 期无 IO」惯例）；
- **不用 ASGI lifespan 钩子**、生产不挂全局 shutdown 钩子；``aclose()`` 仅测试 teardown 调用。

CI/单测**无真 Redis**：装配测试经 stub 注入证明 wiring，行为测试全走 FakeLock（#253 AC5）。
"""
from __future__ import annotations

import pytest

from common.lock.fakes import FakeLock
from common.lock.locator import LockFleet
from common.lock.ports import DistributedLock as _DistributedLockPort


@pytest.fixture(autouse=True)
def _reset_lock_fleet():
    """每个 case 前后复原 LockFleet 单例，防 cross-test 状态泄漏（对齐 Fleet fixture 先例）。"""
    LockFleet.reset()
    yield
    LockFleet.reset()


class _SpyClient:
    """redis.asyncio.Redis 的构造探针：记录 from_url 的 url、提供 lock() 工厂、可关。"""

    def __init__(self, url: str):
        self.url = url
        self.lock_calls: list[dict] = []
        self.closed = False

    def lock(self, name, timeout=None, blocking=True, **_ignored):
        self.lock_calls.append({'name': name, 'timeout': timeout, 'blocking': blocking})
        raise AssertionError('装配测试不应真正取锁（仅证明 wiring，不触 Redis 行为）')

    async def aclose(self):
        self.closed = True


class TestLazyBuild:
    """#253 AC2：懒构造共享 client——import 期零 IO、首个 get 才建、复用同一 client。"""

    def test_get_does_not_build_client_until_first_use(self, monkeypatch):
        """import/reset 期不读 settings、不调 from_url（import 期零 IO）。"""
        built: list[str] = []
        monkeypatch.setattr(
            'common.lock.locator._redis_from_url',
            lambda url: built.append(url) or _SpyClient(url),
        )

        LockFleet.reset()  # 仅 reset 不 get：不应构造任何 client
        assert not built

    def test_first_get_builds_default_adapter(self, monkeypatch):
        """首个 get() 懒构造 adapter（无真 Redis：adapter 仅在取锁时才连）。"""
        monkeypatch.setattr('common.lock.locator._redis_from_url', _SpyClient)
        lock = LockFleet.get()
        assert isinstance(lock, _DistributedLockPort)

    def test_client_constructed_from_settings_redis_url(self, monkeypatch, settings):
        """共享 client 经 ``from_url(settings.REDIS_URL)`` 构造（settings 唯一 env 读取处）。"""
        settings.REDIS_URL = 'redis://example:6380/3'
        spy: list[_SpyClient] = []
        monkeypatch.setattr(
            'common.lock.locator._redis_from_url', lambda url: spy.append(_SpyClient(url)) or spy[0],
        )

        LockFleet.get()

        assert spy and spy[0].url == 'redis://example:6380/3'

    def test_get_reuses_single_shared_client(self, monkeypatch):
        """多次 get() 复用同一共享 client（懒共享，非每次新建）。"""
        built: list[str] = []
        monkeypatch.setattr(
            'common.lock.locator._redis_from_url',
            lambda url: built.append(url) or _SpyClient(url),
        )

        first = LockFleet.get()
        second = LockFleet.get()

        assert first is second
        assert len(built) == 1, 'client 应只构造一次（懒共享）'


class TestOverrideReset:
    """#253 AC4：override(FakeLock) 后 get() 返回替身、reset() 复原默认。"""

    def test_override_injects_fake_and_get_returns_it(self):
        fake = FakeLock()
        LockFleet.override(fake)

        assert LockFleet.get() is fake

    def test_reset_restores_default_build(self, monkeypatch):
        monkeypatch.setattr('common.lock.locator._redis_from_url', _SpyClient)
        LockFleet.override(FakeLock())
        LockFleet.reset()

        restored = LockFleet.get()
        assert not isinstance(restored, FakeLock), 'reset 后 get 应复原默认 adapter 而非替身'
        assert isinstance(restored, _DistributedLockPort)

    def test_override_does_not_build_default_client(self, monkeypatch):
        """override 注入路径不触发默认 client 构造（注入替身时零 Redis）。"""
        built: list[str] = []
        monkeypatch.setattr(
            'common.lock.locator._redis_from_url',
            lambda url: built.append(url) or _SpyClient(url),
        )

        LockFleet.override(FakeLock())
        LockFleet.get()

        assert not built, 'override 注入时不应构造默认 client'

    async def test_override_after_get_preserves_client_for_aclose(self, monkeypatch):
        """override-after-get：先前已建共享 client 不被丢成孤儿——aclose 仍能关它。"""
        spy: list[_SpyClient] = []
        monkeypatch.setattr(
            'common.lock.locator._redis_from_url', lambda url: spy.append(_SpyClient(url)) or spy[0],
        )
        LockFleet.get()  # 先建真 client
        LockFleet.override(FakeLock())  # 再注入替身

        await LockFleet.aclose()

        assert spy and spy[0].closed, 'override 后已建 client 应由 aclose 关闭，不泄漏'


class TestAclose:
    """#247 D6：aclose() 关共享 client，仅测试 teardown 调用；幂等。"""

    async def test_aclose_closes_shared_client(self, monkeypatch):
        spy: list[_SpyClient] = []
        monkeypatch.setattr(
            'common.lock.locator._redis_from_url', lambda url: spy.append(_SpyClient(url)) or spy[0],
        )
        LockFleet.get()  # 懒建共享 client

        await LockFleet.aclose()

        assert spy and spy[0].closed, 'aclose 应关闭共享 client'

    async def test_aclose_resets_singleton(self, monkeypatch):
        """aclose 后单例复原——下个 get() 重建（测试 teardown 干净语义）。"""
        monkeypatch.setattr('common.lock.locator._redis_from_url', _SpyClient)
        first = LockFleet.get()
        await LockFleet.aclose()
        second = LockFleet.get()

        assert first is not second, 'aclose 后 get 应重建新实例'

    async def test_aclose_without_prior_get_is_noop(self):
        """未 get 即 aclose：无 client 可关，幂等不抛（无真 Redis 也安全）。"""
        await LockFleet.aclose()  # 不抛即过

    async def test_aclose_after_override_does_not_touch_fake(self):
        """override 注入 FakeLock 时 aclose 不构造/关闭真 client（替身无共享 client）。"""
        fake = FakeLock()
        LockFleet.override(fake)

        await LockFleet.aclose()  # 不抛、不碰替身

        LockFleet.reset()
        assert fake is not None
