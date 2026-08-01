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
from chat.pairing import ExecPairingApprover, PairingService
from chat.pairing_ws import PairingError, PairingRequired
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
    transport = FakeTransport.hello_ok()
    svc = PairingService(transport=transport)
    pairing = svc.ensure_paired(instance)

    assert pairing.status == Pairing.STATUS_PAIRED
    assert pairing.device_token == 'dt-fake'
    assert set(pairing.scopes_list()) >= {'operator.read', 'operator.write', 'operator.approvals'}
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


def test_pair_retries_gateway_startup_pending_then_succeeds(instance):
    """生产路径：创建容器后立即配对撞上冷启动 isStartupPending（retryable）→ 握手层
    有界重试后成功（不再落 STATUS_ERROR 抛 502，codex P1）。"""
    svc = PairingService(transport=FakeTransport.startup_then_ok())
    pairing = svc.ensure_paired(instance)

    assert pairing.status == Pairing.STATUS_PAIRED
    assert pairing.device_token == 'dt-fake'


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
    with pytest.raises(PairingError):
        svc.ensure_paired(instance)
    pairing = Pairing.objects.get(instance=instance)
    assert pairing.status == Pairing.STATUS_ERROR


# ---------------------------- 并发与恢复 ----------------------------


def test_force_repair_re_handshakes_even_when_already_paired(instance):
    """deviceToken 被网关撤销/重置后，force_repair=True 重新握手并更新 token。"""
    svc = PairingService(transport=FakeTransport.hello_ok(device_token='dt-old'))
    p1 = svc.ensure_paired(instance)
    assert p1.device_token == 'dt-old'

    svc2 = PairingService(transport=FakeTransport.hello_ok(device_token='dt-new'))
    p2 = svc2.ensure_paired(instance, force_repair=True)
    assert p2.device_token == 'dt-new'
    assert p2.status == Pairing.STATUS_PAIRED


# 并发身份竞态由 PairingService.ensure_paired 内 select_for_update() 保证；
# 多线程同时写入 SQLite 在测试中会触发 database locked，故用单线程回归验证
# 身份持久化后复用（test_pair_generates_persistent_identity_reused_across_calls）+ force_repair。


# ---------------------------- 自动 approve（面板默认开启）----------------------------


class _FakeApprover:
    """记录 approve 调用；可注入失败以测 approve 异常路径。"""

    def __init__(self, fail_with: Exception | None = None):
        self.calls: list[tuple[str, str]] = []
        self._fail_with = fail_with

    def approve(self, instance_name: str, request_id: str) -> None:
        self.calls.append((instance_name, request_id))
        if self._fail_with is not None:
            raise self._fail_with


def test_auto_approve_pairs_in_single_call(instance):
    """注入 approver：PAIRING_REQUIRED 后自动 approve + 同 deviceId 重握手 → 一次 ensure_paired 即 paired。"""
    transport = FakeTransport.sequence([
        FakeTransport.pairing_required(request_id='req-auto')._result_frame,
        FakeTransport.hello_ok(device_token='dt-approved')._result_frame,
    ])
    approver = _FakeApprover()
    svc = PairingService(transport=transport, approver=approver)
    pairing = svc.ensure_paired(instance)

    assert pairing.status == Pairing.STATUS_PAIRED
    assert pairing.device_token == 'dt-approved'
    assert approver.calls == [(instance.name, 'req-auto')]   # approve 用首次 reqId
    assert transport.connect_calls == 2                       # 握手两次：pending → hello-ok


def test_auto_approve_failure_falls_back_to_pending(instance):
    """approve 异常（容器未起/CLI 失败）→ 落 pending + raise PairingRequired（调用方给重试路径）。"""
    transport = FakeTransport.pairing_required(request_id='req-fail')
    approver = _FakeApprover(fail_with=RuntimeError('container not running'))
    svc = PairingService(transport=transport, approver=approver)
    with pytest.raises(PairingRequired):
        svc.ensure_paired(instance)

    pairing = Pairing.objects.get(instance=instance)
    assert pairing.status == Pairing.STATUS_PENDING
    assert pairing.pairing_request_id == 'req-fail'
    assert transport.connect_calls == 1   # 仅首次握手，未重握手


def test_auto_approve_pairing_error_marks_status_error_not_pending(instance):
    """codex P2 :f617d25 review（pairing.py:258）：approve 抛 PairingError（来自
    ExecPairingApprover 把 exec_sync RuntimeError 转译）→ 保留 STATUS_ERROR + raise PairingError，
    不降级为 STATUS_PENDING + PairingRequired。降级会让 admin 看到 202 actionable 但实际是
    永久失败（token 不匹配 / request ID 过期 / 网关断连），后续 retry 只需 force_repair 重置
    attempt_version，而非「再试一次就过」。RuntimeError 路径仍走 pending fallback（transient）。
    """
    transport = FakeTransport.pairing_required(request_id='req-perm-fail')
    approver = _FakeApprover(
        fail_with=PairingError('openclaw devices approve failed in demo: token mismatch'),
    )
    svc = PairingService(transport=transport, approver=approver)
    with pytest.raises(PairingError) as exc_info:
        svc.ensure_paired(instance)
    # 错误消息保留底层 approver 细节，便于排错
    assert 'token mismatch' in str(exc_info.value)

    pairing = Pairing.objects.get(instance=instance)
    # 核心不变量：STATUS_ERROR 而非 STATUS_PENDING，admin 看到这是 error 不是 actionable
    assert pairing.status == Pairing.STATUS_ERROR
    assert pairing.pairing_request_id == 'req-perm-fail'  # 保留 reqId 以便排错
    assert transport.connect_calls == 1   # 仅首次握手，approve 失败未触发重握手


