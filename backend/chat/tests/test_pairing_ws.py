"""seam: chat.pairing_ws —— 配对握手 WS 客户端（issue #40 / spec §8.1）。

一次性握手：challenge(nonce) → connect(device 签名 + bootstrap token) →
hello-ok(auth.deviceToken+scopes) / PAIRING_REQUIRED(requestId) / 其它 error。

注入 transport（FakeTransport），fake 模拟网关帧序列（含乱序帧），无需真容器。
"""
import pytest

from chat.device_crypto import DeviceCrypto
from chat.pairing_ws import (
    PairingError,
    PairingHandshake,
    PairingRequired,
    PairingResult,
)
from chat.tests.fakes import FakeTransport


@pytest.fixture
def identity():
    return DeviceCrypto.generate_identity()


@pytest.mark.asyncio
async def test_handshake_success_returns_device_token_and_scopes(identity):
    scopes = ['operator.read', 'operator.write', 'operator.approvals']
    hs = PairingHandshake(transport=FakeTransport.hello_ok(scopes=scopes, device_token='dt-abc'))
    result = await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)

    assert isinstance(result, PairingResult)
    assert result.device_token == 'dt-abc'
    assert result.scopes == scopes


@pytest.mark.asyncio
async def test_sends_signed_connect_frame(identity):
    sent = []

    class _Ws:
        async def send(self, data):
            import json
            sent.append(json.loads(data))

        async def recv(self):
            import json
            if not sent:
                return json.dumps({'type': 'event', 'event': 'connect.challenge',
                                   'payload': {'nonce': 'nz-9', 'ts': 1}})
            return json.dumps({'type': 'res', 'id': sent[0]['id'], 'ok': True,
                               'payload': {'auth': {'deviceToken': 'dt',
                                                    'scopes': ['operator.read', 'operator.write', 'operator.approvals']}}})

        async def close(self):
            pass

    class _CM:
        async def __aenter__(self):
            return _Ws()

        async def __aexit__(self, *a):
            return False

    hs = PairingHandshake(transport=lambda url: _CM())
    await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)

    connect = sent[0]
    assert connect['type'] == 'req'
    assert connect['method'] == 'connect'
    params = connect['params']
    assert params['auth']['token'] == 'gw-tok'
    assert params['role'] == 'operator'
    assert set(params['scopes']) >= {'operator.read', 'operator.write', 'operator.approvals'}
    assert 'tool-events' in params['caps']
    device = params['device']
    assert device['id'] == identity.device_id
    assert device['nonce'] == 'nz-9'
    assert device['publicKey'] == identity.public_key_raw_base64url()
    assert isinstance(device['signedAt'], int)
    assert device['signature']


@pytest.mark.asyncio
async def test_handshake_pairing_required_raises_with_request_id(identity):
    hs = PairingHandshake(transport=FakeTransport.pairing_required(request_id='req-777'))
    with pytest.raises(PairingRequired) as exc_info:
        await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)
    assert exc_info.value.request_id == 'req-777'


@pytest.mark.asyncio
async def test_handshake_rejects_partial_scopes(identity):
    """hello-ok 协商 scope 缺少 operator.read/write/approvals 任一 → PairingError。"""
    hs = PairingHandshake(transport=FakeTransport.hello_ok(scopes=['operator.read']))
    with pytest.raises(PairingError) as exc_info:
        await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)
    assert 'operator.write' in str(exc_info.value)
    assert 'operator.approvals' in str(exc_info.value)


@pytest.mark.asyncio
async def test_handshake_rejects_empty_scopes(identity):
    """hello-ok 协商空 scopes → PairingError，不能标记 paired。"""
    hs = PairingHandshake(transport=FakeTransport.hello_ok(scopes=[]))
    with pytest.raises(PairingError):
        await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)


@pytest.mark.asyncio
async def test_pairing_required_without_request_id_becomes_pairing_error(identity):
    """PAIRING_REQUIRED 缺 requestId 是协议失败，不应让用户执行空 approve 命令。"""
    transport = FakeTransport(
        result_frame={'type': 'res', 'ok': False,
                      'error': {'code': 'PAIRING_REQUIRED',
                                'details': {'recommendedNextStep': 'wait_then_retry'}}},
    )
    hs = PairingHandshake(transport=transport)
    with pytest.raises(PairingError) as exc_info:
        await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)
    assert 'requestId' in str(exc_info.value)


