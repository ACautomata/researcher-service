# pylint: disable=too-many-lines
"""seam: chat.chat_client —— OpenClaw 长连接对话客户端（issue #41 / spec §8.2）。

chat.send + runId 路由：发 chat.send → ack(runId) → chat 事件按 runId 经 translator 翻译回调 on_event。
注入 FakeChatTransport（fakes.py）。覆盖 connect 握手 / send_message 帧与 ack / recv 路由 / stray 容错 /
error 收尾 / discard / ack 失败。
"""
import asyncio

import pytest

from chat.chat_client import (
    ChatClientError,
    ChatConnectError,
    ChatPayloadTooLargeError,
    ChatSendError,
    GatewayPolicy,
    OpenClawChatClient,
)
from chat.device_crypto import DeviceCrypto, DeviceIdentity
from chat.tests.fakes import FakeChatTransport
from integration.openclaw.wire_client import HISTORY_RUN_ID

URL = 'ws://127.0.0.1:19000/'

# issue #139：session connect 帧 device 签名块所需，注入共享假值（这些测试关注路由/ack，不验签）。
_IDENTITY = DeviceCrypto.generate_identity()
_SCOPES = ['operator.read', 'operator.write', 'operator.approvals']


def _client(url=URL, device_token='dt', **kwargs):
    """构造 OpenClawChatClient，默认注入假 identity/scopes 走 #140 签名路径（贴合 #141 生产注入）；
    配套 FakeChatTransport 默认下发 connect.challenge（nonce 由其提取），无需逐测试另配。"""
    return OpenClawChatClient(
        url, device_token,
        identity=_IDENTITY, scopes=_SCOPES, **kwargs,
    )


@pytest.mark.asyncio
async def test_client_from_persisted_identity_builds_signed_device_block():
    """回归 (codex #149 P2)：从持久化材料重建 DeviceIdentity 构造 client 不 TypeError，
    且 connect 帧 device 块（id/publicKey/signature）源自该 identity、scopes 源自传入值。
    锁定 test_integration smoke 与 #141 pool 注入共用的「从 Pairing 记录构造 client」契约。"""
    persisted = DeviceIdentity(
        device_id=_IDENTITY.device_id,
        public_key_pem=_IDENTITY.public_key_pem,
        private_key_pem=_IDENTITY.private_key_pem,
    )
    approved = ['operator.read', 'operator.write']  # 模拟 pairing.scopes_list()，少于全量 SCOPES
    t = FakeChatTransport(challenge_nonce='nz-persisted')  # #140：签名路径先等 challenge
    c = OpenClawChatClient(
        URL, 'dt', identity=persisted, scopes=approved, transport=t,
    )
    await c.connect()
    connect = next(f for f in t.sent if f.get('method') == 'connect')
    dev = connect['params']['device']
    assert dev['id'] == persisted.device_id
    assert dev['publicKey'] == persisted.public_key_raw_base64url()
    assert dev['signature']  # 持久化私钥可签（非空）
    assert dev['nonce'] == 'nz-persisted'  # #140：nonce 取自 connect.challenge
    assert connect['params']['scopes'] == approved
    assert connect['params']['auth']['token'] == 'dt'
    await c.aclose()


@pytest.mark.asyncio
async def test_connect_sends_connect_frame_with_device_token():
    t = FakeChatTransport()
    c = _client(device_token='dt-xyz', transport=t)
    await c.connect()
    connect = next(f for f in t.sent if f.get('method') == 'connect')
    assert connect['params']['auth']['token'] == 'dt-xyz'
    await c.aclose()


@pytest.mark.asyncio
async def test_connect_waits_for_challenge_and_signs():
    """issue #140：connect() 先等网关 connect.challenge 提取 nonce，用 DeviceIdentity 签名后才发
    connect 帧——帧 device 块 nonce 来自 challenge（非构造注入），且签名是把该 nonce 混入 v3
    payload 后的有效 Ed25519 签名（独立真值验签，非仅断言字段相等）。"""
    challenge_nonce = 'nonce-from-challenge'
    t = FakeChatTransport(challenge_nonce=challenge_nonce)
    c = OpenClawChatClient(URL, 'dt', identity=_IDENTITY, scopes=_SCOPES, transport=t)
    await c.connect()
    connect = next(f for f in t.sent if f.get('method') == 'connect')
    dev = connect['params']['device']
    assert dev['nonce'] == challenge_nonce  # nonce 来自 challenge，非构造期占位
    assert connect['params']['scopes'] == _SCOPES
    assert connect['params']['auth']['token'] == 'dt'
    # 用 challenge nonce 独立重建 v3 签名串，验签 device.signature（证明签名真的覆盖了 challenge nonce）
    payload = DeviceCrypto.build_auth_payload_v3(
        device_id=_IDENTITY.device_id, client_id='gateway-client', client_mode='backend',
        role='operator', scopes=_SCOPES, signed_at_ms=dev['signedAt'], token='dt',
        nonce=challenge_nonce, platform='linux', device_family='',
    )
    assert DeviceIdentity.verify(_IDENTITY, payload, dev['signature'])
    await c.aclose()


@pytest.mark.asyncio
async def test_connect_challenge_missing_nonce_raises():
    """issue #140 边界：challenge 事件缺 nonce → ChatConnectError（对齐 pairing_ws 防御，不签空 nonce）。"""
    t = FakeChatTransport(challenge_nonce='')  # 下发 challenge 但 payload.nonce 为空
    c = OpenClawChatClient(URL, 'dt', identity=_IDENTITY, scopes=_SCOPES, transport=t)
    with pytest.raises(ChatConnectError):
        await c.connect()


