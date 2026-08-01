"""containers/fleet —— 容器编排域子包（issue #277 拆分 / #278 预重构 / #279 读侧剥离）。

#278 预重构（make the change easy）：原 ``containers.orchestrator.py`` 单类**原样整体**迁入
本子包 ``orchestrator.py``。本文件做 **identity-preserving re-export**（同对象，非拷贝）——
``InstanceOrchestrator`` / ``Fleet`` / ``FleetConfig`` / 异常族的**原 import 路径完全不变**
（``from containers.orchestrator import ...`` 经 shim 双路径可达），所有既有调用方（views /
models / wiki / chat）与测试零改动，``is`` / isinstance / 异常 ``__cause__`` 链语义完全保持。

#279 预重构（parent #277）：读侧 ``FleetReadModel`` + 共享注入单元 ``FleetDeps``（含锁内化的
``InflightSet``）落地（``fleet/deps.py`` / ``fleet/read_model.py``）。纯值层（HEALTH_* /
FleetConfig / 异常族）迁 ``fleet/values.py``——本入口改从 values 转发；编排协议常量（LEASE_TTL /
MAX_HEALTH_WORKERS / MAX_PORT_RETRIES / TOKEN_URLSAFE_BYTES）单一来源仍在
``containers.constants``（读侧经 constants 直接导入，本入口经 constants 转发）。re-export 集合
与语义完全不变。

#280 预重构（parent #277）：写侧 ``FleetCommand`` + config 原子写单源 ``ConfigStore`` 落地
（``fleet/command.py`` / ``fleet/config_store.py``），facade 写方法委托 ``FleetCommand``。

#255（parent #243）：create 双创建防护 + 租约收敛进 ``DistributedLock`` Port（sync 形态，
``FleetDeps.lock``，生产默认 ``LockFleet.get(sync=True)`` 真 Redis、测试注入 FakeLockSync）。
``InflightSet`` 删除、``Instance.lease_expires_at`` 不再写入（字段保留、零 DB 变更）。

包名无下划线（对齐 #271 的 ``integration.openclaw.wire`` 先例）；import 置顶绝对路径。
"""
from containers.constants import (
    LEASE_TTL,
    MAX_HEALTH_WORKERS,
    MAX_PORT_RETRIES,
    TOKEN_URLSAFE_BYTES,
)
from containers.fleet.command import FleetCommand
from containers.fleet.config_store import ConfigStore
from containers.fleet.orchestrator import Fleet, InstanceOrchestrator
from containers.fleet.values import (
    HEALTH_HEALTHY,
    HEALTH_PENDING,
    HEALTH_REMOVING,
    HEALTH_STOPPED,
    HEALTH_UNHEALTHY,
    # re-export：纯值层迁 values.py，双路径可达
    ConfigurationError,
    ConfigWriteError,
    FleetConfig,
    InstanceBusy,
    InstanceCleanupError,
    InstanceDirExists,
    InstanceExists,
    InstanceNotFound,
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
