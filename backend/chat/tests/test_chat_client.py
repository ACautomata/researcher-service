"""seam: chat.chat_client —— OpenClaw 长连接对话客户端（issue #41 / spec §8.2）。

chat.send + runId 路由：发 chat.send → ack(runId) → chat 事件按 runId 经 translator 翻译回调 on_event。
注入 FakeChatTransport（fakes.py）。覆盖 connect 握手 / send_message 帧与 ack / recv 路由 / stray 容错 /
error 收尾 / discard / ack 失败。
"""
import asyncio

import pytest

from chat.chat_client import ChatClientError, ChatConnectError, ChatSendError, OpenClawChatClient
from chat.device_crypto import DeviceCrypto
from chat.tests.fakes import FakeChatTransport

URL = 'ws://127.0.0.1:19000/'

# issue #139：session connect 帧 device 签名块所需，注入共享假值（这些测试关注路由/ack，不验签）。
_IDENTITY = DeviceCrypto.generate_identity()
_NONCE = 'nz-chat'
_SCOPES = ['operator.read', 'operator.write', 'operator.approvals']


def _client(url=URL, device_token='dt', **kwargs):
    """构造 OpenClawChatClient，默认注入假 identity/nonce/scopes（issue #139 session device 块）。"""
    return OpenClawChatClient(
        url, device_token,
        identity=_IDENTITY, nonce=_NONCE, scopes=_SCOPES, **kwargs,
    )


@pytest.mark.asyncio
async def test_connect_sends_connect_frame_with_device_token():
    t = FakeChatTransport()
    c = _client(device_token='dt-xyz', transport=t)
    await c.connect()
    connect = next(f for f in t.sent if f.get('method') == 'connect')
    assert connect['params']['auth']['token'] == 'dt-xyz'
    await c.aclose()


@pytest.mark.asyncio
async def test_connect_failure_raises():
    t = FakeChatTransport(connect_ok=False)
    c = _client(transport=t)
    with pytest.raises(ChatConnectError):
        await c.connect()


@pytest.mark.asyncio
async def test_send_message_builds_chat_send_frame_and_returns_runid():
    t = FakeChatTransport(ack_run_id='run-9')

    async def on_event(frame):
        pass

    c = _client(transport=t)
    await c.connect()
    run_id = await c.send_message('sess-1', '你好', on_event=on_event)
    assert run_id == 'run-9'
    cs = next(f for f in t.sent if f.get('method') == 'chat.send')
    params = cs['params']
    assert params['sessionKey'] == 'sess-1'
    assert params['message'] == '你好'
    assert params['agentId'] == 'main'
    assert params['idempotencyKey']
    await c.aclose()


@pytest.mark.asyncio
async def test_ack_error_raises_chat_send_error():
    t = FakeChatTransport(ack_error={'code': 'RATE_LIMIT', 'message': 'too fast'})

    async def on_event(frame):
        pass

    c = _client(transport=t)
    await c.connect()
    with pytest.raises(ChatSendError) as exc:
        await c.send_message('s', 'm', on_event=on_event)
    assert 'too fast' in str(exc.value)
    await c.aclose()


@pytest.mark.asyncio
async def test_recv_routes_delta_final_to_on_event():
    events = [
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'delta', 'deltaText': '你好'}},
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'delta', 'deltaText': '世界'}},
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'final'}},
    ]
    t = FakeChatTransport(ack_run_id='r1', events=events)
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    await c.connect()
    await c.send_message('s', 'm', on_event=on_event)
    await asyncio.sleep(0.1)
    assert received == [
        {'type': 'text', 'runId': 'r1', 'delta': '你好'},
        {'type': 'text', 'runId': 'r1', 'delta': '世界'},
        {'type': 'done', 'runId': 'r1'},
    ]
    await c.aclose()