@pytest.mark.asyncio
async def test_connect_without_identity_ignores_challenge_legacy_path():
    """issue #140 向后兼容：device_identity 为 None 时走旧路径——不等 challenge、立即发帧、不签名。"""
    t = FakeChatTransport(challenge_nonce=None)  # 不下发 challenge（旧网关）
    c = OpenClawChatClient(URL, 'dt', transport=t)  # 不传 identity/scopes
    await c.connect()
    connect = next(f for f in t.sent if f.get('method') == 'connect')
    assert connect['params']['auth']['token'] == 'dt'
    assert 'device' not in connect['params']  # 旧路径无 device 签名块
    await c.aclose()


@pytest.mark.asyncio
async def test_identity_without_scopes_raises_at_construction():
    """回归 (codex #150 P2 #1)：identity 与 scopes 是签名路径一体前提——给 identity 但 scopes
    缺省/为空时，构造期 fail-fast ValueError，而非连上网关后 `','.join(None)` TypeError 半途崩。"""
    t = FakeChatTransport(challenge_nonce='nz')
    with pytest.raises(ValueError, match='non-empty scopes'):
        OpenClawChatClient(URL, 'dt', identity=_IDENTITY, scopes=None, transport=t)
    with pytest.raises(ValueError, match='non-empty scopes'):
        OpenClawChatClient(URL, 'dt', identity=_IDENTITY, scopes=[], transport=t)


@pytest.mark.asyncio
async def test_connect_accepts_legacy_two_arg_frame_builder():
    """回归 (codex #150 P2 #3)：注入的 connect_frame_builder 保持 (req_id, device_token) 两参契约——
    签名路径提取的 nonce 经实例态传给默认 builder，不向自定义两参 builder 多传第三参。"""
    seen = {}

    def legacy_builder(req_id, device_token):  # 两参 seam（#140 前唯一契约）
        seen['req_id'] = req_id
        seen['token'] = device_token
        return {'type': 'req', 'id': req_id, 'method': 'connect',
                'params': {'auth': {'token': device_token}}}

    t = FakeChatTransport(challenge_nonce='nz')
    c = OpenClawChatClient(URL, 'dt', identity=_IDENTITY, scopes=_SCOPES,
                           transport=t, connect_frame_builder=legacy_builder)
    await c.connect()  # 不 TypeError
    assert seen['token'] == 'dt'
    await c.aclose()


@pytest.mark.asyncio
async def test_connect_shares_single_timeout_budget_across_challenge_and_res():
    """回归 (codex #150 P2 #2)：challenge 与 connect res 共享一份 connect_timeout——challenge 耗时
    逼近预算后，res 只剩余量，总握手不超过 connect_timeout（而非两段各拿整份 ~2×）。"""
    import json
    import time

    # pylint: disable=attribute-defined-outside-init
    class _SlowWs:  # 网关：challenge 拖 0.8s，之后永不回 res
        async def send(self, _f):
            pass

        async def recv(self):
            if not getattr(self, '_ch', False):
                self._ch = True
                await asyncio.sleep(0.8)
                return json.dumps({'type': 'event', 'event': 'connect.challenge',
                                   'payload': {'nonce': 'nz'}})
            await asyncio.sleep(60)
    # pylint: enable=attribute-defined-outside-init

    class _Cm:
        async def __aenter__(self):
            return _SlowWs()

        async def __aexit__(self, *a):
            return False

    c = OpenClawChatClient(URL, 'dt', identity=_IDENTITY, scopes=_SCOPES,
                           transport=lambda _url: _Cm(), connect_timeout=1.0)
    t0 = time.monotonic()
    with pytest.raises(ChatConnectError):
        await c.connect()
    assert time.monotonic() - t0 < 1.4  # 共享预算 ~1.0s，非 0.8+1.0=1.8s


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
    # T08（issue #153 实测校准）：event:"agent" + stream:"tool" + data.phase→ 经既有 runId 路由推给 on_event
    # （chat_client 无需改动；translator 产 tool 帧，_handle 按 frames[0].runId 路由，tool 非终态不清 route）
    events = [
        {'type': 'event', 'event': 'agent',
         'payload': {'runId': 'r1', 'stream': 'tool',
                     'data': {'phase': 'start', 'name': 'wiki.search', 'args': {'query': 'x'}}}},
        {'type': 'event', 'event': 'agent',
         'payload': {'runId': 'r1', 'stream': 'tool',
                     'data': {'phase': 'result', 'name': 'wiki.search', 'result': {'count': 3}}}},
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
         'id': None, 'title': None, 'input': {'query': 'x'}, 'result': None, 'isError': False},
        {'type': 'tool', 'runId': 'r1', 'name': 'wiki.search', 'state': 'done',
         'id': None, 'title': None, 'input': None, 'result': {'count': 3}, 'isError': False},
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
    await c.aclose()  # 连接死 → _fail_pending_acks reject 未决 ack
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
    result = await c.resolve_approval('ap-1', 'exec', 'allow-once')  # 请求 allow-once，权威记录 deny
    assert result == {'id': 'ap-1', 'decision': 'deny', 'decidedBy': 'other-op'}
    # issue #154：method 格式是 {kind}.approval.resolve（如 exec.approval.resolve），非通用 approval.resolve
    rs = next(f for f in t.sent if f.get('method') == 'exec.approval.resolve')
    # issue #154：params 为 {id, decision}（无 kind），decision=allow-once/allow-always/deny
    assert rs['params'] == {'id': 'ap-1', 'decision': 'allow-once'}
    await c.aclose()


