"""seam: chat.pool —— 连接池 + ChatFleet（issue #41 / spec §8.2）。

注入 FakePairingService（get_status 可控）+ StubClient（记录 connect/aclose）。覆盖：
同容器复用、异容器隔离、未配对 NotPaired（pending/error + request_id）、paired 但缺 token、aclose_all、ChatFleet locator。
"""
import asyncio
from types import SimpleNamespace

import pytest

from chat.pool import ChatConnectionPool, ChatFleet, NotPaired

# pool.get_or_create 经 channels database_sync_to_async（线程内 close_old_connections 触 DB 连接管理），
# 故测试需 django_db mark，即便 FakePairingService 不真查 DB。
pytestmark = pytest.mark.django_db


class StubClient:
    """记录 connect/aclose 的 client 替身（runId 路由已由 test_chat_client 覆盖）。"""

    def __init__(self, url, device_token):
        self.url = url
        self.device_token = device_token
        self.connect_calls = 0
        self.closed = False
        self.discarded = []

    async def connect(self):
        self.connect_calls += 1

    async def aclose(self):
        self.closed = True

    def discard(self, run_id):
        self.discarded.append(run_id)


class FakePairingService:
    """get_status 返回可控 Pairing 快照（不触 DB/握手）。"""

    def __init__(self, *, status='paired', device_token='dt-1', request_id=''):
        self._status = status
        self._device_token = device_token
        self._request_id = request_id

    def get_status(self, instance):
        return SimpleNamespace(
            status=self._status,
            device_token=self._device_token,
            pairing_request_id=self._request_id,
        )


def _instance(name, port):
    return SimpleNamespace(name=name, port=port)


def _url_for(inst):
    return f'ws://test:{inst.port}/'


@pytest.fixture
def pool():
    return ChatConnectionPool(
        pairing_service=FakePairingService(),
        client_factory=StubClient,
        ws_url_for=_url_for,
    )


@pytest.mark.asyncio
async def test_same_instance_reuses_same_client(pool):
    inst = _instance('a', 19001)
    c1 = await pool.get_or_create(inst)
    c2 = await pool.get_or_create(inst)
    assert c1 is c2
    assert c1.connect_calls == 1  # 复用，不重连


@pytest.mark.asyncio
async def test_different_instances_get_different_clients(pool):
    ca = await pool.get_or_create(_instance('a', 19001))
    cb = await pool.get_or_create(_instance('b', 19002))
    assert ca is not cb
    assert ca.url.endswith('19001/')
    assert cb.url.endswith('19002/')


@pytest.mark.asyncio
async def test_concurrent_get_or_create_same_key_returns_single_client(pool):
    """并发 get_or_create 同容器：asyncio.Lock 串行化，只建一个 client（无 orphan 泄漏）。"""
    inst = _instance('a', 19001)
    c1, c2 = await asyncio.gather(pool.get_or_create(inst), pool.get_or_create(inst))
    assert c1 is c2
    assert c1.connect_calls == 1


@pytest.mark.asyncio
async def test_unpaired_pending_raises_not_paired():
    p = ChatConnectionPool(
        pairing_service=FakePairingService(status='pending', device_token='', request_id='req-9'),
        client_factory=StubClient, ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired) as exc:
        await p.get_or_create(_instance('a', 19001))
    assert exc.value.status == 'pending'
    assert exc.value.request_id == 'req-9'


@pytest.mark.asyncio
async def test_unpaired_error_raises_not_paired():
    p = ChatConnectionPool(
        pairing_service=FakePairingService(status='error', device_token=''),
        client_factory=StubClient, ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired) as exc:
        await p.get_or_create(_instance('a', 19001))
    assert exc.value.status == 'error'


@pytest.mark.asyncio
async def test_paired_status_but_empty_token_raises_not_paired():
    # 异常态：status=paired 但 device_token 空 → 视作未配对（避免空 token 建连）
    p = ChatConnectionPool(
        pairing_service=FakePairingService(status='paired', device_token=''),
        client_factory=StubClient, ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired):
        await p.get_or_create(_instance('a', 19001))


@pytest.mark.asyncio
async def test_aclose_all_closes_clients_and_clears(pool):
    c = await pool.get_or_create(_instance('a', 19001))
    await pool.aclose_all()
    assert c.closed
    assert pool._clients == {}


def test_fleet_singleton_and_override():
    ChatFleet.reset()
    a = ChatFleet.get()
    b = ChatFleet.get()
    assert a is b
    fake = ChatConnectionPool(
        pairing_service=FakePairingService(),
        client_factory=StubClient, ws_url_for=_url_for,
    )
    ChatFleet.override(fake)
    assert ChatFleet.get() is fake
    ChatFleet.reset()
    assert ChatFleet.get() is not fake
    ChatFleet.reset()  # 清理单例，避免跨测试污染
