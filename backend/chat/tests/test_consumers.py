"""seam: chat.consumers —— ChatConsumer 集成（issue #41，验收 ①②③）。

WebsocketCommunicator 经 config.asgi.application（含 JwtAuthMiddleware）。ChatFleet.override 注入
FakePool（FakeChatClient 记录 send_message、可 emit 事件回调）。覆盖：JWT 握手成功、匿名不可达、
start→ready、未知容器 error、未配对 error、send→流式 text/done、多容器切换。
"""
import asyncio

import pytest
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.tokens import RefreshToken

from chat.chat_client import ChatConnectError, ChatSendError, ChatSendTransmittedError
from chat.pool import ChatFleet, NotPaired
from config.asgi import application
from containers.models import Instance

User = get_user_model()
# channels database_sync_to_async 在独立线程跑 DB；非 transaction 模式下 SQLite 会锁表。
pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]


class FakeChatClient:
    """记录 send_message 的 client 替身；emit 直接触发注册过的 on_event 回调。"""

    def __init__(self):
        self.sent = []  # (session_key, message)
        self._handlers = {}
        self.discarded = []
        self.resolved = []  # (approval_id, kind, decision)
        self.resolve_payload = {}  # resolve_approval 返回的权威 payload
        self.pending = []  # start 时补拉的待审批卡（codex P2 断线恢复）
        self._approval_subscribers = []
        # issue #214 T2：对齐真实 client 的 public dead 契约（chat_client.dead = _dead or _closed）。
        # consumer 自愈据此判定；真实场景由 #213 T1 看门狗/CancelledError 置位。
        self.dead = False
        # codex #219 P1：记录每次 send_message 收到的 idempotency_key（验证重试复用同 key）。
        self.sent_idempotency_keys = []

    async def send_message(self, session_key, message, *, on_event, idempotency_key=None):
        run_id = f'run-{len(self.sent) + 1}'
        self.sent.append((session_key, message))
        self.sent_idempotency_keys.append(idempotency_key)
        self._handlers[run_id] = on_event
        return run_id

    def discard(self, run_id):
        self.discarded.append(run_id)
        self._handlers.pop(run_id, None)

    async def emit(self, frame):
        cb = self._handlers.get(frame.get('runId'))
        if cb is not None:
            await cb(frame)

    # T06：订阅者集合（codex P1）+ 权威 decision 回覆 + start 补拉待审批（codex P2）
    def add_approval_subscriber(self, cb):
        if cb not in self._approval_subscribers:
            self._approval_subscribers.append(cb)

    def remove_approval_subscriber(self, cb):
        if cb in self._approval_subscribers:
            self._approval_subscribers.remove(cb)

    def approval_subscribers(self):
        # codex #219 P2：对齐真实 client 的迁移访问器（_reacquire_client 迁全部订阅者用）。
        return list(self._approval_subscribers)

    async def resolve_approval(self, approval_id, kind, decision):
        self.resolved.append((approval_id, kind, decision))
        return self.resolve_payload

    async def broadcast_approval_resolved(self, approval_id, decision):
        # 与真实 client 一致：fan-out approvalResolved 到全部订阅者（codex R2 P2 副本收敛）
        await self.emit_approval({'type': 'approvalResolved', 'id': approval_id, 'decision': decision})

    async def list_pending_approvals(self):
        return list(self.pending)

    async def emit_approval(self, frame):
        for cb in list(self._approval_subscribers):
            await cb(frame)


class FakePool:
    def __init__(self, client):
        self._client = client
        self.created = []

    def set_client(self, client):
        # issue #214：替换 get_or_create 将返回的 client（模拟 pool 驱逐死连接后重建新 client）。
        self._client = client

    async def get_or_create(self, instance):
        self.created.append(instance.name)
        return self._client

    async def get_live(self, instance):
        # codex #219 P2：对齐真实 pool 的非创建式查活——返回当前存活 client（dead 则 None）。
        if self._client is not None and not getattr(self._client, 'dead', False):
            return self._client
        return None


class NotPairedPool:
    async def get_or_create(self, instance):
        raise NotPaired('pending', 'req-9')

    async def get_live(self, instance):
        return None


async def _access_token(username='alice'):
    user = await database_sync_to_async(User.objects.create_user)(
        username=username, password='strong-pass-1')
    return str(RefreshToken.for_user(user).access_token)


