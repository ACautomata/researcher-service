"""DockerRuntime —— docker-py 适配层（spec §5.4 / r27 §4.2）。

build_run_kwargs 是纯逻辑 seam（不调 daemon），把 docker run 参数正确性与 IO 分离；
run/list_fleet/get/stop/remove 经 docker client 操作 daemon（integration test 覆盖）。

client_factory 延迟注入（默认 docker.from_env）—— 构造时不连 daemon，仅实际调用时才连。
"""
import docker
from docker.errors import NotFound

from .runtime import (
    CONFIG_BIND,
    CONTAINER_PREFIX,
    ContainerInfo,
    ContainerSpec,
    GATEWAY_INTERNAL_PORT,
    HOME_BIND,
    LABEL_APP_KEY,
    LABEL_APP_VALUE,
    LABEL_INSTANCE_KEY,
    LABEL_PORT_KEY,
    container_name,
)

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
    'OPENCLAW_GATEWAY_BIND': 'lan',
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

    def _client(self):
        return self._client_factory()

    def build_run_kwargs(self, spec: ContainerSpec) -> dict:
        """构造 docker-py containers.run() 的 kwargs（纯逻辑，可单测）。"""
        environment = {
            **_BASE_ENV,
            **_SYNC_FLAGS_OFF,
            'GATEWAY_TOKEN': spec.gateway_token,
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
                spec.config_path: {'bind': CONFIG_BIND, 'mode': 'ro'},
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
            all=True, filters={'label': [f'{LABEL_APP_KEY}={LABEL_APP_VALUE}']}
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
        )


# 标识前缀供外部对账（spec §5.5：按 label 扫 daemon 对账）
PREFIX = CONTAINER_PREFIX
