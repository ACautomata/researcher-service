"""OpenClaw 防腐层 4 Port 的可注入 fake 骨架（issue #98 / spec #97）。

沿用 containers/tests/fakes.py 的 Protocol 注入范式：fake 实现 Port，记录调用 / 内存模拟状态，
供业务层单测注入（override Fleet service locator / 构造注入）。本票仅骨架——每 fake 的具体
行为细节随对应路径实现 ticket（#99 HealthProbe / #100 WikiFileSystem / #101 ContainerRuntime /
#102-103 OpenClawWire）补全。
"""
from __future__ import annotations

from typing import Any


class FakeContainerRuntime:
    """ContainerRuntime Port 的内存 fake：记录调用、模拟容器状态（对齐 containers FakeRuntime 语义）。"""

    def __init__(self) -> None:
        self.run_specs: list = []
        self.containers: dict[str, Any] = {}
        self.stopped: list[str] = []
        self.removed: list[str] = []
        self.exec_calls: list[tuple[str, list[str]]] = []

    def run(self, spec: Any) -> str:
        self.run_specs.append(spec)
        return f'fakeid-{spec.name}'

    def list_fleet(self) -> list:
        return list(self.containers.values())

    def get(self, name: str) -> Any:
        return self.containers.get(name)

    def stop(self, name: str) -> None:
        self.stopped.append(name)

    def remove(self, name: str) -> None:
        self.containers.pop(name, None)
        self.removed.append(name)

    def exec_in_container(self, name: str, cmd: list[str]) -> None:
        self.exec_calls.append((name, cmd))


class FakeOpenClawWire:
    """OpenClawWire Port 的内存 fake：记录 pair/connect/send/close 调用。"""

    def __init__(self) -> None:
        self.pair_calls: list = []
        self.connected: list[tuple[str, str]] = []
        self.sent: list = []
        self.closed: bool = False
        # 测试可预设 pair() 返回值（如 PairingResult dataclass）
        self.pair_result: Any = None

    async def pair(self, url: str, identity: Any, bootstrap_token: str) -> Any:
        self.pair_calls.append((url, identity, bootstrap_token))
        return self.pair_result

    async def connect(self, url: str, device_token: str) -> None:
        self.connected.append((url, device_token))

    async def send(self, content: str, on_event: Any) -> str:
        self.sent.append((content, on_event))
        return 'fake-run-id'

    async def close(self) -> None:
        self.closed = True


class FakeWikiFileSystem:
    """WikiFileSystem Port 的内存 fake：dict 模拟 wiki/main 文件系统。"""

    def __init__(self) -> None:
        self.pages: dict[str, str] = {}  # rel_path → content

    def build_tree(self) -> dict:
        return {'pages': list(self.pages)}

    def read_page(self, rel_path: str) -> dict:
        return {'path': rel_path, 'title': rel_path, 'content': self.pages[rel_path]}

    def write_page(self, rel_path: str, content: str) -> dict:
        self.pages[rel_path] = content
        return {'path': rel_path}

    def create_page(self, rel_path: str, content: str) -> dict:
        self.pages[rel_path] = content
        return {'path': rel_path}

    def delete_page(self, rel_path: str) -> None:
        self.pages.pop(rel_path, None)


class FakeHealthProbe:
    """HealthProbe Port 的可控 fake：set_reachable 决定端口可达性（对齐 containers FakeHealthProbe）。"""

    def __init__(self) -> None:
        self.reachable_ports: set[int] = set()

    def set_reachable(self, port: int, reachable: bool = True) -> None:
        if reachable:
            self.reachable_ports.add(port)
        else:
            self.reachable_ports.discard(port)

    def is_reachable(self, port: int) -> bool:
        return port in self.reachable_ports