async def _connect_authed(username='alice'):
    token = await _access_token(username)
    return WebsocketCommunicator(
        application, '/ws/chat/', subprotocols=['access_token', token])


@pytest.fixture
def fake_client():
    return FakeChatClient()


@pytest.fixture
def override_pool(fake_client):
    pool = FakePool(fake_client)
    ChatFleet.override(pool)
    yield pool
    ChatFleet.reset()


@pytest.fixture
def instance():
    return Instance.objects.create(
        name='demo', port=19000, token='gw', home_dir='/tmp/x',
        status=Instance.STATUS_RUNNING, image='img:tag',
    )


@pytest.mark.asyncio
async def test_jwt_handshake_accepted_for_authenticated_user(instance):
    comm = await _connect_authed()
    connected, _ = await comm.connect()
    assert connected
    await comm.disconnect()


@pytest.mark.asyncio
async def test_single_value_subprotocol_echo(instance):
    """codex #190 P2: 单值格式 ['access_token.<jwt>'] 服务器必须原样回显 subprotocol。"""
    token = await _access_token('alice')
    full_proto = f'access_token.{token}'
    comm = WebsocketCommunicator(application, '/ws/chat/', subprotocols=[full_proto])
    connected, subprotocol = await comm.connect()
    assert connected is True
    assert subprotocol == full_proto, (
        f'expected subprotocol={full_proto!r} to be echoed, got {subprotocol!r}'
    )
    await comm.disconnect()


@pytest.mark.asyncio
async def test_anonymous_handshake_cannot_reach_consumer():
    # JwtAuthMiddleware 匿名 accept+close(4401)；ChatConsumer 不应被触达
    comm = WebsocketCommunicator(application, '/ws/chat/')
    await comm.connect()
    try:
        await comm.send_json_to({'type': 'start', 'container': 'demo'})
    except Exception:  # pylint: disable=broad-exception-caught
        pass
    # 不会收到业务帧（ready/error）；receive 会拿到 close 帧 → receive_json_from 内部断言失败
    with pytest.raises(AssertionError):
        await asyncio.wait_for(comm.receive_json_from(), timeout=1.0)
    await comm.disconnect()


@pytest.mark.asyncio
async def test_start_emits_ready(override_pool, instance):
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    resp = await comm.receive_json_from()
    assert resp == {'type': 'ready', 'container': 'demo'}
    assert override_pool.created == ['demo']
    await comm.disconnect()


@pytest.mark.asyncio
async def test_start_unknown_container_sends_error(override_pool):
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'nope'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    await comm.disconnect()


@pytest.mark.asyncio
async def test_start_unpaired_sends_error(instance):
    ChatFleet.override(NotPairedPool())
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    assert '配对' in resp['message']
    ChatFleet.reset()
    await comm.disconnect()


@pytest.mark.asyncio
async def test_send_streams_text_then_done(override_pool, instance, fake_client):
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    await asyncio.sleep(0.05)  # 等 consumer 调 send_message 注册 on_event
    await fake_client.emit({'type': 'text', 'runId': 'run-1', 'delta': '你好'})
    await fake_client.emit({'type': 'done', 'runId': 'run-1'})
    text_frame = await comm.receive_json_from()
    assert text_frame == {'type': 'text', 'runId': 'run-1', 'delta': '你好'}
    done_frame = await comm.receive_json_from()
    assert done_frame == {'type': 'done', 'runId': 'run-1'}
    await comm.disconnect()


@pytest.mark.asyncio
async def test_multi_container_switch(override_pool, instance):
    await database_sync_to_async(Instance.objects.create)(
        name='other', port=19001, token='gw2', home_dir='/tmp/y', image='img:tag')
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    r1 = await comm.receive_json_from()
    await comm.send_json_to({'type': 'start', 'container': 'other'})
    r2 = await comm.receive_json_from()
    assert r1 == {'type': 'ready', 'container': 'demo'}
    assert r2 == {'type': 'ready', 'container': 'other'}
    assert override_pool.created == ['demo', 'other']
    await comm.disconnect()


@pytest.mark.asyncio
async def test_send_failure_sends_error_frame_not_crash(override_pool, instance, fake_client):
    """chat.send 被网关拒（ChatSendError）→ 发 error 帧，不传播导致 WS 关闭。"""

    async def fail_send(*args, **kwargs):
        raise ChatSendError('rate limit')

    fake_client.send_message = fail_send
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk', 'message': 'hi'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    await comm.disconnect()


