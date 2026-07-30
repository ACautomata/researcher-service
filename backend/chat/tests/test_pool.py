"""seam: chat.pool —— 连接池 + ChatFleet（issue #41 / spec §8.2 / #141 identity+scopes 传递）。

注入 FakePairingService（get_status 可控）+ StubClient（记录 connect/aclose）。覆盖：
同容器复用、异容器隔离、未配对 NotPaired（pending/error + request_id）、paired 但缺 token、aclose_all、ChatFleet locator、
死连接驱逐重建、per-key 锁（坏容器不阻塞其他容器）、#141 factory 传递 DeviceIdentity 和 scopes。
"""
import asyncio
import contextlib
from types import SimpleNamespace
from typing import ClassVar

import pytest

from chat.chat_client import ChatConnectError
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
        # 缺省含 operator.admin 全量 4-scope（#222 REQUIRED_SCOPES 纳入 admin，pool 据此校验）。
        scopes_json='["operator.read","operator.write","operator.admin","operator.approvals"]',
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
            scopes_json='["operator.read","operator.write","operator.admin","operator.approvals"]',
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
    assert c.scopes == ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals']


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
            scopes_json='["operator.read","operator.write"]',  # 缺 operator.admin/approvals
        ),
        client_factory=StubClient,
        ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired):
        await pool.get_or_create(_instance('x', 19106))


# ── #222 / #197-01：按结构化错误码分流恢复策略 ─────────────────────────────


class _FlakyConnectClient:
    """connect() 按脚本抛结构化 ChatConnectError（或成功）的 client 替身。

    fail_codes：列表，第 i 次 connect 若 i < len(fail_codes) 则抛对应 code 的 ChatConnectError，
    否则成功。模拟「同一 client 有界重试」场景。
    """

    instances: ClassVar[list] = []
    fail_codes: ClassVar[list] = []

    def __init__(self, url, device_token, *, identity, scopes):
        self.url = url
        self.device_token = device_token
        self.identity = identity
        self.scopes = scopes
        self.dead = False
        self.connect_calls = 0
        self.closed = False
        self.scopes_narrowed = False
        self.on_device_token_rotated = None
        self.__class__.instances.append(self)

    async def connect(self):
        self.connect_calls += 1
        codes = self.__class__.fail_codes
        if self.connect_calls <= len(codes):
            code = codes[self.connect_calls - 1]
            # UNAVAILABLE 附 startup-sidecars + retryAfterMs=0（测 #222 暂态重试路径；
            # retryAfterMs=0 避免测试真 sleep）。
            details = {'reason': 'startup-sidecars', 'retryAfterMs': 0} if code == 'UNAVAILABLE' else {}
            raise ChatConnectError('rejected', code=code, details=details)

    async def aclose(self):
        self.closed = True

    def discard(self, run_id):
        pass


class _RecordingPairingService(FakePairingService):
    """在 FakePairingService 上记录「标记配对失效 / 持久化轮换 token」调用。"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.invalidated = []  # [(instance, reason)] 标记配对失效（引导重配）
        self.token_updates = []  # [(instance, new_token)] deviceToken 轮换落库

    def mark_pairing_invalid(self, instance, reason=''):
        self.invalidated.append((instance, reason))

    def update_device_token(self, instance, new_token):
        self.token_updates.append((instance, new_token))
        self._device_token = new_token  # 落库后下次 get_status 返回新 token（模拟真实 DB 写入生效）


def _flaky_pool(codes, **pairing_kwargs):
    _FlakyConnectClient.instances = []
    _FlakyConnectClient.fail_codes = codes
    pairing = _RecordingPairingService(**pairing_kwargs)
    pool = ChatConnectionPool(
        pairing_service=pairing, client_factory=_FlakyConnectClient, ws_url_for=_url_for,
    )
    return pool, pairing


@pytest.mark.asyncio
async def test_auth_token_mismatch_retries_once_then_guides_repair():
    """#222 问题1 AUTH_TOKEN_MISMATCH（deviceToken 被撤销/轮换）：同一 client 有界重试一次已存
    deviceToken，仍失败则**停止自动重连**、标记配对失效并 raise NotPaired 引导重新配对——
    不再用同一失效 token 无限重建（当前 = 聊天永久变砖）。"""
    pool, pairing = _flaky_pool(['AUTH_TOKEN_MISMATCH', 'AUTH_TOKEN_MISMATCH'])
    with pytest.raises(NotPaired):
        await pool.get_or_create(_instance('a', 19001))
    client = _FlakyConnectClient.instances[0]
    assert client.connect_calls == 2  # 重试一次（共 2 次）后停连
    assert len(pairing.invalidated) == 1  # 标记配对失效（引导重配）


@pytest.mark.asyncio
async def test_auth_token_mismatch_first_retry_succeeds_recovers():
    """#222 AUTH_TOKEN_MISMATCH 边界：第一次失败、重试一次成功 → 正常返回 client（不误判重配）。"""
    pool, pairing = _flaky_pool(['AUTH_TOKEN_MISMATCH'])  # 仅第一次失败
    client = await pool.get_or_create(_instance('a', 19001))
    assert client.connect_calls == 2
    assert pairing.invalidated == []  # 恢复成功，不标记失效


