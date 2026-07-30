"""seam: chat.pool —— 连接池 + ChatFleet（issue #41 / spec §8.2 / #141 identity+scopes 传递）。

注入 FakePairingService（get_status 可控）+ StubClient（记录 connect/aclose）。覆盖：
同容器复用、异容器隔离、未配对 NotPaired（pending/error + request_id）、paired 但缺 token、aclose_all、ChatFleet locator、
死连接驱逐重建、per-key 锁（坏容器不阻塞其他容器）、#141 factory 传递 DeviceIdentity 和 scopes。
"""
import asyncio
import contextlib
from types import SimpleNamespace

import pytest

from chat.chat_client import OpenClawChatClient
from chat.device_crypto import DeviceCrypto
from chat.pool import ChatConnectionPool, ChatFleet, NotPaired, ReconnectPolicy
from chat.tests.fakes import FakeChatTransport

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


# ── #196 T3 / #215：主动重连 + 指数退避（1s→30s）────────────────


class _ScriptedReconnectClient:
    """按脚本决定 connect 成败的 client 替身（记录 connect/aclose 调用供断言）。

    每次 connect 消费脚本一格决定成败（超限复用最后一格）。接受 pool 注入的 ``on_dead``（模拟
    真实 client 的 ``_mark_dead`` → ``on_dead`` 链路）：``kill()`` 模拟 T1 看门狗标死并上报，
    触发 pool 后台主动重连——这正是 #215 的「标 dead 后无需用户发消息即自愈」。
    """

    def __init__(self, url, device_token, *, identity, scopes, script, index, on_dead=None):
        self.url = url
        self.device_token = device_token
        self.identity = identity
        self.scopes = scopes
        self._script = script
        self._index = index
        self._on_dead = on_dead
        self.dead = False
        self.connect_calls = 0
        self.closed = False

    async def connect(self):
        self.connect_calls += 1
        should_fail = self._script[min(self._index[0], len(self._script) - 1)]
        self._index[0] += 1
        if should_fail:
            raise ConnectionError('gateway offline')

    def kill(self):
        """模拟 T1 看门狗判死：置 dead 并经 on_dead 上报 pool（触发主动重连）。"""
        self.dead = True
        if self._on_dead is not None:
            self._on_dead()

    async def aclose(self):
        self.closed = True

    def discard(self, run_id):
        pass


def _scripted_factory(script, index):
    def factory(url, device_token, *, identity, scopes, on_dead=None):
        return _ScriptedReconnectClient(
            url, device_token, identity=identity, scopes=scopes,
            script=script, index=index, on_dead=on_dead,
        )
    return factory


@pytest.fixture
def clock():
    """假时钟：sleep 只记录时长（指数退避序列可断言），不真睡（issue #215 假时钟可控）。"""
    return SimpleNamespace(sleeps=[], now=0.0)


def _sleeper_for(clock):
    async def sleeper(seconds):
        clock.sleeps.append(seconds)
        clock.now += seconds
    return sleeper


def _reconnect_pool(clock, script, index):
    return ChatConnectionPool(
        pairing_service=FakePairingService(),
        client_factory=_scripted_factory(script, index),
        ws_url_for=_url_for,
        reconnect_policy=ReconnectPolicy(sleeper=_sleeper_for(clock)),
    )


async def _run_reconnect(pool, key):
    """确定性驱动后台重连跑完（假时钟下退避立即返回，直接 await 该 key 的重连 task）。"""
    task = pool._reconnect_tasks.get(key)
    assert task is not None, '应已启动后台重连'
    await task


@pytest.mark.asyncio
async def test_reconnect_policy_exponential_backoff_with_cap(clock):
    """#215：指数退避序列 1,2,4,8,16,30，封顶 30（契约 GATEWAY_RECONNECT_POLICY 1s→30s）。"""
    policy = ReconnectPolicy(sleeper=_sleeper_for(clock))
    assert [await policy.next_delay() for _ in range(8)] == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]


@pytest.mark.asyncio
async def test_reconnect_policy_reset_restarts_from_initial(clock):
    """#215：重连成功 reset() 后下次 dead 退避重置回 1s（不沿用上次失败累计的退避）。"""
    policy = ReconnectPolicy(sleeper=_sleeper_for(clock))
    await policy.next_delay()
    await policy.next_delay()
    policy.reset()
    assert await policy.next_delay() == 1.0