@pytest.mark.asyncio
async def test_resolve_approval_plugin_kind_uses_plugin_prefix():
    """issue #154：kind='plugin' 时 method 为 plugin.approval.resolve。"""
    t = FakeChatTransport(resolve_payload={'id': 'ap-1', 'decision': 'allow-once'})
    c = _client(transport=t)
    await c.connect()
    await c.resolve_approval('ap-1', 'plugin', 'allow-once')
    rs = next(f for f in t.sent if f.get('method') == 'plugin.approval.resolve')
    assert rs is not None
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
async def test_approval_and_rpc_rejected_when_dead():
    """codex #219 十一轮 P2-319：dead 置位（closing/recv 死）期间 resolve_approval / _rpc 入口拒发。

    closing 死窗口内（_notify_all_error 快照后 await 回调、_ws 未置 None）若仍放行，新 RPC 的
    future 注册后网关或已接受审批，但 ack/resolved 事件随死连接丢失 → 超时把已执行的卡误复位
    pending。dead（_dead or _closed）置位即抛 ChatClientError，consumer 走 dead 重取。
    """
    t = FakeChatTransport()
    c = _client(transport=t)
    await c.connect()
    c._dead = True  # pylint: disable=protected-access  # closing/recv 死已置位

    with pytest.raises(ChatClientError):
        await c.resolve_approval('ap-1', 'exec', 'allow-once')
    with pytest.raises(ChatClientError):
        await c.list_sessions()  # 经 _rpc
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
async def test_list_pending_approvals_payload_list_translates_cards():
    """实测校准（spike ghcr 2026.6.34-browser, 2026-07-27）：exec.approval.list 的 payload
    直接是 list（非空 [{...}]），非 {approvals:[...]} dict。旧代码 list.get 会 AttributeError。"""
    t = FakeChatTransport(list_payload=[
        {'id': 'ap-1', 'kind': 'exec', 'systemRunPlan': {'rawCommand': 'cmd1'}},
    ])
    c = _client(transport=t)
    await c.connect()
    cards = await c.list_pending_approvals()
    assert cards == [
        {'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'cmd1', 'sessionKey': None},
    ]
    await c.aclose()


@pytest.mark.asyncio
async def test_list_pending_approvals_payload_empty_list_returns_empty():
    """实测：payload 直接是空列表 → 空卡列表（best-effort）。"""
    t = FakeChatTransport(list_payload=[])
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


# ---- #196 T1 / #213：可靠 _dead 地基（hello-ok policy 解析 + tick 静默看门狗 + CancelledError 置 dead）----


@pytest.mark.asyncio
async def test_recv_task_cancelled_marks_client_dead():
    """#196 问题3 / #213：recv_task 被取消（REST 跨 loop 清理 / 服务关闭竞态）→ 置 _dead，pool
    快路径（not client.dead）据此驱逐假活 client。原 CancelledError 分支只 raise 不置位，一次
    task 取消后死连接被无限复用、该容器聊天永久变砖。"""
    t = FakeChatTransport()
    c = _client(transport=t)
    await c.connect()
    assert not c.dead
    await asyncio.sleep(0.05)  # 让 _recv_loop 跑到 recv() 挂起（真实取消场景：loop 已在跑）
    c._recv_task.cancel()  # 非 aclose 路径的 task 取消（aclose 会同时置 _closed）
    with pytest.raises(asyncio.CancelledError):
        await c._recv_task
    assert c.dead is True  # 取消即连接不可用，pool 不再复用
    await c.aclose()


@pytest.mark.asyncio
async def test_hello_ok_policy_parsed_and_stored():
    """#196 问题1 / #213：hello-ok payload.policy（HelloOkSchema 必填项）被解析存储，供静默看门狗
    （2×tickIntervalMs）与 T5 maxPayload 发送预检 / T3 重连计时复用。原 _await_res 只看 ok、
    payload（含 policy）整体丢弃。"""
    policy = {'tickIntervalMs': 100, 'maxPayload': 26214400, 'maxBufferedBytes': 52428800}
    t = FakeChatTransport(connect_policy=policy)
    c = _client(transport=t)
    await c.connect()
    assert c.policy.tick_interval_ms == 100
    assert c.policy.max_payload_bytes == 26214400
    assert c.policy.max_buffered_bytes == 52428800
    await c.aclose()


@pytest.mark.asyncio
async def test_hello_ok_missing_policy_falls_back_to_protocol_defaults():
    """#213：缺 policy 字段（旧网关 / 握手前）回退协议默认——tickIntervalMs=30000、maxPayload=25MB
    （MAX_PAYLOAD_BYTES）；maxBufferedBytes 协议未指定握手前默认 → None。"""
    t = FakeChatTransport()  # 默认不下发 policy
    c = _client(transport=t)
    await c.connect()
    assert c.policy.tick_interval_ms == 30000
    assert c.policy.max_payload_bytes == 26214400
    assert c.policy.max_buffered_bytes is None
    await c.aclose()


@pytest.mark.asyncio
async def test_silence_watchdog_marks_dead_and_rejects_pending_after_two_ticks():
    """#196 问题1 / #213：半开连接（recv 永久挂起——TCP 半开 / NAT 超时 / 代理静默掐断）静默 >
    2×tickIntervalMs → 置 _dead + 拒全部挂起请求（不重放）。原 _recv_loop 裸 recv() 永久挂起，
    _dead 永不置位、连接永不自愈，所有 chat.send 只能逐条等 ack timeout 失败——与契约「静默 >
    2×tick 即关闭重连」完全相反。"""
    # tickIntervalMs=50 → 看门狗 100ms。不 push 任何帧 → _recv_loop 的 recv() 永久挂起（半开）。
    t = FakeChatTransport(connect_policy={'tickIntervalMs': 50, 'maxPayload': 26214400})
    c = _client(transport=t, ack_timeout=1.0)
    await c.connect()

    async def on_event(frame):
        pass

    send = asyncio.create_task(c.send_message('s', 'm', on_event=on_event))
    await asyncio.sleep(0.06)  # chat.send 已发、挂起等 ack（半开 → ack 永不回）
    assert not send.done()
    await asyncio.sleep(0.12)  # 静默 > 2×tick（100ms）→ 看门狗触发
    assert c.dead is True
    assert t._close_code == 4000  # 按契约 close code 4000 语义关闭套接字
    with pytest.raises(ChatClientError):  # 挂起 ack 被拒（不重放被拒请求）
        await send
    await c.aclose()


# ---- #196 T5 / #216：send_message 帧大小预检（maxPayload 发送侧自律）----


@pytest.mark.asyncio
async def test_send_message_oversized_frame_rejected_locally():
    """#196 问题4 / #216：send_message 序列化帧后按 policy.maxPayload 预检——超限本地抛
    ChatSendError（明确文案「消息超过网关帧大小上限 N MB，请分段发送」），不发出该帧、连接不断。
    原无预检：超长粘贴触发网关按协议断连，用户看到莫名「容器连接断开」，还连累同连接其他在途 run。"""
    # maxPayload 极小（200B）：正常 chat.send 帧（含 connect 帧/签名块）序列化后即超 → 必触发预检。
    t = FakeChatTransport(connect_policy={'tickIntervalMs': 30_000, 'maxPayload': 200})

    async def on_event(frame):
        pass

    c = _client(transport=t)
    await c.connect()
    with pytest.raises(ChatPayloadTooLargeError) as exc:
        await c.send_message('s', 'x' * 1000, on_event=on_event)
    assert '帧大小上限' in str(exc.value)
    assert '分段发送' in str(exc.value)
    # 本地拒绝：未发出任何 chat.send 帧（网关完全无感知）
    assert not any(f.get('method') == 'chat.send' for f in t.sent)
    assert c.dead is False  # 连接未断（预检不触发网关断连）
    await c.aclose()


@pytest.mark.asyncio
async def test_send_message_oversized_does_not_leak_pending_ack():
    """#216：超限本地拒绝后 _pending_acks 无泄漏——预检在 _ws.send 之前，须先移除已注册的 pending
    ack（否则本地拒绝、永不发帧也永无回执，future 悬挂泄漏；且会误吞同连接后续 ack）。"""
    t = FakeChatTransport(connect_policy={'tickIntervalMs': 30_000, 'maxPayload': 200})

    async def on_event(frame):
        pass

    c = _client(transport=t)
    await c.connect()
    with pytest.raises(ChatPayloadTooLargeError):
        await c.send_message('s', 'x' * 1000, on_event=on_event)
    assert not c._pending_acks  # pylint: disable=protected-access  # 无泄漏：pending ack 已 pop
    await c.aclose()


@pytest.mark.asyncio
async def test_send_message_oversized_does_not_affect_inflight_run():
    """#216 验收：超限消息本地被拒、同连接其他在途 run 不受影响。先发一条正常消息建立 run
    （增大 maxPayload 让其通过），再发超限消息（被本地拒），正常 run 的 ack / 事件路由不受影响。"""
    # maxPayload 足够大：正常帧通过。connect 后先行第一条正常 chat.send。
    t = FakeChatTransport(connect_policy={'tickIntervalMs': 30_000, 'maxPayload': 26214400})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    await c.connect()
    run_id = await c.send_message('s', 'hello', on_event=on_event)
    assert run_id == 'r1'  # 正常 run 已建立
    # 同连接上发超限消息：临时收紧 policy 模拟另一条超限（>25MB 实操难凑，收紧 policy 等价触发预检）。
    c._policy = GatewayPolicy(  # pylint: disable=protected-access
        tick_interval_ms=30_000, max_payload_bytes=200, max_buffered_bytes=None)
    with pytest.raises(ChatPayloadTooLargeError):
        await c.send_message('s', 'x' * 1000, on_event=on_event)
    assert c.dead is False  # 超限未断连
    # 正常 run 的后续事件仍按 runId 路由（在途 run 不受超限消息影响）
    t.push({'type': 'event', 'event': 'chat',
            'payload': {'runId': 'r1', 'state': 'delta', 'deltaText': '世界'}})
    t.push({'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'final'}})
    await asyncio.sleep(0.1)
    assert received == [
        {'type': 'text', 'runId': 'r1', 'delta': '世界'},
        {'type': 'done', 'runId': 'r1'},
    ]
    await c.aclose()


@pytest.mark.asyncio
async def test_send_message_sends_text_frame_not_binary():
    """codex #220 P1：websockets.send(bytes) 发二进制帧——OpenClaw 协议 chat.send 与其他 RPC 一致
    走 JSON 文本帧。maxPayload 预检需 frame_bytes 仅供测量；send() 必须传原始序列化 str（文本帧），
    否则强制文本帧协议的网关会在 ack 到达前拒绝/断连每个本应合法的 chat.send。"""
    t = FakeChatTransport(ack_run_id='r1')

    async def on_event(frame):
        pass

    c = _client(transport=t)
    await c.connect()
    await c.send_message('s', '你好', on_event=on_event)
    # 找到 chat.send 那次 send 的原始类型：必须是 str（文本帧），不能是 bytes（二进制帧）
    idx = next(i for i, f in enumerate(t.sent) if f.get('method') == 'chat.send')
    assert t.sent_types[idx] is str
    await c.aclose()


# ---- #196 T4 / #217：重连恢复流程（契约《构建 Gateway 客户端》「重连后恢复状态」5 步）----
#
# 每次 connect()（首连与每次 pool 主动重连）握手成功后：
# 1. 发 sessions.subscribe；对已记住的活跃 sessionKey 发 sessions.messages.subscribe{key}；
# 2. 对该 sessionKey 调 chat.history（投影替换语义经 text replace 帧回放）；
# 3. 采用返回的 inFlightRun（runId + 缓冲 text[即使为空] + 可选 plan），重建 runId 路由；
# 4. 读 sessionInfo.hasActiveRun / activeRunIds 判定运行归属；
# 5. 后续事件按 runId 路由（去重归 #203）。
#
# 恢复的 history / inFlightRun 经 record_active_session 注册的 session 回调回放为 text replace
# 帧（replace=True → 前端整段替换、不追加），runId 用 __history__ 命名空间避免与真实 runId 冲突；
# 恢复本身不发终态 done（进行中 run 的终帧由网关后续事件经重建路由到达）。


def _methods(t):
    """transport 已发帧的 method 序列（按发送顺序），供恢复顺序断言。"""
    return [f.get('method') for f in t.sent]


@pytest.mark.asyncio
async def test_connect_emits_sessions_subscribe_no_active_session():
    """#217 步1（无活跃会话）：connect() 握手成功后发 sessions.subscribe；未记录活跃 sessionKey
    时不发 sessions.messages.subscribe、不调 chat.history。"""
    t = FakeChatTransport()
    c = _client(transport=t)
    await c.connect()
    assert 'sessions.subscribe' in _methods(t)
    assert 'sessions.messages.subscribe' not in _methods(t)
    assert 'chat.history' not in _methods(t)
    await c.aclose()


@pytest.mark.asyncio
async def test_reconnect_sequences_subscribe_messages_subscribe_history():
    """#217 步1-2（断线→重连→hello-ok）：旧 client 记住的活跃会话经 recovery_sessions 传播到替换
    client（pool 换 client 路径），替换 client connect 后按序发
    sessions.subscribe → sessions.messages.subscribe{key} → chat.history{sessionKey}。"""
    t = FakeChatTransport(rpc_payloads={'chat.history': {'messages': []}})
    c = _client(transport=t)
    c.record_active_session('s1')
    await c.connect()  # 首连（记住 s1）
    await c.aclose()  # 断线
    # 重连：pool 建新 client，经 recovery_sessions() 从旧 client 继承记住的会话（不在 c2 上手填）。
    c2 = _client(transport=t)
    for session_key, callbacks in c.recovery_sessions():
        if not callbacks:
            c2.record_active_session(session_key)  # key-only：只记住 key
            continue
        for on_event in callbacks:
            c2.record_active_session(session_key, on_event)
    await c2.connect()  # 重连（同一 transport，第二连接）
    methods = _methods(t)
    assert 'sessions.subscribe' in methods
    assert 'sessions.messages.subscribe' in methods
    assert 'chat.history' in methods
    assert (methods.index('sessions.subscribe')
            < methods.index('sessions.messages.subscribe')
            < methods.index('chat.history'))
    # messages.subscribe 带当前会话 key；chat.history 带 sessionKey
    ms = next(f for f in t.sent if f.get('method') == 'sessions.messages.subscribe')
    assert ms['params'] == {'key': 's1'}
    hist = next(f for f in t.sent if f.get('method') == 'chat.history')
    assert hist['params'] == {'sessionKey': 's1'}
    await c2.aclose()


@pytest.mark.asyncio
async def test_record_active_session_default_subscribes_on_first_connect():
    """#217 步1：首连前已 record_active_session → 首连即发 messages.subscribe + chat.history
    （恢复语义对首连同样生效——每次握手成功后都重建订阅）。"""
    t = FakeChatTransport(rpc_payloads={'chat.history': {'messages': []}})
    c = _client(transport=t)
    c.record_active_session('s1')
    await c.connect()
    methods = _methods(t)
    assert 'sessions.messages.subscribe' in methods
    assert 'chat.history' in methods
    await c.aclose()


@pytest.mark.asyncio
async def test_recovery_restores_every_remembered_session():
    """#217 / codex #236 R2 P1-223：多 consumer 共享池化 client 各自记住不同 sessionKey——恢复须
    **逐会话** messages.subscribe + chat.history（不再只恢复最近一条，否则其余 consumer 的进行中
    run 丢路由续流）。"""
    t = FakeChatTransport(rpc_payloads={'chat.history': {'messages': []}})
    received = []

    async def cb_a(frame):
        received.append(('a', frame))

    async def cb_b(frame):
        received.append(('b', frame))

    c = _client(transport=t)
    c.record_active_session('sess-a', cb_a)  # consumer A 的会话
    c.record_active_session('sess-b', cb_b)  # consumer B 的会话（同 client，不同 key）
    await c.connect()
    sub_keys = {f['params'].get('key') for f in t.sent if f.get('method') == 'sessions.messages.subscribe'}
    hist_keys = {f['params'].get('sessionKey') for f in t.sent if f.get('method') == 'chat.history'}
    assert sub_keys == {'sess-a', 'sess-b'}, f'两会话都须 messages.subscribe: {sub_keys}'
    assert hist_keys == {'sess-a', 'sess-b'}, f'两会话都须 chat.history: {hist_keys}'
    # recovery_sessions 逐条返回（传播源）
    assert dict(c.recovery_sessions()) == {'sess-a': [cb_a], 'sess-b': [cb_b]}
    await c.aclose()


@pytest.mark.asyncio
async def test_unregister_matches_bound_method_equality_not_identity():
    """#217 / codex #236 R2 P2-251：unregister 用**相等**（bound method 按 __self__+__func__ 判等）
    非恒等——consumer 每次求值 self._on_event 得到新 bound-method 对象，``is`` 恒假会让注销静默失效。
    此处断开时传入**新求值**的 bound method（非 record 时同一对象），仍须成功注销。"""
    class _Consumer:  # 模拟 ChatConsumer：方法作回调，两次取 self.cb 得不同 bound-method 对象
        async def cb(self, frame):
            pass

    consumer = _Consumer()
    c = _client(transport=FakeChatTransport(rpc_payloads={'chat.history': {'messages': []}}))
    c.record_active_session('s1', consumer.cb)  # 注册时的一个 bound-method 对象
    assert dict(c.recovery_sessions())  # 非空即注册成功（空 dict 为 falsey，C1803 简化）
    c.unregister_active_session('s1', consumer.cb)  # 断开时再取 self.cb——新对象但 __eq__ 相等
    assert c.recovery_sessions() == [], 'bound-method 相等应注销成功（恒等比较会静默失效）'
    await c.aclose()


@pytest.mark.asyncio
async def test_unregister_drops_adopted_run_route():
    """#217 / codex #236 R2 P2-96：恢复采用的 inFlightRun 重建了路由但不进 consumer._active_runids
    （disconnect 不 discard）——unregister_active_session 须按会话对称清这些重建路由，防已关闭
    consumer 被池化 client 保留并续接该 run 事件。"""
    history = {'messages': [], 'inFlightRun': {'runId': 'adopted-run', 'text': 'buf'}}
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event)
    await c.connect()
    assert 'adopted-run' in c._routes  # 恢复重建了路由
    c.unregister_active_session('s1', on_event)  # 断开 → 对称清
    assert 'adopted-run' not in c._routes, 'adopted run 路由须随 unregister 清除'
    # 后续该 runId 事件不再路由到已注销 consumer（cb is None 丢弃）
    t.push({'type': 'event', 'event': 'chat',
            'payload': {'runId': 'adopted-run', 'state': 'delta', 'deltaText': 'x'}})
    await asyncio.sleep(0.05)
    assert not any(f.get('runId') == 'adopted-run' and f.get('type') == 'text' and f.get('delta') == 'x'
                   for f in received)
    await c.aclose()


@pytest.mark.asyncio
async def test_adopt_inflight_run_rebuilds_route_and_replays_text():
    """#217 步3：chat.history 返回 inFlightRun → 采用其 runId + 缓冲 text（replace 回放），
    重建 runId 路由——网关后续该 runId 的事件路由到 session 回调（不再 cb is None 黑洞）。"""
    history = {
        'messages': [],
        'inFlightRun': {'runId': 'inflight-1', 'text': '半截回答'},
    }
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    # 采用 inFlightRun：缓冲 text 经真实 runId replace 回放
    assert {'type': 'text', 'runId': 'inflight-1', 'delta': '半截回答', 'replace': True} in received
    # 恢复不发终态 done
    assert not any(f.get('type') == 'done' for f in received)
    # 路由已重建：网关后续该 runId 的 delta 路由到 session 回调
    t.push({'type': 'event', 'event': 'chat',
            'payload': {'runId': 'inflight-1', 'state': 'delta', 'deltaText': '，继续'}})
    await asyncio.sleep(0.05)
    assert {'type': 'text', 'runId': 'inflight-1', 'delta': '，继续'} in received
    await c.aclose()


@pytest.mark.asyncio
async def test_adopt_inflight_run_empty_text_still_rebuilds_route():
    """#217 步3（即使 text 为空也采用）：inFlightRun.text 为空 → 不发 text 帧，但仍重建 runId 路由
    （恢复进行中 run 的事件流不丢）。"""
    history = {'messages': [], 'inFlightRun': {'runId': 'inflight-empty', 'text': ''}}
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    # 空 text：不发 text 回放帧，但路由须已重建
    assert not any(f.get('runId') == 'inflight-empty' and f.get('type') == 'text' for f in received)
    t.push({'type': 'event', 'event': 'chat',
            'payload': {'runId': 'inflight-empty', 'state': 'delta', 'deltaText': 'x'}})
    await asyncio.sleep(0.05)
    assert {'type': 'text', 'runId': 'inflight-empty', 'delta': 'x'} in received
    await c.aclose()


@pytest.mark.asyncio
async def test_adopt_inflight_run_plan_passthrough():
    """#217 步3（采用可选 plan）/ codex #236 P2-104：inFlightRun.plan（systemRunPlan）被采用进
    RecoveredRun，但**不下发** plan 帧——前端 ws.ts 尚无 plan ChatFrame 类型/handleMessage 分支，
    发即静默丢弃；前端 plan 卡接线属 #198。故断言**无** plan 帧发出（采纳值留 RecoveredRun 供 #198）。"""
    history = {
        'messages': [],
        'inFlightRun': {'runId': 'inflight-plan', 'text': '',
                        'plan': {'rawCommand': 'curl x', 'sessionKey': 's1'}},
    }
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    # plan 被采用（路由重建证明 run 被采纳），但不下发 plan 帧（前端无此契约，#198 接线前不发明文）
    assert not any(f.get('type') == 'plan' for f in received)
    await c.aclose()


@pytest.mark.asyncio
async def test_history_messages_replayed_as_history_namespace_replace():
    """#217 步2：chat.history 的 messages 投影经 __history__ 命名空间 runId 整段回放（replace=True
    → 前端整段替换而非追加），按消息顺序拼接、后发覆盖先发。"""
    history = {
        'messages': [
            {'role': 'user', 'content': [{'type': 'text', 'text': '问题一'}]},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': '回答一'}]},
        ],
    }
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    history_frames = [f for f in received if f.get('runId') == '__history__']
    assert history_frames == [
        {'type': 'text', 'runId': '__history__', 'delta': '问题一', 'replace': True},
        {'type': 'text', 'runId': '__history__', 'delta': '回答一'},
    ]
    await c.aclose()


@pytest.mark.asyncio
async def test_history_user_string_content_replayed():
    """#217 步2 / codex #236 P2-120：chat.history 的 content **多态**（ADR 0003：user=字符串，
    assistant=list）。复用 _extract_text 会把 user 字符串 content 归 '' → 历史 user turn 从恢复
    投影消失。此处 user 用字符串 content、assistant 用 list，两者都须回放进 __history__ 投影。"""
    history = {
        'messages': [
            {'role': 'user', 'content': '问题一'},  # 字符串 content（ADR 0003 user 形态）
            {'role': 'assistant', 'content': [{'type': 'text', 'text': '回答一'}]},  # list content
        ],
    }
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    history_frames = [f for f in received if f.get('runId') == '__history__']
    assert history_frames == [
        {'type': 'text', 'runId': '__history__', 'delta': '问题一', 'replace': True},
        {'type': 'text', 'runId': '__history__', 'delta': '回答一'},
    ]
    await c.aclose()


@pytest.mark.asyncio
async def test_history_first_emitted_frame_marked_replace_when_leading_empty():
    """#217 步2 / codex #236 P2-120：replace=True 锚定**首个产出帧**而非 index==0——index 0 消息 text
    为空（如纯工具 turn，无 text content）被跳过时，首个实际产出帧仍须带 replace=True 供前端整段锚定。"""
    history = {
        'messages': [
            {'role': 'assistant', 'content': [{'type': 'thinking', 'thinking': '...'}]},  # 无 text → 跳过
            {'role': 'user', 'content': '首个有效'},
        ],
    }
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    history_frames = [f for f in received if f.get('runId') == '__history__']
    # index 0 跳过（无 text）；首个产出帧（index 1）带 replace=True
    assert history_frames == [
        {'type': 'text', 'runId': '__history__', 'delta': '首个有效', 'replace': True},
    ]
    await c.aclose()


@pytest.mark.asyncio
async def test_session_info_active_run_not_in_ids_no_retained_route():
    """#217 步4：sessionInfo.hasActiveRun=true 但 inFlightRun.runId 不在 activeRunIds → 不重建
    保留路由（该 run 属另一活跃投影，网关不会在本连接续流）。"""
    history = {
        'messages': [],
        'inFlightRun': {'runId': 'stale-run', 'text': 'orphan'},
        'sessionInfo': {'hasActiveRun': True, 'activeRunIds': ['other-run']},
    }
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    # 不采用 stale-run（不在 activeRunIds）→ 后续该 runId 事件不路由（cb is None 丢弃）
    t.push({'type': 'event', 'event': 'chat',
            'payload': {'runId': 'stale-run', 'state': 'delta', 'deltaText': 'x'}})
    await asyncio.sleep(0.05)
    assert not any(f.get('runId') == 'stale-run' for f in received)
    await c.aclose()


@pytest.mark.asyncio
async def test_inflight_event_arriving_during_recovery_not_lost():
    """#217 步3+5（不丢）：inFlightRun 的 delta 事件**在恢复泵期**到达（history res 与路由重建之间
    或紧随其后）——经缓冲在路由重建后回放，不丢帧（契约「重连后进行中 run 输出不进入无路由黑洞」）。"""
    history = {'messages': [], 'inFlightRun': {'runId': 'inflight-1', 'text': 'buf'}}
    # events 预设在 connect 期到达（恢复泵会读到并缓冲）；路由重建后回放。
    t = FakeChatTransport(
        rpc_payloads={'chat.history': history},
        events=[{'type': 'event', 'event': 'chat',
                 'payload': {'runId': 'inflight-1', 'state': 'delta', 'deltaText': '，途中'}}],
    )
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    await asyncio.sleep(0.1)  # 等缓冲回放
    deltas = [f for f in received if f.get('runId') == 'inflight-1' and f.get('type') == 'text']
    assert any(f.get('delta') == '，途中' for f in deltas), f'恢复泵期到达的事件未回放: {received}'
    await c.aclose()


@pytest.mark.asyncio
async def test_connection_level_event_drained_when_no_adoptable_run():
    """#217 / codex #236 P2-419：恢复泵期到达的**连接级** event（approval，无 runId、无可采用
    inFlightRun）须在恢复完成后**无条件**回放 fan-out——原先仅「采用 inFlightRun」或「后续 send ack」
    两路回放缓冲，无活跃会话/无可采用 run 时该帧滞留到无关的未来 send 才浮现（审批卡迟到/丢失）。"""
    t = FakeChatTransport(
        rpc_payloads={'chat.history': {'messages': []}},  # 无 inFlightRun → 无可采用 run
        events=[{'type': 'event', 'event': 'exec.approval.requested',
                 'payload': {'id': 'ap-conn', 'request': {'command': 'curl x', 'sessionKey': 's1'}}}],
    )
    approvals = []

    async def on_approval(frame):
        approvals.append(frame)

    async def on_event(frame):  # 会话投影回调（本测试不关注）
        pass

    c = _client(transport=t)
    c.add_approval_subscriber(on_approval)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    await asyncio.sleep(0.1)  # 等恢复完成后的无条件缓冲回放
    assert any(f.get('type') == 'approval' and f.get('id') == 'ap-conn' for f in approvals), \
        f'连接级审批事件在无可采用 run 时未回放: {approvals}'
    await c.aclose()


@pytest.mark.asyncio
async def test_session_info_active_run_in_ids_keeps_route():
    """#217 步4（对照）：inFlightRun.runId 在 activeRunIds 中 → 正常重建路由（归属本连接）。"""
    history = {
        'messages': [],
        'inFlightRun': {'runId': 'live-run', 'text': 'buf'},
        'sessionInfo': {'hasActiveRun': True, 'activeRunIds': ['live-run']},
    }
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    t.push({'type': 'event', 'event': 'chat',
            'payload': {'runId': 'live-run', 'state': 'delta', 'deltaText': 'y'}})
    await asyncio.sleep(0.05)
    assert {'type': 'text', 'runId': 'live-run', 'delta': 'y'} in received
    await c.aclose()


@pytest.mark.asyncio
async def test_recovered_inflight_run_final_does_not_duplicate():
    """#217 / codex #236 R3 P1-108：恢复回放的 inFlightRun 缓冲 text 须 seed 翻译器累积器——否则网关
    后续 final 快照以为尚未产出、整段重发（"Hello"+"Hello world"→"HelloHello world"）。

    恢复后仅应补 final 的**尾部增量**（sent 差集），不得重放已恢复的整段文本。"""
    history = {'messages': [], 'inFlightRun': {'runId': 'inflight-1', 'text': 'Hello'}}
    # final 在恢复完成后到达（经重建路由翻译）——message 含已恢复前缀 + 尾部。
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received = []

    async def on_event(frame):
        received.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event=on_event)
    await c.connect()
    # 恢复已完成：路由重建 + 缓冲 text 回放（此时才推 final，避免撞泵期缓冲）
    t.push({'type': 'event', 'event': 'chat',
            'payload': {'runId': 'inflight-1', 'state': 'final',
                        'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Hello world'}]}}})
    await asyncio.sleep(0.1)  # 等 final 翻译
    texts = [f for f in received if f.get('type') == 'text']
    # 恢复回放整段 Hello（replace），final 只补尾部 world——全文不得出现第二次整段 Hello
    assert {'type': 'text', 'runId': 'inflight-1', 'delta': 'Hello', 'replace': True} in texts
    assert {'type': 'text', 'runId': 'inflight-1', 'delta': ' world'} in texts, \
        f'final 未以恢复文本为基线只补尾部: {texts}'
    assert not any(f.get('delta') == 'Hello world' for f in texts), \
        f'final 整段重发已恢复文本（累积器未 seed）: {texts}'
    assert any(f.get('type') == 'done' for f in received)
    await c.aclose()


