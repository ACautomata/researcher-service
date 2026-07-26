"""ApprovalPairer 编排逻辑单测（issue #94 配对 approve 轮询）。

集成测试本体需真 daemon（RUN_INTEGRATION=1 门控），无法在 CI 红→绿；把配对 approve
轮询的纯编排逻辑抽成 ApprovalPairer（integration_helpers.py），此处用 fake pairing
service + 假时钟确定性驱动其正确性：approve 只触发一次、轮询至 paired、独立超时、
PairingError 立即传播。
"""
import pytest

from chat.pairing_ws import PairingError, PairingRequired
from containers.tests.integration_helpers import (
    ApprovalPairer,
    GatewayNotReady,
    GatewayReadinessWaiter,
    PairingApprovalTimeout,
    dump_container_diagnostics,
    force_remove_tree,
)

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


# —— GatewayReadinessWaiter：网关冷启动就绪轮询（codex P2，配对前等 /health）——


class _FakeProbe:
    """按脚本返回 is_reachable；calls 超过脚本长度后重复最后一个 outcome（覆盖持续未就绪）。"""

    def __init__(self, outcomes):
        self._outcomes = outcomes
        self.calls = 0

    def is_reachable(self, port):
        self.calls += 1
        idx = min(self.calls - 1, len(self._outcomes) - 1)
        return self._outcomes[idx]


def _make_waiter(probe, *, timeout=5.0, interval=1.0, start=100.0):
    clock = _FakeClock(start)
    waiter = GatewayReadinessWaiter(
        probe,
        timeout=timeout,
        interval=interval,
        sleep=clock.sleep,
        clock=clock,
    )
    return waiter, clock


def test_wait_returns_immediately_when_already_ready():
    probe = _FakeProbe([True])
    waiter, clock = _make_waiter(probe)

    waiter.wait(port=9999)

    assert probe.calls == 1           # 已就绪：一次探测即返回，不 sleep
    assert clock.now == 100.0


def test_wait_polls_until_ready():
    probe = _FakeProbe([False, False, True])
    waiter, clock = _make_waiter(probe)

    waiter.wait(port=9999)

    assert probe.calls == 3           # 第 3 次探测命中 True → 返回
    assert clock.now == 102.0         # 前两次 False 各 sleep(1)：100→101→102


def test_wait_times_out_when_never_ready():
    probe = _FakeProbe([False])
    waiter, _ = _make_waiter(probe, timeout=5.0, interval=1.0)

    with pytest.raises(GatewayNotReady):
        waiter.wait(port=9999)

    # deadline=100+5=105；每次 sleep(1) 推进，至 now>=105 终止（不依赖全程 timeout）
    assert probe.calls == 6


# ===================== force_remove_tree / dump_container_diagnostics（issue #95 CI 加固）=====================


class _RecordingRunner:
    """记录收到的 docker CLI argv 并按需抛错，断言编排正确性（不真连 daemon）。"""

    def __init__(self, *, fail_on=None):
        self.calls = []          # 每次调用的 argv list
        self._fail_on = fail_on  # 命中该子串的 argv 抛 RuntimeError

    def __call__(self, argv):
        self.calls.append(list(argv))
        if self._fail_on and self._fail_on in ' '.join(argv):
            raise RuntimeError(f'runner failed: {self._fail_on}')
        return ''


def test_force_remove_tree_runs_helper_container_as_root(tmp_path):
    """强删经 helper 容器（0:0 root，bind 父目录）对容器内 root 拥有的文件 rm -rf。"""
    instance_dir = tmp_path / 'fleet' / 'instances' / 'smoke'
    runner = _RecordingRunner()

    force_remove_tree(instance_dir, runner=runner)

    assert len(runner.calls) == 1
    argv = ' '.join(runner.calls[0])
    assert 'docker run' in argv
    assert '--rm' in argv
    # 挂载父目录（instances/），删除目标相对名（smoke）——避免把绝对路径塞进容器内 rm
    assert f'-v {instance_dir.parent}:/target' in argv
    assert 'rm -rf /target/smoke' in argv


def test_force_remove_tree_propagates_helper_failure(tmp_path):
    """helper 容器自身失败（daemon 不可用）直接抛——不做伪成功。"""
    instance_dir = tmp_path / 'fleet' / 'instances' / 'smoke'
    runner = _RecordingRunner(fail_on='docker run')

    with pytest.raises(RuntimeError, match='runner failed'):
        force_remove_tree(instance_dir, runner=runner)


def test_dump_container_diagnostics_reads_logs_and_inspect():
    """诊断转储读 docker logs + docker inspect（只读），输出含两者内容。"""
    def runner(argv):
        cmd = ' '.join(argv)
        if 'logs' in cmd:
            return 'gateway boot trace'
        if 'inspect' in cmd:
            return 'exited(1)'
        return ''

    out = dump_container_diagnostics('smoke-chain', runner=runner)

    assert 'gateway boot trace' in out
    assert 'exited(1)' in out


def test_dump_container_diagnostics_swallows_read_errors():
    """诊断转储永不再抛（容器已删/daemon 抖动）——返回占位串而非中断原失败。"""
    def runner(argv):
        raise RuntimeError('no such container')

    out = dump_container_diagnostics('gone', runner=runner)

    assert isinstance(out, str)   # 不抛，返回可打印占位