def test_auto_approve_skipped_when_still_pending_after_approve(instance):
    """approve 后重握手仍 PAIRING_REQUIRED（approve 未生效/竞态）→ 落最新 reqId + raise。"""
    transport = FakeTransport.sequence([
        FakeTransport.pairing_required(request_id='req-1')._result_frame,
        FakeTransport.pairing_required(request_id='req-2')._result_frame,
    ])
    approver = _FakeApprover()
    svc = PairingService(transport=transport, approver=approver)
    with pytest.raises(PairingRequired) as exc_info:
        svc.ensure_paired(instance)
    assert exc_info.value.request_id == 'req-2'

    pairing = Pairing.objects.get(instance=instance)
    assert pairing.status == Pairing.STATUS_PENDING
    assert pairing.pairing_request_id == 'req-2'


def test_no_approver_keeps_legacy_pending_behavior(instance):
    """无 approver：PAIRING_REQUIRED 保持原行为（落 pending + raise，不自动 approve）。"""
    transport = FakeTransport.pairing_required(request_id='req-legacy')
    approver = _FakeApprover()
    svc = PairingService(transport=transport, approver=None)
    with pytest.raises(PairingRequired):
        svc.ensure_paired(instance)
    assert not approver.calls  # 未注入 approver，不触发 approve


def test_auto_approve_second_handshake_error_marks_status_error(instance):
    """codex P2 :257：approve 成功但第二次握手抛 PairingError（网关断连/坏帧）→ 必须落
    STATUS_ERROR 再 raise。

    该 PairingError 源自外层 ``except PairingRequired`` 块内的 ``_approve_and_rehandshake``
    调用，外层 sibling ``except PairingError`` 无法再捕获（Python：进入某 except handler 后，
    同一 try 的其它 except 不再 consult）。原实现：异常透传 → API 返 502 且配对行停留在旧
    状态（force_repair 时残留已撤销的 paired + 旧 deviceToken）。force_repair 下先建 paired
    行以复现「stale paired」最坏情形。
    """
    # 先 paired + 旧 token（模拟 deviceToken 被网关撤销后的 force_repair）
    PairingService(transport=FakeTransport.hello_ok(device_token='dt-old')).ensure_paired(instance)
    assert Pairing.objects.get(instance=instance).status == Pairing.STATUS_PAIRED

    transport = FakeTransport.sequence([
        FakeTransport.pairing_required(request_id='req-auto')._result_frame,
        FakeTransport.connect_error(message='gateway disconnected')._result_frame,
    ])
    approver = _FakeApprover()  # approve 成功
    svc = PairingService(transport=transport, approver=approver)
    with pytest.raises(PairingError):
        svc.ensure_paired(instance, force_repair=True)

    pairing = Pairing.objects.get(instance=instance)
    assert pairing.status == Pairing.STATUS_ERROR          # 不再残留 paired（核心不变量）
    assert approver.calls == [(instance.name, 'req-auto')]  # approve 确已执行（第二次握手才崩）
    assert transport.connect_calls == 2                    # 首次 PAIRING_REQUIRED + 第二次崩


# ---------------------------- 事件循环上下文（ASGI 安全）----------------------------


def test_exec_pairing_approver_wraps_runtime_error_as_pairing_error():
    """codex P2 :2902641 review（chat/pairing.py:66）：DockerRuntime.exec_sync 在 approve CLI
    退出码非零时抛 RuntimeError（Phase 2.1 改）。ExecPairingApprover 必须转译为 PairingError，
    让 PairingService 的 STATUS_ERROR 路径生效——否则 RuntimeError 透传 = 配对行停留在 stale
    actionable pending + 重握手替换原 requestId → 配对 churn 无限循环。
    """
    def _raise_runtime_error(instance_name, cmd):
        raise RuntimeError(
            f'exec_sync failed in {instance_name}: exit_code=1 cmd={cmd!r}',
        )

    approver = ExecPairingApprover(executor=_raise_runtime_error)
    with pytest.raises(PairingError) as exc_info:
        approver.approve('demo', 'req-1')
    # 错误消息保留底层细节便于排错
    assert 'exit_code=1' in str(exc_info.value)
    assert 'demo' in str(exc_info.value)


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
        svc = PairingService(transport=FakeTransport.hello_ok())
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
