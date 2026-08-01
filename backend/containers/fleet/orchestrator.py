"""InstanceOrchestrator —— 容器生命周期编排 facade（spec §5.4/§5.5）。

#279 预重构（parent #277）：沿**读/写 seam（CQRS）**把原单类拆为 facade 组合根 + 深协作者——
本模块退为 **薄 facade**（组合根），读侧方法（list/detail/created_item）委托给
``FleetReadModel``（``fleet/read_model.py``），写侧方法（create/delete/rewrite_config/exec_*）
仍内联 facade（Ticket ③ 抽 ``FleetCommand`` + ``ConfigStore``），读写共享依赖经
``FleetDeps``（``fleet/deps.py``，含锁内化的 ``InflightSet``）单点注入。公开方法面与返回 DTO
形状不变，views / models / wiki / chat 与全部既有测试零改动。

依赖方向：``orchestrator`` → ``deps`` → ``values``；``orchestrator`` → ``read_model`` → ``deps``。
纯值层（HEALTH_* / FleetConfig / 异常族）已迁 ``fleet/values.py``（经本模块 re-export，原
``from containers.orchestrator import ...`` 路径不变，双路径可达）。

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
"""
import json
import os
import secrets
from collections.abc import Callable
from pathlib import Path

from django.db import IntegrityError, transaction
from django.utils import timezone

