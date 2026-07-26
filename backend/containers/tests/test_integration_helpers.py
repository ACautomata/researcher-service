"""ApprovalPairer 编排逻辑单测（issue #94 配对 approve 轮询）。

集成测试本体需真 daemon（RUN_INTEGRATION=1 门控），无法在 CI 红→绿；把配对 approve
轮询的纯编排逻辑抽成 ApprovalPairer（integration_helpers.py），此处用 fake pairing
service + 假时钟确定性驱动其正确性：approve 只触发一次、轮询至 paired、独立超时、
PairingError 立即传播。
"""
import pytest

from chat.pairing_ws import PairingError, PairingRequired
from containers.tests.integration_helpers import ApprovalPairer, PairingApprovalTimeout

# 已配对的 Pairing 占位（helper 只透传 ensure_paired 返回值，不读其字段）
_PAIRED = object()


class _FakePairingService:
    """按脚本返回/抛：calls 超过脚本长度后重复最后一个 outcome（覆盖持续 pending）。"""

    def __init__(self, outcomes):
        self._outcomes = outcomes
        self.calls = 0

    def ensure_paired(self, instance):
        self.calls += 1
        idx = min(self.calls - 1, len(self._outcomes) - 1)
        outcome = self._outcomes[idx]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class _FakeClock:
    """可读 + sleep 推进，替代 time.monotonic/time.sleep（测试不真睡）。"""

    def __init__(self, start=0.0):
        self.now = start

    def __call__(self):
        return self.now

    def sleep(self, secs):
        self.now += secs


def _make_pairer(service, *, timeout=5.0, interval=1.0, start=100.0):
    clock = _FakeClock(start)
    approved = []

    def approve(request_id):
        approved.append(request_id)

    pairer = ApprovalPairer(
        service,
        approve,
        timeout=timeout,
        interval=interval,
        sleep=clock.sleep,
        clock=clock,
    )
    return pairer, approved


def test_pair_returns_immediately_when_already_paired():
    service = _FakePairingService([_PAIRED])
    pairer, approved = _make_pairer(service)

    result = pairer.pair(instance=None)

    assert result is _PAIRED
    assert not approved             # 已 paired 不触发 approve
    assert service.calls == 1


def test_approves_once_then_succeeds():
    service = _FakePairingService([PairingRequired('req-1'), _PAIRED])
    pairer, approved = _make_pairer(service)

    result = pairer.pair(instance=None)

    assert result is _PAIRED
    assert approved == ['req-1']    # approve 恰好一次
    assert service.calls == 2


def test_approves_once_across_repeated_pairing_required():
    # 网关 approve 异步生效前，ensure_paired 可能连续多次仍报 PAIRING_REQUIRED
    service = _FakePairingService(
        [PairingRequired('req-1'), PairingRequired('req-1'), _PAIRED],
    )
    pairer, approved = _make_pairer(service)

    result = pairer.pair(instance=None)

    assert result is _PAIRED
    assert approved == ['req-1']    # 多次 required 也只 approve 一次
    assert service.calls == 3


def test_times_out_when_never_paired():
    service = _FakePairingService([PairingRequired('req-1')])
    pairer, approved = _make_pairer(service, timeout=5.0, interval=1.0)

    with pytest.raises(PairingApprovalTimeout):
        pairer.pair(instance=None)

    assert approved == ['req-1']    # approve 仍触发过一次
    # deadline=100+5=105；每次 sleep(1) 推进，至 now>=105 终止（不依赖全程 timeout）
    assert service.calls == 6


def test_propagates_pairing_error_without_retry():
    # PairingError（非 PAIRING_REQUIRED）不可重试，立即传播，且不 approve
    service = _FakePairingService([PairingError('boom')])
    pairer, approved = _make_pairer(service)

    with pytest.raises(PairingError):
        pairer.pair(instance=None)

    assert not approved             # PairingError 不 approve
    assert service.calls == 1
