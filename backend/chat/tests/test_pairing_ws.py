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
                               'payload': {'auth': {'deviceToken': 'dt', 'scopes': []}}})

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
async def test_handshake_other_error_raises_pairing_error(identity):
    hs = PairingHandshake(transport=FakeTransport.connect_error('bad token'))
    with pytest.raises(PairingError):
        await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)


# ---------------------------- 乱序帧容错（codex R protocol/correctness）----------------------------


@pytest.mark.asyncio
async def test_tolerates_interleaved_event_before_challenge(identity):
    """challenge 前先收到无关 event → 忽略，继续等 challenge。"""
    transport = FakeTransport.hello_ok(
        scopes=['operator.read'],
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
        scopes=['operator.read', 'operator.write'],
        pre_result_frames=[
            {'type': 'res', 'id': 'stale-id', 'ok': False,
             'error': {'code': 'SOME_STALE', 'message': 'stale'}},
        ],
    )
    hs = PairingHandshake(transport=transport)
    result = await hs.pair(url='ws://127.0.0.1:19000/', token='gw-tok', identity=identity)
    assert result.device_token == 'dt-fake'
    assert 'operator.write' in result.scopes
