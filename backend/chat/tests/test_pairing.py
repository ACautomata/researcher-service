"""seam: chat.pairing —— PairingService 配对状态机编排（issue #40 / spec §8.1）。

PairingService.ensure_paired(instance)：加载/创建设备身份 → 握手 → 三分支落库：
- hello-ok → 存 deviceToken+scopes，status=paired
- PAIRING_REQUIRED → 存 requestId，status=pending（清晰错误 + 重试路径）
- 其它错误 → status=error
幂等：已 paired 且 deviceToken 在 → 直接复用，不重握手。
注入 transport（fake）替代真网关；containers 用 conftest fleet 注入 FakeRuntime。
"""
import pytest

from chat.models import Pairing
from chat.pairing import PairingService
from chat.pairing_ws import PairingRequired
from chat.tests.fakes import FakeTransport
from containers.models import Instance

pytestmark = pytest.mark.django_db


@pytest.fixture
def instance(db):
    return Instance.objects.create(
        name='demo', port=19000, token='gw-tok',
        home_dir='/tmp/x', container_id='cid', status=Instance.STATUS_RUNNING,
        image='img:tag',
    )


# ---------------------------- 首次配对成功 ----------------------------


def test_pair_success_persists_device_token_and_scopes(instance):
    transport = FakeTransport.hello_ok(scopes=['operator.read', 'operator.write'])
    svc = PairingService(transport=transport)
    pairing = svc.ensure_paired(instance)

    assert pairing.status == Pairing.STATUS_PAIRED
    assert pairing.device_token == 'dt-fake'
    assert set(pairing.scopes_list()) >= {'operator.read', 'operator.write'}
    assert pairing.device_id  # 已生成稳定设备身份
    assert pairing.private_key_pem.startswith('-----BEGIN PRIVATE KEY-----')


def test_pair_generates_persistent_identity_reused_across_calls(instance):
    svc = PairingService(transport=FakeTransport.hello_ok())
    p1 = svc.ensure_paired(instance)
    # 已 paired 且 token 在 → 幂等复用，不再握手（transport 不应再被调用）
    transport2 = FakeTransport.hello_ok()
    svc2 = PairingService(transport=transport2)
    p2 = svc2.ensure_paired(instance)
    assert p1.device_id == p2.device_id
    assert transport2.connect_calls == 0  # 未触发新握手


# ---------------------------- PAIRING_REQUIRED（待批准）----------------------------


def test_pair_pending_when_pairing_required(instance):
    transport = FakeTransport.pairing_required(request_id='req-123')
    svc = PairingService(transport=transport)
    with pytest.raises(PairingRequired) as exc_info:
        svc.ensure_paired(instance)
    assert exc_info.value.request_id == 'req-123'

    pairing = Pairing.objects.get(instance=instance)
    assert pairing.status == Pairing.STATUS_PENDING
    assert pairing.pairing_request_id == 'req-123'
    assert pairing.device_token == ''  # 尚未拿到 token
    # 设备身份已生成并持久化（approve 后重连沿用同一 deviceId）
    assert pairing.device_id


def test_pair_retry_after_approve_succeeds(instance):
    # 第一次：PAIRING_REQUIRED（pending）
    svc = PairingService(transport=FakeTransport.pairing_required(request_id='req-1'))
    with pytest.raises(PairingRequired):
        svc.ensure_paired(instance)
    pairing = Pairing.objects.get(instance=instance)
    assert pairing.status == Pairing.STATUS_PENDING
    first_device_id = pairing.device_id

    # 宿主 approve 后重试：同一 deviceId 握手成功
    svc2 = PairingService(transport=FakeTransport.hello_ok(
        scopes=['operator.read', 'operator.write', 'operator.approvals']))
    pairing2 = svc2.ensure_paired(instance)
    assert pairing2.status == Pairing.STATUS_PAIRED
    assert pairing2.device_id == first_device_id  # 身份稳定
    assert 'operator.approvals' in pairing2.scopes_list()


# ---------------------------- 其它错误 ----------------------------


def test_pair_error_marks_status_error(instance):
    transport = FakeTransport.connect_error('bad gateway token')
    svc = PairingService(transport=transport)
    with pytest.raises(Exception):
        svc.ensure_paired(instance)
    pairing = Pairing.objects.get(instance=instance)
    assert pairing.status == Pairing.STATUS_ERROR


# ---------------------------- 事件循环上下文（ASGI 安全）----------------------------


def test_run_handshake_inside_running_event_loop_thread():
    """codex R: 握手桥接在「调用线程已运行事件循环」时也必须可用。

    真实场景：未来 async view / Channels consumer（事件循环线程）调 ensure_paired。
    asyncio.run / async_to_sync 在同线程事件循环内都会 RuntimeError；
    PairingService 须在独立线程跑握手协程，与调用线程的循环隔离。
    """
    import asyncio

    from chat.device_crypto import DeviceCrypto
    from chat.pairing import PairingService

    async def _main():
        # 当前线程事件循环已运行；直接同步调桥接（不应 RuntimeError）
        svc = PairingService(transport=FakeTransport.hello_ok(scopes=['operator.read']))
        return svc._run_handshake('ws://x/', 'tok', DeviceCrypto.generate_identity())

    result = asyncio.run(_main())
    assert result.device_token == 'dt-fake'


def test_run_handshake_sync_context_still_works():
    """桥接在无事件循环的普通同步上下文（现有 sync 测试路径）同样可用。"""
    from chat.device_crypto import DeviceCrypto
    from chat.pairing import PairingService

    svc = PairingService(transport=FakeTransport.hello_ok())
    result = svc._run_handshake('ws://x/', 'tok', DeviceCrypto.generate_identity())
    assert result.device_token == 'dt-fake'
