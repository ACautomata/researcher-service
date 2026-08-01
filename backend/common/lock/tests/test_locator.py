"""common/lock LockFleet composition root 测试（issue #253 / parent #243）。

``LockFleet`` service locator（镜像 ``orchestrator.py`` 的 ``Fleet`` 先例）：``get`` /
``override`` / ``reset`` / ``aclose``。生命周期约束（#247 D2/D6）：

- ``_build_default()`` 懒构造**单个共享 client**（``redis.asyncio.from_url(settings.REDIS_URL)``）
  注入 ``AsyncRedisLockAdapter``，**import 期零 IO**（复刻 ``Fleet``「import 期无 IO」惯例）；
- **不用 ASGI lifespan 钩子**、生产不挂全局 shutdown 钩子；``aclose()`` 仅测试 teardown 调用。

CI/单测**无真 Redis**：装配测试经 stub 注入证明 wiring，行为测试全走 FakeLock（#253 AC5）。
"""
from __future__ import annotations

import threading
import time

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
    """redis.asyncio.Redis 的构造探针：记录 from_url 的 url、提供 lock() 工厂、可关。

    async 形态持 ``aclose()``（``redis.asyncio.Redis``），sync 形态持 ``close()``
    （``redis.Redis``）——两类探针都记录关闭次数，供 aclose 分槽断言。
    """

    def __init__(self, url: str):
        self.url = url
        self.lock_calls: list[dict] = []
        self.aclose_calls = 0
        self.close_calls = 0

    def lock(self, name, timeout=None, blocking=True, **_ignored):
        self.lock_calls.append({'name': name, 'timeout': timeout, 'blocking': blocking})
        raise AssertionError('装配测试不应真正取锁（仅证明 wiring，不触 Redis 行为）')

    async def aclose(self):
        self.aclose_calls += 1

    def close(self):
        self.close_calls += 1


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

        assert spy and spy[0].aclose_calls == 1, 'override 后已建 async client 应由 aclose 关闭，不泄漏'


