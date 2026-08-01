"""common/lock AsyncRedisLockAdapter 行为测试（issue #253 / parent #243）。

**无真 Redis**（#253 AC5）：经 ``_RecordingRedisClient`` stub 注入 adapter——它复刻
redis.asyncio Lock 的公开契约面（token 化 acquire/release/extend + Lua CAS 语义），
但内存模拟、记录全部 Redis 交互。断言的是**可观察行为**而非 Redis 内部：

- SET NX PX 语义——blocking acquire 重试至取得、非阻塞 try_acquire 被持有即 None；
- TTL 经 ``redis.lock(..., timeout=ttl)`` 注入（PX），**不经** SET 字符串拼接；
- 键由 adapter 内部构造（LockResource → ``lock:<kind>:<id>``），**不外泄**给调用方；
- release 幂等且只释放自己 token；renew → extend 仍持有、过期/被顶替 no-op（不 resurrect）；
- 闭锁 LockResource——裸 string / 外来类抛 TypeError（防 KV 逃逸口 #246 Q6）；
- 无 get/set/通用 KV 逃逸口（结构性 guard，Port 仅 acquire/try_acquire）。
"""
from __future__ import annotations

import asyncio
import itertools
import threading
import time
import uuid
from datetime import timedelta

import pytest
from redis.asyncio.lock import Lock as _RedisLock
from redis.exceptions import LockError, LockNotOwnedError

from common.lock.adapters import AsyncRedisLockAdapter, SyncRedisLockAdapter
from common.lock.ports import (
    DistributedLock as _DistributedLockPort,
)
from common.lock.ports import (
    PairingResource,
    ProvisionResource,
)
from common.lock.ports import (
    SyncDistributedLock as _SyncDistributedLockPort,
)


class _StubRedisLock:
    """redis.asyncio Lock 的内存 stub：token 化 SET NX PX + Lua CAS 语义，记录交互。

    与真 Lock 同一公开契约面（acquire/release/extend + timeout），但键/过期/持有者由
    宿主 ``_RecordingRedisClient._store`` 内存维护——测试不连真 Redis。
    """

    def __init__(self, client, name, timeout=None, blocking=True):
        self._client = client
        self.name = name
        self.timeout = timeout  # 租约 TTL（秒），由 client.lock(timeout=) 注入
        self.blocking = blocking
        self.token = None

    async def acquire(self, blocking=None, blocking_timeout=None, token=None):
        token = uuid.uuid1().hex.encode() if token is None else token
        blocking = self.blocking if blocking is None else blocking
        stop_at = (
            None
            if blocking_timeout is None
            else asyncio.get_running_loop().time() + blocking_timeout
        )
        while True:
            if self._client._claim_nx(self.name, token, self.timeout):
                self.token = token
                return True
            if not blocking:
                return False
            if stop_at is not None and asyncio.get_running_loop().time() > stop_at:
                return False
            await asyncio.sleep(0.001)

    async def release(self):
        if self.token is None:
            raise LockError('Cannot release a lock that is not owned')
        # Lua 安全释放：CAS 比对 token，非自己 token 抛 LockNotOwnedError。
        if not self._client._release_cas(self.name, self.token):
            self.token = None
            raise LockNotOwnedError('Cannot release a lock that is no longer owned')
        self.token = None

    async def extend(self, additional_time, replace_ttl=False):
        if self.token is None:
            raise LockError('Cannot extend an unlocked lock')
        # Lua 续约：仍持有自己 token 才重置 TTL，否则 LockNotOwnedError（不 resurrect）。
        if not self._client._extend_cas(self.name, self.token, float(additional_time)):
            raise LockNotOwnedError('Cannot extend a lock that is no longer owned')
        return True


