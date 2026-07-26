"""集成测试编排 helper（issue #94）：配对 approve 轮询等纯编排逻辑。

独立于 RUN_INTEGRATION 门控的 test_integration.py——helper 是无 daemon 可确定性单测的
编排逻辑，供集成测试本体与自身单测（test_integration_helpers.py）共用。非生产业务代码。
"""
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