class TestSyncSlot:
    """#254 AC：sync 槽位（get(sync=True)/override(lock, sync=True)）独立于 async 槽位。

    sync 侧是同一 Port 的 threading 形态——locator 需为 sync 调用点（orchestrator/pairing）
    提供独立装配，不串扰 async 槽（不假装一个 asyncio Lock 服务 sync 线程，#247 D3）。
    """

    def test_get_sync_builds_sync_adapter(self, monkeypatch):
        from common.lock.adapters import SyncRedisLockAdapter

        class _FakeRedis:
            @staticmethod
            def from_url(url):
                return _SpyClient(url)

        monkeypatch.setattr('common.lock.locator._Redis', _FakeRedis)
        lock = LockFleet.get(sync=True)

        assert isinstance(lock, SyncRedisLockAdapter)

    def test_get_sync_uses_redis_from_url(self, monkeypatch, settings):
        """sync 槽懒建共享 client 经 ``Redis.from_url(settings.REDIS_URL)``（settings 唯一读取处）。"""
        settings.REDIS_URL = 'redis://example:6380/3'
        spy: list[_SpyClient] = []

        class _FakeRedis:
            @staticmethod
            def from_url(url):
                spy.append(_SpyClient(url))
                return spy[0]

        monkeypatch.setattr('common.lock.locator._Redis', _FakeRedis)

        LockFleet.get(sync=True)

        assert spy and spy[0].url == 'redis://example:6380/3'

    def test_sync_slot_reuses_single_client(self, monkeypatch):
        built: list[_SpyClient] = []

        class _FakeRedis:
            @staticmethod
            def from_url(url):
                built.append(_SpyClient(url))
                return built[0]

        monkeypatch.setattr('common.lock.locator._Redis', _FakeRedis)

        first = LockFleet.get(sync=True)
        second = LockFleet.get(sync=True)

        assert first is second
        assert len(built) == 1, 'sync client 应只构造一次（懒共享）'

    def test_override_sync_injects_fake_and_get_returns_it(self):
        from common.lock.fakes import FakeLockSync

        fake = FakeLockSync()
        LockFleet.override(fake, sync=True)

        assert LockFleet.get(sync=True) is fake

    def test_sync_and_async_slots_are_independent(self):
        """async 与 sync 槽互不串扰：override sync 不影响 async get，反之亦然。"""
        from common.lock.fakes import FakeLock, FakeLockSync

        fake_async = FakeLock()
        fake_sync = FakeLockSync()
        LockFleet.override(fake_async)  # async 槽
        LockFleet.override(fake_sync, sync=True)  # sync 槽

        assert LockFleet.get() is fake_async
        assert LockFleet.get(sync=True) is fake_sync

    def test_override_sync_does_not_build_default_client(self, monkeypatch):
        built: list[_SpyClient] = []

        class _FakeRedis:
            @staticmethod
            def from_url(url):
                built.append(_SpyClient(url))
                return built[0]

        monkeypatch.setattr('common.lock.locator._Redis', _FakeRedis)
        from common.lock.fakes import FakeLockSync

        LockFleet.override(FakeLockSync(), sync=True)
        LockFleet.get(sync=True)

        assert not built, 'override 注入时不应构造默认 client'

    async def test_aclose_closes_sync_client(self, monkeypatch):
        spy: list[_SpyClient] = []

        class _FakeRedis:
            @staticmethod
            def from_url(url):
                spy.append(_SpyClient(url))
                return spy[0]

        monkeypatch.setattr('common.lock.locator._Redis', _FakeRedis)
        LockFleet.get(sync=True)

        await LockFleet.aclose()

        assert spy and spy[0].close_calls == 1, 'aclose 应关闭 sync 共享 client'

    async def test_aclose_closes_both_slots(self, monkeypatch):
        spy: list[_SpyClient] = []

        class _FakeRedis:
            @staticmethod
            def from_url(url):
                spy.append(_SpyClient(url))
                return spy[-1]

        monkeypatch.setattr('common.lock.locator._Redis', _FakeRedis)
        monkeypatch.setattr(
            'common.lock.locator._redis_from_url', lambda url: spy.append(_SpyClient(url)) or spy[-1],
        )
        LockFleet.get()  # async 槽 → spy[0]
        LockFleet.get(sync=True)  # sync 槽 → spy[1]

        await LockFleet.aclose()

        assert len(spy) == 2
        # 分槽关闭：async client 走 aclose()、sync client 走 close()（互不错调）
        assert spy[0].aclose_calls == 1 and spy[0].close_calls == 0, 'async client 应走 aclose()'
        assert spy[1].close_calls == 1 and spy[1].aclose_calls == 0, 'sync client 应走 close()'


class TestSyncLazyBuildThreadSafety:
    """#254 / codex P2：sync 懒构造首次并发调用是线程安全的。

    两个 threadpool 调用方并发首个 ``get(sync=True)`` 时，若都看到 ``_sync_lock is None``
    会各自建 client——``_sync_lock`` 与 ``_sync_client`` 可能指向不同实例，``aclose()``
    关错池、真 client 泄漏（codex 意见 #2）。懒构造需线程安全 once。
    """

    async def test_concurrent_first_get_sync_builds_exactly_one_client(self, monkeypatch):
        """并发首个 get(sync=True)：只建一个共享 client，且 lock 与 client 同实例。"""
        built: list[_SpyClient] = []
        gate = threading.Barrier(2)
        results: list[tuple] = []
        errors: list[BaseException] = []

        class _FakeRedis:
            @staticmethod
            def from_url(url):
                built.append(_SpyClient(url))
                time.sleep(0.03)  # 扩宽首构窗口：两线程都进 from_url 后再返回，触发并发建 client
                return built[-1]

        monkeypatch.setattr('common.lock.locator._Redis', _FakeRedis)

        def _first_get():
            try:
                gate.wait(timeout=2)  # 尽量同时触发首次构造
                lock = LockFleet.get(sync=True)
                results.append((lock, LockFleet._sync_client))
            except BaseException as exc:  # 测试线程捕获，断言阶段统一上报
                errors.append(exc)

        threads = [threading.Thread(target=_first_get) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=3)

        assert not errors, f'并发首构不应抛异常：{errors}'
        assert not any(t.is_alive() for t in threads)
        assert len(built) == 1, f'sync client 应只构造一次（并发首构），实际 {len(built)} 个'

        # 关键：lock 与其共享 client 必须同实例，aclose 才关对池
        assert all(lock is results[0][0] for lock, _ in results), '并发 get(sync=True) 应返回同一 lock'
        assert all(client is results[0][1] for _, client in results), '并发调用应共享同一 client'