class _RecordingRedisClient:
    """``redis.asyncio.Redis`` 的内存 stub：``lock()`` 工厂 + 内存键存储 + 调用记录。

    ``lock(name, timeout=, blocking=)`` 返回 ``_StubRedisLock``；``_store`` 为
    ``{name: (token, expires_at)}``，单进程内模拟 SET NX PX 互斥。测试可读 ``lock_calls``
    断言键构造与 TTL 注入。
    """

    def __init__(self):
        self._store: dict[str, tuple[bytes, float]] = {}
        self.lock_calls: list[dict] = []
        self._monotonic = itertools.count()  # 占位：真实时钟用 event-loop time

    @staticmethod
    def _now() -> float:
        return asyncio.get_running_loop().time()

    def lock(self, name, timeout=None, blocking=True, **_ignored):
        """复刻 ``Redis.lock`` 工厂签名（**零网络 IO**）；记录 name/timeout。"""
        self.lock_calls.append({'name': name, 'timeout': timeout, 'blocking': blocking})
        return _StubRedisLock(self, name, timeout=timeout, blocking=blocking)

    # ---- SET NX PX / Lua CAS 语义的内存模拟（stub 内部，非 Port 面） ----
    def _claim_nx(self, name, token, timeout) -> bool:
        """SET NX PX：键缺失或已过期才写入（NX），写则带过期（PX=timeout）。"""
        entry = self._store.get(name)
        if entry is not None and entry[1] > self._now():
            return False  # 被他人持有（未过期）：NX 拒绝
        expires_at = float('inf') if timeout is None else self._now() + float(timeout)
        self._store[name] = (token, expires_at)
        return True

    def _release_cas(self, name, token) -> bool:
        """Lua 安全释放 CAS：token 匹配才删键；不匹配（含已被他人顶替）返回 False。"""
        entry = self._store.get(name)
        if entry is None or entry[0] != token:
            return False
        self._store.pop(name, None)
        return True

    def _extend_cas(self, name, token, additional_time) -> bool:
        """Lua 续约 CAS：token 匹配且未过期才重置 TTL；否则 False（不 resurrect）。"""
        entry = self._store.get(name)
        if entry is None or entry[0] != token or entry[1] <= self._now():
            return False
        self._store[name] = (token, self._now() + additional_time)
        return True


def _adapter_with_stub_client() -> tuple[AsyncRedisLockAdapter, _RecordingRedisClient]:
    client = _RecordingRedisClient()
    return AsyncRedisLockAdapter(client), client