@pytest.mark.asyncio
async def test_recv_ignores_stray_events_and_keeps_routing():
    events = [
        {'type': 'event', 'event': 'tool.start', 'payload': {'runId': 'r1'}},
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'delta', 'deltaText': 'x'}},
        {'type': 'event', 'event': 'noise', 'payload': {}},
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'final'}},
    ]
    t = FakeChatTransport(ack_run_id='r1', events=events)
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    await c.connect()
    await c.send_message('s', 'm', on_event=on_event)
    await asyncio.sleep(0.1)
    assert received == [
        {'type': 'text', 'runId': 'r1', 'delta': 'x'},
        {'type': 'done', 'runId': 'r1'},
    ]
    await c.aclose()


@pytest.mark.asyncio
async def test_recv_routes_tool_events_to_on_event():
    # T08（issue #44）：agent.tool.start/result 挂在 chat run 内、带 runId → 经既有 runId 路由推给 on_event
    # （chat_client 无需改动；translator 产 tool 帧，_handle 按 frames[0].runId 路由，tool 非终态不清 route）
    events = [
        {'type': 'event', 'event': 'agent.tool.start',
         'payload': {'runId': 'r1', 'tool': 'wiki.search', 'input': {'query': 'x'}}},
        {'type': 'event', 'event': 'agent.tool.result',
         'payload': {'runId': 'r1', 'tool': 'wiki.search', 'result': {'count': 3}}},
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'final'}},
    ]
    t = FakeChatTransport(ack_run_id='r1', events=events)
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    await c.connect()
    await c.send_message('s', 'm', on_event=on_event)
    await asyncio.sleep(0.1)
    assert received == [
        {'type': 'tool', 'runId': 'r1', 'name': 'wiki.search', 'state': 'running',
         'id': None, 'title': None, 'input': {'query': 'x'}, 'result': None},
        {'type': 'tool', 'runId': 'r1', 'name': 'wiki.search', 'state': 'done',
         'id': None, 'title': None, 'input': None, 'result': {'count': 3}},
        {'type': 'done', 'runId': 'r1'},
    ]
    await c.aclose()


@pytest.mark.asyncio
async def test_error_state_completes_with_error_event():
    events = [
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'delta', 'deltaText': 'x'}},
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'error', 'errorMessage': '模型错'}},
    ]
    t = FakeChatTransport(ack_run_id='r1', events=events)
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    await c.connect()
    await c.send_message('s', 'm', on_event=on_event)
    await asyncio.sleep(0.1)
    assert received[-1] == {'type': 'error', 'runId': 'r1', 'message': '模型错'}
    await c.aclose()


@pytest.mark.asyncio
async def test_discard_stops_routing_subsequent_events():
    events = [
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'delta', 'deltaText': 'a'}},
    ]
    t = FakeChatTransport(ack_run_id='r1', events=events)
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    await c.connect()
    await c.send_message('s', 'm', on_event=on_event)
    await asyncio.sleep(0.05)
    assert received == [{'type': 'text', 'runId': 'r1', 'delta': 'a'}]
    c.discard('r1')
    t.push({'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'delta', 'deltaText': 'b'}})
    t.push({'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'final'}})
    await asyncio.sleep(0.05)
    # discard 后该 runId 事件不再回调
    assert all(fr.get('delta') != 'b' for fr in received)
    assert all(fr.get('type') != 'done' for fr in received)
    await c.aclose()


@pytest.mark.asyncio
async def test_on_event_exception_does_not_kill_recv_loop():
    """单 route 的 on_event 抛异常不应杀整个 recv loop；同 route 后续事件仍送达。"""
    events = [
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'delta', 'deltaText': 'a'}},
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'delta', 'deltaText': 'b'}},
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'final'}},
    ]
    t = FakeChatTransport(ack_run_id='r1', events=events)
    received = []
    call_count = [0]

    async def on_event(frame):
        call_count[0] += 1
        if call_count[0] == 1:
            raise RuntimeError('boom')
        received.append(frame)

    c = _client(transport=t)
    await c.connect()
    await c.send_message('s', 'm', on_event=on_event)
    await asyncio.sleep(0.1)
    # 第一次回调抛异常被隔离；后续 delta/final 仍送达
    assert any(fr.get('delta') == 'b' for fr in received)
    assert any(fr.get('type') == 'done' for fr in received)
    await c.aclose()