@pytest.mark.asyncio
async def test_same_session_multi_subscriber_both_get_recovery():
    """#217 / codex #236 R3 P1-242：共享池化 client 同一会话多 consumer（各自 record_active_session）——
    history 投影 + inFlightRun 续流须 fan-out 到**全部**订阅者，非只投最后一个（单槽覆盖会丢前者的
    续流）。"""
    history = {
        'messages': [{'role': 'user', 'content': '历史消息'}],
        'inFlightRun': {'runId': 'inflight-shared', 'text': '半截'},
    }
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received_a, received_b = [], []

    async def on_event_a(frame):
        received_a.append(frame)

    async def on_event_b(frame):
        received_b.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event_a)  # consumer A
    c.record_active_session('s1', on_event_b)  # consumer B（同会话——单槽覆盖会顶掉 A）
    await c.connect()
    # 两会话投影都到：历史 replace 帧 + inFlightRun 缓冲 text
    assert {'type': 'text', 'runId': HISTORY_RUN_ID, 'delta': '历史消息', 'replace': True} in received_a
    assert {'type': 'text', 'runId': HISTORY_RUN_ID, 'delta': '历史消息', 'replace': True} in received_b
    assert {'type': 'text', 'runId': 'inflight-shared', 'delta': '半截', 'replace': True} in received_a
    assert {'type': 'text', 'runId': 'inflight-shared', 'delta': '半截', 'replace': True} in received_b
    # 续流：网关后续该 runId 的 delta 须路由到**两个**订阅者（fan-out 路由，非单槽）
    t.push({'type': 'event', 'event': 'chat',
            'payload': {'runId': 'inflight-shared', 'state': 'delta', 'deltaText': '，续'}})
    await asyncio.sleep(0.05)
    assert {'type': 'text', 'runId': 'inflight-shared', 'delta': '，续'} in received_a
    assert {'type': 'text', 'runId': 'inflight-shared', 'delta': '，续'} in received_b
    await c.aclose()


