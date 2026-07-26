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
