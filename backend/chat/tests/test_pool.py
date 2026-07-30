"""seam: chat.pool —— 连接池 + ChatFleet（issue #41 / spec §8.2 / #141 identity+scopes 传递）。

注入 FakePairingService（get_status 可控）+ StubClient（记录 connect/aclose）。覆盖：
同容器复用、异容器隔离、未配对 NotPaired（pending/error + request_id）、paired 但缺 token、aclose_all、ChatFleet locator、
死连接驱逐重建、per-key 锁（坏容器不阻塞其他容器）、#141 factory 传递 DeviceIdentity 和 scopes。
"""
import asyncio
import contextlib
from types import SimpleNamespace

import pytest

from chat.pool import ChatConnectionPool, ChatFleet, NotPaired

# pool.get_or_create 经 channels database_sync_to_async（线程内 close_old_connections 触 DB 连接管理），
# 故测试需 django_db mark，即便 FakePairingService 不真查 DB。
pytestmark = pytest.mark.django_db


class StubClient:
    """记录 connect/aclose 的 client 替身（runId 路由已由 test_chat_client 覆盖）。"""

    dead = False  # pool 据此判断存活；StubClient 恒存活（dead 场景由 _DeadAwareClient 覆盖）

    def __init__(self, url, device_token, *, identity, scopes):
        self.url = url
        self.device_token = device_token
        self.identity = identity
        self.scopes = scopes
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

    def __init__(
        self,
        *,
        status='paired',
        device_token='dt-1',
        request_id='',
        device_id='dev-1',
        public_key_pem='PUBKEY',
        private_key_pem='PRIVKEY',
        scopes_json='["operator.read","operator.write","operator.approvals"]',
    ):
        self._status = status
        self._device_token = device_token
        self._request_id = request_id
        self._device_id = device_id
        self._public_key_pem = public_key_pem
        self._private_key_pem = private_key_pem
        self._scopes_json = scopes_json

    def get_status(self, instance):
        return SimpleNamespace(
            status=self._status,
            device_token=self._device_token,
            pairing_request_id=self._request_id,
            device_id=self._device_id,
            public_key_pem=self._public_key_pem,
            private_key_pem=self._private_key_pem,
            scopes_json=self._scopes_json,
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


# ── 基础复用/隔离 ──────────────────────────────────────────

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


# ── 未配对 / 缺 token ──────────────────────────────────────

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


# ── 清理 / locator ─────────────────────────────────────────

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


# ── 死连接驱逐 ─────────────────────────────────────────────

class _DeadAwareClient:
    """带 dead 标志的 client 替身：模拟 recv loop 死掉后 pool 的驱逐重建。"""

    def __init__(self, url, device_token, *, identity, scopes):
        self.url = url
        self.device_token = device_token
        self.identity = identity
        self.scopes = scopes
        self.dead = False
        self.connect_calls = 0
        self.closed = False

    async def connect(self):
        self.connect_calls += 1

    async def aclose(self):
        self.closed = True

    def discard(self, run_id):
        pass


@pytest.mark.asyncio
async def test_dead_client_is_evicted_and_recreated():
    # 连接断开后 client 标记 dead，pool 不再复用：驱逐旧 client 并重建（codex P1）
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(),
        client_factory=_DeadAwareClient,
        ws_url_for=_url_for,
    )
    inst = _instance('a', 19001)
    c1 = await pool.get_or_create(inst)
    assert c1.connect_calls == 1
    c1.dead = True  # 模拟 recv loop 退出（连接断开）
    c2 = await pool.get_or_create(inst)
    assert c2 is not c1
    assert c2.connect_calls == 1
    assert not c2.dead
    assert c1.closed  # 旧死连接 best-effort aclose 清理


# ── codex #219 四轮 P2-891：evidence 证明死但 dead 未置位时的驱逐 ────────────
# RPC 在刚关闭的 socket 上 ws.send() 抛原生 ConnectionClosed（连接已断的充分证据），但
# 后台 recv task 尚未跑异常处理器置 client.dead——竞态窗口。此时 get_or_create 快路径
# （pool.py:80-82）只看 dead==False，会返回同一个濒死 client，consumer 的 identity check
# 放弃恢复。须先 evict 把该 client 逐出缓存，再 get_or_create 才走慢路径重建。


