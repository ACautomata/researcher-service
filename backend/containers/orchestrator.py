"""InstanceOrchestrator —— 容器生命周期编排（spec §5.4/§5.5）。

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
import os
import secrets
import shutil
import socket
import threading
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from django.db import IntegrityError, transaction

from .config_renderer import ConfigRenderer
from .docker_runtime import DockerRuntime
from .models import Instance
from .ports import RESERVED_PORT_18789, PortAllocator
from .provisioner import HomeProvisioner
from .runtime import ContainerSpec

# health 字段枚举（issue #39 验收：列表显示 health 变 healthy）
HEALTH_HEALTHY = 'healthy'
HEALTH_UNHEALTHY = 'unhealthy'
HEALTH_STOPPED = 'stopped'
HEALTH_PENDING = 'pending'        # creating：容器未起，无 health 可探
HEALTH_REMOVING = 'removing'      # removing：清理中

# codex R1 :77：port 并发冲突的最大重试次数（port 池充足，覆盖极端并发）
_MAX_PORT_RETRIES = 8
# codex R1 :156：list 健康探测并发上限（避免线程爆炸）
_MAX_HEALTH_WORKERS = 8


class InstanceExists(Exception):
    """并发同名插入被 DB 唯一约束拒绝（spec §10 name 唯一）；view 层转 409。"""

    def __init__(self, name: str) -> None:
        super().__init__(f'instance {name!r} already exists')
        self.name = name


class InstanceCleanupError(Exception):
    """容器已停删但 home 目录清理失败（权限/属主）；保留 DB 行可重试（spec §5.5）。"""

    def __init__(self, name: str, path: str) -> None:
        super().__init__(f'cleanup failed for {name!r}: {path}')
        self.name = name
        self.path = path


class PortAllocationError(Exception):
    """端口分配重试用尽（池理论充足但持续冲突）；不可重试，view 层 503。"""

    def __init__(self, name: str) -> None:
        super().__init__(f'port allocation exhausted for {name!r}')
        self.name = name


class InstanceBusy(Exception):
    """删除目标仍在 provisioning（creating 且在本次/它次 create 在飞）；view 层 409（codex R3）。

    防 delete 与在飞 create 竞争：create 收尾 save(running) 会 resurrect 已被删除的行。
    """

    def __init__(self, name: str) -> None:
        super().__init__(f'instance {name!r} is still being provisioned')
        self.name = name


@dataclass(frozen=True)
class FleetConfig:
    """编排控制面配置（来自 settings.OPENCLAW_FLEET，测试可注入 tmp 路径）。"""

    root: Path                 # OPENCLAW_FLEET_ROOT（instances/ 落盘根）
    template_dir: Path         # 共享只读模板（cp -a 源）
    template_json: str         # openclaw.json 模板文本
    image: str                 # pin 的镜像 tag
    port_start: int
    port_end: int
    llm_api_key: str           # 全面板共享 LLM_API_KEY（spec §5.2）
    reserved_ports: frozenset[int] = frozenset({RESERVED_PORT_18789})


class HealthProbe:
    """外部 HTTP GET 127.0.0.1:<port>/health 探容器 gateway 可达性（spec §5.4/§12）。"""

    def __init__(self, timeout: float = 2.0) -> None:
        self._timeout = timeout

    def is_reachable(self, port: int) -> bool:
        url = f'http://127.0.0.1:{port}/health'
        try:
            with urllib.request.urlopen(url, timeout=self._timeout) as resp:
                return 200 <= resp.status < 300
        except Exception:
            # URLError（连不上）/ HTTPError（非 2xx）/ timeout —— 统一不可达
            return False


def _host_port_in_use(port: int) -> bool:
    """宿主 127.0.0.1:<port> 是否已被占用（socket bind 实测；codex R2 端口分配）。

    Instance.port 只反映本面板记账的容器；无关进程/未跟踪容器占用最低候选端口时
    本探测返回 True，allocator 跳过它，避免 run() 因宿主 bind 冲突确定性失败。
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(('127.0.0.1', port))
        return False
    except OSError:
        return True
    finally:
        probe.close()