from containers.config_renderer import ConfigRenderer
from containers.constants import HOME_BIND, LEASE_TTL, MAX_PORT_RETRIES, TOKEN_URLSAFE_BYTES
from containers.docker_runtime import DockerRuntime
from containers.fleet.deps import FleetDeps
from containers.fleet.read_model import FleetReadModel
from containers.fleet.values import (  # re-export：纯值层迁 values.py，原 import 路径不变
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
from containers.models import Instance
from containers.runtime import ContainerSpec


class InstanceOrchestrator:  # pylint: disable=too-many-instance-attributes
    """容器实例生命周期 facade（create/delete/list）——组合根 + 读/写委托。

    #279 预重构（parent #277）：读侧方法委托 ``FleetReadModel``（``_read``），写方法仍内联
    facade（Ticket ③ 抽 ``FleetCommand`` + ``ConfigStore``），读写共享依赖经 ``FleetDeps``
    （``_deps``）单点注入。facade 自身只持有组合根三成员（``_deps`` / ``_read`` / 写侧专属
    ``_renderer``），测试可经 ``_deps.*`` 单点替换任一依赖。
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
        # 读侧聚合（list/detail/created_item + creating 行对账），独立于写侧演进。
        self._read = FleetReadModel(self._deps)
        # codex R6 :475：ConfigRenderer 推迟到 create() 内惰性构造——
        # 模板 JSON 仅供 create() 使用，list/delete 不应因其损坏而 500。
        self._renderer = None

    def exec_in_container(self, name: str, cmd: list[str]) -> None:
        """在运行中的实例容器内执行命令（如 wiki compile）—— 委托 runtime（codex PR #62 意见1）。

        供 wiki compile 触发器等跨域调用；保持 runtime 为唯一 docker 接触面。
        """
        self._deps.runtime.exec_in_container(name, cmd)

    def exec_sync(self, name: str, cmd: list[str]) -> None:
        """在容器内同步执行命令并等待完成 —— 委托 runtime。

        区别于 exec_in_container 的 fire-and-forget（detach=True）：供需等命令落库的调用，
        如设备配对 approve（``openclaw devices approve <reqId>``）——approve 须在重握手前真正写入
        gateway 设备表，否则重握手仍 PAIRING_REQUIRED。runtime 为唯一 docker 接触面（同上）。
        """
        self._deps.runtime.exec_sync(name, cmd)

    def rewrite_config(self, name: str) -> None:
        """重渲染该容器 openclaw.json（spec §7：model CRUD 后经 OpenClaw watch 热加载生效）。

        DB（ModelProvider）为单一来源：读该实例全部 provider → ProviderConfigBuilder 合并进
        模板 base（强制 gateway 安全不变量）→ 覆盖写 instances/<name>/openclaw.json。
        #36 已证：改 models.providers 即热加载，无需 restart；SecretRef env 缺失时 reload 失败
        但 runtime 停留 last-known-good 不崩，env 补齐自动恢复。
        原子写（tmp + os.replace）：写盘失败不污染既有 openclaw.json，DB 事务据此回滚（view 层）。
        """
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            raise InstanceNotFound(name)
        if self._renderer is None:
            self._renderer = ConfigRenderer(Path(self._deps.config.template_json).read_text(encoding="utf-8"))
        specs = [p.as_spec() for p in inst.model_providers.all()]
        merged = self._deps.provider_builder.build(self._renderer.render_dict(), specs)
        config_path = self._deps.config.root / 'instances' / name / 'openclaw.json'
        config_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = config_path.with_name(config_path.name + '.tmp')
        try:
            tmp.write_text(json.dumps(merged, indent=2, ensure_ascii=False))
            os.chmod(tmp, 0o644)
            os.replace(tmp, config_path)   # POSIX 原子：要么整体新配置生效，要么保留旧文件
        except OSError:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            raise ConfigWriteError(name, str(config_path)) from None

    def _used_ports(self) -> set[int]:
        """已用端口 = DB 记账 ∪ fleet 容器 label 端口 ∪ 池内宿主实测占用（codex R2 :161）。

        仅记账会让最低候选被无关进程/未跟踪容器占用而反复失败；并入 daemon label
        端口与宿主 bind 实测后，allocator 跳过真实不可用端口。宿主探测只扫池区间，
        且对池外/异常端口容错（占用即跳过该候选，不影响其余）。
        """
        used = set(Instance.objects.values_list('port', flat=True))
        try:
            for info in self._deps.runtime.list_fleet():
                port = getattr(info, 'port', None)
                if isinstance(port, int):
                    used.add(port)
        except Exception:  # pylint: disable=broad-exception-caught
            # daemon 不可达不阻断分配：DB 记账 + 宿主实测仍可给出候选
            pass
        for port in range(self._deps.config.port_start, self._deps.config.port_end + 1):
            if port not in used and self._deps.port_in_use(port):
                used.add(port)
        return used

    def _reserve_row(self, name: str) -> Instance:
        """事务内占位 INSERT：name/port 冲突由 DB 唯一约束仲裁（codex R1 :77/:84）。

        port 冲突（并发选同 port）→ 保存点回滚后重试下一个空闲 port；
        name 冲突（并发同名）→ InstanceExists（view 409，不重试）。
        预占在 mkdir 之前：DB 唯一约束先挡重名，避免误删既有实例目录。
        """
        home = str(self._deps.config.root / 'instances' / name / 'home')
        token = secrets.token_urlsafe(TOKEN_URLSAFE_BYTES)
        for _ in range(MAX_PORT_RETRIES):
            port = self._deps.allocator.next_free(self._used_ports())
            try:
                with transaction.atomic():
                    return Instance.objects.create(
                        name=name,
                        port=port,
                        token=token,
                        home_dir=home,
                        container_id='',
                        status=Instance.STATUS_CREATING,
                        image=self._deps.config.image,
                        # codex R8 F1：lease 起点随预占行落盘——其它 worker 的 _reconcile_creating
                        # 据此在 provisioning 期间不误收敛本行（created_at+60s 无法覆盖长 create）。
                        lease_expires_at=timezone.now() + LEASE_TTL,
                    )
            except IntegrityError:
                if Instance.objects.filter(name=name).exists():
                    raise InstanceExists(name) from None
                # 否则 port 冲突 → 保存点已回滚，继续重试下一 port
        raise PortAllocationError(name)

    def create(self, name: str) -> Instance:  # pylint: disable=too-many-statements
        """创建并启动一个容器（spec §5.4/§5.5）。

        先以进程内 guard 覆盖完整 create，再事务占位（挡重名/仲裁 port），
        然后 mkdir + cp -a + 渲染 + run；失败时只回滚本次实际创建的资源。
        """
        # codex R6 :484：空 LLM_API_KEY 会在 _reserve_row 前拒绝——否则后续创建外表 healthy
        # 但永远无法调 LLM 的容器，且 LLM_API_KEY 是面板级共享的不能通过 delete 修复。
        if not self._deps.config.llm_api_key:
            raise ConfigurationError('LLM_API_KEY')

        # codex R6 :475：ConfigRenderer 惰性构造——模板 JSON 损坏不会阻塞 list/delete。
        # codex R7 :509：ConfigRenderer 构造时读取模板文件（_build_default 不再急切 IO）。
        if self._renderer is None:
            template_text = Path(self._deps.config.template_json).read_text(encoding="utf-8")
            self._renderer = ConfigRenderer(template_text)

        if not self._deps.inflight.claim(name):
            raise InstanceExists(name)

        inst = None
        instance_dir = self._deps.config.root / 'instances' / name
        home = instance_dir / 'home'
        config_path = instance_dir / 'openclaw.json'
        directory_created = False
        run_attempted = False
        preexisting = False
        try:
            # guard 必须先于预占行：DELETE 不能观察到尚未受保护的 creating 行。
            inst = self._reserve_row(name)
            # preflight 也在统一回滚范围内；daemon 异常不得遗留 creating 行。
            preexisting = self._deps.runtime.get(name) is not None
            try:
                instance_dir.mkdir(parents=True, exist_ok=False)
            except FileExistsError:
                # 目录已存在但 _reserve_row 成功（DB 无行）= 上次崩溃中断/外部残留/手动删 DB 遗留的
                # orphan 目录。回滚刚建的 CREATING 行（保持「DB 无行」与残留目录一致，便于客户端
                # 经 DELETE 或手动清理后重试），转 InstanceDirExists（view 409），不冒泡裸 500。
                if inst is not None and inst.pk is not None:
                    inst.delete()
                raise InstanceDirExists(name, str(instance_dir)) from None
            directory_created = True
            self._deps.provisioner.provision(home)
            config_path.write_text(self._renderer.render())
            # codex R9-4：显式 chmod 0644（其它用户可读）防 umask 027/077 导致容器内 node
            # 用户读不了 bind-mount(ro) 的 openclaw.json，gateway 无法启动。
            os.chmod(config_path, 0o644)
            # codex R8 F1：renewable lease——render 完成后、run 前续约，把 lease 起点推到此刻，
            # 覆盖随后的 docker run（create+start）。run 内 image pull 仍受 LEASE_TTL 约束
            # （阻塞 IO 内部不续约，靠 TTL 充分性 + _reconcile self-heal 兜底，见 LEASE_TTL）。
            inst.lease_expires_at = timezone.now() + LEASE_TTL
            inst.save(update_fields=['lease_expires_at'])
            run_attempted = True
            container_id = self._deps.runtime.run(
                ContainerSpec(
                    name=name,
                    image=self._deps.config.image,
                    host_port=inst.port,
                    gateway_token=inst.token,
                    home_dir=str(home),
                    config_path=str(config_path),
                    llm_api_key=self._deps.config.llm_api_key,
                ),
            )
            inst.container_id = container_id
            inst.status = Instance.STATUS_RUNNING
            inst.save()
            return inst
        except Exception:
            # 仅 run 前确认不存在同名容器时，才可能清理由本次 run 留下的容器。
            if run_attempted and not preexisting:
                try:
                    created = self._deps.runtime.get(name)
                    if created is not None and created.container_id:
                        inst.container_id = created.container_id
                    self._deps.runtime.remove(name)
                    inst.container_id = ''
                except Exception:  # pylint: disable=broad-exception-caught
                    # 若清容器失败，保留刚观测到的 id，供 ERROR 行后续 delete 证明所有权。
                    pass
            # mkdir 成功是目录所有权的正向证据；mkdir 自身失败时保留既有数据。
            if directory_created:
                try:
                    self._deps.dir_remover(instance_dir)
                except OSError:
                    if inst is not None:
                        inst.status = Instance.STATUS_ERROR
                        try:
                            inst.save(update_fields=['status', 'container_id'])
                        except Exception:  # pylint: disable=broad-exception-caught
                            pass
                    raise InstanceCleanupError(name, str(instance_dir)) from None
            if inst is not None and inst.pk is not None:
                inst.delete()
            raise
        finally:
            self._deps.inflight.release(name)

    def delete(self, name: str) -> bool:
        """删除容器 + 连数据删（spec §5.4）。

        实例不存在返回 False；容器不存在幂等清理。
        codex R1 :126：home 清理失败（root 容器改属主/权限）不吞——保留 DB 行 +
        标 REMOVING + raise InstanceCleanupError，客户端可重试（容器已删，重试只清目录 + 删行）。
        codex R3 :257：目标仍在 provisioning（create 在飞）→ raise InstanceBusy（view 409），
        防 delete 与在飞 create 竞争（create 收尾 save(running) 会 resurrect 已删行/容器数据已清）。
        """
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            return False
        # codex R9-1 (P1)：记录 claim 时的行身份。后续 rmtree 前重新查行——若行已被另一 delete
        # 删除（None）或被 recreate 替换（pk 不同），则跳过 rmtree（资源已不属于本行）。
        # pk 区分新旧行：recreate 必须等旧行 delete 后、name UNIQUE 阻止重复 INSERT。
        claimed_pk = inst.pk
        # codex R6 :304：基于 DB status 判断 provisioning——跨进程安全。
        # CREATEING 行（无论本进程在飞与否）表明有 create 正在或曾经 provisioning；
        # delete 须拒删 CREATING 行以保护仍在飞的 create，崩溃中断的 CREATING 行
        # 经 _reconcile_creating 收敛后再删。仅进程内 inflight guard 在多 worker
        # 下不可见。
        if inst.status == Instance.STATUS_CREATING:
            raise InstanceBusy(name)
        # codex R3 :257：本进程在飞 create 的额外保险——status 尚未落盘 CREATING
        # 的极窄窗口（_reserve_row 前）仍由进程内标记挡。
        if name in self._deps.inflight:
            raise InstanceBusy(name)
        # container_id 是本行拥有 runtime 容器的正向证据。ERROR + 空 id 可能只是目录清理行，
        # 同名容器可能早于本次 create，不能无条件 stop/remove。
        # codex R6 :311：DB 记录的 container_id 可能与存活容器 ID 不匹配（外部删除后重建同名容器），
        # 先验证再 stop/remove，否则会误删非本 orch 拥有的健康容器。
        if inst.container_id:
            live = self._deps.runtime.get(name)
            if live is None or live.container_id != inst.container_id:
                inst.container_id = ''
                try:
                    inst.save(update_fields=['container_id'])
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
            else:
                # A3：容器以 root 跑，bind-mount home 内由容器写入的文件（session/cache 等）
                # 属主为 root，host 非 root rmtree 会 PermissionError。容器还在（root 权限）时
                # 同步 chown home 给 host uid，让 host rmtree 能清。best-effort——chown 失败不阻断。
                try:
                    self._deps.runtime.exec_sync(
                        name, ['chown', '-R', str(os.getuid()), HOME_BIND],
                    )
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
                self._deps.runtime.stop(name)
                self._deps.runtime.remove(name)
        # codex R4 :296：删除路径优先由 DB 记录的 home_dir 派生（创建时固化的绝对路径，
        # home_dir=<instance_dir>/home，取 parent 即 instance_dir）——OPENCLAW_FLEET_ROOT 变更后
        # 仍能删到旧 root 下的真实数据，而非用当前 cfg.root 重构（新 root 无该目录会被
        # FileNotFoundError 误判为成功，旧数据残留）。
        # 防御：home_dir 占位/被篡改（parent 不在任何 instances 根下，如 '/h'）时回退
        # cfg.root/instances/name，避免对危险路径 rmtree。
        recorded = Path(inst.home_dir).parent
        if recorded.name != name or recorded.parent.name != 'instances':
            instance_dir = self._deps.config.root / 'instances' / name
        else:
            instance_dir = recorded
        # codex R9-1 (P1)：rmtree 前重新查行身份——若行已被另一 delete 删除（None）或
        # 被 recreate 替换为新一代（pk ≠ claimed_pk），则跳过 rmtree。此时目录归新 owner，
        # 容器已由 container_id 比对守卫保护（不匹配→skip stop/remove）。
        current = Instance.objects.filter(name=name).first()
        if current is None or current.pk != claimed_pk:
            # 行已属于另一 lifecycle 代——跳过目录清理，仅删旧实例（inst 仍指向旧 pk）
            inst.delete()
            return True
        try:
            self._deps.dir_remover(instance_dir)
        except FileNotFoundError:
            # codex R2 :204：目录已不存在（外部清理/建行前崩溃）视为清理成功——
            # 否则 FileNotFoundError 落入 OSError 分支，行卡 REMOVING 且重试永远撞同一路径。
            pass
        except OSError as exc:
            inst.status = Instance.STATUS_REMOVING
            inst.save()
            raise InstanceCleanupError(name, str(instance_dir)) from exc
        inst.delete()
        return True

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
        return InstanceOrchestrator(
            runtime=DockerRuntime(),
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
