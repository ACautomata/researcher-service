"""common/lock 契约测试（issue #251 / parent #243）。

单一 seam = DistributedLock Port（backend/common/lock/ports.py）。两面：

1. **签名同构守卫**（#251 AC4 / #253 扩三方）：动态枚举 Port 全部公开方法，断言签名 shape 在
   Port / FakeLock / AsyncRedisLockAdapter **三方**锁步（issue #230「every Port method」范式，
   复制 integration/openclaw/tests/test_contract.py:746-780）。isinstance(runtime_checkable
   Protocol) 只验方法存在、不验签名——历史上 connect 的 keyword-only 参数曾静默分歧
   （codex #149 / #219）。本守卫用 inspect 把覆盖面扩到 Port **每个**方法，新增方法
   自动纳入（动态枚举）；任一单边签名漂移（改名 / 挪位置·关键字 / 增删默认值）都在
   测试期失败而非生产 TypeError。

2. **FakeLock 行为**（#251 AC3）：内存模拟 TTL/持有者，记录 acquire/try_acquire/
   renew/release 调用；租约期满自动失效；未持有不可续约/释放；闭锁 LockResource 的
   bare-string 拒绝（防 KV 逃逸口 #246 Q6）。
"""
from __future__ import annotations

import asyncio
import inspect
from datetime import timedelta

import pytest

from common.lock.ports import DistributedLock as _DistributedLockPort
from common.lock.ports import LeaseHandle as _LeaseHandlePort
from common.lock.ports import LockResource


def _lock_attr_signature_shape(cls, name):
    """提取 ``cls.<name>`` 的可比较签名 shape（issue #251 同构守卫用）。

    返回元组：
    - property：``('property',)``
    - 方法/函数：每个非 ``self`` 参数的 ``(name, kind, has_default)`` 三元组

    只比 Liskov 调用约定相关结构（参数名 / 位置·关键字类别 / 默认值有无），不比标注——
    实现可比 Port 更窄（ADR 0002 downward-closure），强制标注相等会假阳性。
    """
    attr = inspect.getattr_static(cls, name)
    if isinstance(attr, property):
        return ('property',)
    sig = inspect.signature(attr)
    return tuple(
        (pname, param.kind, param.default is not inspect.Parameter.empty)
        for pname, param in sig.parameters.items()
        if pname != 'self'
    )


# 动态枚举 Port 公开方法——新加方法自动纳入守卫（issue #251 AC4）。
_LOCK_PORT_METHODS = tuple(
    n for n in dir(_DistributedLockPort) if not n.startswith('_')
)
_LEASE_HANDLE_METHODS = tuple(
    n for n in dir(_LeaseHandlePort) if not n.startswith('_')
)


@pytest.mark.parametrize('method', _LOCK_PORT_METHODS)
def test_lock_method_signature_isomorphic_across_port_fake_adapter(method):
    """#251/#253：DistributedLock 每个方法在 Port / Fake / Adapter 三方签名同构（向下闭合）。

    isinstance(runtime_checkable Protocol) 只验方法存在、不验签名——历史上
    integration/openclaw connect/send_message 的 keyword-only 参数都曾因此静默分歧
    （#230）。本守卫用 inspect 扩到 Port **每个**方法在 Port/FakeLock/AsyncRedisLockAdapter
    **三方**锁步，任意单边签名漂移（改名 / 挪位置·关键字 / 增删默认值）都在测试期失败
    而非生产 TypeError。
    """
    from common.lock.adapters import AsyncRedisLockAdapter
    from common.lock.fakes import FakeLock

    port_shape = _lock_attr_signature_shape(_DistributedLockPort, method)
    fake_shape = _lock_attr_signature_shape(FakeLock, method)
    adapter_shape = _lock_attr_signature_shape(AsyncRedisLockAdapter, method)

    assert fake_shape == port_shape, (
        f'FakeLock.{method} 签名漂离 Port：port={port_shape} fake={fake_shape}'
    )
    assert adapter_shape == port_shape, (
        f'AsyncRedisLockAdapter.{method} 签名漂离 Port：'
        f'port={port_shape} adapter={adapter_shape}'
    )