class InstanceOrchestrator:
    """容器实例生命周期 facade（create/delete/list）。"""

    def __init__(
        self,
        runtime,
        config: FleetConfig,
        health_probe=None,
        dir_remover=None,
        port_in_use: Callable[[int], bool] | None = None,
    ) -> None:
        self._runtime = runtime
        self._cfg = config
        self._health = health_probe or HealthProbe()
        # codex R1 :126：注入目录删除器（默认 shutil.rmtree，不 ignore），可测清理失败
        self._dir_remover = dir_remover or shutil.rmtree
        # codex R2 :161：注入宿主端口占用探测（默认 socket bind 实测），可测确定性冲突
        self._port_in_use = port_in_use or _host_port_in_use
        # codex R6 :475：ConfigRenderer 推迟到 create() 内惰性构造——
        # 模板 JSON 仅供 create() 使用，list/delete 不应因其损坏而 500。
        self._renderer = None
        self._provisioner = HomeProvisioner(config.template_dir)
        self._allocator = PortAllocator(
            config.port_start, config.port_end, config.reserved_ports
        )
        # codex R3：在飞 create 名字集（进程内，orchestrator 单例跨请求共享）。
        # 区分「正在 provisioning」与「崩溃中断」的 creating 行——delete 据此拒删在飞实例（:257），
        # _reconcile_creating 据此只对非在飞的中断行收敛（:319），create 回滚据 run_attempted
        # 决定是否 remove 容器（:232）。
        self._inflight_creates: set[str] = set()
        self._inflight_lock = threading.Lock()

    def _used_ports(self) -> set[int]:
        """已用端口 = DB 记账 ∪ fleet 容器 label 端口 ∪ 池内宿主实测占用（codex R2 :161）。

        仅记账会让最低候选被无关进程/未跟踪容器占用而反复失败；并入 daemon label
        端口与宿主 bind 实测后，allocator 跳过真实不可用端口。宿主探测只扫池区间，
        且对池外/异常端口容错（占用即跳过该候选，不影响其余）。
        """
        used = set(Instance.objects.values_list('port', flat=True))
        try:
            for info in self._runtime.list_fleet():
                port = getattr(info, 'port', None)
                if isinstance(port, int):
                    used.add(port)
        except Exception:
            # daemon 不可达不阻断分配：DB 记账 + 宿主实测仍可给出候选
            pass
        for port in range(self._cfg.port_start, self._cfg.port_end + 1):
            if port not in used and self._port_in_use(port):
                used.add(port)
        return used

    def _reserve_row(self, name: str) -> Instance:
        """事务内占位 INSERT：name/port 冲突由 DB 唯一约束仲裁（codex R1 :77/:84）。

        port 冲突（并发选同 port）→ 保存点回滚后重试下一个空闲 port；
        name 冲突（并发同名）→ InstanceExists（view 409，不重试）。
        预占在 mkdir 之前：DB 唯一约束先挡重名，避免误删既有实例目录。
        """
        home = str(self._cfg.root / 'instances' / name / 'home')
        token = secrets.token_urlsafe(32)
        for _ in range(_MAX_PORT_RETRIES):
            port = self._allocator.next_free(self._used_ports())
            try:
                with transaction.atomic():
                    return Instance.objects.create(
                        name=name,
                        port=port,
                        token=token,
                        home_dir=home,
                        container_id='',
                        status=Instance.STATUS_CREATING,
                        image=self._cfg.image,
                    )
            except IntegrityError:
                if Instance.objects.filter(name=name).exists():
                    raise InstanceExists(name) from None
                # 否则 port 冲突 → 保存点已回滚，继续重试下一 port
        raise PortAllocationError(name)

    def create(self, name: str) -> Instance:
        """创建并启动一个容器（spec §5.4/§5.5）。

        先以进程内 guard 覆盖完整 create，再事务占位（挡重名/仲裁 port），
        然后 mkdir + cp -a + 渲染 + run；失败时只回滚本次实际创建的资源。
        """
        # codex R6 :484：空 LLM_API_KEY 会在 _reserve_row 前拒绝——否则后续创建外表 healthy
        # 但永远无法调 LLM 的容器，且 LLM_API_KEY 是面板级共享的不能通过 delete 修复。
        if not self._cfg.llm_api_key:
            raise ValueError('LLM_API_KEY is required but not configured')

        # codex R6 :475：ConfigRenderer 惰性构造——模板 JSON 损坏不会阻塞 list/delete。
        if self._renderer is None:
            self._renderer = ConfigRenderer(self._cfg.template_json)

        with self._inflight_lock:
            if name in self._inflight_creates:
                raise InstanceExists(name)
            self._inflight_creates.add(name)

        inst = None
        instance_dir = self._cfg.root / 'instances' / name
        home = instance_dir / 'home'
        config_path = instance_dir / 'openclaw.json'
        directory_created = False
        run_attempted = False
        preexisting = False
        try:
            # guard 必须先于预占行：DELETE 不能观察到尚未受保护的 creating 行。
            inst = self._reserve_row(name)
            # preflight 也在统一回滚范围内；daemon 异常不得遗留 creating 行。
            preexisting = self._runtime.get(name) is not None
            instance_dir.mkdir(parents=True, exist_ok=False)
            directory_created = True
            self._provisioner.provision(home)
            config_path.write_text(self._renderer.render())
            run_attempted = True
            container_id = self._runtime.run(
                ContainerSpec(
                    name=name,
                    image=self._cfg.image,
                    host_port=inst.port,
                    gateway_token=inst.token,
                    home_dir=str(home),
                    config_path=str(config_path),
                    llm_api_key=self._cfg.llm_api_key,
                )
            )
            inst.container_id = container_id
            inst.status = Instance.STATUS_RUNNING
            inst.save()
            return inst
        except Exception:
            # 仅 run 前确认不存在同名容器时，才可能清理由本次 run 留下的容器。
            if run_attempted and not preexisting:
                try:
                    created = self._runtime.get(name)
                    if created is not None and created.container_id:
                        inst.container_id = created.container_id
                    self._runtime.remove(name)
                    inst.container_id = ''
                except Exception:
                    # 若清容器失败，保留刚观测到的 id，供 ERROR 行后续 delete 证明所有权。
                    pass
            # mkdir 成功是目录所有权的正向证据；mkdir 自身失败时保留既有数据。
            if directory_created:
                try:
                    self._dir_remover(instance_dir)
                except OSError:
                    if inst is not None:
                        inst.status = Instance.STATUS_ERROR
                        try:
                            inst.save(update_fields=['status', 'container_id'])
                        except Exception:
                            pass
                    raise InstanceCleanupError(name, str(instance_dir)) from None
            if inst is not None:
                inst.delete()
            raise
        finally:
            with self._inflight_lock:
                self._inflight_creates.discard(name)

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
        # codex R6 :304：基于 DB status 判断 provisioning——跨进程安全。
        # CREATEING 行（无论本进程在飞与否）表明有 create 正在或曾经 provisioning；
        # delete 须拒删 CREATING 行以保护仍在飞的 create，崩溃中断的 CREATING 行
        # 经 _reconcile_creating 收敛后再删。仅进程内 _inflight_creates 在多 worker
        # 下不可见。
        if inst.status == Instance.STATUS_CREATING:
            raise InstanceBusy(name)
        # codex R3 :257：本进程在飞 create 的额外保险——status 尚未落盘 CREATING
        # 的极窄窗口（_reserve_row 前）仍由进程内标记挡。
        with self._inflight_lock:
            if name in self._inflight_creates:
                raise InstanceBusy(name)
        # container_id 是本行拥有 runtime 容器的正向证据。ERROR + 空 id 可能只是目录清理行，
        # 同名容器可能早于本次 create，不能无条件 stop/remove。
        # codex R6 :311：DB 记录的 container_id 可能与存活容器 ID 不匹配（外部删除后重建同名容器），
        # 先验证再 stop/remove，否则会误删非本 orch 拥有的健康容器。
        if inst.container_id:
            live = self._runtime.get(name)
            if live is None or live.container_id != inst.container_id:
                inst.container_id = ''
                try:
                    inst.save(update_fields=['container_id'])
                except Exception:
                    pass
            else:
                self._runtime.stop(name)
                self._runtime.remove(name)
        # codex R4 :296：删除路径优先由 DB 记录的 home_dir 派生（创建时固化的绝对路径，
        # home_dir=<instance_dir>/home，取 parent 即 instance_dir）——OPENCLAW_FLEET_ROOT 变更后
        # 仍能删到旧 root 下的真实数据，而非用当前 cfg.root 重构（新 root 无该目录会被
        # FileNotFoundError 误判为成功，旧数据残留）。
        # 防御：home_dir 占位/被篡改（parent 不在任何 instances 根下，如 '/h'）时回退
        # cfg.root/instances/name，避免对危险路径 rmtree。
        recorded = Path(inst.home_dir).parent
        if recorded.name != name or recorded.parent.name != 'instances':
            instance_dir = self._cfg.root / 'instances' / name
        else:
            instance_dir = recorded
        try:
            self._dir_remover(instance_dir)
        except FileNotFoundError:
            # codex R2 :204：目录已不存在（外部清理/建行前崩溃）视为清理成功——
            # 否则 FileNotFoundError 落入 OSError 分支，行卡 REMOVING 且重试永远撞同一路径。
            pass
        except OSError:
            inst.status = Instance.STATUS_REMOVING
            inst.save()
            raise InstanceCleanupError(name, str(instance_dir)) from None
        inst.delete()
        return True

    def _item(self, inst: Instance, status: str, health: str) -> dict:
        return {
            'name': inst.name,
            'port': inst.port,
            'status': status,
            'health': health,
            'image': inst.image,
            'container_id': inst.container_id,
            'created_at': inst.created_at,
        }

    def _build_item(self, inst: Instance) -> dict:
        """聚合单个 Instance 的 runtime 状态 + gateway 健康探测。

        codex R1 :133：creating/removing 瞬态透传（容器未起时 runtime.get 缺失
        不应误判 stopped，否则暴露错误生命周期、诱使他方对未就绪实例操作）。
        （creating 行的 runtime 对账/自愈在 list() 主线程完成，见 _reconcile_creating。）
        """
        if inst.status == Instance.STATUS_CREATING:
            return self._item(inst, Instance.STATUS_CREATING, HEALTH_PENDING)
        if inst.status == Instance.STATUS_REMOVING:
            return self._item(inst, Instance.STATUS_REMOVING, HEALTH_REMOVING)
        if inst.status == Instance.STATUS_ERROR:
            # codex R3 :319：中断收敛为 error 的行（provisioning 未完成）透传，不探健康
            return self._item(inst, Instance.STATUS_ERROR, HEALTH_STOPPED)
        info = self._runtime.get(inst.name)
        running = bool(info and info.running)
        status = Instance.STATUS_RUNNING if running else Instance.STATUS_STOPPED
        if running:
            health = (
                HEALTH_HEALTHY
                if self._health.is_reachable(inst.port)
                else HEALTH_UNHEALTHY
            )
        else:
            health = HEALTH_STOPPED
        return self._item(inst, status, health)

    def _reconcile_creating(self, insts: list[Instance]) -> None:
        """主线程对账 creating 行（codex R2 :226 / R3 :319）。

        仅处理**非在飞**的 creating 行（在飞者正被本进程 create provisioning，跳过）。
        非在飞即「崩溃中断」——按 runtime 实况收敛，不再永久 pending 占名/占端口：
        - 容器已 running（崩溃在最终 save 前，Docker 已起）→ 自愈为 running 并落盘。
        - 容器存在但未 running（created/exited，崩溃于 start 前后）→ 收敛为 stopped。
        - 无容器（崩溃在 run 之前）→ 收敛为 error（provisioning 未完成；行可经 delete 清除）。

        主线程串行执行（非线程池）：creating 行通常极少，且 Django ORM save 不宜在
        worker 线程做（pytest 事务包裹下 worker 连接隔离，落盘不可见）。
        """
        for inst in insts:
            if inst.status != Instance.STATUS_CREATING:
                continue
            with self._inflight_lock:
                if inst.name in self._inflight_creates:
                    continue            # 正在 provisioning，非中断——跳过对账
            info = self._runtime.get(inst.name)
            if info and info.running:
                inst.status = Instance.STATUS_RUNNING
                if info.container_id:
                    inst.container_id = info.container_id
            elif info is not None:
                inst.status = Instance.STATUS_STOPPED
                if info.container_id:
                    inst.container_id = info.container_id
            else:
                inst.status = Instance.STATUS_ERROR
            try:
                inst.save(update_fields=['status', 'container_id'])
            except Exception:
                # 落盘失败不阻断本次出参（内存对象已收敛，下次 list 再对账）
                pass

    def list(self) -> list[dict]:
        """聚合 DB 记账 + runtime 实时状态 + gateway 健康探测（issue #39 列表验收）。

        codex R1 :156：健康探测并发（ThreadPoolExecutor），bound list 延迟
        （非 N×timeout 串行；否则 20 不可达容器阻塞管理页约 40s）。
        insts 先物化（主线程迭代 QuerySet），_build_item 只读已加载字段 + 线程安全 IO。
        """
        insts = list(Instance.objects.order_by('created_at'))
        if not insts:
            return []
        # codex R2 :226：主线程先对账 creating 行（崩溃中断者自愈为 running），再进线程池
        self._reconcile_creating(insts)
        workers = max(1, min(_MAX_HEALTH_WORKERS, len(insts)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            return list(pool.map(self._build_item, insts))

    def created_item(self, inst: Instance) -> dict:
        """由刚创建成功的 Instance 构造 POST 响应（codex R4 :60）。

        不做 runtime/health 二次查询——create 已 commit 并启动容器，若随后 detail() 的
        runtime 查询因 daemon 抖动失败，会让已成功的创建返回 500（客户端误判失败重试撞 409）。
        容器刚起、gateway 未就绪，health 即 pending（后续 list 轮询会反映真实健康）。
        """
        return self._item(inst, Instance.STATUS_RUNNING, HEALTH_PENDING)

    def detail(self, name: str) -> dict | None:
        """单个实例的聚合视图（post 响应复用）；不存在返回 None。"""
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            return None
        return self._build_item(inst)


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
        template_json = Path(cfg['TEMPLATE_JSON']).read_text()
        return InstanceOrchestrator(
            runtime=DockerRuntime(),
            config=FleetConfig(
                root=Path(cfg['ROOT']),
                template_dir=Path(cfg['TEMPLATE']),
                template_json=template_json,
                image=cfg['IMAGE'],
                port_start=cfg['PORT_POOL_START'],
                port_end=cfg['PORT_POOL_END'],
                llm_api_key=os.environ.get('LLM_API_KEY', ''),
            ),
        )