class TestAsyncRedisLockAdapterContract:
    """#253 AC1：adapter 经 redis.asyncio Lock 实现 T1 Port 全契约（行为断言，无真 Redis）。"""

    async def test_adapter_satisfies_port(self):
        adapter, _ = _adapter_with_stub_client()
        assert isinstance(adapter, _DistributedLockPort), (
            'AsyncRedisLockAdapter 应满足 DistributedLock Port'
        )

    async def test_try_acquire_returns_lease_handle(self):
        adapter, _ = _adapter_with_stub_client()
        handle = await adapter.try_acquire(
            ProvisionResource('gw-a'), ttl=timedelta(seconds=60),
        )
        assert handle is not None

    async def test_second_try_acquire_on_held_resource_returns_none(self):
        adapter, _ = _adapter_with_stub_client()
        await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        assert await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is None

    async def test_acquire_blocks_until_release_then_succeeds(self):
        """blocking acquire：被持有期间等待，持有方 release 后取得（SET NX PX 阻塞语义）。"""
        adapter, _ = _adapter_with_stub_client()
        holder = await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        async def _blocked():
            await asyncio.sleep(0.02)
            return await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        task = asyncio.create_task(_blocked())
        await asyncio.sleep(0.01)
        assert not task.done()

        await holder.release()
        second = await task
        assert second is not None
        await second.release()

    async def test_acquire_unblocks_when_lease_expires(self):
        """blocking acquire 在持有租约 TTL 过期后自动取得（TTL 崩溃安全语义）。"""
        adapter, _ = _adapter_with_stub_client()
        await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(milliseconds=10))

        async def _blocked():
            await asyncio.sleep(0.05)
            return await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        task = asyncio.create_task(_blocked())
        await asyncio.sleep(0.01)
        assert not task.done()

        second = await task
        assert second is not None
        await second.release()

    async def test_distinct_resources_do_not_conflict(self):
        adapter, _ = _adapter_with_stub_client()
        await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        pairing_handle = await adapter.try_acquire(
            PairingResource(instance_id=7), ttl=timedelta(seconds=60),
        )
        assert pairing_handle is not None

    async def test_same_kind_different_id_do_not_conflict(self):
        """同 kind 不同 id 的键不互斥（键含资源标识符）。"""
        adapter, _ = _adapter_with_stub_client()
        await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        assert await adapter.try_acquire(
            ProvisionResource('gw-b'), ttl=timedelta(seconds=60),
        ) is not None

    async def test_release_frees_resource(self):
        adapter, _ = _adapter_with_stub_client()
        handle = await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))
        assert await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is None

        await handle.release()

        assert await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is not None

    async def test_release_is_idempotent(self):
        adapter, _ = _adapter_with_stub_client()
        handle = await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        await handle.release()
        await handle.release()  # 二次释放幂等，不抛

        assert await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is not None

    async def test_release_only_own_token(self):
        """Lua 安全释放：过期被他人顶替后，旧 handle 的 release 不误删新持有者的锁。"""
        adapter, _ = _adapter_with_stub_client()
        stale = await adapter.acquire(
            ProvisionResource('gw-a'), ttl=timedelta(milliseconds=10),
        )
        await asyncio.sleep(0.02)  # stale 租约过期
        fresh = await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        await stale.release()  # 旧 handle：token 已不匹配，no-op 不抛

        # fresh 仍持有——stale.release 不得误删
        assert await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is None
        await fresh.release()

    async def test_renew_extends_lease(self):
        adapter, _ = _adapter_with_stub_client()
        handle = await adapter.acquire(
            ProvisionResource('gw-a'), ttl=timedelta(milliseconds=30),
        )
        await asyncio.sleep(0.02)
        await handle.renew(timedelta(seconds=60))  # 仍持有：续期成功

        await asyncio.sleep(0.02)  # 原 TTL 早已过，但续期生效仍持有
        assert await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is None
        await handle.release()

    async def test_renew_after_expiry_is_noop(self):
        adapter, _ = _adapter_with_stub_client()
        handle = await adapter.acquire(
            ProvisionResource('gw-a'), ttl=timedelta(milliseconds=10),
        )
        await asyncio.sleep(0.02)

        await handle.renew(timedelta(seconds=60))  # 已过期：不 resurrect

        assert await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is not None

    async def test_renew_after_superseded_is_noop(self):
        adapter, _ = _adapter_with_stub_client()
        first = await adapter.acquire(
            ProvisionResource('gw-a'), ttl=timedelta(milliseconds=10),
        )
        await asyncio.sleep(0.02)
        second = await adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        await first.renew(timedelta(seconds=300))  # 已被顶替：no-op 不复活

        assert await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is None
        await second.release()


class TestKeyConstruction:
    """#253 AC1：Redis 键由 adapter 内部构造、TTL 经 timeout 注入、键不外泄。"""

    async def test_ttl_injected_via_lock_timeout(self):
        """TTL 经 ``client.lock(..., timeout=ttl_seconds)``（PX）注入，不经字符串拼接。"""
        adapter, client = _adapter_with_stub_client()
        await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=90))

        assert client.lock_calls[0]['timeout'] == pytest.approx(90.0)

    async def test_key_constructed_from_resource_kind_and_identifier(self):
        """键内部构造：``lock:provision:<name>`` / ``lock:pairing:<id>``（不外泄给调用方）。"""
        adapter, client = _adapter_with_stub_client()
        await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))
        await adapter.try_acquire(PairingResource(instance_id=7), ttl=timedelta(seconds=60))

        names = {call['name'] for call in client.lock_calls}
        assert names == {'lock:provision:gw-a', 'lock:pairing:7'}

    async def test_key_not_leaked_to_caller(self):
        """LeaseHandle 的公开面不暴露 Redis 键（防 KV 逃逸口：键永不外泄）。"""
        adapter, _ = _adapter_with_stub_client()
        handle = await adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        for public in ('name', 'key', 'resource_key'):
            assert not hasattr(handle, public), f'键不应经 .{public} 外泄'
        await handle.release()

    async def test_no_kv_escape_hatch(self):
        """Port 面仅 acquire/try_acquire——无 get/set/通用 KV 逃逸口（结构性 guard）。"""
        adapter, _ = _adapter_with_stub_client()
        for kv in ('get', 'set', 'delete', 'setex', 'setnx', 'expire'):
            assert not hasattr(adapter, kv), f'adapter 不应暴露 KV 方法 .{kv}'


