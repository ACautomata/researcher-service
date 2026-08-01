"""containers/fleet —— 容器编排域子包（issue #277 拆分 / #278 预重构）。

#278 预重构（make the change easy）：原 ``containers.orchestrator.py`` 单类**原样整体**迁入
本子包 ``orchestrator.py``（``InstanceOrchestrator`` 现仍是含六类职责的未拆分单类，facade 组合
根的进一步读/写 seam 拆分见 #279/#280）。本文件做 **identity-preserving re-export**（同对象，
非拷贝）——``InstanceOrchestrator`` / ``Fleet`` / ``FleetConfig`` / 异常族的**原 import 路径
完全不变**（``from containers.orchestrator import ...`` 经 shim 双路径可达），所有既有调用方
（views / models / wiki / chat）与测试零改动，``is`` / isinstance / 异常 ``__cause__`` 链语义
完全保持。

包名无下划线（对齐 #271 的 ``integration.openclaw.wire`` 先例）；import 置顶绝对路径。
"""
from containers.fleet.orchestrator import (
    HEALTH_HEALTHY,
    HEALTH_PENDING,
    HEALTH_REMOVING,
    HEALTH_STOPPED,
    HEALTH_UNHEALTHY,
    LEASE_TTL,
    MAX_HEALTH_WORKERS,
    MAX_PORT_RETRIES,
    TOKEN_URLSAFE_BYTES,
    # re-export：子包入口做 identity 转发，双路径可达
    ConfigurationError,
    ConfigWriteError,
    Fleet,
    FleetConfig,
    InstanceBusy,
    InstanceCleanupError,
    InstanceDirExists,
    InstanceExists,
    InstanceNotFound,
    InstanceOrchestrator,
    PortAllocationError,
)

__all__ = [
    'HEALTH_HEALTHY',
    'HEALTH_PENDING',
    'HEALTH_REMOVING',
    'HEALTH_STOPPED',
    'HEALTH_UNHEALTHY',
    'LEASE_TTL',
    'MAX_HEALTH_WORKERS',
    'MAX_PORT_RETRIES',
    'TOKEN_URLSAFE_BYTES',
    'ConfigWriteError',
    'ConfigurationError',
    'Fleet',
    'FleetConfig',
    'InstanceBusy',
    'InstanceCleanupError',
    'InstanceDirExists',
    'InstanceExists',
    'InstanceNotFound',
    'InstanceOrchestrator',
    'PortAllocationError',
]
