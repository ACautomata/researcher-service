"""集成测试编排 helper（issue #94）：配对 approve 轮询等纯编排逻辑。

独立于 RUN_INTEGRATION 门控的 test_integration.py——helper 是无 daemon 可确定性单测的
编排逻辑，供集成测试本体与自身单测（test_integration_helpers.py）共用。非生产业务代码。
"""
import subprocess
import time

from chat.pairing_ws import PairingRequired


class PairingApprovalTimeout(Exception):
    """配对 approve 后轮询至独立 deadline 仍未 paired（approve 异步未生效/网关拒绝）。"""


class ApprovalPairer:
    """驱动配对：首次 PairingRequired 时 approve 一次，轮询 ensure_paired 至 paired。

    容器内 approve 经 exec_in_container（detach=True fire-and-forget），不能依赖 exec 同步
    返回——须轮询配对状态至 paired，带独立 deadline（不等全程 timeout）。PairingError 等
    非重试错误立即传播。sleep/clock 可注入，便于用假时钟确定性单测（不真睡）。
    """

    def __init__(
        self,
        pairing_service,
        approve,
        *,
        timeout,
        interval,
        sleep=time.sleep,
        clock=time.monotonic,
    ) -> None:
        self._pairing = pairing_service
        self._approve = approve
        self._timeout = timeout
        self._interval = interval
        self._sleep = sleep
        self._clock = clock

    def pair(self, instance):
        deadline = self._clock() + self._timeout
        approved = False
        while True:
            try:
                return self._pairing.ensure_paired(instance)
            except PairingRequired as e:
                if not approved:
                    self._approve(e.request_id)
                    approved = True
                if self._clock() >= deadline:
                    raise PairingApprovalTimeout(
                        f'pairing not paired after {self._timeout}s',
                    ) from e
                self._sleep(self._interval)


class GatewayNotReady(Exception):
    """网关 /health 轮询至独立 deadline 仍未就绪（容器启动失败/网关崩溃/端口不通）。"""


class GatewayReadinessWaiter:
    """轮询容器网关 /health 至就绪，带独立 deadline（codex P2：网关冷启动 race）。

    InstanceOrchestrator.create() 在 docker start 后即返回，网关 WS server 仍需数秒 boot；
    list() 的健康探针只单次探测记 unhealthy 不等待。若此时直接配对，WS connect 撞 connection
    refused → PairingHandshake 把一切网络异常包成 PairingError，而 ApprovalPairer 仅重试
    PairingRequired、不重试 PairingError——链路在到达 approve 前即失败。smoke 在调 pair() 前
    先用它轮询 /health 至就绪。probe/sleep/clock 可注入，便于用假探针 + 假时钟确定性单测
    （不真睡、不真连）。
    """

    def __init__(
        self,
        probe,
        *,
        timeout,
        interval,
        sleep=time.sleep,
        clock=time.monotonic,
    ) -> None:
        self._probe = probe
        self._timeout = timeout
        self._interval = interval
        self._sleep = sleep
        self._clock = clock

    def wait(self, port):
        deadline = self._clock() + self._timeout
        while True:
            if self._probe.is_reachable(port):
                return
            if self._clock() >= deadline:
                raise GatewayNotReady(
                    f'gateway not ready after {self._timeout}s on port {port}',
                )
            self._sleep(self._interval)


# ==================== issue #95 CI 加固：诊断转储 + 强制删除（root 容器文件）====================
# 容器以 user=0:0 运行（docker_runtime.build_run_kwargs），在 bind-mount home 内写 root 拥有的
# 文件；CI runner 用户（uid 1001）对实例目录 shutil.rmtree 撞 EACCES → InstanceCleanupError
# （codex R1 :126 已预言）。首个 CI 真跑环境（Linux runner）下 delete 链路须能自证根因并
# 确定性地清掉 root 文件。两 helper 注入 runner（默认走 docker CLI）便于确定性单测（不真连 daemon）。

# 强删 helper 容器镜像：与 OPENCLAW_IMAGE 无关，用极小 busybox（CI 必能拉；且 runner 已有 daemon）。
_FORCE_REMOVE_IMAGE = 'busybox:latest'


def _docker_cli_runner(argv):
    """默认 runner：经 docker CLI 执行，返回 stdout（失败抛 CalledProcessError）。"""
    return subprocess.run(
        argv, check=True, capture_output=True, text=True, timeout=120,
    ).stdout


def force_remove_tree(instance_dir, *, runner=None):
    """对容器内 root 拥有的实例目录强制删除（runner 用户 rmtree EACCES 的兜底）。

    经同 daemon 起一次性 helper 容器（busybox, --rm, user 默认 root 0:0），bind 实例**父目录**
    到 /target，对相对名 `rm -rf /target/<name>`——root 删 root 文件必成，确定性地清掉
    runner 用户删不掉的文件。挂父目录而非实例目录本身，避免删除挂载点自身的边界问题。
    helper 失败（daemon 不可用）直接抛，不做伪成功。runner 可注入便于单测。
    """
    run = runner or _docker_cli_runner
    instance_dir = instance_dir.resolve() if hasattr(instance_dir, 'resolve') else instance_dir
    parent = instance_dir.parent
    name = instance_dir.name
    argv = [
        'docker', 'run', '--rm',
        '-v', f'{parent}:/target',
        _FORCE_REMOVE_IMAGE,
        'rm', '-rf', f'/target/{name}',
    ]
    run(argv)


def dump_container_diagnostics(name, *, runner=None, tail=200):
    """抓取容器诊断（docker logs + docker inspect state），用于 CI 失败时自证根因。

    只读、永不再抛（容器已删/daemon 抖动返回占位串而非中断原失败路径）。输出含容器名、
    最近 tail 行日志、状态/退出码/OOM 摘要。runner 可注入便于单测。
    """
    run = runner or _docker_cli_runner
    parts = [f'===== diagnostics: {name} =====']
    try:
        logs = run(['docker', 'logs', '--tail', str(tail), f'openclaw-gw-{name}'])
        parts.append(f'--- logs (tail {tail}) ---\n{logs}')
    except Exception as e:  # pylint: disable=broad-exception-caught
        parts.append(f'--- logs unavailable: {e} ---')
    try:
        state = run([
            'docker', 'inspect', '--format',
            (
                'status={{.State.Status}} exit={{.State.ExitCode}} '
                'oom={{.State.OOMKilled}} err={{.State.Error}}'
            ),
            f'openclaw-gw-{name}',
        ])
        parts.append(f'--- inspect state ---\n{state}')
    except Exception as e:  # pylint: disable=broad-exception-caught
        parts.append(f'--- inspect unavailable: {e} ---')
    return '\n'.join(parts)