@pytest.mark.asyncio
async def test_aclose_rejects_pending_send_message():
    """aclose 时若有未决 ack，send_message 抛 ChatClientError 而非永久挂起。"""
    t = FakeChatTransport(suppress_ack=True)  # 不回 ack，send_message 永久等待

    async def on_event(frame):
        pass

    c = _client(transport=t)
    await c.connect()
    task = asyncio.create_task(c.send_message('s', 'm', on_event=on_event))
    await asyncio.sleep(0.05)  # send_message 已发 chat.send，在等 ack
    await c.aclose()
    with pytest.raises(ChatClientError):
        await task


@pytest.mark.asyncio
async def test_connect_handshake_timeout_raises_connect_error():
    # 网关升级 WS 后永不回 connect res → _await_res 挂起 → connect_timeout 触发 ChatConnectError
    t = FakeChatTransport(suppress_connect_ack=True)
    c = _client(transport=t, connect_timeout=0.1)
    with pytest.raises(ChatConnectError):
        await c.connect()


@pytest.mark.asyncio
async def test_send_message_times_out_when_ack_never_arrives():
    # 网关连着但不回 chat.send ack → send_message 不应永久挂起；超时后清理 pending 条目
    t = FakeChatTransport(suppress_ack=True)
    c = _client(transport=t, ack_timeout=0.1)
    await c.connect()

    async def on_event(frame):
        pass

    with pytest.raises(ChatSendError):
        await c.send_message('s', 'm', on_event=on_event)
    assert c._pending_acks == {}  # pylint: disable=use-implicit-booleaness-not-comparison
    await c.aclose()


# ---- T06 权限审批（issue #42 / spec §8.2）----
# 审批事件是连接级（无 runId）→ 走连接级审批订阅者集合，不进 runId 路由；
# resolve_approval 发 approval.resolve 方法帧（id+kind+decision），有界等 res，返回权威 payload。


