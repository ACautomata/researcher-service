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
        image='acautomata/openclaw-docker-cn-im:latest',
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


def test_home_bind_mount_rw_config_ro():
    # spec §5.6：home bind-mount rw（agent 写 wiki/workspace）；openclaw.json ro 覆盖（配置单一来源）
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
    # r27 §4.2：root 启动便于 init.sh chown，cap 仅 4 项；restart unless-stopped
    kw = DockerRuntime().build_run_kwargs(_spec())
    assert kw['user'] == '0:0'
    assert set(kw['cap_add']) == {'CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'}
    assert kw['restart_policy'] == {'Name': 'unless-stopped'}
    assert kw['detach'] is True