class TestClosedResourceValidation:
    """#246 Q6：闭锁 LockResource tagged union——裸 string / 外来类抛 TypeError。"""

    async def test_bare_string_resource_rejected(self):
        adapter, _ = _adapter_with_stub_client()
        with pytest.raises(TypeError):
            await adapter.try_acquire('gw-a', ttl=timedelta(seconds=60))  # type: ignore[arg-type]
        with pytest.raises(TypeError):
            await adapter.acquire('gw-a', ttl=timedelta(seconds=60))  # type: ignore[arg-type]

    async def test_foreign_class_with_kind_attribute_rejected(self):
        adapter, _ = _adapter_with_stub_client()

        class ForeignResource:
            kind = 'foreign'

        with pytest.raises(TypeError):
            await adapter.try_acquire(ForeignResource(), ttl=timedelta(seconds=60))  # type: ignore[arg-type]

    async def test_validation_happens_before_any_redis_interaction(self):
        """校验在任何 Redis 交互前抛错（非法 resource 不产生 lock 调用）。"""
        adapter, client = _adapter_with_stub_client()
        with pytest.raises(TypeError):
            await adapter.try_acquire('gw-a', ttl=timedelta(seconds=60))  # type: ignore[arg-type]

        assert not client.lock_calls


class TestAdapterUsesRedisAsyncioLock:
    """#253 AC1：adapter 经 ``redis.asyncio`` 自带 asyncio Lock 实现（非自研 KV/Lua）。"""

    def test_client_lock_factory_yields_redis_lock_objects(self):
        """adapter 经 client.lock() 取 redis.asyncio Lock（SET NX PX + Lua 安全释放实现侧）。

        用真 ``Redis`` 客户端（**不连网**——lock() 只是构造 Lock 对象，零 IO）证明 adapter
        走的正是 redis.asyncio 自带 Lock，而非自造互斥原语。
        """
        pytest.importorskip('redis.asyncio')
        from redis.asyncio import Redis

        client = Redis.from_url('redis://localhost:6379/0')
        lock = client.lock('lock:provision:gw-a', timeout=60)
        assert isinstance(lock, _RedisLock), 'client.lock() 应返回 redis.asyncio Lock'


# ---- #254 sync 形态：SyncRedisLockAdapter 行为（threading stub client，无真 Redis） ----

class _SyncStubRedisLock:
    """redis.Redis Lock 的内存 stub（sync 形态）：token 化 SET NX PX + Lua CAS 语义。

    与 async 侧 ``_StubRedisLock`` 同一契约面（acquire/release/extend），但同步阻塞——
    测试不连真 Redis。acquire(blocking=True) 循环轮询直至取得（模拟 redis-py 阻塞语义）。
    """

    def __init__(self, client, name, timeout=None, blocking=True):
        self._client = client
        self.name = name
        self.timeout = timeout
        self.blocking = blocking
        self.token = None

    def acquire(self, blocking=None, blocking_timeout=None, token=None):
        token = uuid.uuid1().hex.encode() if token is None else token
        blocking = self.blocking if blocking is None else blocking
        stop_at = (
            None if blocking_timeout is None else time.monotonic() + blocking_timeout
        )
        while True:
            if self._client._claim_nx(self.name, token, self.timeout):
                self.token = token
                return True
            if not blocking:
                return False
            if stop_at is not None and time.monotonic() > stop_at:
                return False
            time.sleep(0.001)

    def release(self):
        if self.token is None:
            raise LockError('Cannot release a lock that is not owned')
        if not self._client._release_cas(self.name, self.token):
            self.token = None
            raise LockNotOwnedError('Cannot release a lock that is no longer owned')
        self.token = None

    def extend(self, additional_time, replace_ttl=False):
        if self.token is None:
            raise LockError('Cannot extend an unlocked lock')
        if not self._client._extend_cas(self.name, self.token, float(additional_time)):
            raise LockNotOwnedError('Cannot extend a lock that is no longer owned')
        return True


