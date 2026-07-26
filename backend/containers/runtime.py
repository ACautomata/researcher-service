"""容器运行时数据类（spec §5.4）。

ContainerSpec / ContainerInfo 数据类与 container_name()。容器域纯常量（label key、容器名前缀、
容器内 bind 路径、固定端口）已收口到 containers.constants（issue #88/#89，parent #79）。
ContainerRuntime Port 已归属前移到 integration.openclaw.ports（issue #101）；DockerRuntime 与
FakeRuntime 通过 @runtime_checkable 结构子类型自动满足端口，无需显式继承。

设计要点：
- 业务层只传语义参数（ContainerSpec），docker-py 的 name/volumes/ports/labels/environment
  等接线细节封装在 DockerRuntime.build_run_kwargs（可纯逻辑单测）。
- 容器内 gateway 固定 18789，仅宿主侧分配映射端口（spec §5.3）。
"""
from __future__ import annotations

from dataclasses import dataclass

# 容器/编排域纯常量单一来源 = containers.constants（issue #88 收口端口、#89 收口 label/
# 前缀/bind 路径）。runtime 仅内部消费 CONTAINER_PREFIX（container_name）；GATEWAY_INTERNAL_PORT
# 为 #88 遗留 re-export，钉住「runtime 引用 constants」单一来源契约（test_constants），消费方
# 已直引 constants，此处保留以维持契约的可执行证据。
from .constants import CONTAINER_PREFIX, GATEWAY_INTERNAL_PORT  # noqa: F401


def container_name(name: str) -> str:
    """实例名 → docker 容器名（openclaw-gw-<name>）。"""
    return f'{CONTAINER_PREFIX}{name}'


@dataclass(frozen=True)
class ContainerSpec:
    """创建一个容器所需的语义参数（orchestrator → runtime）。"""

    name: str            # 实例名（不含前缀）
    image: str
    host_port: int       # 宿主映射端口（端口池分配）
    gateway_token: str   # GATEWAY_TOKEN env 值（敏感：仅 env 注入，不落盘）
    home_dir: str        # 宿主 bind-mount home（instances/<name>/home）
    config_path: str     # 宿主 openclaw.json（instances/<name>/openclaw.json）
    llm_api_key: str     # 全面板共享 LLM_API_KEY（spec §5.2 决策）


@dataclass(frozen=True)
class ContainerInfo:
    """一个容器的运行时状态快照（runtime → orchestrator）。"""

    container_id: str
    name: str
    running: bool
    status: str          # docker status 原值：running/exited/...
    image: str
    # codex R2 :161：宿主映射端口（来自 openclaw.port label），供端口分配对账
    # 未跟踪/无 label 时为 None（allocator 仅并入 int 端口）。
    port: int | None = None
    # codex R9-2：实例名（来自 openclaw.instance label）——reconcile/delete 用它校验
    # 容器所有权（外来同名容器 instance_name≠本名则不采纳）。无 label 时为 None。
    instance_name: str | None = None
