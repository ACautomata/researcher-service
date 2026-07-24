"""InstanceOrchestrator —— 容器生命周期编排（spec §5.4/§5.5）。

组合 ContainerRuntime + ConfigRenderer + HomeProvisioner + HealthProbe + PortAllocator（依赖注入）。
业务逻辑（端口分配/预填充/渲染/run/对账/健康聚合）依赖 Protocol，测试用 FakeRuntime 覆盖。

状态机（spec §5.5）：creating（先以 CREATING 预占 DB 行 + cp -a + 渲染 + run）
→ running → stopped → removing（终态）。失败回滚 DB 行 + 目录。
"""
import os
import secrets
import shutil
import urllib.request
from dataclasses import dataclass
from pathlib import Path

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


class InstanceOrchestrator:
    """容器实例生命周期 facade（create/delete/list）。"""

    def __init__(self, runtime, config: FleetConfig, health_probe=None) -> None:
        self._runtime = runtime
        self._cfg = config
        self._health = health_probe or HealthProbe()
        self._renderer = ConfigRenderer(config.template_json)
        self._provisioner = HomeProvisioner(config.template_dir)
        self._allocator = PortAllocator(
            config.port_start, config.port_end, config.reserved_ports
        )

    def _used_ports(self) -> set[int]:
        return set(Instance.objects.values_list('port', flat=True))

    def create(self, name: str) -> Instance:
        """创建并启动一个容器（spec §5.4/§5.5）。重名由 DB 唯一约束拒绝。"""
        port = self._allocator.next_free(self._used_ports())
        token = secrets.token_urlsafe(32)
        instance_dir = self._cfg.root / 'instances' / name
        home = instance_dir / 'home'
        config_path = instance_dir / 'openclaw.json'

        # 先以 CREATING 预占 DB 行：DB 唯一约束在 mkdir 前挡重名，避免误删既有实例目录
        inst = Instance.objects.create(
            name=name,
            port=port,
            token=token,
            home_dir=str(home),
            container_id='',
            status=Instance.STATUS_CREATING,
            image=self._cfg.image,
        )
        try:
            instance_dir.mkdir(parents=True, exist_ok=False)
            self._provisioner.provision(home)
            config_path.write_text(self._renderer.render())
            container_id = self._runtime.run(
                ContainerSpec(
                    name=name,
                    image=self._cfg.image,
                    host_port=port,
                    gateway_token=token,
                    home_dir=str(home),
                    config_path=str(config_path),
                    llm_api_key=self._cfg.llm_api_key,
                )
            )
        except Exception:
            # spec §5.5：失败回滚 DB 行 + 目录
            inst.delete()
            shutil.rmtree(instance_dir, ignore_errors=True)
            raise
        inst.container_id = container_id
        inst.status = Instance.STATUS_RUNNING
        inst.save()
        return inst

    def delete(self, name: str) -> bool:
        """删除容器 + 连数据删（spec §5.4）。实例不存在返回 False；容器不存在幂等清理。"""
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            return False
        self._runtime.stop(name)
        self._runtime.remove(name)
        shutil.rmtree(self._cfg.root / 'instances' / name, ignore_errors=True)
        inst.delete()
        return True

    def _build_item(self, inst: Instance) -> dict:
        """聚合单个 Instance 的 runtime 状态 + gateway 健康探测。"""
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
        return {
            'name': inst.name,
            'port': inst.port,
            'status': status,
            'health': health,
            'image': inst.image,
            'container_id': inst.container_id,
            'created_at': inst.created_at,
        }

    def list(self) -> list[dict]:
        """聚合 DB 记账 + runtime 实时状态 + gateway 健康探测（issue #39 列表验收）。"""
        return [
            self._build_item(inst)
            for inst in Instance.objects.order_by('created_at')
        ]

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