class _SyncRecordingRedisClient:
    """redis.Redis 的内存 stub：``lock()`` 工厂 + 内存键存储 + 调用记录（sync 形态）。"""

    def __init__(self):
        self._store: dict[str, tuple[bytes, float]] = {}
        self.lock_calls: list[dict] = []

    @staticmethod
    def _now() -> float:
        return time.monotonic()

    def lock(self, name, timeout=None, blocking=True, **_ignored):
        self.lock_calls.append({'name': name, 'timeout': timeout, 'blocking': blocking})
        return _SyncStubRedisLock(self, name, timeout=timeout, blocking=blocking)

    def _claim_nx(self, name, token, timeout) -> bool:
        entry = self._store.get(name)
        if entry is not None and entry[1] > self._now():
            return False
        expires_at = float('inf') if timeout is None else self._now() + float(timeout)
        self._store[name] = (token, expires_at)
        return True

    def _release_cas(self, name, token) -> bool:
        entry = self._store.get(name)
        if entry is None or entry[0] != token:
            return False
        self._store.pop(name, None)
        return True

    def _extend_cas(self, name, token, additional_time) -> bool:
        entry = self._store.get(name)
        if entry is None or entry[0] != token or entry[1] <= self._now():
            return False
        self._store[name] = (token, self._now() + additional_time)
        return True


def _sync_adapter_with_stub_client() -> tuple[SyncRedisLockAdapter, _SyncRecordingRedisClient]:
    client = _SyncRecordingRedisClient()
    return SyncRedisLockAdapter(client), client


class TestSyncRedisLockAdapterContract:
    """#254 AC：sync adapter 实现 T1 Port 全契约（threading 形态，行为断言，无真 Redis）。"""

    def test_adapter_satisfies_sync_port(self):
        adapter, _ = _sync_adapter_with_stub_client()
        assert isinstance(adapter, _SyncDistributedLockPort), (
            'SyncRedisLockAdapter 应满足 SyncDistributedLock Port'
        )

    def test_try_acquire_returns_lease_handle(self):
        adapter, _ = _sync_adapter_with_stub_client()
        handle = adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))
        assert handle is not None

    def test_second_try_acquire_on_held_resource_returns_none(self):
        adapter, _ = _sync_adapter_with_stub_client()
        adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        assert adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is None

    def test_acquire_blocks_until_release_then_succeeds(self):
        """sync 阻塞 acquire：被持有期间等待，持有方 release 后取得（redis-py 轮询语义）。"""
        adapter, _ = _sync_adapter_with_stub_client()
        holder = adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        box: dict = {}
        started = threading.Event()

        def _blocked():
            started.set()
            box['handle'] = adapter.acquire(
                ProvisionResource('gw-a'), ttl=timedelta(seconds=60),
            )

        t = threading.Thread(target=_blocked)
        t.start()
        assert started.wait(timeout=1), 'acquire 线程应已启动'
        time.sleep(0.02)  # 给线程进入阻塞轮询的时间
        assert 'handle' not in box, 'release 前阻塞 acquire 不应返回'

        holder.release()
        t.join(timeout=2)
        assert 'handle' in box, 'release 后阻塞 acquire 应返回'
        box['handle'].release()

    def test_acquire_unblocks_when_lease_expires(self):
        """sync 阻塞 acquire 在持有租约 TTL 过期后自动取得（TTL 崩溃安全语义）。"""
        adapter, _ = _sync_adapter_with_stub_client()
        adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(milliseconds=10))

        box: dict = {}

        def _blocked():
            box['handle'] = adapter.acquire(
                ProvisionResource('gw-a'), ttl=timedelta(seconds=60),
            )

        t = threading.Thread(target=_blocked)
        t.start()
        time.sleep(0.05)  # 让租约自然过期
        t.join(timeout=2)
        assert not t.is_alive(), '租约过期后阻塞 acquire 应取得'
        assert box['handle'] is not None
        box['handle'].release()

    def test_distinct_resources_do_not_conflict(self):
        adapter, _ = _sync_adapter_with_stub_client()
        adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        pairing_handle = adapter.try_acquire(
            PairingResource(instance_id=7), ttl=timedelta(seconds=60),
        )
        assert pairing_handle is not None

    def test_same_kind_different_id_do_not_conflict(self):
        adapter, _ = _sync_adapter_with_stub_client()
        adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        assert adapter.try_acquire(
            ProvisionResource('gw-b'), ttl=timedelta(seconds=60),
        ) is not None

    def test_release_frees_resource(self):
        adapter, _ = _sync_adapter_with_stub_client()
        handle = adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))
        assert adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is None

        handle.release()

        assert adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is not None

    def test_release_is_idempotent(self):
        adapter, _ = _sync_adapter_with_stub_client()
        handle = adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        handle.release()
        handle.release()  # 二次释放幂等，不抛

        assert adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is not None

    def test_release_only_own_token(self):
        """Lua 安全释放：过期被他人顶替后，旧 handle 的 release 不误删新持有者的锁。"""
        adapter, _ = _sync_adapter_with_stub_client()
        stale = adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(milliseconds=10))
        time.sleep(0.02)  # stale 租约过期
        fresh = adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        stale.release()  # 旧 handle：token 已不匹配，no-op 不抛

        assert adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is None
        fresh.release()

    def test_renew_extends_lease(self):
        adapter, _ = _sync_adapter_with_stub_client()
        handle = adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(milliseconds=30))
        time.sleep(0.02)
        handle.renew(timedelta(seconds=60))  # 仍持有：续期成功

        time.sleep(0.02)  # 原 TTL 早已过，但续期生效仍持有
        assert adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is None
        handle.release()

    def test_renew_after_expiry_is_noop(self):
        adapter, _ = _sync_adapter_with_stub_client()
        handle = adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(milliseconds=10))
        time.sleep(0.02)

        handle.renew(timedelta(seconds=60))  # 已过期：不 resurrect

        assert adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is not None

    def test_renew_after_superseded_is_noop(self):
        adapter, _ = _sync_adapter_with_stub_client()
        first = adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(milliseconds=10))
        time.sleep(0.02)
        second = adapter.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        first.renew(timedelta(seconds=300))  # 已被顶替：no-op 不复活

        assert adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60)) is None
        second.release()


