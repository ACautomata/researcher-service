"""测试替身：FakeRuntime / FakeHealthProbe（containers 编排层 TDD 用）。

实现 ContainerRuntime Protocol，记录调用、模拟 daemon 状态；无需 docker daemon。
"""
from dataclasses import replace

from containers.runtime import ContainerInfo, ContainerSpec, container_name


class FakeRuntime:
    """记录调用 + 内存维护容器状态的假运行时。"""

    def __init__(self) -> None:
        self.run_specs: list[ContainerSpec] = []
        # name → ContainerInfo（模拟 daemon 里的容器）
        self.containers: dict[str, ContainerInfo] = {}
        self.stopped: list[str] = []
        self.removed: list[str] = []
        self.exec_calls: list[tuple[str, list[str]]] = []  # (name, cmd) 记录容器内 exec
        self._next = 0
        # codex R1 :112：模拟 docker create 成功后 start 失败（端口占用等）。
        # 设非 None 时 run() 先记录容器（模拟 create 落 daemon）再抛该异常，
        # 用于验证 except 分支 best-effort 清理残留命名容器。
        self.fail_after_create: Exception | None = None

    def run(self, spec: ContainerSpec) -> str:
        self.run_specs.append(spec)
        cid = f'fakeid-{spec.name}-{self._next}'
        self._next += 1
        # 模拟 docker create：容器先入 daemon（Created 态），与真实 containers.run(create+start) 一致
        self.containers[spec.name] = ContainerInfo(
            container_id=cid,
            name=container_name(spec.name),
            running=True,
            status='running',
            image=spec.image,
            instance_name=spec.name,  # codex R9-2：模拟真实 Docker 的 openclaw.instance label
        )
        if self.fail_after_create is not None:
            exc = self.fail_after_create
            self.fail_after_create = None
            raise exc  # pylint: disable=raising-bad-type
        return cid

    def list_fleet(self) -> list[ContainerInfo]:
        return list(self.containers.values())

    def get(self, name: str) -> ContainerInfo | None:
        return self.containers.get(name)

    def stop(self, name: str) -> None:
        info = self.containers.get(name)
        if info is None:
            return
        self.containers[name] = replace(info, running=False, status='exited')
        self.stopped.append(name)

    def remove(self, name: str) -> None:
        self.containers.pop(name, None)
        self.removed.append(name)

    def exec_in_container(self, name: str, cmd: list[str]) -> None:
        self.exec_calls.append((name, cmd))


class FakeHealthProbe:
    """可控的健康探测：set_reachable(port, bool) 决定端口对应的 gateway /health 可达性。

    对齐真实 HealthProbe.is_reachable(port) 语义（按宿主映射端口探 127.0.0.1:<port>/health）。
    """

    def __init__(self) -> None:
        self._reachable_ports: set[int] = set()

    def set_reachable(self, port: int, reachable: bool = True) -> None:
        if reachable:
            self._reachable_ports.add(port)
        else:
            self._reachable_ports.discard(port)

    def is_reachable(self, port: int) -> bool:
        return port in self._reachable_ports
