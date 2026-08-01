"""containers.fleet.deps —— 读写两侧共享的注入单元（FleetDeps）+ 并发 guard（InflightSet）。

#279 预重构（parent #277）：读侧（FleetReadModel）与写侧（facade InstanceOrchestrator）共享的
依赖打包进 ``FleetDeps``，单一装配点解析全部默认绑定（HttpHealthProbe / shutil.rmtree /
HostPortProbe / ProviderConfigBuilder / HomeProvisioner / PortAllocator），读侧可整体剥离、测试可
单点替换。**真实类非 dataclass bag、非 frozen**——保住测试「config 整体 dataclasses.replace
替换」的写法（frozen 则 read_model/facade 无法换 config 引用，测试 :445 依赖）。

- ``InflightSet``：把「在飞 create 名字集 + 锁」的分离写法（set + threading.Lock 两处、调用方
  四处分别掏）升格为锁内化的领域对象：``claim(name) -> bool``（原子 check+add）、``release(name)``、
  ``__contains__(name)``。读写两侧共享**同一实例**（住 FleetDeps 而非写侧）——读侧
  _reconcile_creating 要跳过在飞行。
- ``HostPortProbe``：把模块级自由函数 ``_host_port_in_use`` 升格为领域类（host 端口占用探测，
  socket bind 实测）。宿主 127.0.0.1:<port> 已被占用时返回 True，allocator 据此跳过最低候选，
  避免 run() 因宿主 bind 冲突确定性失败（codex R2 :161）。
- **不放 lazy renderer**（ConfigRenderer）——它归写侧（create/rewrite_config 唯一消费者），
  Ticket ③ 随 FleetCommand 收口。

依赖方向：``deps`` → ``values``（零 import 编排协作者），无环。
"""
import shutil
import socket
import threading
from collections.abc import Callable

from containers.fleet.values import FleetConfig
from containers.ports import PortAllocator
from containers.provisioner import HomeProvisioner
from integration.openclaw.adapters import HttpHealthProbe
from models.config_builder import ProviderConfigBuilder


class HostPortProbe:
    """宿主 <host>:<port> 是否已被占用（socket bind 实测；codex R2 端口分配）。

    Instance.port 只反映本面板记账的容器；无关进程/未跟踪容器占用最低候选端口时
    本探测返回 True，allocator 跳过它，避免 run() 因宿主 bind 冲突确定性失败。

    host 默认 127.0.0.1（与 DockerRuntime publish_host 默认同源）；#295 生产后端容器化后
    publish_host=0.0.0.0，若 probe 仍只测 loopback，端口被非 loopback 接口占用的候选会被
    误报空闲 → allocator 选中 → docker -p 0.0.0.0:<port> 真实发布失败（bind address
    already in use）→ create 回滚。故探测目标与发布目标须同源（Fleet._build_default 注入
    PORT_BIND_HOST）。
    """

    def __init__(self, host: str = '127.0.0.1') -> None:
        self._host = host

    def __call__(self, port: int) -> bool:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind((self._host, port))
            return False
        except OSError:
            return True
        finally:
            probe.close()


class InflightSet:
    """「在飞 create 名字集」并发 guard——mutate-under-lock 锁内化单源（codex R3 :257）。

    替代「set + threading.Lock 两处分离、调用方四处分别掏」的写法：写侧 create/delete 与读侧
    _reconcile_creating 共享同一实例（读侧据此跳过仍在 provisioning 的行），每次操作内部取锁，
    「先检查后变更」的原子性收敛为本类唯一实现点。
    """

    def __init__(self) -> None:
        self._names: set[str] = set()
        self._lock = threading.Lock()

    def claim(self, name: str) -> bool:
        """原子 check+add：未在飞则标记并入飞返回 True；已在飞返回 False。"""
        with self._lock:
            if name in self._names:
                return False
            self._names.add(name)
            return True

    def release(self, name: str) -> None:
        """释放在飞标记（create 收尾/finally）；不存在则幂等。"""
        with self._lock:
            self._names.discard(name)

    def __contains__(self, name: str) -> bool:
        """name 是否仍在飞（读侧 _reconcile_creating 跳过用；delete 拒删用）。"""
        with self._lock:
            return name in self._names


class FleetDeps:
    """读写两侧共享依赖的**单一装配点**（parent #277 / #279）。

    打包：runtime / config(FleetConfig) / health / dir_remover / port_in_use / provider_builder /
    provisioner / allocator / inflight（InflightSet）。默认绑定（HttpHealthProbe / shutil.rmtree /
    HostPortProbe / ProviderConfigBuilder）在此**一处解析**；runtime 与 config 为构造必填（调用方
    注入），Fleet._build_default 只经本类装配真实运行时。非 frozen：测试可对 config 整体
    dataclasses.replace 后回写（:445），read/facade 持同一引用。

    ConfigRenderer 不在此——它归写侧（create/rewrite_config 唯一消费者，Ticket ③ 收口）。
    """

    def __init__(  # pylint: disable=too-many-positional-arguments
        self,
        runtime,
        config: FleetConfig,
        health_probe=None,
        dir_remover=None,
        port_in_use: Callable[[int], bool] | None = None,
        provider_builder=None,
    ) -> None:
        self.runtime = runtime
        self.config = config
        # codex R1 :126：注入目录删除器（默认 shutil.rmtree，不 ignore），可测清理失败
        self.dir_remover = dir_remover or shutil.rmtree
        # codex R2 :161：注入宿主端口占用探测（默认 socket bind 实测），可测确定性冲突
        self.port_in_use = port_in_use or HostPortProbe()
        # spec §7：model CRUD 重渲染合并层（默认 ProviderConfigBuilder，可注入替身）
        self.provider_builder = provider_builder or ProviderConfigBuilder()
        self.health = health_probe or HttpHealthProbe()
        self.provisioner = HomeProvisioner(config.template_dir)
        self.allocator = PortAllocator(
            config.port_start, config.port_end, config.reserved_ports,
        )
        # codex R3：在飞 create 名字集（进程内，orchestrator 单例跨请求共享）。
        # 区分「正在 provisioning」与「崩溃中断」的 creating 行——delete 据此拒删在飞实例，
        # _reconcile_creating 据此只对非在飞的中断行收敛。读侧与写侧共享同一实例。
        self.inflight = InflightSet()
