"""seam: DockerRuntime 构造 docker run 参数 —— issue #39 容器编排控制面。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §5.4（docker-py 生命周期 + 挂 docker.sock）/r27 §4.2
（run 完整参数骨架：name/cap/env/volumes/ports/labels/restart_policy）。

只测 build_run_kwargs（纯逻辑，不需要 docker daemon）—— 真实 run/stop/remove 走 integration test。
build_run_kwargs 是故意提取出的可测 seam：把「docker 调用参数正确性」从「需要 daemon 的 IO」分离。
"""
import pytest

from containers.runtime import ContainerSpec

pytest.importorskip('docker')  # build_run_kwargs 不需 daemon，但 docker_runtime 顶部 import docker
from containers.docker_runtime import DockerRuntime


def _spec() -> ContainerSpec:
    return ContainerSpec(
        name='demo',
        image='ghcr.io/openclaw/openclaw:2026.7.1-browser',
        host_port=19000,
        gateway_token='tok-DO-NOT-LEAK',
        home_dir='/fleet/instances/demo/home',
        config_path='/fleet/instances/demo/openclaw.json',
        llm_api_key='sk-test',
    )


def test_name_carries_fleet_prefix():
    # spec §5.3：容器名 openclaw-gw-<name>，与原 compose 栈 openclaw-gateway 隔离
    kw = DockerRuntime().build_run_kwargs(_spec())
    assert kw['name'] == 'openclaw-gw-demo'


def test_carries_fleet_label():
    # issue #39 验收 + spec §5.4：label app=openclaw-fleet（按 label 过滤管理生命周期）
    kw = DockerRuntime().build_run_kwargs(_spec())
    assert kw['labels']['app'] == 'openclaw-fleet'
    assert kw['labels']['openclaw.instance'] == 'demo'
    assert kw['labels']['openclaw.port'] == '19000'


def test_gateway_port_maps_to_loopback_host_port():
    # spec §5.3/r27 §3.2：容器内 18789 → 宿主 127.0.0.1:<host_port>（loopback 收敛暴露面）
    kw = DockerRuntime().build_run_kwargs(_spec())
    assert kw['ports'] == {'18789/tcp': ('127.0.0.1', 19000)}


def test_publish_host_configurable():
    """#295：端口发布 host 构造注入，生产可配 0.0.0.0 使 host-gateway 可达。

    本地默认 loopback（收敛暴露面）；生产后端容器化后经 ``OPENCLAW_FLEET_PORT_BIND_HOST``
    注入 0.0.0.0，控制面容器经 host.docker.internal:<port> 寻址宿主映射端口。
    """
    kw = DockerRuntime(publish_host='0.0.0.0').build_run_kwargs(_spec())
    assert kw['ports'] == {'18789/tcp': ('0.0.0.0', 19000)}


def test_home_rw_and_config_bind_mount_ro():
    # home rw（agent 写 wiki/workspace）；openclaw.json ro（spec §5.2 防容器内篡改配置）。
    # 官方镜像无 init.sh chown，ro 不会崩（ADR 0003）；配置写入全在 host 侧，gateway 只 read-only watch。
    kw = DockerRuntime().build_run_kwargs(_spec())
    assert kw['volumes']['/fleet/instances/demo/home'] == {
        'bind': '/home/node/.openclaw',
        'mode': 'rw',
    }
    assert kw['volumes']['/fleet/instances/demo/openclaw.json'] == {
        'bind': '/home/node/.openclaw/openclaw.json',
        'mode': 'ro',
    }


def test_sync_flags_off_and_credentials_in_env():
    # r27 §4.2 / R6 §3：4 个 sync flag 全关（防覆写挂载的 openclaw.json / 防明文写凭证）
    env = DockerRuntime().build_run_kwargs(_spec())['environment']
    assert env['SYNC_OPENCLAW_CONFIG'] == 'false'
    assert env['SYNC_EXTENSIONS_ON_START'] == 'false'
    assert env['SYNC_EXTENSIONS_MODE'] == 'none'
    assert env['SYNC_MODEL_CONFIG'] == 'false'
    # 凭证经 env 注入（SecretRef 运行时读进程 env，不写盘）
    assert env['GATEWAY_TOKEN'] == 'tok-DO-NOT-LEAK'
    assert env['OPENCLAW_GATEWAY_TOKEN'] == 'tok-DO-NOT-LEAK'
    assert env['LLM_API_KEY'] == 'sk-test'
    # 容器内统一 18789 + lan（跨容器访问必需）
    assert env['OPENCLAW_GATEWAY_PORT'] == '18789'
    assert env['OPENCLAW_GATEWAY_BIND'] == 'lan'


def test_gateway_token_never_in_persistent_layers():
    # spec §5.2 安全不变量：真 token 只经 env 注入，绝不落进 label / volume 路径 / 命令
    # （label 与 volume 路径会随容器元数据/宿主文件持久化）。
    kw = DockerRuntime().build_run_kwargs(_spec())
    blob = repr(kw['labels']) + repr(kw['volumes'])
    if 'command' in kw:
        blob += repr(kw['command'])
    assert 'tok-DO-NOT-LEAK' not in blob