@pytest.mark.asyncio
async def test_auth_scope_mismatch_routes_repair_not_token_retry():
    """#222 问题1 AUTH_SCOPE_MISMATCH：直接路由重新配对（不当 token 错误重试）——
    connect 只调一次即标记失效 + NotPaired。"""
    pool, pairing = _flaky_pool(['AUTH_SCOPE_MISMATCH', 'AUTH_SCOPE_MISMATCH'])
    with pytest.raises(NotPaired):
        await pool.get_or_create(_instance('a', 19001))
    client = _FlakyConnectClient.instances[0]
    assert client.connect_calls == 1  # 不重试 token（scope 问题重试无意义）
    assert len(pairing.invalidated) == 1


@pytest.mark.asyncio
async def test_unavailable_startup_sidecars_retries_then_recovers():
    """#222 问题1 UNAVAILABLE+startup-sidecars：合法启动暂不可用，按 retryAfterMs 有界重试——
    第一次 UNAVAILABLE(startup-sidecars)、第二次成功 → 正常返回（非硬错误）。"""
    pool, pairing = _flaky_pool(['UNAVAILABLE'])
    client = await pool.get_or_create(_instance('a', 19001))
    assert client.connect_calls == 2  # 重试后恢复
    assert pairing.invalidated == []


@pytest.mark.asyncio
async def test_unavailable_startup_sidecars_exhausts_bounded_retries():
    """#222 UNAVAILABLE 有界：持续 startup-sidecars 不可用 → 有界重试耗尽后抛 ChatConnectError
    （非 NotPaired——这是暂态非配对问题），不无限重试。"""
    # fail_codes 长度 5 > pool 有界重试上限 → 耗尽后仍失败
    pool, pairing = _flaky_pool(['UNAVAILABLE'] * 5)
    with pytest.raises(ChatConnectError):
        await pool.get_or_create(_instance('a', 19001))
    assert pairing.invalidated == []  # UNAVAILABLE 不路由重配


@pytest.mark.asyncio
async def test_hello_ok_narrowed_scopes_marks_invalid_and_raises_not_paired():
    """#222 问题2：connect 成功但 hello-ok 授予 scopes 收窄（client.scopes_narrowed=True）→
    pool 标记配对失效 + raise NotPaired 路由重新配对（后续 RPC 会逐个 FORBIDDEN，须尽早暴露）。"""
    class _NarrowedClient(_FlakyConnectClient):
        async def connect(self):
            self.connect_calls += 1
            self.scopes_narrowed = True  # 模拟 hello-ok 收窄

    _NarrowedClient.instances = []
    _NarrowedClient.fail_codes = []
    pairing = _RecordingPairingService()
    pool = ChatConnectionPool(
        pairing_service=pairing, client_factory=_NarrowedClient, ws_url_for=_url_for,
    )
    with pytest.raises(NotPaired):
        await pool.get_or_create(_instance('a', 19001))
    assert len(pairing.invalidated) == 1


@pytest.mark.asyncio
async def test_device_token_rotation_persisted_and_pool_rekeyed():
    """#222 问题2：hello-ok 轮换下发新 deviceToken → client 在 connect 内采纳为当前 device_token
    属性（并触发 on_device_token_rotated 钩子），pool connect 后检测到变化 → 经 PairingService
    加密落库（update_device_token）并以新 token re-key 供后续连接复用。"""
    class _RotatingClient(_FlakyConnectClient):
        async def connect(self):
            self.connect_calls += 1
            # 模拟 client 在 connect 内采纳 hello-ok 新 token（更新 device_token 属性并触发钩子）
            self.device_token = 'dt-rotated-new'
            if self.on_device_token_rotated is not None:
                self.on_device_token_rotated('dt-rotated-new')

    _RotatingClient.instances = []
    _RotatingClient.fail_codes = []
    pairing = _RecordingPairingService(device_token='dt-old')
    pool = ChatConnectionPool(
        pairing_service=pairing, client_factory=_RotatingClient, ws_url_for=_url_for,
    )
    inst = _instance('a', 19001)
    client = await pool.get_or_create(inst)
    assert pairing.token_updates == [(inst, 'dt-rotated-new')]  # 新 token 已落库
    # pool 以新 token re-key：再次 get_or_create 复用同一 client（key 已更新）
    assert client is await pool.get_or_create(inst)
