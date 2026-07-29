"""DockerRuntime —— docker-py 适配层（spec §5.4 / r27 §4.2）。

build_run_kwargs 是纯逻辑 seam（不调 daemon），把 docker run 参数正确性与 IO 分离；
run/list_fleet/get/stop/remove 经 docker client 操作 daemon（integration test 覆盖）。

client_factory 延迟注入（默认 docker.from_env）—— 构造时不连 daemon，仅实际调用时才连。
"""
import docker
from docker.errors import NotFound

from .constants import (
    CONFIG_BIND,
    CONTAINER_PREFIX,
    GATEWAY_BIND,
    GATEWAY_INTERNAL_PORT,
    HOME_BIND,
    LABEL_APP_KEY,
    LABEL_APP_VALUE,
    LABEL_INSTANCE_KEY,
    LABEL_PORT_KEY,
)
from .runtime import ContainerInfo, ContainerSpec, container_name

# 4 个 sync flag 全关（R6 §3：防覆写挂载的 openclaw.json / 防明文写凭证）
_SYNC_FLAGS_OFF = {
    'SYNC_OPENCLAW_CONFIG': 'false',
    'SYNC_EXTENSIONS_ON_START': 'false',
    'SYNC_EXTENSIONS_MODE': 'none',
    'SYNC_MODEL_CONFIG': 'false',
}

# 基础环境（r27 §4.2：locale + gateway 绑定 + 关闭外联 IM channel + 插件开关）
_BASE_ENV = {
    'TZ': 'Asia/Shanghai',
    'HOME': '/home/node',
    'TERM': 'xterm-256color',
    'NODE_ENV': 'production',
    'LANG': 'en_US.UTF-8',
    'LANGUAGE': 'en_US:en',
    'LC_ALL': 'en_US.UTF-8',
    'OPENCLAW_GATEWAY_PORT': str(GATEWAY_INTERNAL_PORT),
    'OPENCLAW_GATEWAY_BIND': GATEWAY_BIND,
    'OPENCLAW_GATEWAY_MODE': 'local',
    'OPENCLAW_WORKSPACE_ROOT': HOME_BIND,
    'DM_POLICY': 'disabled',
    'GROUP_POLICY': 'disabled',
    'ALLOW_FROM': '',
    'OPENCLAW_PLUGINS_ENABLED': 'true',
}