@pytest.mark.asyncio
async def test_evict_removes_live_client_so_get_or_create_recreates():
    """codex #219 四轮 P2-891：evict 把 dead 未置位的 client 逐出缓存，get_or_create 重建新 client。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(),
        client_factory=_DeadAwareClient,
        ws_url_for=_url_for,
    )
    inst = _instance('a', 19001)
    c1 = await pool.get_or_create(inst)
    assert c1.connect_calls == 1
    assert c1.dead is False  # 竞态：dead 未置位（ConnectionClosed 先于 recv task 异常处理器）

    await pool.evict(inst)  # evidence 证明已死 → 逐出缓存
    assert c1.closed  # best-effort aclose 清理（对齐死连接驱逐语义）

    c2 = await pool.get_or_create(inst)
    assert c2 is not c1  # 不再是同一个濒死 client
    assert c2.connect_calls == 1
    assert not c2.dead


@pytest.mark.asyncio
async def test_evict_without_cached_client_is_noop():
    """evict 幂等：pool 无该容器缓存 client 时不抛错、不建连。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(),
        client_factory=_DeadAwareClient,
        ws_url_for=_url_for,
    )
    inst = _instance('a', 19001)
    await pool.evict(inst)  # 无缓存 → noop，不抛
    # get_or_create 正常建连（确认 evict 未破坏状态）
    c = await pool.get_or_create(inst)
    assert c.connect_calls == 1


@pytest.mark.asyncio
async def test_evict_unpaired_is_noop():
    """evict 未配对容器：get_status 非 paired → 找不到 key，noop 不抛。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(status='pending', device_token=''),
        client_factory=_DeadAwareClient,
        ws_url_for=_url_for,
    )
    await pool.evict(_instance('a', 19001))  # 未配对 → noop，不抛 NotPaired


# ── codex #219 六轮 P1-872：reacquire 把比较+驱逐+重建收敛进一把锁（消 TOCTOU）────────
# consumer 原 get_live→evict→get_or_create 三步非原子：两 consumer 并发自愈同一死 client 时
# 都见无 live，A 在 B 检查与 evict 间装好健康连接，B 又把它 evict+aclose（中断 A 路由 + 订阅者
# 滞留死 client）。reacquire(instance, expected_client) 在 per-key 锁内一次性完成「比较缓存项
# → 采纳/驱逐 → 重建」，比较与替换原子，消除跨 consumer 的 TOCTOU。


@pytest.mark.asyncio
async def test_reacquire_evicts_expected_dead_and_recreates():
    """缓存项就是 expected_client（自己持有的死 client）→ 驱逐并重建新 client。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(),
        client_factory=_DeadAwareClient,
        ws_url_for=_url_for,
    )
    inst = _instance('a', 19001)
    c1 = await pool.get_or_create(inst)
    c1.dead = True  # 本 consumer 持有的死 client

    c2, replaced = await pool.reacquire(inst, c1)
    assert c2 is not c1
    assert not c2.dead
    assert replaced is c1  # codex #219 十四轮 P2-183：返回被驱逐的旧死 client（供迁订阅者）
    assert c1.closed  # 旧死 client best-effort aclose
    # 再 get_or_create 命中刚重建的健康 client（复用）
    assert await pool.get_or_create(inst) is c2


@pytest.mark.asyncio
async def test_reacquire_adopts_live_replacement_installed_by_peer():
    """codex #219 六轮 P1-872：缓存项已被别的 consumer 换成健康新连接（≠expected_client）→ 采纳，
    不驱逐不重建（绝不误关别人建好的连接）。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(),
        client_factory=_DeadAwareClient,
        ws_url_for=_url_for,
    )
    inst = _instance('a', 19001)
    stale = await pool.get_or_create(inst)
    stale.dead = True  # 本 consumer 持有的旧死 client

    # 别的 consumer 已先自愈：驱逐并装好健康新连接（模拟 peer 在锁内完成替换）
    peer_fresh, peer_replaced = await pool.reacquire(inst, stale)
    assert peer_fresh is not stale and not peer_fresh.dead
    assert peer_replaced is stale  # 首次驱逐的是 stale
    stale_closed_before = stale.closed

    # 本 consumer 后到：缓存项已是 peer 换好的健康连接（≠ 自己持有的 stale）→ 直接采纳
    adopted, adopt_replaced = await pool.reacquire(inst, stale)
    assert adopted is peer_fresh  # 采纳 peer 的健康连接
    assert adopt_replaced is None  # codex #219 十四轮 P2-183：采纳无驱逐 → replaced=None
    assert not peer_fresh.closed  # 不误关 peer 的连接
    assert stale.closed == stale_closed_before  # stale 已被 peer 关过，不重复关


@pytest.mark.asyncio
async def test_reacquire_concurrent_same_dead_client_single_recreate():
    """codex #219 六轮 P1-872：两 consumer 并发 reacquire 同一死 client——per-key 锁串行化，
    只重建一次，两者都拿到同一健康新连接（无互相 evict 对方成果）。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(),
        client_factory=_DeadAwareClient,
        ws_url_for=_url_for,
    )
    inst = _instance('a', 19001)
    dead_client = await pool.get_or_create(inst)
    dead_client.dead = True

    # 两个 consumer 都持有同一 dead_client，并发自愈
    (r1, rep1), (r2, rep2) = await asyncio.gather(
        pool.reacquire(inst, dead_client),
        pool.reacquire(inst, dead_client),
    )
    assert r1 is r2  # 都拿到同一健康新连接（第二个采纳第一个的重建成果）
    assert r1 is not dead_client
    assert not r1.dead
    # codex #219 十四轮 P2-183：恰好一个驱逐（replaced=dead_client），另一个采纳（replaced=None）
    assert (rep1 is dead_client) != (rep2 is dead_client)
    assert (rep1 is None) != (rep2 is None)
    assert r1.connect_calls == 1  # 只重建一次（不重复建连）
    assert dead_client.closed  # 死 client 被清理一次