def test_privilege_floor_matches_researcher_image():
    # r27 §4.2：root + 4 caps 保留——A3 delete cleanup（orchestrator）依赖 root chown home 给 host uid；
    # 收紧到 node(1000) 是 ADR 0003 后续（需配套重做 cleanup）。restart unless-stopped
    kw = DockerRuntime().build_run_kwargs(_spec())
    assert kw['user'] == '0:0'
    assert set(kw['cap_add']) == {'CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'}
    assert kw['restart_policy'] == {'Name': 'unless-stopped'}
    assert kw['detach'] is True


def test_host_published_ports_enumerates_unlabelled_containers(monkeypatch):
    """#295 codex P2：宿主端口占用须经 daemon 命名空间枚举，而非容器内 socket bind。

    生产后端容器化（bridge 网络）时，后端容器内 socket.bind 探测不到宿主已发布端口
    （命名空间盲区）；且 list_fleet 按 label 过滤看不到未跟踪容器。host_published_ports
    无 label 过滤枚举 daemon 全部容器 PortBindings → 未跟踪容器占用的池端口也能被 allocator
    跳过。
    """
    from containers.docker_runtime import DockerRuntime

    class _FakeContainers:
        def list(self, all=True, filters=None):  # pylint: disable=redefined-builtin
            return [
                _FakeC('tracked', {'openclaw.port': '19000'}, None, 'running'),
                _FakeC('untracked', None, {'18789/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '19002'}]}, 'running'),
            ]

    class _FakeC:
        def __init__(self, name, labels, port_bindings, status='running'):
            self.name = name
            self.labels = labels or {}
            self.status = status
            self.attrs = {'HostConfig': {'PortBindings': port_bindings}} if port_bindings else {'HostConfig': {}}

    class _FakeClient:
        containers = _FakeContainers()

    rt = DockerRuntime(client_factory=_FakeClient)
    ports = rt.host_published_ports()
    assert 19002 in ports          # 未跟踪容器的宿主发布端口被枚举
    assert 19000 not in ports      # 无 PortBindings 的容器不算发布端口


def test_host_published_ports_ignores_stopped_containers(monkeypatch):
    """#295 codex P2 :134：exited/created/dead 容器保留 PortBindings 但无活跃宿主监听。

    list(all=True) 会枚举 stopped 容器，其 PortBindings 是残留配置而非真实占用——
    _used_ports 据此误判池端口占用会跳过空闲候选，足够多 stale 容器可假耗尽
    19000–19999 使创建失败。只跳过 daemon 已收回绑定的状态（exited/created/dead）；
    running/restarting/paused 仍持有宿主监听，须计数（宁多算只跳过候选，少算则真实
    占用被误判空闲 → bind 冲突）。
    """
    from containers.docker_runtime import DockerRuntime

    class _FakeContainers:
        def list(self, all=True, filters=None):  # pylint: disable=redefined-builtin
            return [
                _FakeC('running-external', None, {'18789/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '19001'}]}, 'running'),
                _FakeC('restarting', None, {'18789/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '19002'}]}, 'restarting'),
                _FakeC('paused', None, {'18789/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '19003'}]}, 'paused'),
                _FakeC('stopped', None, {'18789/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '19004'}]}, 'exited'),
                _FakeC('created', None, {'18789/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '19005'}]}, 'created'),
                _FakeC('dead', None, {'18789/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '19006'}]}, 'dead'),
            ]

    class _FakeC:
        def __init__(self, name, labels, port_bindings, status):
            self.name = name
            self.labels = labels or {}
            self.status = status
            self.attrs = {'HostConfig': {'PortBindings': port_bindings}} if port_bindings else {'HostConfig': {}}

    class _FakeClient:
        containers = _FakeContainers()

    rt = DockerRuntime(client_factory=_FakeClient)
    ports = rt.host_published_ports()
    assert 19001 in ports          # running 容器的宿主发布端口被计数
    assert 19002 in ports          # restarting 容器仍持绑定 → 计数
    assert 19003 in ports          # paused 容器仍持绑定 → 计数
    assert 19004 not in ports      # exited 容器残留 PortBindings 不计数
    assert 19005 not in ports      # created 容器残留 PortBindings 不计数
    assert 19006 not in ports      # dead 容器残留 PortBindings 不计数


def test_host_published_ports_empty_when_no_containers(monkeypatch):
    """空 daemon → 空集合（不误报占用）。"""
    from containers.docker_runtime import DockerRuntime

    class _FakeContainers:
        def list(self, all=True, filters=None):  # pylint: disable=redefined-builtin
            return []

    class _FakeClient:
        containers = _FakeContainers()

    rt = DockerRuntime(client_factory=_FakeClient)
    assert rt.host_published_ports() == set()
