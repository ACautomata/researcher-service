"""seam: chat.consumers —— ChatConsumer 集成（issue #41，验收 ①②③）。

WebsocketCommunicator 经 config.asgi.application（含 JwtAuthMiddleware）。ChatFleet.override 注入
FakePool（conftest.py；FakeChatClient 记录 send_message、可 emit 事件回调）。覆盖：JWT 握手成功、
匿名不可达、start→ready、未知容器 error、未配对 error、send→流式 text/done、多容器切换、审批契约。
issue #214 自愈 + codex #219 各轮见同 seam 的 test_consumers_self_heal.py（本文件超 pylint C0302 拆分）。
"""
import asyncio

import pytest
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator

from chat.chat_client import (
    ChatConnectError,
    ChatPayloadTooLargeError,
    ChatSendError,
)
from chat.pool import ChatFleet
from chat.tests.conftest import (
    FakeChatClient,
    FakePool,
    NotPairedPool,
    _access_token,
    _connect_authed,
)
from config.asgi import application
from containers.models import Instance

# channels database_sync_to_async 在独立线程跑 DB；非 transaction 模式下 SQLite 会锁表。
pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]

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
async def test_send_records_active_session_for_reconnect_recovery(override_pool, instance, fake_client):
    """#196 T4 / #217：consumer _handle_send 记住活跃 sessionKey + 其 on_event 回调，
    供 pool 主动重连后 recovery_session() 传播给替换 client 恢复该会话投影。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    await asyncio.sleep(0.05)  # 等 consumer 走完 _handle_send（send_message + record_active_session）
    assert fake_client.recorded_session is not None
    session_key, on_event = fake_client.recorded_session
    assert session_key == 'sk-1'
    assert callable(on_event)
    await comm.disconnect()


@pytest.mark.asyncio
async def test_disconnect_unregisters_recovery_session(override_pool, instance, fake_client):
    """#217 / codex #236 P2-261：浏览器断开后，consumer 须对称注销池化 client 上记住的恢复回调——
    否则该 client 后续重连把恢复投影投到已关闭 consumer（输出丢失 + 回调异常连累 connect），并保留
    consumer 引用。断开即 recorded_session 被清（unregister_active_session 生效）。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    await asyncio.sleep(0.05)  # 等 record_active_session
    assert fake_client.recorded_session is not None
    await comm.disconnect()
    await asyncio.sleep(0.05)  # 等 consumer disconnect() 跑对称注销
    assert fake_client.recorded_session is None, '断开后恢复回调未注销'


@pytest.mark.asyncio
async def test_switch_container_unregisters_old_recovery_session(override_pool, instance, fake_client):
    """#217 / codex #236 P2-261：切容器换 client 前，须把旧 client 上的恢复回调注销（旧 client 重连
    不应再把本 consumer 的恢复投影投出）。新容器用**不同** client（stage_next），旧 client 即被注销对象。"""
    await database_sync_to_async(Instance.objects.create)(
        name='other', port=19001, token='gw2', home_dir='/tmp/y', image='img:tag')
    other_client = FakeChatClient()
    override_pool.stage_next(other_client)  # 旧 client dead 后 get_or_create 换用的新 client
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    await asyncio.sleep(0.05)
    assert fake_client.recorded_session is not None
    fake_client.dead = True  # get_or_create 仅对 dead 缓存驱逐换 _next（FakePool 语义）
    await comm.send_json_to({'type': 'start', 'container': 'other'})
    await comm.receive_json_from()  # ready(other)
    await asyncio.sleep(0.05)
    # 旧 client 上的恢复回调已随切容器注销；新 client 尚未 send → 无记住
    assert fake_client.recorded_session is None, '切容器后旧 client 恢复回调未注销'
    assert other_client.recorded_session is None
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
    """chat.send 被网关拒（普通 ChatSendError，非超限）→ 走通用「发送失败」，不透传英文技术文案
    （codex review / #216：spec 只要求把超限这一种映射为可理解错误，其他 ChatSendError 不 scope-creep）。"""

    async def fail_send(*args, **kwargs):
        raise ChatSendError('rate limit')

    fake_client.send_message = fail_send
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk', 'message': 'hi'})
    resp = await comm.receive_json_from()
    assert resp == {'type': 'error', 'message': '发送失败，请稍后重试'}  # 非超限不透传 'rate limit'
    await comm.disconnect()


@pytest.mark.asyncio
async def test_send_oversized_shows_clear_message_not_generic(override_pool, instance, fake_client):
    """#196 T5 / #216：send_message 帧大小预检超限（ChatPayloadTooLargeError，带明确文案）→ 前端看到
    「消息超过网关帧大小上限…请分段发送」而非笼统「发送失败，请稍后重试」（区别于真连接断开）。
    本地预检拒绝、连接未断——不应让用户误以为容器掉线。"""

    async def oversized_send(*args, **kwargs):
        raise ChatPayloadTooLargeError('消息超过网关帧大小上限 25 MB，请分段发送')

    fake_client.send_message = oversized_send
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk', 'message': 'x' * 1000})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    assert '帧大小上限' in resp['message']
    assert '分段发送' in resp['message']
    assert '容器连接断开' not in resp['message']
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
    """FakeChatClient + dead/connect/close 语义的 consumer 测试替身（#231 收敛后：

    此替身仅模拟 consumer 实际调用的方法集——send_message/resolve_approval/list_pending_approvals/
    add_approval_subscriber/remove_approval_subscriber/discard + dead/discard。额外的
    sessions_rpc/connect/close 是历史遗留的富余方法，consumer 不调用；收敛后 OpenClawWire Port
    已收窄（无 sessions_rpc/close——具名 session 方法 + aclose），consumer 与本替身均不依赖它们，
    故原样保留不删（测试替身可比 Port 富，向下闭合）。
    """

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
