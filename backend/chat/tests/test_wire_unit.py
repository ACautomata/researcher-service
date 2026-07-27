"""Unit tests for WireTestContext (no Docker dependency).

回归 (codex #164 P2)：__enter__ 在 create 后失败时清理已创建容器。
Python CM 协议在 __enter__ 抛异常时不调用 __exit__，此前 self._inst 已设则
容器泄漏。验证 cleanup-on-error 后再抛。
"""
import pytest


class TestWireTestContextCleanup:
    """回归 (codex #164 P2)：WireTestContext.__enter__ 异常路径的容器清理。"""

    def test_enter_failure_after_create_cleans_up_container(self, monkeypatch):
        """__enter__ 在步骤 1 成功后失败 → orch.delete() 被调用 + _inst 清零。"""
        from unittest.mock import MagicMock

        from chat.tests.test_integration_wire import WireTestContext
        from containers.tests.integration_helpers import GatewayReadinessWaiter

        class _RaisingWaiter(GatewayReadinessWaiter):
            def wait(self, port):
                raise TimeoutError('gateway not ready (simulated)')

        monkeypatch.setattr(
            'containers.tests.integration_helpers.GatewayReadinessWaiter',
            _RaisingWaiter,
        )

        orch = MagicMock()
        fake_inst = MagicMock()
        fake_inst.port = 19000
        fake_inst.name = 'test-cleanup-leak'
        orch.create.return_value = fake_inst

        ctx = WireTestContext(
            orch=orch,
            runtime=MagicMock(),
            pairing_service=MagicMock(),
            health_probe=MagicMock(),
            name='test-cleanup-leak',
        )

        with pytest.raises(TimeoutError, match='gateway not ready'):
            # pylint: disable=unnecessary-dunder-call
            # 显式调 __enter__：要验证异常时 CM 协议不调 __exit__
            ctx.__enter__()

        orch.delete.assert_called_once_with('test-cleanup-leak')
        assert ctx._inst is None  # 防止 __exit__ 二次清理