class TestAclose:
    """#247 D6：aclose() 关共享 client，仅测试 teardown 调用；幂等。"""

    async def test_aclose_closes_shared_client(self, monkeypatch):
        spy: list[_SpyClient] = []
        monkeypatch.setattr(
            'common.lock.locator._redis_from_url', lambda url: spy.append(_SpyClient(url)) or spy[0],
        )
        LockFleet.get()  # 懒建共享 client

        await LockFleet.aclose()

        assert spy and spy[0].aclose_calls == 1, 'aclose 应关闭共享 client'

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


class TestAcloseSyncSlot:
    """#254 / codex P2：aclose() 对 sync 槽位走 ``close()``（sync client 无 aclose()）。

    ``redis.Redis``（sync）只有 ``close()``，``aclose()`` 是 ``redis.asyncio.Redis`` 才有——
    aclose() 若对所有 client 统一 ``await client.aclose()``，真 sync client 会
    ``AttributeError`` 且连接池泄漏（codex 意见 #1）。sync 槽位必须分槽清理。
    """

    @staticmethod
    def _install_sync_fake_redis(monkeypatch, spy: list):
        """monkeypatch ``locator._Redis`` 为返回真 sync 形态探针的工厂（无 aclose()）。"""

        class _SyncSpyClient(_SpyClient):
            """模拟 redis.Redis sync client：只有 close()，**没有 aclose()**。"""

            async def aclose(self):  # 故意制造 AttributeError（真 sync client 无此方法）
                raise AttributeError('redis.Redis has no aclose')

        class _FakeRedis:
            @staticmethod
            def from_url(url):
                spy.append(_SyncSpyClient(url))
                return spy[-1]

        monkeypatch.setattr('common.lock.locator._Redis', _FakeRedis)

    async def test_aclose_closes_sync_client_with_close_not_aclose(self, monkeypatch):
        """sync 槽 aclose 必须走 close()——统一 aclose() 会因 sync client 无此方法而 AttributeError。"""
        spy: list = []
        self._install_sync_fake_redis(monkeypatch, spy)
        LockFleet.get(sync=True)

        await LockFleet.aclose()  # 修复前：AttributeError（sync client 无 aclose）

        assert spy and spy[0].close_calls == 1, 'sync client 应经 close() 关闭'
        assert spy[0].aclose_calls == 0, 'sync client 不应走 aclose()'

    async def test_aclose_closes_async_with_aclose_and_sync_with_close(self, monkeypatch):
        """双槽 aclose 分槽：async 走 aclose()、sync 走 close()（互不错调）。"""
        async_spy: list = []
        monkeypatch.setattr(
            'common.lock.locator._redis_from_url', lambda url: async_spy.append(_SpyClient(url)) or async_spy[0],
        )
        sync_spy: list = []
        self._install_sync_fake_redis(monkeypatch, sync_spy)
        LockFleet.get()  # async 槽
        LockFleet.get(sync=True)  # sync 槽

        await LockFleet.aclose()

        assert async_spy and async_spy[0].aclose_calls == 1 and async_spy[0].close_calls == 0
        assert sync_spy and sync_spy[0].close_calls == 1 and sync_spy[0].aclose_calls == 0