@pytest.mark.asyncio
async def test_dead_client_triggers_background_reconnect(clock):
    """#215：client 标 dead（on_dead 上报）后，pool 后台按 1s 退避主动重连——无需用户发消息即自愈。"""
    index = [0]
    pool = _reconnect_pool(clock, [False, False], index)  # c1 建连 + 后台重连各 1 次，全成功
    inst = _instance('a', 19001)
    c1 = await pool.get_or_create(inst)
    assert index[0] == 1  # 仅建连 1 次
    key = (c1.url, c1.device_token)
    c1.kill()  # 模拟 T1 看门狗标死（半开连接）→ on_dead 触发 pool 主动重连
    await _run_reconnect(pool, key)  # 后台重连跑完（假时钟退避立即返回）
    assert index[0] == 2  # 前台 1 次（c1）+ 后台重连 1 次
    assert clock.sleeps == [1.0]  # 首次退避 1s
    latest = pool._clients[key]
    assert latest is not c1  # 重连换入全新 client
    assert not latest.dead
    assert c1.closed  # 换入前 best-effort 清理旧死连接
    await pool.aclose_all()


@pytest.mark.asyncio
async def test_successful_reconnect_resets_backoff(clock):
    """#215 验收①：重连成功即重置退避——首次重连成功后再次标 dead，退避重新从 1s 起。"""
    index = [0]
    pool = _reconnect_pool(clock, [False], index)  # 全部 connect 成功
    inst = _instance('a', 19001)
    c1 = await pool.get_or_create(inst)
    key = (c1.url, c1.device_token)
    c1.kill()
    await _run_reconnect(pool, key)  # 后台重连成功（脚本全成功）
    assert clock.sleeps == [1.0]
    # 重连成功 → 退避已 reset；再次标 dead 触发新一轮重连，退避从 1s 重起
    c2 = pool._clients[key]
    c2.kill()
    await _run_reconnect(pool, key)
    assert clock.sleeps == [1.0, 1.0]  # 第二轮退避重置回 1s（非 2s）
    await pool.aclose_all()


@pytest.mark.asyncio
async def test_failed_reconnect_retries_with_backoff_until_success(clock):
    """#215：重连失败按 1,2,4… 退避持续重试，成功后换入存活 client（半开断线自愈，T4 前提）。"""
    index = [0]
    # c1 建连成功（False）；后台重连前 2 次失败、第 3 次成功（True,True,False）
    pool = _reconnect_pool(clock, [False, True, True, False], index)
    inst = _instance('a', 19001)
    c1 = await pool.get_or_create(inst)
    key = (c1.url, c1.device_token)
    c1.kill()
    await _run_reconnect(pool, key)  # 后台重连跑通全部重试（假时钟退避立即返回）
    assert index[0] == 4  # 前台 1 次 + 后台 3 次（2 败 1 成）
    assert clock.sleeps == [1.0, 2.0, 4.0]  # 指数退避序列
    latest = pool._clients[key]
    assert latest is not c1
    assert not latest.dead
    await pool.aclose_all()


@pytest.mark.asyncio
async def test_aclose_all_cancels_pending_reconnect_timer(clock):
    """#215 验收②：aclose_all 取消未触发的退避计时器——不再重连、无悬挂 task。"""
    index = [0]
    # 重连 task 建连前立刻取消（同步 hook，跑在 connect_factory 内、重连循环 await 退避之前），
    # 否则假时钟下重连循环在 aclose_all 前就跑完，测不到「取消未触发计时器」。
    pool = _reconnect_pool(clock, [False], index)
    inst = _instance('a', 19001)
    c1 = await pool.get_or_create(inst)
    key = (c1.url, c1.device_token)
    c1.kill()  # 标 dead → on_dead 启动后台重连（task 已挂在 pool 上）
    assert pool._reconnect_tasks.get(key) is not None
    await pool.aclose_all()  # 取消并等待重连 task 落定
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert index[0] == 1  # 仅前台建连 1 次，后台重连被取消未再 connect
    assert clock.sleeps == []  # 退避计时器从未触发（aclose_all 在首个退避 await 前取消）
    assert not pool._reconnect_tasks  # 无悬挂重连 task