@pytest.mark.asyncio
async def test_same_session_unregister_keeps_peer_subscriber():
    """#217 / codex #236 R3 P1-242：同会话多订阅者之一断开（unregister）只移除**自己**——会话与
    恢复路由保留，peer 的续流不受影响（单槽覆盖会因最后一个注册者断开而整个清掉）。"""
    history = {'messages': [], 'inFlightRun': {'runId': 'inflight-shared', 'text': 'buf'}}
    t = FakeChatTransport(rpc_payloads={'chat.history': history})
    received_a, received_b = [], []

    async def on_event_a(frame):
        received_a.append(frame)

    async def on_event_b(frame):
        received_b.append(frame)

    c = _client(transport=t)
    c.record_active_session('s1', on_event_a)
    c.record_active_session('s1', on_event_b)
    await c.connect()
    assert 'inflight-shared' in c._routes  # 恢复路由已建
    c.unregister_active_session('s1', on_event_a)  # A 断开
    # B 仍在订阅：会话保留、恢复路由未清、续流继续投 B
    assert 's1' in c._active_session_keys
    assert 'inflight-shared' in c._routes, 'peer 仍订阅时恢复路由不得随单订阅者断开清除'
    t.push({'type': 'event', 'event': 'chat',
            'payload': {'runId': 'inflight-shared', 'state': 'delta', 'deltaText': 'x'}})
    await asyncio.sleep(0.05)
    assert not any(f.get('delta') == 'x' for f in received_a), '已断开订阅者不得再收续流'
    assert {'type': 'text', 'runId': 'inflight-shared', 'delta': 'x'} in received_b
    await c.aclose()