class DockerRuntime:
    """docker-py 容器运行时适配器（实现 ContainerRuntime Protocol）。"""

    def __init__(self, client_factory=None) -> None:
        self._client_factory = client_factory or docker.from_env
        # codex R9-3：复用单 client 而非每次 docker.from_env() —— 管理页每 3s×N instance
        # 的 status 轮询会产生大量无谓 daemon 连接。lazy 构造兼容构造时不连 daemon 的约定。
        # 注意：属性名 _cached_client 区别于方法 _client()，避免 Python attribute shadow 导致
        # self._client() 返回 None → TypeError（R10-1）。
        self._cached_client: ... = None

    def _client(self):
        if self._cached_client is None:
            self._cached_client = self._client_factory()
        return self._cached_client

    def build_run_kwargs(self, spec: ContainerSpec) -> dict:
        """构造 docker-py containers.run() 的 kwargs（纯逻辑，可单测）。"""
        environment = {
            **_BASE_ENV,
            **_SYNC_FLAGS_OFF,
            'GATEWAY_TOKEN': spec.gateway_token,
            # ADR 0003 / issue #156：容器内 sidecar CLI（approve/exec 审批注册）自连
            # gateway 须 OPENCLAW_GATEWAY_TOKEN = GATEWAY_TOKEN 同值；spike 实测
            # 不一致时 CLI 自连报 1008 token mismatch。
            'OPENCLAW_GATEWAY_TOKEN': spec.gateway_token,
            'LLM_API_KEY': spec.llm_api_key,
        }
        return {
            'image': spec.image,
            'name': container_name(spec.name),
            'detach': True,
            'user': '0:0',
            'cap_add': ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
            'environment': environment,
            'volumes': {
                spec.home_dir: {'bind': HOME_BIND, 'mode': 'rw'},
                # openclaw.json 挂 rw（对齐 deploy/docker-compose.yml 默认 rw 挂载）。
                # spec §5.2 原要求 ro，但 acautomata/openclaw-docker-cn-im 镜像 init.sh 以 root
                # (user 0:0) 启动时执行 ``chown -R node:node "$OPENCLAW_HOME"``（init.sh:236），
                # 递归修复 home 属主，撞上 ro 的 openclaw.json → "Read-only file system" →
                # ``set -e`` 致命退出 → restart loop → 容器 unhealthy、配对连不上。
                # ro 覆写「防容器内篡改配置」的保护改由 ``SYNC_OPENCLAW_CONFIG=false``（_SYNC_FLAGS_OFF）
                # 承担：init.sh 检测该 flag 后跳过 openclaw.json 覆写同步，渲染产物不被改写。
                spec.config_path: {'bind': CONFIG_BIND, 'mode': 'rw'},
            },
            'ports': {f'{GATEWAY_INTERNAL_PORT}/tcp': ('127.0.0.1', spec.host_port)},
            'restart_policy': {'Name': 'unless-stopped'},
            'labels': {
                LABEL_APP_KEY: LABEL_APP_VALUE,
                LABEL_INSTANCE_KEY: spec.name,
                LABEL_PORT_KEY: str(spec.host_port),
            },
        }

    def run(self, spec: ContainerSpec) -> str:
        container = self._client().containers.run(**self.build_run_kwargs(spec))
        return container.id

    def list_fleet(self) -> list[ContainerInfo]:
        cs = self._client().containers.list(
            all=True, filters={'label': [f'{LABEL_APP_KEY}={LABEL_APP_VALUE}']},
        )
        return [self._to_info(c) for c in cs]

    def get(self, name: str) -> ContainerInfo | None:
        try:
            c = self._client().containers.get(container_name(name))
        except NotFound:
            return None
        return self._to_info(c)

    def stop(self, name: str) -> None:
        try:
            self._client().containers.get(container_name(name)).stop(timeout=10)
        except NotFound:
            pass

    def remove(self, name: str) -> None:
        try:
            c = self._client().containers.get(container_name(name))
        except NotFound:
            return
        c.remove(v=True, force=True)

    def exec_in_container(self, name: str, cmd: list[str]) -> None:
        # 容器内执行命令（如 wiki compile）；NotFound 幂等（容器已停/删）
        try:
            c = self._client().containers.get(container_name(name))
        except NotFound:
            return
        c.exec_run(cmd, detach=True)

    def exec_sync(self, name: str, cmd: list[str]) -> None:
        # 同步等命令完成（exec_run 默认 detach=False）；区别于 exec_in_container 的
        # fire-and-forget（detach=True，wiki compile）。供 delete cleanup：容器以 root 跑，
        # bind-mount home 内由容器写入的文件属主为 root，须容器还在（root 权限）同步 chown 给
        # host uid 后再 stop/remove/rmtree——否则 host 非 root rmtree PermissionError（A3）。
        try:
            c = self._client().containers.get(container_name(name))
        except NotFound:
            return
        c.exec_run(cmd)

    @staticmethod
    def _to_info(c) -> ContainerInfo:
        image = c.attrs.get('Config', {}).get('Image') or ''
        # codex R2 :161：从 openclaw.port label 还原宿主映射端口（供端口分配对账）；
        # 无 label / 非数字时为 None（未跟踪容器由宿主 bind 实测兜底）。
        raw_port = (c.labels or {}).get(LABEL_PORT_KEY)
        try:
            port = int(raw_port) if raw_port is not None else None
        except (TypeError, ValueError):
            port = None
        return ContainerInfo(
            container_id=c.id,
            name=c.name,
            running=(c.status == 'running'),
            status=c.status,
            image=image,
            port=port,
            # codex R9-2：按 openclaw.instance label 提取实例归属——reconcile/delete 用它
            # 校验容器所有权（外来同名容器 instance_name 不匹配则不采纳/不删）。
            instance_name=(c.labels or {}).get(LABEL_INSTANCE_KEY),
        )


# 标识前缀供外部对账（spec §5.5：按 label 扫 daemon 对账）
PREFIX = CONTAINER_PREFIX