@pytest.mark.asyncio
async def test_fast_path_get_or_create_cancels_pending_reconnect(clock):
    """#215：重连在途时 fast-path 命中存活 client → 幂等取消悬挂重连（竞态防御，防双 client 分裂）。

    场景：重连计时器在途（client 已死、池尚未换入新连接）时，外部已把池中换成存活 client（如另一
    路 fast-path 重建）；此后台重连再触发会顶掉存活 client → fast-path 命中时幂等取消悬挂重连。
    """
    index = [0]
    pool = _reconnect_pool(clock, [False, False], index)
    inst = _instance('a', 19001)
    c1 = await pool.get_or_create(inst)
    key = (c1.url, c1.device_token)
    c1.kill()  # 标 dead → on_dead 启动后台重连（task 在途、假时钟下尚未跑）
    task = pool._reconnect_tasks.get(key)
    assert task is not None
    # fast-path 在重连在途期间命中：池中换成存活 client（模拟另一路已重建），取消悬挂重连
    c_alive = await pool.get_or_create(inst)  # c1 已死 → 驱逐重建 c_alive
    assert c_alive is not c1
    assert not c_alive.dead
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert pool._clients[key] is c_alive  # 存活 client 未被悬挂重连顶掉（无 client 分裂）
    await pool.aclose_all()


@pytest.mark.asyncio
async def test_real_client_dead_triggers_proactive_reconnect(clock):
    """#215 生产闭环：真实 client 经 _recv_loop 看门狗标 dead → on_dead 触发 pool 主动重连。

    stub 不接受 on_dead kwarg（走 TypeError 回退），覆盖不到「client 标死 → pool 重连」的触发链路；
    此测试用接受 on_dead 的 factory 包真实 OpenClawChatClient + FakeChatTransport：首连接 tickIntervalMs
    极小 → 半开看门狗判死 → on_dead 上报 → pool 后台退避重连 → 换入新连接（其 hello-ok 用大 tick 不再判死）。
    """
    async def _main():
        # FakePairingService 默认返回假 PEM（'PUBKEY'/'PRIVKEY'），真实 client 签名路径需合法
        # Ed25519 身份——用真实生成的 identity，签名握手才能通过（_recv_loop 才启动、看门狗才生效）。
        real_identity = DeviceCrypto.generate_identity()
        pairing = FakePairingService(
            device_id=real_identity.device_id,
            public_key_pem=real_identity.public_key_pem,
            private_key_pem=real_identity.private_key_pem,
            scopes_json='["operator.read","operator.write","operator.approvals"]',
        )
        # 第 1 次连接 hello-ok 带小 tick（看门狗 2×20ms=40ms 判死）；重连后第 2 次起用大 tick（不再判死）
        transports = [
            FakeChatTransport(connect_policy={'tickIntervalMs': 20, 'maxPayload': 26214400}),
            FakeChatTransport(connect_policy={'tickIntervalMs': 60000, 'maxPayload': 26214400}),
        ]
        made = []

        def factory(url, device_token, *, identity, scopes, on_dead=None):
            t = transports[min(len(made), len(transports) - 1)]
            client = OpenClawChatClient(
                url, device_token, identity=identity, scopes=scopes,
                transport=t, on_dead=on_dead,
            )
            made.append(client)
            return client

        pool = ChatConnectionPool(
            pairing_service=pairing,
            client_factory=factory,
            ws_url_for=_url_for,
            reconnect_policy=ReconnectPolicy(sleeper=_sleeper_for(clock)),
        )
        inst = _instance('a', 19001)
        c1 = await pool.get_or_create(inst)
        assert not c1.dead
        # 静默 > 2×20ms → 看门狗判死，触发 on_dead → pool 启动后台重连。假时钟下退避立即返回，
        # 重连在此 sleep 窗口内并发跑完（真实 client 的 recv_task 用真实时钟，aclose_all 负责清理）。
        await asyncio.sleep(0.08)
        assert c1.dead
        key = (c1._url, c1._device_token)  # 真实 client 的 url/device_token 是私有属性（stub 才是公开）
        # 等后台重连落定（退避立即返回，重连建 c2 换入）。轮询至重连建了第 2 个 client。
        for _ in range(200):
            if len(made) >= 2:
                break
            await asyncio.sleep(0.005)
        assert clock.sleeps == [1.0]  # 首次退避 1s
        assert len(made) == 2  # 重连建了第 2 个真实 client
        latest = pool._clients[key]
        assert latest is not c1
        assert not latest.dead  # 新连接存活（大 tick 不再判死）
        await pool.aclose_all()

    await asyncio.wait_for(_main(), timeout=5.0)  # 硬上限：重连/aclose 异常挂起时快速失败而非超时
