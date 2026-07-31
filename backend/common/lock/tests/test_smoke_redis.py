"""common/lock 真 Redis 集成 smoke（issue #253 / parent #243，**可选**、自动探测门控、默认 skip）。

CI/单测默认**无真 Redis**（#253 AC5）：行为测试全走 FakeLock / stub client（test_adapters.py /
test_locator.py）。本文件是唯一触真 Redis 的可选 smoke——``_redis_reachable()`` 探测本地
``REDIS_URL``，不可达即整文件 skip（对齐 repo 集成 smoke 的 daemon 门控惯例，见
tests/integration/test_integration_http.py:_docker_daemon_reachable）。

**刻意不打 ``integration`` marker**：该 marker 现有语义绑 docker daemon +
OPENCLAW_TEMPLATE_DIR/LLM_API_KEY 环境（tests/integration/conftest.py），与 Redis 无关；本
smoke 只需一个可达 Redis，独立探针即可。运行（本地起 redis，如 ``docker run -p 6379:6379 redis``）::

  cd backend
  python -m pytest common/lock/tests/test_smoke_redis.py -v
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
from django.conf import settings
from redis.asyncio import from_url as _redis_from_url

from common.lock.adapters import AsyncRedisLockAdapter
from common.lock.ports import PairingResource, ProvisionResource


def _redis_reachable() -> bool:
    """探测 ``settings.REDIS_URL`` 可达（case 级 skipif 门控，对齐 daemon 探测惯例）。

    短超时界定探测，Redis 不可达（本地未起 / REDIS_URL 未指）即返 False → case skip；
    仅在 case 实际运行时探测（skipif 字符串条件引用），collection 阶段不连 Redis。
    """

    async def _ping() -> bool:
        client = _redis_from_url(
            settings.REDIS_URL, socket_connect_timeout=1, socket_timeout=1,
        )
        try:
            return bool(await client.ping())
        except Exception:  # pylint: disable=broad-exception-caught  # 探测即故障隔离
            return False
        finally:
            await client.aclose()

    try:
        return asyncio.run(_ping())
    except Exception:  # pylint: disable=broad-exception-caught  # 探测即故障隔离
        return False


pytestmark = pytest.mark.skipif(
    'not _redis_reachable()', reason='需可达 Redis（本地起 redis；settings.REDIS_URL 指向）',
)


@pytest.fixture
async def redis_client():
    """真 Redis client（每 case 独立 + teardown 关连 + 清本 case 遗留键）。"""
    client = _redis_from_url(settings.REDIS_URL)
    yield client
    # teardown：清掉本 case 可能遗留的锁键（lock:* 仅本 smoke 用），再关连。
    async for key in client.scan_iter('lock:*'):
        await client.delete(key)
    await client.aclose()


class TestAsyncRedisLockAdapterSmoke:
    """真 Redis 端到端 smoke：adapter 经 redis.asyncio Lock 拿到真互斥/崩溃安全租约。"""

    async def test_mutual_exclusion_across_two_clients(self, redis_client):
        """两个独立 client（模拟两进程）对同一资源互斥：一家持有，另一家 try_acquire 得 None。"""
        other_client = _redis_from_url(settings.REDIS_URL)
        try:
            adapter_a = AsyncRedisLockAdapter(redis_client)
            adapter_b = AsyncRedisLockAdapter(other_client)
            resource = ProvisionResource(f'smoke-{uuid.uuid1().hex[:8]}')

            await adapter_a.acquire(resource, ttl=timedelta(seconds=30))

            assert await adapter_b.try_acquire(resource, ttl=timedelta(seconds=30)) is None
        finally:
            await other_client.aclose()

    async def test_lease_auto_expires_after_ttl_unblocks_retry(self, redis_client):
        """崩溃安全语义：不 release 让租约 TTL 自然过期后，另一获取者能取得（TTL 兜底）。"""
        adapter = AsyncRedisLockAdapter(redis_client)
        resource = PairingResource(instance_id=900000 + uuid.uuid1().int % 1000)

        await adapter.acquire(resource, ttl=timedelta(milliseconds=100))
        await asyncio.sleep(0.3)  # 让租约自然过期（模拟崩溃未 release）

        assert await adapter.try_acquire(resource, ttl=timedelta(seconds=30)) is not None

    async def test_release_then_reacquire(self, redis_client):
        adapter = AsyncRedisLockAdapter(redis_client)
        resource = ProvisionResource(f'smoke-{uuid.uuid1().hex[:8]}')

        handle = await adapter.acquire(resource, ttl=timedelta(seconds=30))
        await handle.release()

        assert await adapter.try_acquire(resource, ttl=timedelta(seconds=30)) is not None
