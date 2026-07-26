"""OpenClaw 防腐层 4 Port 接口（Hexagonal / spec #97 / ADR 0002 / issue #98）。

四条接触路径各一个 Port（Protocol 形态），业务层依赖 Port、测试注入 fake/Adapter：
- ContainerRuntime（路径1，Docker SDK 编排）—— 复刻 containers.ports 既有 Protocol，归属前移到集成包
  （strangler：#101 才让 DockerRuntime implements + containers.Fleet 委托，本票仅接口骨架）。
- OpenClawWire（路径4，WS 协议 v4）—— 合并配对握手 + 配对后长连为单一连接生命周期 Port
  （#102 配对握手 / #103 长连填充实现；本票仅接口骨架）。
- WikiFileSystem（路径2，宿主 bind-mount 读写）—— wiki/main 文件树 + 五分类 + 越权防护
  （#100 WikiService 构造注入；本票仅接口骨架）。
- HealthProbe（路径3，HTTP /health 探测）—— 构造注入 http client（#99 真实 Adapter；本票仅接口骨架）。

本票仅定义接口骨架；方法签名据现有业务推导，后续每路径「填实现」时按需细化。
"""
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from containers.runtime import ContainerInfo, ContainerSpec


@runtime_checkable
class ContainerRuntime(Protocol):
    """路径1：容器运行时（Docker SDK 编排）。复刻 containers.ports.ContainerRuntime，归属前移。"""

    def run(self, spec: ContainerSpec) -> str:
        """创建并启动容器，返回 container_id。"""
        ...

    def list_fleet(self) -> list[ContainerInfo]:
        """列出所有 fleet 容器（label app=openclaw-fleet）。"""
        ...

    def get(self, name: str) -> ContainerInfo | None:
        """取单个实例的容器状态；不存在返回 None。"""
        ...

    def stop(self, name: str) -> None:
        """停止容器（优雅超时后 SIGKILL）。"""
        ...

    def remove(self, name: str) -> None:
        """删除容器（连匿名卷，force）；容器不存在则幂等。"""
        ...

    def exec_in_container(self, name: str, cmd: list[str]) -> None:
        """在运行中的实例容器内执行命令（如 wiki compile）；容器不存在则幂等。"""
        ...


@runtime_checkable
class OpenClawWire(Protocol):
    """路径4：单一连接生命周期（配对握手 + 配对后长连）。

    状态机：未配对 → 配对中 → 稳态长连（ADR 0002 合并 pairing_ws + chat_client 两套 connect 帧）。
    方法签名待 #102（配对握手）/ #103（长连）填充实现时细化——本票仅占位骨架。
    """

    async def pair(self, url: str, identity: Any, bootstrap_token: str) -> Any:
        """配对握手（challenge/nonce/Ed25519/connect 帧）→ deviceToken；未配对上抛 PairingRequired。"""
        ...

    async def connect(self, url: str, device_token: str) -> None:
        """建立已配对长连（deviceToken 作 auth.token）。"""
        ...

    async def send(self, content: str, on_event: Any) -> str:
        """发 chat.send → ack(runId) → 事件流回调 on_event；返回 runId。"""
        ...

    async def close(self) -> None:
        """关闭长连、清理路由。"""
        ...


@runtime_checkable
class WikiFileSystem(Protocol):
    """路径2：wiki/main 文件树读写（bind-mount）。封装路径约定/五分类/越权防护。"""

    def build_tree(self) -> dict:
        """构建 wiki/main 文件树（跳过插件私有/占位目录）。"""
        ...

    def read_page(self, rel_path: str) -> dict:
        """读一页 {path,title,content}；越权路径上抛 InvalidPath。"""
        ...

    def write_page(self, rel_path: str, content: str) -> dict:
        """覆写已存在页；越权路径上抛 InvalidPath。"""
        ...

    def create_page(self, rel_path: str, content: str) -> dict:
        """新建页（父目录须存在）；已存在/越权上抛。"""
        ...

    def delete_page(self, rel_path: str) -> None:
        """删除页；越权路径上抛 InvalidPath。"""
        ...


@runtime_checkable
class HealthProbe(Protocol):
    """路径3：HTTP GET 127.0.0.1:<port>/health 探容器 gateway 可达性。构造注入 http client。"""

    def is_reachable(self, port: int) -> bool:
        """宿主映射端口对应的 gateway /health 是否可达（2xx）。"""
        ...
