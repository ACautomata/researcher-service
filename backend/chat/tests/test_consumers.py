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
        self._approval_handler = None

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

    # T06：consumer 注册/退订连接级审批回调 + 回覆
    def set_approval_handler(self, cb):
        self._approval_handler = cb

    async def resolve_approval(self, approval_id, kind, decision):
        self.resolved.append((approval_id, kind, decision))
        return True

    async def emit_approval(self, frame):
        if self._approval_handler is not None:
            await self._approval_handler(frame)


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


async def _connect_authed():
    user = await database_sync_to_async(User.objects.create_user)(
        username='alice', password='strong-pass-1')
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
    except Exception:
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
# 审批卡是连接级（无 runId）：start 后 consumer 注册 client.set_approval_handler 透传给前端；
# 前端发 resolve{id,kind,decision} → consumer 调 client.resolve_approval；disconnect 退订。


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
async def test_resolve_calls_client_resolve_approval(override_pool, instance, fake_client):
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'approve'})
    resp = await comm.receive_json_from()
    assert resp == {'type': 'approvalResolved', 'id': 'ap-1', 'decision': 'approve'}
    assert fake_client.resolved == [('ap-1', 'exec', 'approve')]
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
    await comm.disconnect()


@pytest.mark.asyncio
async def test_disconnect_unsubscribes_approval_handler(override_pool, instance, fake_client):
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.disconnect()
    # disconnect 后 handler 退订：再 emit 不再推给已关闭连接
    assert fake_client._approval_handler is None