@pytest.mark.asyncio
async def test_approval_event_fans_out_to_all_subscribers():
    """codex P1：多 consumer 共享同一 client 时，两个订阅者都收到审批卡（不互相覆盖）。"""
    t = FakeChatTransport()
    a_received, b_received = [], []

    async def a_cb(frame):
        a_received.append(frame)

    async def b_cb(frame):
        b_received.append(frame)

    c = _client(transport=t)
    c.add_approval_subscriber(a_cb)
    c.add_approval_subscriber(b_cb)
    await c.connect()
    t.push({'type': 'event', 'event': 'exec.approval.requested',
            'payload': {'id': 'ap-1', 'kind': 'exec', 'systemRunPlan': {'rawCommand': 'rm -rf /tmp'}}})
    await asyncio.sleep(0.05)
    expected = [{'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'rm -rf /tmp', 'sessionKey': None}]
    assert a_received == expected
    assert b_received == expected
    await c.aclose()


@pytest.mark.asyncio
async def test_remove_subscriber_keeps_peer_subscribed():
    """codex P1：一个 consumer disconnect 退订不应误伤仍活跃的 peer 订阅者。"""
    t = FakeChatTransport()
    a_received, b_received = [], []

    async def a_cb(frame):
        a_received.append(frame)

    async def b_cb(frame):
        b_received.append(frame)

    c = _client(transport=t)
    c.add_approval_subscriber(a_cb)
    c.add_approval_subscriber(b_cb)
    await c.connect()
    c.remove_approval_subscriber(a_cb)  # A 断开退订
    t.push({'type': 'event', 'event': 'exec.approval.requested', 'payload': {'id': 'ap-2'}})
    await asyncio.sleep(0.05)
    assert a_received == []  # pylint: disable=use-implicit-booleaness-not-comparison
    assert len(b_received) == 1  # B 仍活跃，照收
    await c.aclose()


@pytest.mark.asyncio
async def test_approval_event_not_routed_to_runid_handler():
    """审批事件不应泄漏进 chat runId 的 on_event（它是连接级，r26:88）。"""
    events = [
        {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'final'}},
    ]
    t = FakeChatTransport(ack_run_id='r1', events=events)
    chat_received = []
    approvals = []

    async def on_event(frame):
        chat_received.append(frame)

    async def on_approval(frame):
        approvals.append(frame)

    c = _client(transport=t)
    c.add_approval_subscriber(on_approval)
    await c.connect()
    await c.send_message('s', 'm', on_event=on_event)
    t.push({'type': 'event', 'event': 'exec.approval.requested', 'payload': {'id': 'ap-9'}})
    await asyncio.sleep(0.1)
    # chat run 只收到 done；审批卡走审批订阅者，不进 chat_received
    assert all(f.get('type') != 'approval' for f in chat_received)
    assert any(f.get('type') == 'done' for f in chat_received)
    assert len(approvals) == 1
    await c.aclose()


@pytest.mark.asyncio
async def test_approval_event_dropped_when_no_subscriber():
    """无订阅者（consumer 未 start）：审批事件被丢弃，不 crash recv loop。"""
    t = FakeChatTransport()
    c = _client(transport=t)
    await c.connect()
    t.push({'type': 'event', 'event': 'exec.approval.requested', 'payload': {'id': 'ap-1'}})
    await asyncio.sleep(0.05)
    assert not c.dead  # recv loop 存活
    await c.aclose()


@pytest.mark.asyncio
async def test_subscriber_exception_does_not_block_peers():
    """单订阅者回调抛异常被隔离，不影响同 client 其他订阅者。"""
    t = FakeChatTransport()
    b_received = []

    async def boom(frame):
        raise RuntimeError('boom')

    async def b_cb(frame):
        b_received.append(frame)

    c = _client(transport=t)
    c.add_approval_subscriber(boom)
    c.add_approval_subscriber(b_cb)
    await c.connect()
    t.push({'type': 'event', 'event': 'exec.approval.requested', 'payload': {'id': 'ap-1'}})
    await asyncio.sleep(0.05)
    assert len(b_received) == 1
    assert not c.dead
    await c.aclose()


@pytest.mark.asyncio
async def test_resolve_approval_returns_authoritative_payload():
    """codex P1：first-answer-wins —— resolve 返回网关权威 payload（可能与请求 decision 不同）。"""
    t = FakeChatTransport(resolve_payload={'id': 'ap-1', 'decision': 'deny', 'decidedBy': 'other-op'})
    c = _client(transport=t)
    await c.connect()
    result = await c.resolve_approval('ap-1', 'exec', 'approve')  # 请求 approve，权威记录 deny
    assert result == {'id': 'ap-1', 'decision': 'deny', 'decidedBy': 'other-op'}
    rs = next(f for f in t.sent if f.get('method') == 'approval.resolve')
    assert rs['params'] == {'id': 'ap-1', 'kind': 'exec', 'decision': 'approve'}
    await c.aclose()


@pytest.mark.asyncio
async def test_resolve_approval_gateway_reject_raises():
    t = FakeChatTransport(resolve_error={'code': 'FORBIDDEN', 'message': 'missing scope operator.approvals'})
    c = _client(transport=t)
    await c.connect()
    with pytest.raises(ChatSendError) as exc:
        await c.resolve_approval('ap-1', 'exec', 'deny')
    assert 'operator.approvals' in str(exc.value)
    await c.aclose()


@pytest.mark.asyncio
async def test_resolve_approval_timeout_raises():
    t = FakeChatTransport(suppress_ack=True)  # 不回 resolve res
    c = _client(transport=t, ack_timeout=0.1)
    await c.connect()
    with pytest.raises(ChatSendError):
        await c.resolve_approval('ap-1', 'exec', 'approve')
    await c.aclose()


@pytest.mark.asyncio
async def test_list_pending_approvals_translates_cards():
    """codex P2：start 补拉——发 exec.approval.list（文档已证方法名，codex R3 P1 收窄），响应项翻译成审批卡帧。"""
    t = FakeChatTransport(list_payload={
        'approvals': [
            {'id': 'ap-1', 'kind': 'exec', 'systemRunPlan': {'rawCommand': 'cmd1', 'sessionKey': 's1'}},
            {'id': 'ap-2', 'command': 'cmd2'},
        ],
    })
    c = _client(transport=t)
    await c.connect()
    cards = await c.list_pending_approvals()
    assert cards == [
        {'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'cmd1', 'sessionKey': 's1'},
        {'type': 'approval', 'id': 'ap-2', 'kind': 'exec', 'command': 'cmd2', 'sessionKey': None},
    ]
    req = next(f for f in t.sent if f.get('method') == 'exec.approval.list')
    assert req['type'] == 'req'
    await c.aclose()


@pytest.mark.asyncio
async def test_list_pending_approvals_single_approval_key_tolerated():
    """approval.get 响应用单项 approval 键（待实测的另一种形态）→ 翻译成单卡列表。"""
    t = FakeChatTransport(list_payload={'approval': {'id': 'ap-9', 'command': 'cmd'}})
    c = _client(transport=t)
    await c.connect()
    cards = await c.list_pending_approvals()
    assert cards == [{'type': 'approval', 'id': 'ap-9', 'kind': 'exec', 'command': 'cmd', 'sessionKey': None}]
    await c.aclose()


@pytest.mark.asyncio
async def test_list_pending_approvals_empty_or_malformed_tolerated():
    """approval.get 响应缺 approvals/approval 键或非列表 → 返回空列表（best-effort，不崩）。"""
    t = FakeChatTransport(list_payload={})
    c = _client(transport=t)
    await c.connect()
    assert await c.list_pending_approvals() == []
    await c.aclose()


@pytest.mark.asyncio
async def test_broadcast_approval_resolved_fans_out_to_all_subscribers():
    """codex R2 P2：broadcast_approval_resolved 把权威回执 fan-out 到全部订阅者（副本一致收敛）。"""
    t = FakeChatTransport()
    c = _client(transport=t)
    await c.connect()
    got_a, got_b = [], []

    async def sub_a(frame):
        got_a.append(frame)

    async def sub_b(frame):
        got_b.append(frame)

    c.add_approval_subscriber(sub_a)
    c.add_approval_subscriber(sub_b)
    await c.broadcast_approval_resolved('ap-1', 'deny')
    expected = {'type': 'approvalResolved', 'id': 'ap-1', 'decision': 'deny'}
    assert got_a == [expected]
    assert got_b == [expected]
    await c.aclose()


@pytest.mark.asyncio
async def test_resolve_approval_send_failure_cleans_pending_future():
    """codex R3 P2：死连接下 send 抛异常须清理 _pending_resolves，否则重试无限累积 future（内存泄漏）。"""
    t = FakeChatTransport()
    c = _client(transport=t)
    await c.connect()

    class _DeadWs:
        async def send(self, data):
            raise ConnectionError('socket dead')

    c._ws = _DeadWs()  # 模拟 _ws 非 None 但已死（recv loop 尚未标 dead）
    for _ in range(3):  # 模拟多次重试
        with pytest.raises(ConnectionError):
            await c.resolve_approval('ap-1', 'exec', 'approve')
    assert c._pending_resolves == {}  # pylint: disable=use-implicit-booleaness-not-comparison
    await c.aclose()


@pytest.mark.asyncio
async def test_gateway_resolved_event_fans_out_to_subscribers():
    """codex R3 P2：网关 plugin.approval.resolved 事件（他端回覆）→ 连接级 fan-out 给所有订阅者。"""
    t = FakeChatTransport()
    a_received, b_received = [], []

    async def a_cb(frame):
        a_received.append(frame)

    async def b_cb(frame):
        b_received.append(frame)

    c = _client(transport=t)
    c.add_approval_subscriber(a_cb)
    c.add_approval_subscriber(b_cb)
    await c.connect()
    t.push({'type': 'event', 'event': 'plugin.approval.resolved',
            'payload': {'id': 'ap-1', 'decision': 'deny'}})
    await asyncio.sleep(0.05)
    expected = [{'type': 'approvalResolved', 'id': 'ap-1', 'decision': 'deny'}]
    assert a_received == expected
    assert b_received == expected
    await c.aclose()


# ---- T1 会话 RPC（issue #80 / spec #76）----
# 4 个会话管理 RPC（sessions.list / chat.history / sessions.create / sessions.delete）与 resolve_approval
# 同构的 req→res 回执（复用 _pending_resolves）。未连接抛 ChatClientError（会话管理是 REST 主动调用，
# 区别于 list_commands 的 best-effort 补拉），网关拒绝/超时抛 ChatSendError。client 不做字段翻译
# （集中在 REST 解析层 T2），原样透传网关 payload。FakeChatTransport 经通用 rpc_payloads/rpc_errors/
# rpc_suppress 脚本化任意 method 的 res。


@pytest.mark.asyncio
async def test_list_sessions_builds_frame_and_returns_payload():
    """发 sessions.list（agentId/includeDerivedTitles/limit），返回网关 res payload（原样透传）。"""
    payload = {'sessions': [{'key': 's1', 'title': '你好'}, {'key': 's2'}]}
    t = FakeChatTransport(rpc_payloads={'sessions.list': payload})
    c = _client(transport=t)
    await c.connect()
    result = await c.list_sessions('main', include_derived_titles=True, limit=50)
    assert result == payload
    req = next(f for f in t.sent if f.get('method') == 'sessions.list')
    assert req['type'] == 'req'
    assert req['params'] == {'agentId': 'main', 'includeDerivedTitles': True, 'limit': 50}
    await c.aclose()


@pytest.mark.asyncio
async def test_list_sessions_not_connected_raises():
    """未连接（_ws None）→ ChatClientError（区别于 list_commands 的 best-effort 返回 {}）。"""
    c = _client(transport=FakeChatTransport())
    with pytest.raises(ChatClientError):
        await c.list_sessions('main')


@pytest.mark.asyncio
async def test_list_sessions_gateway_reject_raises():
    """网关拒绝（缺 operator.read scope）→ res not ok → ChatSendError（上层映射 502）。"""
    t = FakeChatTransport(rpc_errors={
        'sessions.list': {'code': 'FORBIDDEN', 'message': 'missing scope operator.read'}})
    c = _client(transport=t)
    await c.connect()
    with pytest.raises(ChatSendError) as exc:
        await c.list_sessions('main')
    assert 'operator.read' in str(exc.value)
    await c.aclose()


@pytest.mark.asyncio
async def test_list_sessions_ack_timeout_raises():
    """有界等待：ack 丢失/网关不回 → ChatSendError，且 future 已从 _pending_resolves 清出（不泄漏）。"""
    t = FakeChatTransport(rpc_suppress={'sessions.list'})
    c = _client(transport=t, ack_timeout=0.05)
    await c.connect()
    with pytest.raises(ChatSendError):
        await c.list_sessions('main')
    assert not c._pending_resolves
    await c.aclose()


@pytest.mark.asyncio
async def test_get_history_builds_frame_and_returns_payload():
    """发 chat.history（sessionKey + 可选 limit/messageId 锚点），透传 messages[]+分页 payload。"""
    payload = {'messages': [{'role': 'user', 'text': '你好'}], 'hasMore': True, 'nextOffset': 'msg-5'}
    t = FakeChatTransport(rpc_payloads={'chat.history': payload})
    c = _client(transport=t)
    await c.connect()
    result = await c.get_history('s1', limit=20, message_id='msg-10')
    assert result == payload
    req = next(f for f in t.sent if f.get('method') == 'chat.history')
    assert req['params'] == {'sessionKey': 's1', 'limit': 20, 'messageId': 'msg-10'}
    await c.aclose()


@pytest.mark.asyncio
async def test_get_history_minimal_params_omits_optionals():
    """只传 sessionKey → 不带可选 limit/messageId（spec：两者可选，None 时不下发）。"""
    t = FakeChatTransport(rpc_payloads={'chat.history': {'messages': []}})
    c = _client(transport=t)
    await c.connect()
    await c.get_history('s1')
    req = next(f for f in t.sent if f.get('method') == 'chat.history')
    assert req['params'] == {'sessionKey': 's1'}
    await c.aclose()


@pytest.mark.asyncio
async def test_get_history_not_connected_raises():
    c = _client(transport=FakeChatTransport())
    with pytest.raises(ChatClientError):
        await c.get_history('s1')


@pytest.mark.asyncio
async def test_get_history_gateway_reject_raises():
    t = FakeChatTransport(rpc_errors={'chat.history': {'code': 'NOT_FOUND', 'message': 'no such session'}})
    c = _client(transport=t)
    await c.connect()
    with pytest.raises(ChatSendError):
        await c.get_history('missing')
    await c.aclose()


@pytest.mark.asyncio
async def test_create_session_builds_frame_and_returns_payload():
    """发 sessions.create{key,label}，返回网关 res payload。"""
    payload = {'session': {'key': 'new-1', 'label': '我的会话'}}
    t = FakeChatTransport(rpc_payloads={'sessions.create': payload})
    c = _client(transport=t)
    await c.connect()
    result = await c.create_session('new-1', label='我的会话')
    assert result == payload
    req = next(f for f in t.sent if f.get('method') == 'sessions.create')
    assert req['params'] == {'key': 'new-1', 'label': '我的会话'}
    await c.aclose()


@pytest.mark.asyncio
async def test_create_session_without_label_omits_field():
    """免标题新建（spec：可不带 label，由网关后续派生）→ params 只含 key。"""
    t = FakeChatTransport(rpc_payloads={'sessions.create': {'session': {'key': 'x'}}})
    c = _client(transport=t)
    await c.connect()
    await c.create_session('x')
    req = next(f for f in t.sent if f.get('method') == 'sessions.create')
    assert req['params'] == {'key': 'x'}
    await c.aclose()


@pytest.mark.asyncio
async def test_create_session_not_connected_raises():
    c = _client(transport=FakeChatTransport())
    with pytest.raises(ChatClientError):
        await c.create_session('x')


@pytest.mark.asyncio
async def test_create_session_gateway_reject_raises():
    t = FakeChatTransport(rpc_errors={'sessions.create': {'code': 'CONFLICT', 'message': 'session exists'}})
    c = _client(transport=t)
    await c.connect()
    with pytest.raises(ChatSendError):
        await c.create_session('dup')
    await c.aclose()


@pytest.mark.asyncio
async def test_delete_session_builds_frame_and_returns_payload():
    """发 sessions.delete（admin 级），返回网关 res payload（含归档路径，可恢复）。

    wire 字段是 ``key``（不是 ``sessionKey``）——上游 ``SessionsDeleteParamsSchema``
    （packages/gateway-protocol/src/schema/sessions.ts）是 closedObject，``key`` 必填、
    无 ``sessionKey``；与同族 ``sessions.create``/``sessions.send`` 的 ``key`` 一致。
    区别于 ``chat.*`` 族（``chat.send``/``chat.history`` 用 ``sessionKey``）。codex #96 P1。
    """
    payload = {'deleted': True, 'archived': 'sess-1.jsonl.deleted.123.zst'}
    t = FakeChatTransport(rpc_payloads={'sessions.delete': payload})
    c = _client(transport=t)
    await c.connect()
    result = await c.delete_session('sess-1')
    assert result == payload
    req = next(f for f in t.sent if f.get('method') == 'sessions.delete')
    assert req['params'] == {'key': 'sess-1'}
    await c.aclose()


@pytest.mark.asyncio
async def test_delete_session_not_connected_raises():
    c = _client(transport=FakeChatTransport())
    with pytest.raises(ChatClientError):
        await c.delete_session('sess-1')


@pytest.mark.asyncio
async def test_delete_session_gateway_reject_raises():
    """删除是 admin 级：缺 operator.admin scope → 网关拒绝 → ChatSendError。"""
    t = FakeChatTransport(rpc_errors={
        'sessions.delete': {'code': 'FORBIDDEN', 'message': 'missing scope operator.admin'}})
    c = _client(transport=t)
    await c.connect()
    with pytest.raises(ChatSendError) as exc:
        await c.delete_session('sess-1')
    assert 'operator.admin' in str(exc.value)
    await c.aclose()
