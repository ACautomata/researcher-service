"""OpenClaw 防腐层集成包（spec #97 / ADR 0002 / issue #98）。

四条接触路径的 Port 接口 + wire 域常量单一来源 + 翻译层 + 可注入 fake 骨架。业务层
（orchestrator / WikiService / ChatConsumer / PairingService）依赖 Port，测试注入 fake。

公共 API：4 Port（ContainerRuntime / OpenClawWire / WikiFileSystem / HealthProbe）
+ 翻译层（translation）。wire 域常量经 `from integration.openclaw.wire import ...` 访问；
fake 骨架在 integration.openclaw.fakes。
"""
from integration.openclaw.ports import (
    ContainerRuntime,
    HealthProbe,
    OpenClawWire,
    WikiFileSystem,
)

__all__ = ['ContainerRuntime', 'OpenClawWire', 'WikiFileSystem', 'HealthProbe']
