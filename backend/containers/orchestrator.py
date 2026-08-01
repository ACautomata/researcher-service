"""InstanceOrchestrator —— 容器生命周期编排（spec §5.4/§5.5）—— identity re-export 薄壳。

#278 预重构（parent #277）：拆分后主体迁入 ``containers.fleet`` 子包（包名无下划线，符合
「包名禁下划线」约定；issue #278）。本模块退为薄壳做 **identity re-export**（同对象，非拷贝）
——``InstanceOrchestrator`` / ``Fleet`` / ``FleetConfig`` / 异常族的**原 import 路径完全不变**，
views / models / wiki / chat 与全部既有测试零改动，isomorph 守卫与 ``is`` / isinstance /
异常 ``__cause__`` 链语义完全保持（``from containers.fleet import ...`` 双路径亦可达）。
"""
from containers.fleet import (  # re-export：薄壳有意全量转发
    HEALTH_HEALTHY,
    HEALTH_PENDING,
    HEALTH_REMOVING,
    HEALTH_STOPPED,
    HEALTH_UNHEALTHY,
    LEASE_TTL,
    MAX_HEALTH_WORKERS,
    MAX_PORT_RETRIES,
    TOKEN_URLSAFE_BYTES,
    ConfigStore,
    ConfigurationError,
    ConfigWriteError,
    Fleet,
    FleetCommand,
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
    'ConfigStore',
    'ConfigWriteError',
    'ConfigurationError',
    'Fleet',
    'FleetCommand',
    'FleetConfig',
    'InstanceBusy',
    'InstanceCleanupError',
    'InstanceDirExists',
    'InstanceExists',
    'InstanceNotFound',
    'InstanceOrchestrator',
    'PortAllocationError',
]