@pytest.mark.asyncio
async def test_handshake_other_error_raises_pairing_error(identity):
    hs = PairingHandshake(transport=FakeTransport.connect_error('bad token'))
    with pytest.raises(PairingError):
        await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)


@pytest.mark.asyncio
async def test_handshake_propagates_retryable_flag_on_startup_pending(identity):
    """网关冷启动期 ``gateway starting; retry shortly``（errorShape retryable:true）应透传
    retryable 标志与 retryAfterMs，供调用方（ApprovalPairer）重试而非当确定失败。"""
    hs = PairingHandshake(transport=FakeTransport.startup_pending())
    with pytest.raises(PairingError) as exc_info:
        await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)

    assert exc_info.value.retryable is True
    assert exc_info.value.retry_after_ms == 500
    assert 'retry shortly' in str(exc_info.value)


@pytest.mark.asyncio
async def test_handshake_retries_startup_pending_then_succeeds(identity):
    """有界重试：冷启动瞬态错误（retryable）重试后成功——生产配对与 smoke 共用此叶子。"""
    transport = FakeTransport.startup_then_ok()
    sleeps = []

    async def _record_sleep(secs):
        sleeps.append(secs)

    hs = PairingHandshake(transport=transport, sleep=_record_sleep)
    result = await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)

    assert isinstance(result, PairingResult)
    assert result.device_token == 'dt-fake'
    assert transport.connect_calls == 2      # 第 1 次 startup pending → 第 2 次成功
    assert sleeps == [0.5]                   # 按 retryAfterMs=500 等待一次


@pytest.mark.asyncio
async def test_handshake_gives_up_after_max_startup_retries(identity):
    """有界重试上限：持续 startup pending 至 max_startup_retries 后仍抛（不无限循环）。"""
    transport = FakeTransport.startup_pending()
    sleeps = []

    async def _record_sleep(secs):
        sleeps.append(secs)

    hs = PairingHandshake(
        transport=transport, max_startup_retries=3,
        sleep=_record_sleep,
    )
    with pytest.raises(PairingError) as exc_info:
        await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)

    assert exc_info.value.retryable is True
    assert transport.connect_calls == 4      # 初始 1 + 重试 3
    assert len(sleeps) == 3                  # 每次失败后等 0.5s


@pytest.mark.asyncio
async def test_handshake_does_not_retry_non_retryable_error(identity):
    """确定错误（非 retryable）不重试，立即传播。"""
    transport = FakeTransport.connect_error('bad token')
    hs = PairingHandshake(transport=transport, max_startup_retries=5)
    with pytest.raises(PairingError):
        await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)

    assert transport.connect_calls == 1


# ---------------------------- 乱序帧容错（codex R protocol/correctness）----------------------------


@pytest.mark.asyncio
async def test_tolerates_interleaved_event_before_challenge(identity):
    """challenge 前先收到无关 event → 忽略，继续等 challenge。"""
    transport = FakeTransport.hello_ok(
        scopes=['operator.read', 'operator.write', 'operator.approvals'],
        pre_challenge_frames=[
            {'type': 'event', 'event': 'tool.start', 'payload': {}},
        ],
    )
    hs = PairingHandshake(transport=transport)
    result = await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)
    assert result.device_token == 'dt-fake'


@pytest.mark.asyncio
async def test_tolerates_stray_res_before_connect_res(identity):
    """connect res 前先收到 id 不匹配的 stray res → 忽略，等真正的 connect res。"""
    transport = FakeTransport.hello_ok(
        scopes=['operator.read', 'operator.write', 'operator.approvals'],
        pre_result_frames=[
            {'type': 'res', 'id': 'stale-id', 'ok': False,
             'error': {'code': 'SOME_STALE', 'message': 'stale'}},
        ],
    )
    hs = PairingHandshake(transport=transport)
    result = await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)
    assert result.device_token == 'dt-fake'
    assert 'operator.write' in result.scopes
