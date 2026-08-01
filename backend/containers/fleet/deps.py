"""containers.fleet.deps —— 读写两侧共享的注入单元（FleetDeps）+ 分布式锁装配。

#279 预重构（parent #277）：读侧（FleetReadModel）与写侧（facade InstanceOrchestrator）共享的
依赖打包进 ``FleetDeps``，单一装配点解析全部默认绑定（HttpHealthProbe / shutil.rmtree /
HostPortProbe / ProviderConfigBuilder / HomeProvisioner / PortAllocator / DistributedLock），
读侧可整体剥离、测试可单点替换。**真实类非 dataclass bag、非 frozen**——保住测试「config 整体
dataclasses.replace 替换」的写法（frozen 则 read_model/facade 无法换 config 引用，测试 :445 依赖）。

- ``lock``：**#255（parent #243）**——create 双创建防护 + 租约统一收敛进 ``DistributedLock``
  Port（sync 形态，``SyncDistributedLock``）。生产默认 ``LockFleet.get(sync=True)``（真 Redis，
  懒装配、崩溃自动 TTL 释放、跨进程互斥）；测试注入 ``FakeLockSync``（CI 无真 Redis）。取代
  ``InflightSet``（原仅进程内 guard、跨 worker 不可见）与 ``Instance.lease_expires_at`` 的
  DB lease（读写两侧共享同一实例：写侧 create 取锁/续约/释放，读侧 _reconcile_creating 锁探测）。
- ``HostPortProbe``：把模块级自由函数 ``_host_port_in_use`` 升格为领域类（host 端口占用探测，
  socket bind 实测）。宿主 127.0.0.1:<port> 已被占用时返回 True，allocator 据此跳过最低候选，
  避免 run() 因宿主 bind 冲突确定性失败（codex R2 :161）。
- **不放 lazy renderer**（ConfigRenderer）——它归写侧（create/rewrite_config 唯一消费者），
  Ticket ③ 随 FleetCommand 收口。

依赖方向：``deps`` → ``values``（零 import 编排协作者），无环。
"""
import shutil
import socket
from collections.abc import Callable

from common.lock.locator import LockFleet
from common.lock.ports import SyncDistributedLock
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
        lock: SyncDistributedLock | None = None,
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
        # #255（parent #243）：create 双创建防护 + 租约统一收敛进 DistributedLock Port
        # （sync 形态）。生产默认 LockFleet.get(sync=True)（真 Redis）；测试注入 FakeLockSync
        # （CI 无真 Redis）。取代 InflightSet（仅进程内 guard、跨 worker 不可见）与
        # Instance.lease_expires_at 的 DB lease（崩溃自动 TTL 释放）。
        self.lock = lock or LockFleet.get(sync=True)
