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

# 4 个 sync flag 全关（R6 §3：防覆写挂载的 openclaw.json / 防明文写凭证）。
# 官方镜像 entrypoint = tini 直起 gateway，无 init.sh、无 sync 逻辑，不读这些 flag（对官方
# 无效、无害）；保留以兼容 acautomata 谱系——用户可经 OPENCLAW_IMAGE 切回 fork，其 init.sh
# 仍会读这些 flag 做配置同步。
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
                # openclaw.json 挂 ro（spec §5.2：防容器内篡改配置）。
                # 官方镜像 entrypoint = tini 直起 gateway，无 init.sh、无 chown/sync 逻辑（ADR 0003），
                # 故 acautomata fork init.sh ``chown -R`` 撞 ro 的崩溃路径在官方镜像上不成立——ro 不会崩。
                # 所有配置写入都在 host 侧（orchestrator 原子 os.replace / create 写盘），gateway 只
                # read-only watch 热加载（r28）；host 侧写透过 bind 传播给容器，不受 ro 影响。
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
        #
        # codex P2 :66（2902641 review）：docker SDK 的 exec_run 在命令退出码非零时返回
        # ``ExecResult``（exit_code/output），并不抛异常。原实现 discard 返回值会让 approve
        # CLI 失败（例如 token 不匹配 / request ID 过期）仍报成功，触发重握手 → 再生成新
        # request ID → 原始 actionable pending 被替换 → 配对 churn 无限循环。这里捕获 exit_code
        # 非零即抛 RuntimeError（含 output 片段便于排错），让 caller（ExecPairingApprover）
        # 走 2902641 已加的 STATUS_ERROR 路径。
        try:
            c = self._client().containers.get(container_name(name))
        except NotFound:
            return
        result = c.exec_run(cmd)
        if result.exit_code != 0:
            output = getattr(result, 'output', b'') or b''
            output_str = output.decode('utf-8', errors='replace').strip() if hasattr(output, 'decode') else str(output)
            raise RuntimeError(
                f'exec_sync failed in {name}: exit_code={result.exit_code} '
                f'cmd={cmd!r} output={output_str[:500]!r}',
            )

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
