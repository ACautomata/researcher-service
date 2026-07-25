"""seam: chat.chat_client —— OpenClaw 长连接对话客户端（issue #41 / spec §8.2）。

chat.send + runId 路由：发 chat.send → ack(runId) → chat 事件按 runId 经 translator 翻译回调 on_event。
注入 FakeChatTransport（fakes.py）。覆盖 connect 握手 / send_message 帧与 ack / recv 路由 / stray 容错 /
error 收尾 / discard / ack 失败。
"""
import asyncio

import pytest

from chat.chat_client import ChatClientError, ChatConnectError, ChatSendError, OpenClawChatClient
from chat.tests.fakes import FakeChatTransport

URL = 'ws://127.0.0.1:19000/'


@pytest.mark.asyncio
async def test_connect_sends_connect_frame_with_device_token():
    t = FakeChatTransport()
    c = OpenClawChatClient(URL, 'dt-xyz', transport=t)
    await c.connect()
    connect = next(f for f in t.sent if f.get('method') == 'connect')
    assert connect['params']['auth']['token'] == 'dt-xyz'
    await c.aclose()


@pytest.mark.asyncio
async def test_connect_failure_raises():
    t = FakeChatTransport(connect_ok=False)
    c = OpenClawChatClient(URL, 'dt', transport=t)
    with pytest.raises(ChatConnectError):
        await c.connect()


@pytest.mark.asyncio
async def test_send_message_builds_chat_send_frame_and_returns_runid():
    t = FakeChatTransport(ack_run_id='run-9')

    async def on_event(frame):
        pass

    c = OpenClawChatClient(URL, 'dt', transport=t)
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

    c = OpenClawChatClient(URL, 'dt', transport=t)
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

    c = OpenClawChatClient(URL, 'dt', transport=t)
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

    c = OpenClawChatClient(URL, 'dt', transport=t)
    await c.connect()
    await c.send_message('s', 'm', on_event=on_event)
    await asyncio.sleep(0.1)
    assert received == [
        {'type': 'text', 'runId': 'r1', 'delta': 'x'},
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

    c = OpenClawChatClient(URL, 'dt', transport=t)
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

    c = OpenClawChatClient(URL, 'dt', transport=t)
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

    c = OpenClawChatClient(URL, 'dt', transport=t)
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

    c = OpenClawChatClient(URL, 'dt', transport=t)
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
    c = OpenClawChatClient(URL, 'dt', transport=t, connect_timeout=0.1)
    with pytest.raises(ChatConnectError):
        await c.connect()


@pytest.mark.asyncio
async def test_send_message_times_out_when_ack_never_arrives():
    # 网关连着但不回 chat.send ack → send_message 不应永久挂起；超时后清理 pending 条目
    t = FakeChatTransport(suppress_ack=True)
    c = OpenClawChatClient(URL, 'dt', transport=t, ack_timeout=0.1)
    await c.connect()

    async def on_event(frame):
        pass

    with pytest.raises(ChatSendError):
        await c.send_message('s', 'm', on_event=on_event)
    assert c._pending_acks == {}
    await c.aclose()


# ---- T06 权限审批（issue #42 / spec §8.2）----
# 审批事件是连接级（无 runId）→ 走连接级 on_approval 回调，不进 runId 路由；
# resolve_approval 发 approval.resolve 方法帧（id+kind+decision），有界等 res。


@pytest.mark.asyncio
async def test_approval_event_routed_to_on_approval_callback():
    t = FakeChatTransport()
    approvals = []

    async def on_approval(frame):
        approvals.append(frame)

    c = OpenClawChatClient(URL, 'dt', transport=t)
    c.set_approval_handler(on_approval)
    await c.connect()
    t.push({'type': 'event', 'event': 'exec.approval.requested',
            'payload': {'id': 'ap-1', 'kind': 'exec', 'systemRunPlan': {'rawCommand': 'rm -rf /tmp'}}})
    await asyncio.sleep(0.05)
    assert approvals == [{'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'rm -rf /tmp'}]
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

    c = OpenClawChatClient(URL, 'dt', transport=t)
    c.set_approval_handler(on_approval)
    await c.connect()
    await c.send_message('s', 'm', on_event=on_event)
    t.push({'type': 'event', 'event': 'exec.approval.requested', 'payload': {'id': 'ap-9'}})
    await asyncio.sleep(0.1)
    # chat run 只收到 done；审批卡走审批回调，不进 chat_received
    assert all(f.get('type') != 'approval' for f in chat_received)
    assert any(f.get('type') == 'done' for f in chat_received)
    assert len(approvals) == 1
    await c.aclose()


@pytest.mark.asyncio
async def test_approval_event_dropped_when_no_handler():
    """未注册审批回调（consumer 未 start）：审批事件被丢弃，不 crash recv loop。"""
    t = FakeChatTransport()
    c = OpenClawChatClient(URL, 'dt', transport=t)
    await c.connect()
    t.push({'type': 'event', 'event': 'exec.approval.requested', 'payload': {'id': 'ap-1'}})
    await asyncio.sleep(0.05)
    assert not c.dead  # recv loop 存活
    await c.aclose()


@pytest.mark.asyncio
async def test_resolve_approval_sends_method_frame():
    t = FakeChatTransport()
    c = OpenClawChatClient(URL, 'dt', transport=t)
    await c.connect()
    result = await c.resolve_approval('ap-1', 'exec', 'approve')
    assert result is True
    rs = next(f for f in t.sent if f.get('method') == 'approval.resolve')
    assert rs['params'] == {'id': 'ap-1', 'kind': 'exec', 'decision': 'approve'}
    await c.aclose()


@pytest.mark.asyncio
async def test_resolve_approval_gateway_reject_raises():
    t = FakeChatTransport(resolve_error={'code': 'FORBIDDEN', 'message': 'missing scope operator.approvals'})
    c = OpenClawChatClient(URL, 'dt', transport=t)
    await c.connect()
    with pytest.raises(ChatSendError) as exc:
        await c.resolve_approval('ap-1', 'exec', 'deny')
    assert 'operator.approvals' in str(exc.value)
    await c.aclose()


@pytest.mark.asyncio
async def test_resolve_approval_timeout_raises():
    t = FakeChatTransport(suppress_ack=True)  # 不回 resolve res
    c = OpenClawChatClient(URL, 'dt', transport=t, ack_timeout=0.1)
    await c.connect()
    with pytest.raises(ChatSendError):
        await c.resolve_approval('ap-1', 'exec', 'approve')
    await c.aclose()