@pytest.mark.parametrize('method', _LEASE_HANDLE_METHODS)
def test_lease_handle_signature_isomorphic_across_port_fake_adapter(method):
    """#251/#253：LeaseHandle 每个方法在 Port / Fake / Adapter 三方签名同构（契约公开面全覆盖）。"""
    from common.lock.adapters import _RedisLeaseHandle
    from common.lock.fakes import FakeLeaseHandle

    port_shape = _lock_attr_signature_shape(_LeaseHandlePort, method)
    fake_shape = _lock_attr_signature_shape(FakeLeaseHandle, method)
    adapter_shape = _lock_attr_signature_shape(_RedisLeaseHandle, method)

    assert fake_shape == port_shape, (
        f'FakeLeaseHandle.{method} 签名漂离 Port：port={port_shape} fake={fake_shape}'
    )
    assert adapter_shape == port_shape, (
        f'_RedisLeaseHandle.{method} 签名漂离 Port：'
        f'port={port_shape} adapter={adapter_shape}'
    )


def _fresh_resource() -> LockResource:
    from common.lock.ports import ProvisionResource

    return ProvisionResource(container_name='gw-a')


class TestFakeLockBehavior:
    """FakeLock 契约行为：#251 AC3（内存模拟 TTL/持有者 + 记录调用）。"""

    async def test_try_acquire_returns_lease_and_records_call(self):
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        handle = await lock.try_acquire(_fresh_resource(), ttl=timedelta(seconds=60))

        assert handle is not None
        assert not lock.acquire_calls
        assert len(lock.try_acquire_calls) == 1
        assert lock.try_acquire_calls[0][0] == _fresh_resource()
        assert lock.try_acquire_calls[0][1] == timedelta(seconds=60)

    async def test_acquire_returns_lease_and_records_call(self):
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        handle = await lock.acquire(_fresh_resource(), ttl=timedelta(seconds=60))

        assert handle is not None
        assert len(lock.acquire_calls) == 1
        assert not lock.try_acquire_calls

    async def test_second_try_acquire_on_held_resource_returns_none(self):
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        await lock.acquire(_fresh_resource(), ttl=timedelta(seconds=60))

        assert await lock.try_acquire(_fresh_resource(), ttl=timedelta(seconds=60)) is None

    async def test_distinct_resources_do_not_conflict(self):
        from common.lock.fakes import FakeLock
        from common.lock.ports import PairingResource, ProvisionResource

        lock = FakeLock()
        await lock.acquire(ProvisionResource('gw-a'), ttl=timedelta(seconds=60))

        # 不同 tagged resource 互不争锁
        pairing_handle = await lock.try_acquire(PairingResource(instance_id=7), ttl=timedelta(seconds=60))
        assert pairing_handle is not None

    async def test_acquire_blocks_until_release_then_succeeds(self):
        """#251：acquire 阻塞——被持有期间等待，持有方 release 后取得租约。"""
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        holder = await lock.acquire(_fresh_resource(), ttl=timedelta(seconds=60))

        async def _blocked_acquire():
            await asyncio.sleep(0.05)
            return await lock.acquire(_fresh_resource(), ttl=timedelta(seconds=60))

        task = asyncio.create_task(_blocked_acquire())
        await asyncio.sleep(0.01)  # 确保 task 已进入等待
        assert not task.done()

        await holder.release()
        second = await task

        assert second is not None
        await second.release()

    async def test_release_frees_resource_and_records_call(self):
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        handle = await lock.acquire(_fresh_resource(), ttl=timedelta(seconds=60))
        assert await lock.try_acquire(_fresh_resource(), ttl=timedelta(seconds=60)) is None

        await handle.release()

        assert await lock.try_acquire(_fresh_resource(), ttl=timedelta(seconds=60)) is not None
        assert len(lock.release_calls) == 1

    async def test_release_is_idempotent(self):
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        handle = await lock.acquire(_fresh_resource(), ttl=timedelta(seconds=60))

        await handle.release()
        await handle.release()  # 二次释放幂等

        assert len(lock.release_calls) == 2

    async def test_renew_extends_lease_and_records_call(self):
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        handle = await lock.acquire(_fresh_resource(), ttl=timedelta(seconds=60))
        await handle.renew(timedelta(seconds=300))

        assert len(lock.renew_calls) == 1
        assert lock.renew_calls[0][1] == timedelta(seconds=300)

    async def test_lease_expires_after_ttl_and_frees_resource(self):
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        await lock.acquire(_fresh_resource(), ttl=timedelta(milliseconds=10))
        await asyncio.sleep(0.02)

        assert await lock.try_acquire(_fresh_resource(), ttl=timedelta(seconds=60)) is not None

    async def test_renew_after_expiry_is_noop(self):
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        handle = await lock.acquire(_fresh_resource(), ttl=timedelta(milliseconds=10))
        await asyncio.sleep(0.02)

        await handle.renew(timedelta(seconds=60))  # 已过期：不 resurrect 锁

        assert await lock.try_acquire(_fresh_resource(), ttl=timedelta(seconds=60)) is not None

    async def test_bare_string_resource_rejected(self):
        from common.lock.fakes import FakeLock

        lock = FakeLock()

        with pytest.raises(TypeError):
            await lock.try_acquire('gw-a', ttl=timedelta(seconds=60))  # type: ignore[arg-type]
        with pytest.raises(TypeError):
            await lock.acquire('gw-a', ttl=timedelta(seconds=60))  # type: ignore[arg-type]

    async def test_foreign_class_with_kind_attribute_rejected(self):
        """闭合 tagged union：带 kind 标记的外来类同样拒绝（防 KV 逃逸口 #246 Q6）。"""
        from common.lock.fakes import FakeLock

        class ForeignResource:
            kind = 'foreign'

        lock = FakeLock()
        with pytest.raises(TypeError):
            await lock.try_acquire(ForeignResource(), ttl=timedelta(seconds=60))  # type: ignore[arg-type]

    async def test_acquire_unblocks_when_lease_expires(self):
        """阻塞 acquire 在持有租约 TTL 过期后自动取得（无显式 release）。"""
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        holder = await lock.acquire(_fresh_resource(), ttl=timedelta(milliseconds=10))
        assert holder is not None

        async def _blocked_acquire():
            await asyncio.sleep(0.05)
            return await lock.acquire(_fresh_resource(), ttl=timedelta(seconds=60))

        task = asyncio.create_task(_blocked_acquire())
        await asyncio.sleep(0.01)  # 确保 task 已进入等待（租约此时已过期）
        assert not task.done()

        second = await task
        assert second is not None
        await second.release()

    async def test_renew_after_superseded_is_noop(self):
        """release 后另一 handle 取得同一资源：旧 handle renew 不得复活其租约。"""
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        first = await lock.acquire(_fresh_resource(), ttl=timedelta(seconds=60))
        await first.release()
        second = await lock.acquire(_fresh_resource(), ttl=timedelta(seconds=60))

        await first.renew(timedelta(seconds=300))  # 已被顶替：no-op
        await second.release()

        # 旧 handle renew 后资源仍可获取（未被旧 handle 复活占用）
        assert await lock.try_acquire(_fresh_resource(), ttl=timedelta(seconds=60)) is not None


class TestFakeLockSatisfiesPort:
    """#251 AC2/AC3：FakeLock 满足 DistributedLock Port；LockResource 闭合性守卫。"""

    def test_fake_lock_satisfies_port(self):
        from common.lock.fakes import FakeLock

        lock = FakeLock()
        assert isinstance(lock, _DistributedLockPort), 'FakeLock 应满足 DistributedLock Port'

    def test_lock_resource_is_closed_tagged_union(self):
        """LockResource 为闭合 tagged union 类型（type-level guard，防 KV 逃逸口 #246 Q6）。

        union 别名意味着类型级闭合：新增资源用途必须扩展本 union 才能被 Port 接受，
        任何只带 ``kind`` 属性的外来类都不能冒充变体。运行时裸 string 拒绝由
        test_bare_string_resource_rejected / test_foreign_class_with_kind_attribute_rejected 覆盖。
        """
        from common.lock.ports import PairingResource, ProvisionResource

        assert LockResource == ProvisionResource | PairingResource