class TestSyncKeyConstruction:
    """#254 AC：sync adapter 键内部构造、TTL 经 timeout 注入、键不外泄（同 async）。"""

    def test_ttl_injected_via_lock_timeout(self):
        adapter, client = _sync_adapter_with_stub_client()
        adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=90))

        assert client.lock_calls[0]['timeout'] == pytest.approx(90.0)

    def test_key_constructed_from_resource_kind_and_identifier(self):
        adapter, client = _sync_adapter_with_stub_client()
        adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))
        adapter.try_acquire(PairingResource(instance_id=7), ttl=timedelta(seconds=60))

        names = {call['name'] for call in client.lock_calls}
        assert names == {'lock:provision:gw-a', 'lock:pairing:7'}

    def test_key_not_leaked_to_caller(self):
        adapter, _ = _sync_adapter_with_stub_client()
        handle = adapter.try_acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        for public in ('name', 'key', 'resource_key'):
            assert not hasattr(handle, public), f'键不应经 .{public} 外泄'
        handle.release()

    def test_no_kv_escape_hatch(self):
        adapter, _ = _sync_adapter_with_stub_client()
        for kv in ('get', 'set', 'delete', 'setex', 'setnx', 'expire'):
            assert not hasattr(adapter, kv), f'adapter 不应暴露 KV 方法 .{kv}'


class TestSyncClosedResourceValidation:
    """#246 Q6：sync adapter 闭锁 LockResource——裸 string / 外来类抛 TypeError。"""

    def test_bare_string_resource_rejected(self):
        adapter, client = _sync_adapter_with_stub_client()
        with pytest.raises(TypeError):
            adapter.try_acquire('gw-a', ttl=timedelta(seconds=60))  # type: ignore[arg-type]
        with pytest.raises(TypeError):
            adapter.acquire('gw-a', ttl=timedelta(seconds=60))  # type: ignore[arg-type]

        assert not client.lock_calls, '非法 resource 不产生 Redis 交互'

    def test_foreign_class_with_kind_attribute_rejected(self):
        adapter, _ = _sync_adapter_with_stub_client()

        class ForeignResource:
            kind = 'foreign'

        with pytest.raises(TypeError):
            adapter.try_acquire(ForeignResource(), ttl=timedelta(seconds=60))  # type: ignore[arg-type]
