"""InstanceOrchestrator —— 容器生命周期编排 facade（spec §5.4/§5.5）。

#279 预重构（parent #277）：沿**读/写 seam（CQRS）**把原单类拆为 facade 组合根 + 深协作者——
本模块为**薄 facade**（组合根），读侧方法（list/detail/created_item）委托给
``FleetReadModel``（``fleet/read_model.py``），写侧方法（create/delete/rewrite_config/exec_*）
委托给 ``FleetCommand``（``fleet/command.py``），读写共享依赖经 ``FleetDeps``
（``fleet/deps.py``，含锁内化的 ``InflightSet``）单点注入。config 写盘收敛为
``ConfigStore``（``fleet/config_store.py``，tmp + chmod 0644 + os.replace 原子写单源）。
公开方法面与返回 DTO 形状不变，views / models / wiki / chat 与全部既有测试零改动
（测试仅一处机械改名：``orch._reserve_row`` → ``orch._cmd._reserve_row``）。

依赖方向：``orchestrator`` → ``command`` → ``config_store`` → ``deps`` → ``values``；
``orchestrator`` → ``read_model`` → ``deps``。纯值层（HEALTH_* / FleetConfig / 异常族）在
``fleet/values.py``（经本模块 re-export，原 ``from containers.orchestrator import ...`` 路径
不变，双路径可达）。

组合 ContainerRuntime + ConfigRenderer + HomeProvisioner + HealthProbe + PortAllocator（依赖注入）。
业务逻辑（端口分配/预填充/渲染/run/对账/健康聚合）依赖 Protocol，测试用 FakeRuntime 覆盖。

状态机（spec §5.5）：creating（先以 CREATING 预占 DB 行 + cp -a + 渲染 + run）
→ running → stopped → removing（终态）。失败回滚 DB 行 + 目录 + 残留容器。

并发/失败硬化（codex R1）：
- name/port 冲突由 DB 唯一约束仲裁；port 冲突在保存点内重试下一空闲端口，
  name 冲突转译 InstanceExists（view 409），不抛裸 IntegrityError（500）。
- run 失败（docker create 成功但 start 失败）best-effort remove 残留命名容器。
- delete home 清理失败不吞——保留 DB 行 + 标 REMOVING + raise（可重试）。
- list 健康探测并发（ThreadPoolExecutor），bound 总延迟（非 N×timeout 串行）。

codex R2：
- 端口分配并入宿主实测占用（socket bind 探测）+ fleet 容器 label 端口，
  避免最低候选被无关进程/未跟踪容器占用导致每次 create 确定性失败。
- run 失败回滚时 best-effort remove 自身也可能因 daemon 不可用而失败——单独兜底，
  不阻断 DB 行 + 目录的回滚。
- list 对 creating 行做 runtime 对账：进程在最终 save 前崩溃留下的 creating 行，
  若容器实际已在跑则就地自愈为 running，不再永久 pending。
- delete 时 home 目录已不存在（FileNotFoundError）视为清理成功，不再误判失败卡 REMOVING。

codex R6 / R7（config 写盘）：
- ``create`` 的 config 写盘经 ``ConfigStore.write`` 原子落盘（tmp + chmod 0644 +
  ``os.replace``），不再裸 ``write_text``——provisioning 中途崩溃不残留半个 openclaw.json。
- ``ConfigRenderer`` 惰性构造：模板 JSON 仅供 create/rewrite_config 使用，list/delete
  不应因其损坏而 500。
"""
from collections.abc import Callable
from pathlib import Path

from containers.docker_runtime import DockerRuntime
from containers.fleet.command import FleetCommand
from containers.fleet.config_store import ConfigStore
from containers.fleet.deps import FleetDeps, HostPortProbe
from containers.fleet.read_model import FleetReadModel
from containers.fleet.values import FleetConfig
from containers.models import Instance
from integration.openclaw.adapters import HttpHealthProbe


