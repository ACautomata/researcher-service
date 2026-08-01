"""containers.fleet.values —— 编排域纯值/异常单一来源（parent #277 / #279）。

#279 预重构（parent #277）：原 ``containers.fleet.orchestrator.py`` 的**纯值层**（HEALTH_*
健康枚举、``FleetConfig`` 配置 dataclass、异常族）剥离到本模块，与 ``deps.py`` / ``read_model.py``
／``orchestrator.py`` 形成**无环依赖**（``deps`` → ``values``、``read_model`` → ``deps`` →
``values``、``orchestrator`` → ``deps`` → ``values``）。纯值层独立于任何协作者（零 import
容器编排模块），是拆分后组合根的公共基座——否则 ``deps.py`` 打包 ``FleetConfig`` 会与
``orchestrator.py`` 循环 import。

HEALTH_* 为 read-side 聚合用状态枚举（issue #39 验收：列表显示 health 变 healthy）；FleetConfig
为编排控制面配置（来自 settings.OPENCLAW_FLEET，测试可注入 tmp 路径）；异常族供 view 层
翻译 HTTP 语义（409/404/503）。

对齐 #271 的 ``integration.openclaw.wire.values.py`` 先例（值对象/异常独立于协作者模块）。
"""
from dataclasses import dataclass
from pathlib import Path

from containers.ports import RESERVED_PORT_18789

# health 字段枚举（issue #39 验收：列表显示 health 变 healthy）
HEALTH_HEALTHY = 'healthy'
HEALTH_UNHEALTHY = 'unhealthy'
HEALTH_STOPPED = 'stopped'
HEALTH_PENDING = 'pending'        # creating：容器未起，无 health 可探
HEALTH_REMOVING = 'removing'      # removing：清理中


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


class InstanceDirExists(FileExistsError):
    """create 时目标 instance 目录已存在但 DB 无行（崩溃中断/外部残留/手动删 DB）。

    继承 FileExistsError 以保留 codex R5 契约（``pytest.raises(FileExistsError)``：mkdir 撞既有
    目录 → 本次不拥有该目录 → 不删、DB 行回滚）；view 层额外捕获本子类转 409（避免裸 500），
    提示先删除同名实例或手动清理目录。区别于 InstanceExists（DB 有行→409 重名）：此处 DB 无行、
    仅磁盘残留。
    """

    def __init__(self, name: str, path: str) -> None:
        super().__init__(f'instance dir already exists for {name!r}: {path}')
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


class ConfigurationError(Exception):
    """面板级配置缺失——LLM_API_KEY 等必填字段未设置；view 层 503。"""

    def __init__(self, field: str) -> None:
        super().__init__(f'{field} is required but not configured')
        self.field = field


class InstanceNotFound(Exception):
    """rewrite_config 找不到容器行（可能被并发 delete）；view 层 404。"""

    def __init__(self, name: str) -> None:
        super().__init__(f'instance {name!r} not found')
        self.name = name


class ConfigWriteError(Exception):
    """重渲染 openclaw.json 写盘失败（卷只读/满/权限）；view 层 503，DB 事务回滚。"""

    def __init__(self, name: str, path: str) -> None:
        super().__init__(f'config write failed for {name!r}: {path}')
        self.name = name
        self.path = path


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
