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

from chat.chat_client import ChatConnectError, ChatSendError
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

    async def send_message(self, session_key, message, *, on_event):
        run_id = f'run-{len(self.sent) + 1}'
        self.sent.append((session_key, message))
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

    async def get_or_create(self, instance):
        self.created.append(instance.name)
        return self._client


class NotPairedPool:
    async def get_or_create(self, instance):
        raise NotPaired('pending', 'req-9')


async def _connect_authed(username='alice'):
    user = await database_sync_to_async(User.objects.create_user)(
        username=username, password='strong-pass-1')
    token = str(RefreshToken.for_user(user).access_token)
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
    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'approve'})
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
    wire.resolve_payload = {'id': 'ap-1', 'decision': 'approve'}
    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'approve'})
    resolved = await comm.receive_json_from()
    assert resolved['decision'] == 'approve'
    # disconnect → approved subscriber removed
    await comm.disconnect()
    assert wire._approval_subscribers == []  # pylint: disable=use-implicit-booleaness-not-comparison
    ChatFleet.reset()