class InstanceOrchestrator:
    """容器实例生命周期 facade（create/delete/list）——组合根 + 读/写委托。

    #280 预重构（parent #277）：写侧方法委托 ``FleetCommand``（``_cmd``），读侧方法委托
    ``FleetReadModel``（``_read``），读写共享依赖经 ``FleetDeps``（``_deps``）单点注入。
    facade 自身只持有组合根三成员（``_deps`` / ``_cmd`` / ``_read``；ConfigStore 由 ``_cmd``
    持有），测试可经 ``_deps.*`` 单点替换任一依赖、经 ``_cmd.*`` 触达写侧私有 stub。
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
        # 读写共享依赖单一装配点：默认绑定（HttpHealthProbe / shutil.rmtree / HostPortProbe /
        # ProviderConfigBuilder）在 FleetDeps 一处解析；runtime/config 由调用方注入。
        self._deps = FleetDeps(
            runtime=runtime,
            config=config,
            health_probe=health_probe,
            dir_remover=dir_remover,
            port_in_use=port_in_use,
            provider_builder=provider_builder,
        )
        # 写侧编排（create/delete/rewrite_config/exec_*）+ config 原子写单源。
        self._cmd = FleetCommand(self._deps, ConfigStore(self._deps))
        # 读侧聚合（list/detail/created_item + creating 行对账），独立于写侧演进。
        self._read = FleetReadModel(self._deps)

    # ── 写侧：委托 FleetCommand（create/delete/rewrite_config/exec_*）──
    # #280 预重构：写方法实现随私有成员（_reserve_row/_used_ports/lazy renderer）迁
    # fleet/command.py，facade 仅做薄委托；公开方法面与返回 DTO 形状不变。

    def create(self, name: str) -> Instance:
        """创建并启动一个容器（spec §5.4/§5.5）——委托写侧协作者。"""
        return self._cmd.create(name)

    def delete(self, name: str) -> bool:
        """删除容器 + 连数据删（spec §5.4）——委托写侧协作者。"""
        return self._cmd.delete(name)

    def rewrite_config(self, name: str) -> None:
        """重渲染该容器 openclaw.json（spec §7）——委托写侧协作者。"""
        self._cmd.rewrite_config(name)

    def exec_in_container(self, name: str, cmd: list[str]) -> None:
        """在运行中的实例容器内执行命令（如 wiki compile）—— 委托写侧协作者。"""
        self._cmd.exec_in_container(name, cmd)

    def exec_sync(self, name: str, cmd: list[str]) -> None:
        """在容器内同步执行命令并等待完成 —— 委托写侧协作者。"""
        self._cmd.exec_sync(name, cmd)

    # ── 读侧：委托 FleetReadModel（list/detail/created_item + creating 行对账）──
    # #279 预重构：读侧聚合（_item/_build_item/_reconcile_creating/list/created_item/detail）
    # 剥离为 fleet/read_model.py，facade 仅做薄委托；公开方法面与返回 DTO 形状不变。

    def list(self) -> list[dict]:
        """聚合 DB 记账 + runtime 实时状态 + gateway 健康探测（issue #39 列表验收）。"""
        return self._read.list()

    def created_item(self, inst: Instance) -> dict:
        """由刚创建成功的 Instance 构造 POST 响应（codex R4 :60）。"""
        return self._read.created_item(inst)

    def detail(self, name: str) -> dict | None:
        """单个实例的聚合视图（post 响应复用）；不存在返回 None。"""
        return self._read.detail(name)


class Fleet:
    """orchestrator 单例 service locator（view 层依赖；测试用 override 注入 fake）。

    lazy 构造（首次 get 才读 settings + 装 DockerRuntime），import 期无 IO/无 daemon 连接。
    """

    _orchestrator: InstanceOrchestrator | None = None

    @classmethod
    def get(cls) -> InstanceOrchestrator:
        if cls._orchestrator is None:
            cls._orchestrator = cls._build_default()
        return cls._orchestrator

    @classmethod
    def override(cls, orchestrator: InstanceOrchestrator) -> None:
        """测试注入替身。"""
        cls._orchestrator = orchestrator

    @classmethod
    def reset(cls) -> None:
        cls._orchestrator = None

    @staticmethod
    def _build_default() -> InstanceOrchestrator:
        from django.conf import settings

        cfg = settings.OPENCLAW_FLEET
        # codex R7 :509：模板文件 IO 推迟到 create() 内惰性加载——
        # list/delete 恢复操作不应因模板文件缺失而 500。
        # #295：健康探测与 WS 配对共享同一连接目标 host（OPENCLAW_FLEET_WS['HOST']），
        # 端口发布地址用 OPENCLAW_FLEET['PORT_BIND_HOST']——生产后端容器化后前者注入
        # host.docker.internal、后者 0.0.0.0（compose 装配），本地默认 loopback 零回归。
        # HostPortProbe 探测目标与 DockerRuntime 发布目标须同源（codex P2）。
        return InstanceOrchestrator(
            runtime=DockerRuntime(publish_host=cfg['PORT_BIND_HOST']),
            health_probe=HttpHealthProbe(host=settings.OPENCLAW_FLEET_WS['HOST']),
            port_in_use=HostPortProbe(host=cfg['PORT_BIND_HOST']),
            config=FleetConfig(
                root=Path(cfg['ROOT']),
                template_dir=Path(cfg['TEMPLATE']),
                template_json=cfg['TEMPLATE_JSON'],  # 文件路径——create() 惰性 read_text
                image=cfg['IMAGE'],
                port_start=cfg['PORT_POOL_START'],
                port_end=cfg['PORT_POOL_END'],
                llm_api_key=cfg['LLM_API_KEY'],  # ADR 0005：settings 声明，不再 runtime 裸读 env
            ),
        )