@pytest.mark.asyncio
async def test_start_connect_failure_sends_error_frame(instance):
    """pool.get_or_create 内连接握手失败（ChatConnectError）→ 发 error 帧，不 crash。"""

    class ConnectFailPool:
        async def get_or_create(self, instance):
            raise ChatConnectError('network down')

    ChatFleet.override(ConnectFailPool())
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    ChatFleet.reset()
    await comm.disconnect()


# ---- T06 权限审批（issue #42 / spec §8.2）----
# 审批卡是连接级（无 runId）：start 后 consumer add_approval_subscriber 订阅、disconnect 独立退订
# （codex P1 订阅者集合，多 consumer 共享 client 不互伤）；前端发 resolve{id,kind,decision} →
# client.resolve_approval → 回执用权威 decision（codex P1 first-answer-wins）；start 补拉待审批
# （codex P2 断线恢复）。


@pytest.mark.asyncio
async def test_approval_card_pushed_to_frontend(override_pool, instance, fake_client):
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await fake_client.emit_approval(
        {'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'rm -rf /tmp'})
    frame = await comm.receive_json_from()
    assert frame == {'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'rm -rf /tmp'}
    await comm.disconnect()


@pytest.mark.asyncio
async def test_two_consumers_both_receive_approval(override_pool, instance, fake_client):
    """codex P1：两个 consumer 共享同一 pooled client，审批卡 fan-out 到两者（不互相覆盖）。"""
    comm_a = await _connect_authed('alice')
    await comm_a.connect()
    await comm_a.send_json_to({'type': 'start', 'container': 'demo'})
    await comm_a.receive_json_from()  # A ready
    comm_b = await _connect_authed('bob')
    await comm_b.connect()
    await comm_b.send_json_to({'type': 'start', 'container': 'demo'})
    await comm_b.receive_json_from()  # B ready
    await fake_client.emit_approval({'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'x'})
    fa = await comm_a.receive_json_from()
    fb = await comm_b.receive_json_from()
    assert fa['id'] == 'ap-1'
    assert fb['id'] == 'ap-1'
    await comm_a.disconnect()
    await comm_b.disconnect()


@pytest.mark.asyncio
async def test_disconnect_one_keeps_peer_subscribed(override_pool, instance, fake_client):
    """codex P1：A 断开退订不影响仍活跃的 B；B 之后仍收审批卡。"""
    comm_a = await _connect_authed('alice')
    await comm_a.connect()
    await comm_a.send_json_to({'type': 'start', 'container': 'demo'})
    await comm_a.receive_json_from()
    comm_b = await _connect_authed('bob')
    await comm_b.connect()
    await comm_b.send_json_to({'type': 'start', 'container': 'demo'})
    await comm_b.receive_json_from()
    await comm_a.disconnect()  # A 断开
    await asyncio.sleep(0.02)
    await fake_client.emit_approval({'type': 'approval', 'id': 'ap-2', 'kind': 'exec', 'command': 'y'})
    fb = await comm_b.receive_json_from()
    assert fb['id'] == 'ap-2'  # B 仍收
    await comm_b.disconnect()


@pytest.mark.asyncio
async def test_resolve_awaits_resolved_event(override_pool, instance, fake_client):
    """codex P2 #163：resolve ack 不应回送 approvalResolved——权威值由 resolved 事件负责。"""
    fake_client.resolve_payload = {'id': 'ap-1'}
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'})
    # resolve 应静默成功，不应发送 approvalResolved（权威值由 resolved 事件 broadcast）
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(comm.receive_json_from(), timeout=0.5)
    assert fake_client.resolved == [('ap-1', 'exec', 'allow-once')]
    await comm.disconnect()


@pytest.mark.asyncio
async def test_resolve_peer_receives_nothing_from_ack(override_pool, instance, fake_client):
    """codex P2 #163：resolve ack 无广播——对等端不应收到任何帧。"""
    fake_client.resolve_payload = {'id': 'ap-1'}
    comm_a = await _connect_authed('alice')
    await comm_a.connect()
    await comm_a.send_json_to({'type': 'start', 'container': 'demo'})
    await comm_a.receive_json_from()  # A ready
    comm_b = await _connect_authed('bob')
    await comm_b.connect()
    await comm_b.send_json_to({'type': 'start', 'container': 'demo'})
    await comm_b.receive_json_from()  # B ready
    # A 提交 resolve
    await comm_a.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'})
    # A 不应收到任何 immediate feedback
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(comm_a.receive_json_from(), timeout=0.5)
    # B 不应收到任何广播
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(comm_b.receive_json_from(), timeout=0.5)
    await comm_a.disconnect()
    await comm_b.disconnect()


@pytest.mark.asyncio
async def test_start_replays_pending_approvals(override_pool, instance, fake_client):
    """codex P2：断线期间积累的待审批，start 后补拉推给前端（agent 不再卡死）。"""
    fake_client.pending = [
        {'type': 'approval', 'id': 'ap-old', 'kind': 'exec', 'command': 'stale cmd'},
    ]
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    frame = await comm.receive_json_from()  # 补拉的待审批卡
    assert frame == {'type': 'approval', 'id': 'ap-old', 'kind': 'exec', 'command': 'stale cmd'}
    await comm.disconnect()


@pytest.mark.asyncio
async def test_resolve_without_start_sends_error(override_pool, instance):
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'deny'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    await comm.disconnect()


@pytest.mark.asyncio
async def test_resolve_failure_sends_error(override_pool, instance, fake_client):
    async def fail_resolve(*args):
        raise ChatSendError('missing scope operator.approvals')
    fake_client.resolve_approval = fail_resolve
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    assert resp['id'] == 'ap-1'  # codex R2 P2：error 帧带 approval id，前端仅复位该卡
    await comm.disconnect()


@pytest.mark.asyncio
async def test_resolve_rejects_invalid_kind(override_pool, instance, fake_client):
    """codex P2：非法 kind 应在消费端拒绝，不转发到网关。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'typo', 'decision': 'deny'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    assert '非法 kind' in resp.get('message', '')
    # resolve_approval 应未被调用（在消费端即被拒绝）
    assert fake_client.resolved == []
    await comm.disconnect()


@pytest.mark.asyncio
async def test_resolve_rejects_invalid_decision(override_pool, instance, fake_client):
    """codex P2 #163：非法 decision 应在消费端拒绝，不转发到网关。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'approve'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    assert '非法 decision' in resp.get('message', '')
    assert fake_client.resolved == []
    await comm.disconnect()


@pytest.mark.asyncio
async def test_disconnect_unsubscribes_approval(override_pool, instance, fake_client):
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.disconnect()
    # disconnect 后订阅者退订：再 emit 不再推给已关闭连接
    assert fake_client._approval_subscribers == []


# ── issue #103: ChatConsumer 经 OpenClawWire Port 验证 ────────────────────


class FakeWirePort(FakeChatClient):
    """FakeChatClient 兼容 OpenClawWire Port 契约：添加 dead/sessions_rpc/connect/close。"""

    def __init__(self):
        super().__init__()
        self.dead = False
        self.rpc_calls: list[tuple[str, dict]] = []

    async def sessions_rpc(self, method: str, params: dict) -> dict:
        self.rpc_calls.append((method, params))
        return {}

    async def connect(self, url: str, device_token: str) -> None:
        self.dead = False

    async def close(self) -> None:
        self.dead = True


@pytest.mark.asyncio
async def test_consumer_operates_via_wire_port_contract(override_pool, instance):
    """acceptance #103：ChatConsumer 的 start/send/resolve 均经 Wire Port 合约完成。

    FakeWirePort 同时实现 FakeChatClient 的语义 + OpenClawWire Port 契约。
    consumer 不感知 Wire Port 类型差异——走同一 call 模式（send_message/resolve_approval/
    add_approval_subscriber/remove_approval_subscriber/list_pending_approvals）。
    """
    wire = FakeWirePort()
    pool = FakePool(wire)
    ChatFleet.override(pool)
    comm = await _connect_authed()
    await comm.connect()
    # start → ready
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    resp = await comm.receive_json_from()
    assert resp == {'type': 'ready', 'container': 'demo'}
    # send → text→done 流
    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk', 'message': 'hi'})
    await asyncio.sleep(0.05)
    await wire.emit({'type': 'text', 'runId': 'run-1', 'delta': 'hi'})
    await wire.emit({'type': 'done', 'runId': 'run-1'})
    text = await comm.receive_json_from()
    assert text['type'] == 'text'
    done = await comm.receive_json_from()
    assert done['type'] == 'done'
    # resolve
    wire.resolve_payload = {}
    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'})
    # resolve ack 是静默的（权威值由 resolved 事件落地，codex P2 #163）
    # 模拟网关广播 resolved 事件
    await wire.emit_approval({'type': 'approvalResolved', 'id': 'ap-1', 'decision': 'allow-once'})
    resolved = await comm.receive_json_from()
    assert resolved == {'type': 'approvalResolved', 'id': 'ap-1', 'decision': 'allow-once'}
    # disconnect → approved subscriber removed
    await comm.disconnect()
    assert wire._approval_subscribers == []  # pylint: disable=use-implicit-booleaness-not-comparison
    ChatFleet.reset()


# ── issue #214 T2：consumer 发送失效自愈（检测 dead，有界重取重试一次）────────────
# 一次 task 取消 / 跨 loop 清理（REST 触发，根因归 #201）后，pool 已驱逐重建新 client，
# 但本 consumer 仍缓存旧死 client。自愈：_handle_send/_handle_resolve 失败时检测
# self._client.dead，dead 则经 get_or_create(self._instance) 重取一次并重试（有界一次，
# 防循环）；重取成功后刷新 approval 订阅（旧退订、新订阅，对齐 _handle_start 切换逻辑）。
# 非 dead 的失败（如 rate limit）不重取，直接 error 帧。dead 判定靠 #213 T1 保证。


@pytest.mark.asyncio
async def test_send_dead_client_reacquires_and_retries(override_pool, instance, fake_client):
    """AC1：cached client dead 且 send 抛错 → 重取一次 + 新 client 重试成功发流。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    # pool 驱逐旧死 client、重建新 client（模拟 #213 看门狗置 dead 后的重建）。
    fresh = FakeChatClient()
    override_pool.set_client(fresh)
    fake_client.dead = True  # consumer 缓存的旧 client 已死

    async def dead_send(*args, **kwargs):
        raise ChatSendError('client not connected')

    fake_client.send_message = dead_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    await asyncio.sleep(0.05)  # 等自愈重取 + 新 client 注册 on_event
    await fresh.emit({'type': 'text', 'runId': 'run-1', 'delta': '你好'})
    await fresh.emit({'type': 'done', 'runId': 'run-1'})
    text_frame = await comm.receive_json_from()
    assert text_frame == {'type': 'text', 'runId': 'run-1', 'delta': '你好'}
    done_frame = await comm.receive_json_from()
    assert done_frame == {'type': 'done', 'runId': 'run-1'}
    # 有界一次重取：start 一次 + 自愈一次，共两次，无循环
    assert override_pool.created == ['demo', 'demo']
    assert fresh.sent == [('sk-1', '你好')]  # 重试落在唯一的新 client 上
    await comm.disconnect()


@pytest.mark.asyncio
async def test_reacquire_refreshes_approval_subscription(override_pool, instance, fake_client):
    """AC2：重取成功后 approval 订阅刷新——旧 client 退订、新 client 订阅本 consumer 回调。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    assert len(fake_client._approval_subscribers) == 1  # start 已订阅

    fresh = FakeChatClient()
    override_pool.set_client(fresh)
    fake_client.dead = True

    async def dead_send(*args, **kwargs):
        raise ChatSendError('client not connected')

    fake_client.send_message = dead_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': 'hi'})
    await asyncio.sleep(0.05)  # 等自愈完成
    # 旧 client 退订、新 client 订阅（同一 consumer 回调迁移）
    assert fake_client._approval_subscribers == []
    assert len(fresh._approval_subscribers) == 1
    # 新 client 的审批卡能 fan-out 到本 consumer
    await fresh.emit_approval({'type': 'approval', 'id': 'ap-9', 'kind': 'exec', 'command': 'x'})
    # 先排空 send 自愈成功的无任何帧——send 成功不推帧，直接收审批卡
    frame = await comm.receive_json_from()
    assert frame == {'type': 'approval', 'id': 'ap-9', 'kind': 'exec', 'command': 'x'}
    await comm.disconnect()


@pytest.mark.asyncio
async def test_resolve_dead_client_reacquires_and_retries(override_pool, instance, fake_client):
    """AC3：_handle_resolve 复用同一自愈 helper——dead + resolve 抛错 → 重取重试一次。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    fresh = FakeChatClient()
    override_pool.set_client(fresh)
    fake_client.dead = True

    async def dead_resolve(*args):
        raise ChatSendError('client not connected')

    fake_client.resolve_approval = dead_resolve

    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'})
    # resolve 成功是静默的（无 immediate 帧，权威值由 resolved 事件落地，codex P2 #163）
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(comm.receive_json_from(), timeout=0.5)
    # 重试落在新 client 上；有界一次重取
    assert fresh.resolved == [('ap-1', 'exec', 'allow-once')]
    assert override_pool.created == ['demo', 'demo']
    await comm.disconnect()


@pytest.mark.asyncio
async def test_send_nondead_failure_does_not_reacquire(override_pool, instance, fake_client):
    """AC4：send 失败但 client 非 dead（如 rate limit）→ 不重取，直接 error 帧。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    assert override_pool.created == ['demo']  # start 取一次

    async def fail_send(*args, **kwargs):
        raise ChatSendError('rate limit')

    fake_client.send_message = fail_send  # 非 dead（fake_client.dead 仍 False）

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk', 'message': 'hi'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    # 非 dead：不触发重取，仍只 start 那一条
    assert override_pool.created == ['demo']
    await comm.disconnect()


# ── codex #219 P1 回归：自愈重试的两处漏洞 ────────────────────────────────────
# ① 自愈重试须复用同一 idempotencyKey——否则网关收下原 chat.send 但 ack 随死连接丢失时，
#    重试带新 key 会被当作新操作，起两个 run、工具被执行两次。
# ② 自愈换 client 后须补拉 list_pending_approvals——订阅只投未来事件，旧 client 收循环
#    死亡期间积累的待审批不随新订阅到达，不补拉则 agent 卡死直到用户手动再 start。


@pytest.mark.asyncio
async def test_send_initial_and_retry_share_same_key(override_pool, instance, fake_client):
    """codex #219 P1①：初次与重试携带**相同** idempotencyKey（捕捉初次 key 比对重试 key）。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    fresh = FakeChatClient()
    override_pool.set_client(fresh)
    fake_client.dead = True

    captured = []  # 初次发送实际收到的 key

    async def dead_send(session_key, message, *, on_event, idempotency_key=None):
        captured.append(idempotency_key)
        raise ChatSendError('client not connected')

    fake_client.send_message = dead_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    await asyncio.sleep(0.05)
    assert len(captured) == 1  # 初次一次
    assert len(fresh.sent_idempotency_keys) == 1  # 重试一次
    # 关键：初次 key == 重试 key（网关据此幂等去重，不起两个 run）
    assert captured[0] == fresh.sent_idempotency_keys[0]
    assert captured[0]  # 非空
    await comm.disconnect()


@pytest.mark.asyncio
async def test_reacquire_pulls_pending_approvals(override_pool, instance, fake_client):
    """codex #219 P1②：自愈换 client 后补拉待审批——死循环期间积累的卡经新 client 补到前端。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    fresh = FakeChatClient()
    # 旧 client 收循环死亡期间积累的待审批：换到的新 client 经 list_pending_approvals 返回
    fresh.pending = [{'type': 'approval', 'id': 'ap-pend', 'kind': 'exec', 'command': 'curl x'}]
    override_pool.set_client(fresh)
    fake_client.dead = True

    async def dead_send(*args, **kwargs):
        raise ChatSendError('client not connected')

    fake_client.send_message = dead_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': 'hi'})
    # 自愈换 client 后补拉的待审批卡应被推到前端（send 成功不推帧，首个收到的即是补拉卡）
    frame = await comm.receive_json_from()
    assert frame == {'type': 'approval', 'id': 'ap-pend', 'kind': 'exec', 'command': 'curl x'}
    await comm.disconnect()


@pytest.mark.asyncio
async def test_reacquire_migrates_all_shared_subscribers(override_pool, instance, fake_client):
    """codex #219 P2：共享 client 自愈——所有 consumer（不只触发自愈的）迁到 fresh 并收补拉卡。

    A 触发自愈换 client；被动 consumer B 不能滞留死 client——B 的订阅也迁到 fresh，
    补拉的待审批 fan-out 到 A、B 两端（保住共享 fan-out 契约）。
    """
    comm_a = await _connect_authed('alice')
    await comm_a.connect()
    await comm_a.send_json_to({'type': 'start', 'container': 'demo'})
    await comm_a.receive_json_from()  # A ready
    comm_b = await _connect_authed('bob')
    await comm_b.connect()
    await comm_b.send_json_to({'type': 'start', 'container': 'demo'})
    await comm_b.receive_json_from()  # B ready
    assert len(fake_client._approval_subscribers) == 2  # A、B 共享旧 client

    fresh = FakeChatClient()
    fresh.pending = [{'type': 'approval', 'id': 'ap-shared', 'kind': 'exec', 'command': 'curl y'}]
    override_pool.set_client(fresh)
    fake_client.dead = True

    async def dead_send(*args, **kwargs):
        raise ChatSendError('client not connected')

    fake_client.send_message = dead_send

    # A 触发 send → 旧 client dead → 自愈换 fresh
    await comm_a.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': 'hi'})
    # 补拉的待审批卡 fan-out：A、B 都收到（不只 A）
    fa = await comm_a.receive_json_from()
    fb = await comm_b.receive_json_from()
    assert fa == {'type': 'approval', 'id': 'ap-shared', 'kind': 'exec', 'command': 'curl y'}
    assert fb == {'type': 'approval', 'id': 'ap-shared', 'kind': 'exec', 'command': 'curl y'}
    # 全部订阅者迁到 fresh（旧 client 退空、fresh 有 A+B 两个）
    assert fake_client._approval_subscribers == []
    assert len(fresh._approval_subscribers) == 2
    # B 也能收 fresh 上的新审批（不只 A）
    await fresh.emit_approval({'type': 'approval', 'id': 'ap-live', 'kind': 'exec', 'command': 'z'})
    fb2 = await comm_b.receive_json_from()
    assert fb2['id'] == 'ap-live'
    await comm_a.disconnect()
    await asyncio.sleep(0.02)
    # codex #219 P2 残留泄漏修复：被动 consumer B 断开时经 pool 再解析活 client（fresh）退订——
    # 不能因缓存的 self._client 仍是死 client 而把 B 的回调泄漏在 fresh 上。
    await comm_b.disconnect()
    await asyncio.sleep(0.02)
    assert len(fresh._approval_subscribers) == 0  # A、B 均从 fresh 退订，无泄漏


# ── codex #219 P1③：已发出但 ack 丢失的 send 不盲重试 ────────────────────────
# 帧已 send、ack 在连接死前丢失（ChatSendTransmittedError）：网关可能已起 run，其事件流
# 绑在死连接上（runId 连接级，重连不可恢复）。盲重试被幂等去重到同一 runId，但新 route
# 收不到事件 → 浏览器 pending 永久卡。故 consumer 不重试，发终态 error 解锁前端。


@pytest.mark.asyncio
async def test_send_transmitted_failure_does_not_retry(override_pool, instance, fake_client):
    """codex #219 P1③：原 send 已发出但 ack 丢失 → 不重发 chat.send，发终态 error 帧。

    codex #219 P1 二轮：但**仍重取连接**（迁移全体订阅者 + 补拉待审批）——旧 client 已死，
    被收下的 run 若起审批须能经新连接投递/补拉，不因 skip 重发而滞留死 client。
    """
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    assert override_pool.created == ['demo']  # start 取一次

    fresh = FakeChatClient()
    fresh.pending = [{'type': 'approval', 'id': 'ap-accepted', 'kind': 'exec', 'command': 'curl z'}]
    override_pool.set_client(fresh)
    fake_client.dead = True  # 旧 client 已死

    async def transmitted_send(*args, **kwargs):
        raise ChatSendTransmittedError('chat.send ack timeout')  # 帧已发出、ack 丢失

    fake_client.send_message = transmitted_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    # 重取后补拉的待审批卡先到（被收下的 run 起的审批经新连接恢复）
    approval_frame = await comm.receive_json_from()
    assert approval_frame == {'type': 'approval', 'id': 'ap-accepted', 'kind': 'exec', 'command': 'curl z'}
    # 再收到终态 error 帧（解锁前端 pending）
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    assert '结果未知' in resp['message']
    # 不重发 chat.send：fresh 上无 send；但**已重取**连接（start 一次 + 自愈一次）
    assert fresh.sent == []
    assert override_pool.created == ['demo', 'demo']
    # 本 consumer 的审批订阅已迁到 fresh（死 client 退空）
    assert fake_client._approval_subscribers == []
    assert len(fresh._approval_subscribers) == 1
    await comm.disconnect()