# ── per-key 锁隔离 ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_slow_container_does_not_block_other_containers():
    # 容器 A 建连挂起（永不回握手）；异 key 的 B 应不被 A 阻塞（per-key lock）。
    # 全局锁下 B 会等 A → wait_for 超时；per-key lock 下 B 立即返回（codex P1）。
    hang = asyncio.Event()
    started_a = asyncio.Event()

    class HangingClient:
        def __init__(self, url, device_token, *, identity, scopes):
            self.url = url
            self.device_token = device_token
            self.identity = identity
            self.scopes = scopes
            self.dead = False
            self.connect_calls = 0
            self.closed = False

        async def connect(self):
            self.connect_calls += 1
            if self.url.endswith('19001/'):  # A 挂起
                started_a.set()
                await hang.wait()

        async def aclose(self):
            self.closed = True

        def discard(self, run_id):
            pass

    pool = ChatConnectionPool(
        pairing_service=FakePairingService(),
        client_factory=HangingClient,
        ws_url_for=_url_for,
    )
    task_a = asyncio.create_task(pool.get_or_create(_instance('a', 19001)))
    await started_a.wait()  # A 已进入 connect（持 per-key lock A）
    # B 应立即返回，不等 A 的建连
    c_b = await asyncio.wait_for(pool.get_or_create(_instance('b', 19002)), timeout=1.0)
    assert c_b.url.endswith('19002/')
    task_a.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task_a


# ── #141: DeviceIdentity + scopes 传递 ─────────────────────

@pytest.mark.asyncio
async def test_identity_and_scopes_are_passed_from_pairing_to_client():
    """get_or_create 从 Pairing 行提取 device_id/pub/priv 重建 DeviceIdentity，解析 scopes_json → list[str]，传给 factory。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(
            device_token='tok-9',
            device_id='did-1',
            public_key_pem='PUB',
            private_key_pem='PRIV',
            scopes_json='["operator.read","operator.write","operator.approvals"]',
        ),
        client_factory=StubClient,
        ws_url_for=_url_for,
    )
    c = await pool.get_or_create(_instance('x', 19100))
    assert c.device_token == 'tok-9'
    assert c.identity is not None
    assert c.identity.device_id == 'did-1'
    assert c.identity.public_key_pem == 'PUB'
    assert c.identity.private_key_pem == 'PRIV'
    assert c.scopes == ['operator.read', 'operator.write', 'operator.approvals']


@pytest.mark.asyncio
async def test_empty_scopes_json_with_identity_raises_not_paired():
    """scopes_json='[]' 且 identity 完整 → NotPaired（配对材料不完整，路由重新配对）。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(scopes_json='[]'),
        client_factory=StubClient,
        ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired):
        await pool.get_or_create(_instance('x', 19101))


@pytest.mark.asyncio
async def test_malformed_scopes_json_with_identity_raises_not_paired():
    """scopes_json 损坏且 identity 完整 → NotPaired（配对材料不完整，路由重新配对）。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(scopes_json='{bad'),
        client_factory=StubClient,
        ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired):
        await pool.get_or_create(_instance('x', 19102))


@pytest.mark.asyncio
async def test_non_list_scopes_with_identity_raises_not_paired():
    """scopes_json 是合法 JSON 但非 list（如 str "op.read" / dict {}）→ NotPaired。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(scopes_json='"operator.read"'),
        client_factory=StubClient,
        ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired):
        await pool.get_or_create(_instance('x', 19103))


@pytest.mark.asyncio
async def test_non_string_elements_with_identity_raises_not_paired():
    """scopes_json 是 list 但含有非字符串元素 → NotPaired。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(scopes_json='["op.read", 123]'),
        client_factory=StubClient,
        ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired):
        await pool.get_or_create(_instance('x', 19104))


@pytest.mark.asyncio
async def test_incomplete_device_identity_raises_not_paired():
    """PAIRED 且身份字段缺失 → NotPaired（配对材料不完整，路由重新配对）。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(
            device_id='', public_key_pem='', private_key_pem='',
        ),
        client_factory=StubClient,
        ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired):
        await pool.get_or_create(_instance('x', 19105))


@pytest.mark.asyncio
async def test_scopes_missing_required_permissions_raises_not_paired():
    """scopes_json 合法但缺少 REQUIRED_SCOPES → NotPaired（scopes 不足，路由重新配对）。"""
    pool = ChatConnectionPool(
        pairing_service=FakePairingService(
            scopes_json='["operator.read","operator.write"]',  # 缺 operator.approvals
        ),
        client_factory=StubClient,
        ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired):
        await pool.get_or_create(_instance('x', 19106))
