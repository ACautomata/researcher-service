# pylint: disable=too-many-lines
"""seam: InstanceOrchestrator 生命周期编排 —— issue #39 容器编排控制面。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §5.4（生命周期）/§5.5（状态机 + 失败回滚）/§5.6（bind-mount home）。
用 FakeRuntime + FakeHealthProbe 覆盖业务逻辑（CI 无 docker daemon）；真实 DockerRuntime 走 integration。
"""
import json
import os
import threading
import time
from datetime import timedelta
from pathlib import Path

import pytest
from django.db import IntegrityError
from django.utils import timezone

from common.lock.ports import ProvisionResource
from containers.constants import HOME_BIND, LEASE_TTL
from containers.models import Instance
from containers.orchestrator import (  # pylint: disable=too-many-positional-arguments
    ConfigurationError,
    FleetConfig,
    InstanceBusy,
    InstanceCleanupError,
    InstanceDirExists,
    InstanceExists,
    InstanceOrchestrator,
    PortAllocationError,
)
from containers.provisioner import HomeProvisioner
from containers.runtime import ContainerInfo, container_name
from containers.tests.fakes import FakeHealthProbe, FakeRuntime


def _seed_template(template):
    (template / 'workspace').mkdir(parents=True)
    (template / 'workspace' / 'note.md').write_text('hi')
    (template / 'wiki').mkdir()


@pytest.fixture
def config(tmp_path):
    template_file = tmp_path / 'openclaw.json'
    template_file.write_text('{}')
    return FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=tmp_path / 'template',
        template_json=str(template_file),
        image='img:tag',
        port_start=19000,
        port_end=19999,
        llm_api_key='sk-test',
    )


@pytest.fixture
def runtime():
    return FakeRuntime()


@pytest.fixture
def health():
    return FakeHealthProbe()


@pytest.fixture
def orch(config, runtime, health, tmp_path):
    _seed_template(tmp_path / 'template')
    return InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health)


# ---------------------------- create（§5.5 状态机 creating→running）----------------------------


@pytest.mark.django_db
def test_create_provisions_home_and_renders_config(orch, config):
    # spec §5.5/§5.6：cp -a 预填充 home + 渲染 openclaw.json 落到 instances/<name>/
    orch.create('demo')
    home = config.root / 'instances' / 'demo' / 'home'
    assert (home / 'workspace' / 'note.md').read_text() == 'hi'
    cfg_file = config.root / 'instances' / 'demo' / 'openclaw.json'
    assert cfg_file.exists()
    assert cfg_file.read_text().strip()  # 非空


@pytest.mark.django_db
def test_create_allocates_lowest_free_port(orch, runtime):
    # spec §5.3：取最小空闲端口
    inst = orch.create('demo')
    assert inst.port == 19000
    spec = runtime.run_specs[0]
    assert spec.host_port == 19000
    assert spec.name == 'demo'


@pytest.mark.django_db
def test_create_skips_used_ports(orch):
    # 已占用 19000 → 取 19001
    Instance.objects.create(
        name='other', port=19000, token='t', home_dir='/h', image='img:tag',
    )
    inst = orch.create('demo')
    assert inst.port == 19001


@pytest.mark.django_db
def test_create_runs_container_with_matching_token(orch, runtime):
    # spec §5.2：token 存 DB，同一值经 env 注入容器（JSON 内是占位）
    inst = orch.create('demo')
    spec = runtime.run_specs[0]
    assert spec.gateway_token == inst.token
    assert spec.gateway_token  # 非空
    assert spec.image == 'img:tag'


@pytest.mark.django_db
def test_create_generates_unique_token_per_instance(orch):
    a = orch.create('a')
    b = orch.create('b')
    assert a.token != b.token
    assert len(a.token) >= 32  # token_urlsafe(32)


@pytest.mark.django_db
def test_create_persists_instance_as_running(orch):
    inst = orch.create('demo')
    inst.refresh_from_db()
    assert inst.status == Instance.STATUS_RUNNING
    assert inst.container_id  # run 返回了 id
    assert inst.home_dir.endswith('instances/demo/home')


@pytest.mark.django_db
def test_create_rolls_back_on_runtime_failure(config, health, tmp_path):
    # spec §5.5：创建失败回滚目录（不留半成品 home / 不留 Instance 行）
    _seed_template(tmp_path / 'template')

    class _RunFails(FakeRuntime):
        def run(self, spec):
            raise RuntimeError('daemon down')

    orch = InstanceOrchestrator(runtime=_RunFails(), config=config, health_probe=health)
    with pytest.raises(RuntimeError):
        orch.create('demo')
    assert not (config.root / 'instances' / 'demo').exists()
    assert not Instance.objects.filter(name='demo').exists()


@pytest.mark.django_db
def test_create_rejects_duplicate_name(orch):
    # spec §10 name 唯一；DB 唯一约束 → _reserve_row 转译 InstanceExists（view 409）
    orch.create('demo')
    with pytest.raises(InstanceExists):
        orch.create('demo')


# ---------------------------- delete（§5.4 连数据删）----------------------------


@pytest.mark.django_db
def test_delete_stops_removes_container_and_wipes_dir(orch, runtime, config):
    # spec §5.4：stop→remove(v=True) + rmtree(instances/<name>)，默认连数据删
    orch.create('demo')
    ok = orch.delete('demo')
    assert ok is True
    assert 'demo' in runtime.stopped
    assert 'demo' in runtime.removed
    assert not (config.root / 'instances' / 'demo').exists()
    assert not Instance.objects.filter(name='demo').exists()


@pytest.mark.django_db
def test_delete_missing_instance_returns_false(orch):
    assert orch.delete('nope') is False


@pytest.mark.django_db
def test_delete_tolerates_missing_container(orch, runtime, config):
    # 容器已不在 daemon（崩溃/手动删），orchestrator 仍清 DB + 目录（spec §5.5 对账语义）
    orch.create('demo')
    runtime.containers.pop('demo')
    orch.delete('demo')  # 不抛
    assert not Instance.objects.filter(name='demo').exists()
    assert not (config.root / 'instances' / 'demo').exists()


# ---------------------------- list（status + health 聚合）----------------------------


@pytest.mark.django_db
def test_list_healthy_when_running_and_reachable(orch, health):
    inst = orch.create('demo')
    health.set_reachable(inst.port, True)
    items = orch.list()
    assert len(items) == 1
    item = items[0]
    assert item['name'] == 'demo'
    assert item['status'] == 'running'
    assert item['health'] == 'healthy'
    assert item['port'] == inst.port


@pytest.mark.django_db
def test_list_unhealthy_when_running_but_gateway_unreachable(orch):
    # spec §5.4：running 但外部 /health 探不到 → unhealthy（issue #39 验收：health 探测）
    orch.create('demo')
    item = orch.list()[0]
    assert item['status'] == 'running'
    assert item['health'] == 'unhealthy'


@pytest.mark.django_db
def test_list_stopped_when_container_not_running(orch, runtime):
    orch.create('demo')
    runtime.stop('demo')
    item = orch.list()[0]
    assert item['status'] == 'stopped'
    assert item['health'] == 'stopped'


@pytest.mark.django_db
def test_list_reflects_runtime_absence_as_stopped(orch, runtime):
    # DB 有 Instance 但容器已消失（daemon 重启等）→ stopped（spec §5.5 对账）
    orch.create('demo')
    runtime.containers.pop('demo')
    item = orch.list()[0]
    assert item['status'] == 'stopped'


# ---------------------------- codex R1 并发/失败硬化 ----------------------------


class _ConcurrencyProbe:
    """记录 is_reachable 最大并发数，验证 list 健康探测是否并发（:156）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cur = 0
        self.max_concurrent = 0

    def is_reachable(self, port: int) -> bool:
        with self._lock:
            self._cur += 1
            self.max_concurrent = max(self.max_concurrent, self._cur)
        time.sleep(0.05)
        with self._lock:
            self._cur -= 1
        return False


# --- create：:112 run 失败清残留容器 / :84 name→InstanceExists / :77 port 冲突重试 ---


@pytest.mark.django_db
def test_create_removes_partial_container_when_run_fails(config, health, tmp_path):
    # codex P1 :112：docker create 成功但 start 失败（端口占用等）→ 残留命名容器，
    # 重试同名 docker 冲突。except 分支须 best-effort remove 残留容器。
    _seed_template(tmp_path / 'template')
    runtime = FakeRuntime()
    runtime.fail_after_create = RuntimeError('random daemon error')  # 非 bind 措辞——验证 run 后回滚清残留
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    with pytest.raises(RuntimeError):
        orch.create('demo')
    assert 'demo' in runtime.removed          # 残留命名容器已清
    assert 'demo' not in runtime.containers
    assert not Instance.objects.filter(name='demo').exists()
    assert not (config.root / 'instances' / 'demo').exists()


@pytest.mark.django_db
def test_create_translates_duplicate_name_to_instance_exists(orch):
    # codex P2 :84：并发绕 UniqueValidator 时 DB 唯一约束 IntegrityError → 须转译为
    # 领域异常 InstanceExists（view 层 409），非裸 IntegrityError（500）。
    orch.create('demo')
    with pytest.raises(InstanceExists):
        orch.create('demo')


@pytest.mark.django_db
def test_create_retries_port_allocation_on_unique_conflict(orch, monkeypatch):
    # codex P2 :77：并发两 create 读同快照选同 port → port unique 约束冲突。
    # 须在保存点内重试下一个空闲 port，而非整体失败。
    real_create = Instance.objects.create
    state = {'calls': 0}

    def flaky_create(**kwargs):
        state['calls'] += 1
        if state['calls'] == 1:
            raise IntegrityError('UNIQUE constraint failed: containers_instance.port')
        return real_create(**kwargs)

    monkeypatch.setattr(Instance.objects, 'create', flaky_create)
    inst = orch.create('demo')
    assert state['calls'] >= 2                # 至少重试一次
    assert inst.port == 19000                 # 最终成功占用
    assert inst.status == Instance.STATUS_RUNNING


@pytest.mark.django_db
def test_create_retries_on_docker_bind_conflict(config, health, runtime, tmp_path):
    """#295 codex P2：docker run 因宿主 bind 冲突失败时，重试下一空闲端口而非整段回滚。

    宿主非 Docker 进程（无 PortBindings 可枚举）+ 后端容器化（socket.bind 命名空间盲区）
    → 探测全看不到占用，allocator 仍选 19000；docker run 发布冲突（bind: address
    already in use）。create 须识别该冲突、释放端口重试 19001，而不是 create 失败。
    """
    _seed_template(tmp_path / 'template')
    runtime.fail_bind_ports = {19000}         # 19000 被宿主非容器进程占用
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    inst = orch.create('demo')
    assert inst.port == 19001                 # bind 冲突后重试到 19001
    assert inst.status == Instance.STATUS_RUNNING
    assert runtime.run_specs[0].host_port == 19000  # 第一次尝试 19000
    assert runtime.run_specs[1].host_port == 19001  # 冲突后重试 19001
    assert not Instance.objects.filter(name='demo', port=19000).exists()  # 冲突行已删
    assert Instance.objects.filter(name='demo', port=19001).exists()


@pytest.mark.django_db
def test_create_retries_on_port_already_allocated_wording(config, health, runtime, tmp_path):
    """#295 codex P2（新轮 #3695357689）：daemon 报 'port is already allocated' 也是 bind 冲突。

    真实 docker daemon 依来源以 "Bind for 0.0.0.0:19000 failed: port is already
    allocated"（libnetwork portallocator，含 "is"）或 "bind: address already in use"
    （docker-proxy OS 层）报告宿主端口发布冲突。_is_bind_conflict 归一化匹配两种措辞
    （"already allocated" 子串覆盖 "is already allocated" 与简写），任一种都触发学习冲突
    端口重试下一空闲端口，而非整段回滚、create 失败。
    """
    _seed_template(tmp_path / 'template')
    runtime.fail_bind_ports = {19000}
    runtime.fail_bind_message = 'Bind for 0.0.0.0:{port} failed: port is already allocated'
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    inst = orch.create('demo')
    assert inst.port == 19001                 # 冲突措辞被识别 → 重试到 19001
    assert inst.status == Instance.STATUS_RUNNING
    assert runtime.run_specs[0].host_port == 19000  # 第一次尝试 19000
    assert runtime.run_specs[1].host_port == 19001  # 冲突后重试 19001
    assert Instance.objects.filter(name='demo', port=19001).exists()


@pytest.mark.django_db
def test_create_retries_past_eight_bind_conflicts(config, health, runtime, tmp_path):
    """#295 codex P2（第 5 轮）：>8 个宿主监听占最低端口时，重试直至池内空闲端口。

    MAX_PORT_RETRIES=8 是 DB 并发冲突预算；bind 冲突重试须以池候选数为预算。
    宿主 9 个非容器监听占 19000-19008，create 须落到 19009（而非在 8 次后
    PortAllocationError，即使 19009+ 仍空闲）。
    """
    _seed_template(tmp_path / 'template')
    runtime.fail_bind_ports = set(range(19000, 19009))  # 9 个最低端口被宿主监听占用
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    inst = orch.create('demo')
    assert inst.port == 19009                 # 越过 9 个冲突端口落到第 10 个
    assert inst.status == Instance.STATUS_RUNNING
    assert len(runtime.run_specs) == 10       # 9 次冲突 + 1 次成功
    assert runtime.run_specs[-1].host_port == 19009


@pytest.mark.django_db
def test_create_bind_conflict_preserves_row_when_dir_cleanup_fails(config, health, runtime, tmp_path):
    """#295/#297 融合：bind 冲突后**不删目录**——行/目录保留，重试复用 provision。

    #295 原设计是 bind 冲突后删目录重建（行已删、对客户端不可见）；#297 异步化后行对客户端
    可见（POST 已返 202），bind 冲突**就地更新行端口**重试，目录/配置一并保留供复用（不清、
    不重 provision，避免 copytree 撞已存在目录）。故注入失败 dir_remover 时 bind 冲突路径
    不再触发目录清理——重试成功、目录保留、行 running。
    """
    _seed_template(tmp_path / 'template')
    runtime.fail_bind_ports = {19000}   # 19000 冲突 → 就地重试到 19001

    class _FailingRemover:
        def __call__(self, path):
            raise OSError(f'permission denied: {path}')

    orch = InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health, dir_remover=_FailingRemover(),
    )
    inst = orch.create('demo')
    assert inst.port == 19001                 # bind 冲突就地重试成功
    assert inst.status == Instance.STATUS_RUNNING
    # 目录保留（重试复用 provision），dir_remover 从未被调
    assert (config.root / 'instances' / 'demo').exists()
    assert runtime.run_specs[0].host_port == 19000
    assert runtime.run_specs[1].host_port == 19001


@pytest.mark.django_db
def test_create_bind_conflict_preserves_row_when_container_remove_fails(config, health, runtime, tmp_path):
    """#295 codex P2（新轮 #3695394860）：bind 冲突后容器清理失败 → 保留 ERROR 行 + raise。

    容器已创建后才报 bind 冲突（真实 docker create+start：端口冲突在 start 阶段暴露），
    remove 失败（daemon 瞬态错误）时若吞掉并删行：残留容器撞下一轮 name 冲突，且行已删
    则 delete 无所有权记录无法清理孤儿，实例名被永久阻塞。须对齐目录清理失败分支——
    保留 ERROR 行（含 container_id 供 delete 证明所有权）+ raise InstanceCleanupError。
    """
    _seed_template(tmp_path / 'template')
    runtime.fail_bind_after_create = {19000}   # 容器入 daemon 后报 bind 冲突
    runtime.fail_remove = RuntimeError('daemon transient error')  # 清理残留容器失败
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    with pytest.raises(InstanceCleanupError):
        orch.create('demo')
    # 行保留且标 ERROR，container_id 记录残留容器（delete 凭所有权清理）
    row = Instance.objects.get(name='demo')
    assert row.status == Instance.STATUS_ERROR
    assert row.container_id                        # 残留容器 id 已保存供 delete 清理
    assert 'demo' in runtime.containers            # 残留容器仍在 daemon（remove 失败未清）
    assert not runtime.removed                     # 未触发任何 remove
    # 行未被删 → delete 端点可凭 container_id 清理孤儿


# --- delete：:126 rmtree 失败保留 DB 行 + 标 REMOVING（不吞错、可重试）---


@pytest.mark.django_db
def test_delete_preserves_row_when_dir_cleanup_fails(config, health, runtime, tmp_path):
    # codex P1 :126：root 容器改 home 属主 → rmtree 失败不应被 ignore_errors 吞。
    # 须保留 DB 行（可重试）+ 标 REMOVING + raise InstanceCleanupError。
    _seed_template(tmp_path / 'template')

    def fail_rmtree(path, **kwargs):
        raise OSError('permission denied')

    orch = InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health, dir_remover=fail_rmtree,
    )
    orch.create('demo')
    with pytest.raises(InstanceCleanupError):
        orch.delete('demo')
    assert 'demo' in runtime.removed                 # 容器已 stop+remove
    inst = Instance.objects.get(name='demo')         # DB 行保留（可重试）
    assert inst.status == Instance.STATUS_REMOVING
    assert (config.root / 'instances' / 'demo').exists()   # 目录未清


# --- list：:133 creating 瞬态透传 / :156 健康探测并发 ---


@pytest.mark.django_db
def test_list_shows_creating_while_provisioning(orch):
    # codex P2 :133：creating 中（容器未起）不应被 runtime.get 缺失误判 stopped。
    # codex R3 :319：须持有 create 锁（模拟 create 正在 provisioning），否则被视为中断行收敛。
    Instance.objects.create(
        name='booting', port=19005, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    # #255：模拟 create 仍在飞 = 持有 ProvisionResource 锁（reconcile 锁探测据此跳过对账）。
    _lease = orch._deps.lock.acquire(ProvisionResource('booting'), LEASE_TTL)  # pylint: disable=protected-access
    try:
        item = orch.list()[0]
        assert item['status'] == 'creating'
        assert item['health'] == 'pending'         # 未起，不探
    finally:
        _lease.release()


@pytest.mark.django_db
def test_list_probes_health_concurrently(orch):
    # codex P2 :156：N running 容器健康探测须并发，非 N×timeout 串行
    probe = _ConcurrencyProbe()
    orch._deps.health = probe
    for i in range(5):
        orch.create(f'c{i}')
    orch.list()
    assert probe.max_concurrent > 1            # 并发执行（串行则恒为 1）


# ---------------------------- codex R2 并发/失败硬化 ----------------------------


# --- create：:176 回滚时 remove 也失败仍续滚 / :161 跳过宿主已占用端口 ---


@pytest.mark.django_db
def test_create_rollback_continues_when_remove_also_fails(config, health, tmp_path):
    # codex P2 :176：run 因 daemon 不可用失败时，best-effort remove 撞同一 daemon 错误。
    # remove 失败须单独兜底，不阻断 DB 行 + 目录回滚（否则残留 creating 行挡同名重建）。
    _seed_template(tmp_path / 'template')

    class _RunAndRemoveFail(FakeRuntime):
        def run(self, spec):
            raise RuntimeError('daemon down')

        def remove(self, name):
            raise RuntimeError('daemon down')

    orch = InstanceOrchestrator(runtime=_RunAndRemoveFail(), config=config, health_probe=health)
    with pytest.raises(RuntimeError):
        orch.create('demo')
    assert not Instance.objects.filter(name='demo').exists()   # DB 行已回滚
    assert not (config.root / 'instances' / 'demo').exists()   # 目录已回滚


@pytest.mark.django_db
def test_create_skips_host_occupied_port(config, health, tmp_path):
    # codex P2 :161：最低候选 19000 被无关进程/未跟踪容器占用（不在 Instance.port 记账）。
    # 端口分配须并入宿主实测占用，跳过 19000 取 19001，而非每次确定性失败。
    _seed_template(tmp_path / 'template')
    runtime = FakeRuntime()
    orch = InstanceOrchestrator(
        runtime=runtime,
        config=config,
        health_probe=health,
        port_in_use=lambda port: port == 19000,   # 模拟 19000 宿主被占
    )
    inst = orch.create('demo')
    assert inst.port == 19001
    assert runtime.run_specs[0].host_port == 19001


@pytest.mark.django_db
def test_used_ports_includes_fleet_label_port(config, health, tmp_path):
    # codex P2 :161：daemon 里未跟踪的 fleet 容器（label openclaw.port=19000）也并入已用集。
    _seed_template(tmp_path / 'template')
    runtime = FakeRuntime()
    runtime.containers['ghost'] = ContainerInfo(
        container_id='ghostid',
        name=container_name('ghost'),
        running=True,
        status='running',
        image='img:tag',
        port=19000,
    )
    # 宿主探测全空闲——只靠 label 端口排除 19000
    orch = InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health, port_in_use=lambda p: False,
    )
    inst = orch.create('demo')
    assert inst.port == 19001


@pytest.mark.django_db
def test_used_ports_includes_untracked_host_published_ports(config, health, runtime, tmp_path):
    """#295 codex P2：宿主上未跟踪容器（无 label）占用的池端口也被 allocator 跳过。

    后端容器化（bridge 网络）时容器内 socket.bind 探不到宿主端口（命名空间盲区），
    且 list_fleet 按 label 过滤看不到未跟踪容器。host_published_ports 经 daemon 无过滤
    枚举补上这一来源——FakeRuntime 模拟 daemon 返回 port=19002 的未跟踪容器。
    """
    _seed_template(tmp_path / 'template')
    runtime.containers['external'] = ContainerInfo(
        container_id='extid',
        name='external',
        running=True,
        status='running',
        image='other:tag',
        port=19002,  # 无 openclaw label 的未跟踪容器（模拟外部容器占宿主端口）
    )
    orch = InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health, port_in_use=lambda p: False,
    )
    inst = orch.create('demo')
    assert inst.port == 19000  # 19002 已被 host_published_ports 标记占用 → 跳过


# --- delete：:204 目录已不存在视为清理成功 ---


@pytest.mark.django_db
def test_delete_treats_missing_dir_as_deleted(config, health, runtime, tmp_path):
    # codex P2 :204：实例目录已不存在（外部清理/崩溃）→ rmtree 抛 FileNotFoundError。
    # 须视为清理成功（删行返回 True），不再误判失败卡 REMOVING。
    _seed_template(tmp_path / 'template')
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    orch.create('demo')
    # 外部清掉目录（模拟崩溃/手动清理），容器仍在 daemon
    import shutil

    shutil.rmtree(config.root / 'instances' / 'demo')
    ok = orch.delete('demo')
    assert ok is True
    assert not Instance.objects.filter(name='demo').exists()


@pytest.mark.django_db
def test_delete_uses_recorded_home_dir_not_current_root(config, health, runtime, tmp_path):
    # codex P2 :296：OPENCLAW_FLEET_ROOT 在创建后变更时，删除路径须由 DB 记录的 home_dir
    # 派生（创建时固化的绝对路径），而非用当前 cfg.root 重构——否则新 root 下无该目录，
    # FileNotFoundError 被误判为清理成功，删行返回 204 而旧 root 下真实数据残留。
    _seed_template(tmp_path / 'template')
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    orch.create('demo')
    original_dir = config.root / 'instances' / 'demo'
    assert original_dir.exists()
    # 模拟 root 变更：orchestrator 切到另一个空 root（原目录仍在旧 root 下）
    import dataclasses

    new_root = tmp_path / 'fleet-moved'
    (new_root / 'instances').mkdir(parents=True)
    orch._deps.config = dataclasses.replace(config, root=new_root)
    ok = orch.delete('demo')
    assert ok is True
    # 旧 root 下的真实数据目录须被删除（由记录的 home_dir 派生，非新 root）
    assert not original_dir.exists()
    assert not Instance.objects.filter(name='demo').exists()


# --- list：:226 creating 行 runtime 对账自愈 ---


@pytest.mark.django_db
def test_list_reconciles_creating_row_when_container_running(orch, runtime):
    # codex P2 :226：进程在最终 save 前崩溃（Docker 已起容器）留下 creating 行。
    # list 须对账 runtime：容器实际 running 则就地自愈为 running，不再永久 pending。
    from datetime import timedelta

    from django.utils import timezone

    inst = Instance.objects.create(
        name='crashed', port=19007, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    inst.created_at = timezone.now() - timedelta(seconds=120)
    inst.save(update_fields=['created_at'])
    # daemon 里容器实际已在跑（上次崩溃前 Docker 已 start）
    runtime.containers['crashed'] = ContainerInfo(
        container_id='realid',
        name=container_name('crashed'),
        running=True,
        status='running',
        image='img:tag',
        instance_name='crashed',  # R9-2：新增字段 (label 匹配)
    )
    item = orch.list()[0]
    assert item['status'] == 'running'
    # 行已自愈落盘（后续 list 不再重复对账）
    inst = Instance.objects.get(name='crashed')
    assert inst.status == Instance.STATUS_RUNNING
    assert inst.container_id == 'realid'


@pytest.mark.django_db
def test_list_keeps_creating_when_container_not_yet_running(orch):
    # codex P2 :226 对照：容器尚未起且 create 仍在飞（正常 provisioning 中）→ 仍 creating/pending。
    Instance.objects.create(
        name='booting', port=19008, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    # #255：模拟在飞 = 持有 ProvisionResource 锁（reconcile 锁探测据此跳过），区别于崩溃中断（:319）。
    lease = orch._deps.lock.acquire(ProvisionResource('booting'), LEASE_TTL)  # pylint: disable=protected-access
    try:
        item = orch.list()[0]
        assert item['status'] == 'creating'
        assert item['health'] == 'pending'
    finally:
        lease.release()


# ---------------------------- codex R3 并发/失败硬化 ----------------------------


# --- create：:232 仅本次 run 过才在回滚 remove ---


@pytest.mark.django_db
def test_create_rollback_skips_remove_when_run_not_attempted(config, health, tmp_path):
    # codex P1 :232：mkdir/provision/render 阶段失败时，同名容器可能是历史遗留（DB 无行），
    # 不应误删非本次创建的在网 gateway。run_attempted=False → 回滚不 remove。
    _seed_template(tmp_path / 'template')

    class _RenderFail(FakeRuntime):
        pass  # run 正常；让失败发生在 run 之前（config 渲染）

    runtime = _RenderFail()
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    # 让 config_path.write_text 之前的 provision 失败：把 template_dir 指向不存在路径
    orch._deps.provisioner = HomeProvisioner(tmp_path / 'no-such-template')
    with pytest.raises(FileNotFoundError):
        orch.create('demo')
    assert runtime.run_specs == []                 # pylint: disable=use-implicit-booleaness-not-comparison
    assert runtime.removed == []                   # pylint: disable=use-implicit-booleaness-not-comparison


@pytest.mark.django_db
def test_create_rollback_removes_when_run_attempted_and_start_fails(config, health, tmp_path):
    # codex P1 :232 对照 + R1 :112：本次确实 run 过（docker create 成功 start 失败）
    # → 残留命名容器须 best-effort remove（否则重试同名 docker 冲突）。
    _seed_template(tmp_path / 'template')
    runtime = FakeRuntime()
    runtime.fail_after_create = RuntimeError('random daemon error')  # 非 bind 措辞——验证 run 后回滚清残留
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    with pytest.raises(RuntimeError):
        orch.create('demo')
    assert 'demo' in runtime.removed               # run 过 → 残留容器已清
    assert not Instance.objects.filter(name='demo').exists()


# ---------------------------- codex R4 并发/失败硬化 ----------------------------


# --- create：:238 仅 run_attempted ∧ ¬preexisting 才在回滚 remove ---


@pytest.mark.django_db
def test_create_rollback_preserves_preexisting_container(config, health, tmp_path):
    # codex P1 :238：run 因同名容器已存在（DB 恢复/历史孤儿，无 DB 行）而失败时，
    # 该容器非本次创建——回滚不得 remove（否则误删在网 gateway）。
    _seed_template(tmp_path / 'template')
    runtime = FakeRuntime()
    # 历史孤儿：daemon 已有 openclaw-gw-demo，但 DB 无对应行
    runtime.containers['demo'] = ContainerInfo(
        container_id='orphan-id', name=container_name('demo'),
        running=True, status='running', image='img:tag',
    )

    class _RunConflict(FakeRuntime):
        def run(self, spec):
            raise RuntimeError('name conflict: container already exists')

    runtime.run = _RunConflict.run.__get__(runtime)   # pylint: disable=no-value-for-parameter
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    with pytest.raises(RuntimeError):
        orch.create('demo')
    assert 'demo' not in runtime.removed             # 未误删历史孤儿容器
    assert 'demo' in runtime.containers              # 孤儿仍在（非本次创建）
    assert not Instance.objects.filter(name='demo').exists()   # 本次行已回滚


@pytest.mark.django_db
def test_create_rollback_preserves_row_when_dir_cleanup_fails(config, health, runtime, tmp_path):
    # codex P2 :265：run 失败后回滚，若目录清理也失败（root 容器改属主/权限），
    # 不得先删行（否则目录残留挡 retry mkdir 且无 API 记录可清理）——保留行标 ERROR 可重试。
    # 抛 InstanceCleanupError（与 delete :126 对称，view 409 + 行保留），非裸 OSError（500）。
    _seed_template(tmp_path / 'template')

    class _RunFails(FakeRuntime):
        def run(self, spec):
            raise RuntimeError('start failed')

    def fail_rmtree(path, **kwargs):
        raise OSError('permission denied')

    orch = InstanceOrchestrator(
        runtime=_RunFails(), config=config, health_probe=health, dir_remover=fail_rmtree,
    )
    with pytest.raises(InstanceCleanupError):
        orch.create('demo')
    inst = Instance.objects.get(name='demo')         # 行保留（可经 delete 重试清理）
    assert inst.status == Instance.STATUS_ERROR
    assert inst.container_id == ''
    assert (config.root / 'instances' / 'demo').exists()   # 目录残留未清


@pytest.mark.django_db
def test_create_persists_owned_container_id_when_all_cleanup_fails(config, health, tmp_path):
    # run 已创建容器，但 remove 与目录回滚均失败：ERROR 行须持久化 id，后续 delete 才能安全清它。
    _seed_template(tmp_path / 'template')
    runtime = FakeRuntime()
    runtime.fail_after_create = RuntimeError('start failed')

    def fail_remove(name):
        raise RuntimeError('daemon unavailable')

    def fail_rmtree(path, **kwargs):
        raise OSError('permission denied')

    runtime.remove = fail_remove
    orch = InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health, dir_remover=fail_rmtree,
    )

    with pytest.raises(InstanceCleanupError):
        orch.create('demo')

    inst = Instance.objects.get(name='demo')
    assert inst.status == Instance.STATUS_ERROR
    assert inst.container_id.startswith('fakeid-demo-')


@pytest.mark.django_db
def test_create_keeps_lock_until_final_save(orch, monkeypatch):
    # codex P2 :269 精神（#255 改锁）：DELETE 在 run() 返回后、最终 save() 前的窗口不得竞删——
    # create 锁须保留到 save 之后（后台 create_complete 持锁，delete 经锁探测拒删）。验证：
    # 最终 save（status=running）执行期间 'demo' 的 ProvisionResource 锁仍被持有；create 返回后
    # 已释放（锁可被重获）。（_reserve_row 的 INSERT 先于取锁，本就不在锁内，非本测试关注点。）
    real_save = Instance.save
    lock_held_at_save = []
    lock = orch._deps.lock  # pylint: disable=protected-access

    def spy_save(instance, *args, **kwargs):
        if instance.name == 'demo':
            # #255：锁探测——try_acquire 失败 = 锁仍被 create 持有（在飞）
            lock_held_at_save.append(
                lock.try_acquire(ProvisionResource('demo'), LEASE_TTL) is None,
            )
        return real_save(instance, *args, **kwargs)

    monkeypatch.setattr(Instance, 'save', spy_save)
    orch.create('demo')
    # 最终 save（reserve 的 INSERT 之后、取锁之后）执行时必须仍持有锁 → delete 会被拒删
    assert lock_held_at_save, 'create 应至少触发一次 save'
    assert lock_held_at_save[-1] is True, '最终 save 期间 create 锁须仍持有（:269 精神）'
    # create 完整返回后锁已释放，后续 delete 可正常进行
    assert lock.try_acquire(ProvisionResource('demo'), LEASE_TTL) is not None


# --- delete：:257 在飞 create 拒删 ---


@pytest.mark.django_db
def test_delete_rejects_while_create_in_flight(orch):
    # codex P1 :257：目标仍在 provisioning（create 在飞）→ InstanceBusy（view 409），
    # 防 delete 与在飞 create 竞态（create 收尾 save(running) 会 resurrect 已删行）。
    Instance.objects.create(
        name='booting', port=19010, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    # #255：模拟 create 在飞 = 持有 ProvisionResource 锁（delete 锁探测据此拒删）。
    _lease = orch._deps.lock.acquire(ProvisionResource('booting'), LEASE_TTL)  # pylint: disable=protected-access
    try:
        with pytest.raises(InstanceBusy):
            orch.delete('booting')
        assert Instance.objects.filter(name='booting').exists()  # 行未被删
    finally:
        _lease.release()


@pytest.mark.django_db
def test_delete_allows_interrupted_creating_row(orch, runtime, config):
    # codex R6 :304 修正：CREATING 行受 DB 级守卫保护，跨进程安全。须先经 list()
    # 的 _reconcile_creating 收敛（runtime 无容器 → error），再 delete 清理名字/端口占用。
    from datetime import timedelta

    from django.utils import timezone

    inst = Instance.objects.create(
        name='stuck', port=19011, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    inst.created_at = timezone.now() - timedelta(seconds=120)
    inst.save(update_fields=['created_at'])
    # CREATING 行直接 delete → 拒删
    with pytest.raises(InstanceBusy):
        orch.delete('stuck')
    # list() 经 _reconcile_creating 收敛（无 runtime 容器 → error）
    orch.list()
    assert Instance.objects.get(name='stuck').status == Instance.STATUS_ERROR
    # 收敛后 delete 可清理
    ok = orch.delete('stuck')
    assert ok is True
    assert not Instance.objects.filter(name='stuck').exists()


@pytest.mark.django_db
def test_delete_survives_lock_probe_failure(orch, monkeypatch):
    """#255 审查修正：Redis 临时不可用（锁探测抛错）时 delete 按「无在飞 create」放行。

    DB CREATING 守卫是第一道跨进程保护；锁探测仅是窄窗口额外保险。探测失败不得让
    DELETE 500（对齐 R8 F3 读路径逐行降级哲学）——非 CREATING 行应照常删除。
    """
    Instance.objects.create(
        name='normal', port=19022, token='t', home_dir='/h',
        status=Instance.STATUS_RUNNING, image='img:tag',
    )

    class _LockProbeFails:
        def try_acquire(self, *args, **kwargs):
            raise RuntimeError('redis down')

        def acquire(self, *args, **kwargs):
            raise RuntimeError('redis down')

    monkeypatch.setattr(orch._deps, 'lock', _LockProbeFails())  # pylint: disable=protected-access

    ok = orch.delete('normal')
    assert ok is True
    assert not Instance.objects.filter(name='normal').exists()


# --- list：:319 中断 creating 行按 runtime 实况收敛 ---


@pytest.mark.django_db
def test_reconcile_creating_to_stopped_when_container_exited(orch, runtime):
    # codex P2 :319：中断行容器存在但未 running（created/exited）→ 收敛 stopped（非永久 pending）。
    from datetime import timedelta

    from django.utils import timezone

    inst = Instance.objects.create(
        name='half', port=19012, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    inst.created_at = timezone.now() - timedelta(seconds=120)
    inst.save(update_fields=['created_at'])
    runtime.containers['half'] = ContainerInfo(
        container_id='halfid', name=container_name('half'),
        running=False, status='exited', image='img:tag',
        instance_name='half',  # R9-2: label 匹配 (reconcile label guard)
    )
    item = orch.list()[0]
    assert item['status'] == 'stopped'
    assert Instance.objects.get(name='half').status == Instance.STATUS_STOPPED


@pytest.mark.django_db
def test_reconcile_creating_to_error_when_no_container(orch):
    # codex P2 :319：中断行无容器（崩溃在 run 之前）→ 收敛 error（provisioning 未完成）。
    from datetime import timedelta

    from django.utils import timezone

    inst = Instance.objects.create(
        name='ghost', port=19013, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    inst.created_at = timezone.now() - timedelta(seconds=120)
    inst.save(update_fields=['created_at'])
    item = orch.list()[0]
    assert item['status'] == 'error'
    assert Instance.objects.get(name='ghost').status == Instance.STATUS_ERROR


@pytest.mark.django_db
def test_create_marks_lock_before_reserving_row(orch, monkeypatch):
    # codex R5 :238 精神（#255 改锁）：DB 行一旦可见，name 的 create 锁必须已持有
    # （跨进程在飞语义由锁承载）——并发同名 create_reserve 在锁上被互斥挡下。
    real_reserve = orch._cmd._reserve_row
    locked_at_reserve = []

    def spy_reserve(name, extra_used=None):
        locked_at_reserve.append(
            orch._deps.lock.try_acquire(ProvisionResource(name), LEASE_TTL) is None,  # pylint: disable=protected-access
        )
        return real_reserve(name, extra_used)

    monkeypatch.setattr(orch._cmd, '_reserve_row', spy_reserve)
    orch.create('demo')
    assert locked_at_reserve == [True]
    # create 返回后锁已释放（可被重获）
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is not None


@pytest.mark.django_db
def test_create_preserves_directory_it_did_not_create(config, health, runtime, tmp_path):
    # codex R5 :280：mkdir 因既有目录失败时，本次请求不拥有该目录，回滚不得删除。
    instance_dir = config.root / 'instances' / 'demo'
    instance_dir.mkdir(parents=True)
    marker = instance_dir / 'keep.txt'
    marker.write_text('existing data')
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)

    with pytest.raises(FileExistsError):
        orch.create('demo')

    assert marker.read_text() == 'existing data'
    assert not Instance.objects.filter(name='demo').exists()


@pytest.mark.django_db
def test_create_rolls_back_row_when_runtime_preflight_fails(config, health, tmp_path):
    # codex R5 :236：Docker preflight 异常也必须进入统一回滚，不能遗留 creating 行。
    _seed_template(tmp_path / 'template')

    class _PreflightFails(FakeRuntime):
        def get(self, name):
            raise RuntimeError('daemon unavailable')

    orch = InstanceOrchestrator(
        runtime=_PreflightFails(), config=config, health_probe=health)
    with pytest.raises(RuntimeError):
        orch.create('demo')

    assert not Instance.objects.filter(name='demo').exists()
    # #255：create 失败后锁已释放（可被重获），不残留占位
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is not None


@pytest.mark.django_db
def test_delete_cleanup_only_error_row_preserves_unowned_container(orch, runtime, config):
    # codex R5 :319：无 container_id 的 ERROR 行没有正向容器所有权证据，delete 仅清理目录/行。
    instance_dir = config.root / 'instances' / 'demo'
    instance_dir.mkdir(parents=True)
    Instance.objects.create(
        name='demo', port=19014, token='t', home_dir=str(instance_dir / 'home'),
        container_id='', status=Instance.STATUS_ERROR, image='img:tag',
    )
    runtime.containers['demo'] = ContainerInfo(
        container_id='preexisting', name=container_name('demo'),
        running=True, status='running', image='img:tag',
    )

    assert orch.delete('demo') is True
    assert 'demo' in runtime.containers
    assert runtime.stopped == []
    assert runtime.removed == []


# ───────────────────────────── codex R6 review 反证 + TDD ─────────────────────────────


# ◀ C (3644348308) P1 :311 —— 删除前验证存活容器 ID 是否匹配 ◀

@pytest.mark.django_db
def test_delete_preserves_unowned_container_when_container_id_mismatch(orch, runtime, config):
    """codex P1 :311：DB 行有非空 container_id 但存活容器 ID 不同 → 不得 stop/remove。

    精确失败场景：
    1. create('demo') → DB: container_id='abc123', Docker: openclaw-gw-demo id=abc123
    2. 外部 docker rm -f openclaw-gw-demo
    3. 外部 docker run --name openclaw-gw-demo ... → 新 ID='def456'
    4. orch.delete('demo') → inst.container_id='abc123' 非空 → 守卫通过 → stop/remove 按名删除新容器
    """
    instance_dir = config.root / 'instances' / 'demo'
    instance_dir.mkdir(parents=True)
    Instance.objects.create(
        name='demo', port=19020, token='t', home_dir=str(instance_dir / 'home'),
        container_id='stale-id', status=Instance.STATUS_ERROR, image='img:tag',
    )
    # 存活容器 ID 与 DB 记录不同（外部重建）
    runtime.containers['demo'] = ContainerInfo(
        container_id='live-id-different',
        name=container_name('demo'),
        running=True, status='running', image='img:tag',
    )

    assert orch.delete('demo') is True

    # 存活容器（非本 orch 拥有）不被删除
    assert 'demo' in runtime.containers
    assert runtime.stopped == []
    assert runtime.removed == []


# ◀ A (3644348317) P2 :475 —— list/delete 不应因模板 JSON 损坏而不可用 ◀

@pytest.mark.django_db
def test_list_and_delete_work_when_template_json_is_invalid(config, health, runtime, tmp_path):
    """codex R6 :475 / R7 :509：模板 JSON 不存在/格式错误时 list/delete 仍正常。

    模板文件仅供 create() 使用；Fleet._build_default 不再急切 IO，ConfigRenderer 惰性构造。
    """
    _seed_template(tmp_path / 'template')
    config = FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=tmp_path / 'template',
        template_json=str(tmp_path / 'no-such-template.json'),  # 文件缺失，但 list/delete 不应关心
        image='img:tag',
        port_start=19000,
        port_end=19999,
        llm_api_key='sk-fallback',
    )
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)

    # list 不应因模板文件缺失而失败
    items = orch.list()
    assert items == []  # pylint: disable=use-implicit-booleaness-not-comparison

    # delete 亦然（实例不存在 → False）
    assert orch.delete('nobody') is False

    # create 在文件缺失时失败（惰性构造触发 IO）
    with pytest.raises(FileNotFoundError):
        orch.create('demo')


# ◀ B (3644348313) P2 :484 —— create 应拒绝空 LLM_API_KEY ◀

@pytest.mark.django_db
def test_create_rejects_empty_llm_api_key(config, health, runtime, tmp_path):
    """codex P2 :484：空 LLM_API_KEY 静默通过 → 外表 healthy 但永远无法调 LLM 的容器。

    应在 _reserve_row() 之前抛出，避免 DB 行/端口/目录残留。
    """
    _seed_template(tmp_path / 'template')
    tpl_file = tmp_path / 'tpl.json'
    tpl_file.write_text('{}')
    config = FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=tmp_path / 'template',
        template_json=str(tpl_file),
        image='img:tag',
        port_start=19000,
        port_end=19999,
        llm_api_key='',   # 未配置
    )
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    with pytest.raises(ConfigurationError, match='LLM_API_KEY'):
        orch.create('demo')
    assert not Instance.objects.filter(name='demo').exists()


# ◀ D (3644348301) P2 :304 —— delete 应基于 DB status 而非仅进程内 set 拒绝在飞 create ◀

@pytest.mark.django_db
def test_delete_rejects_creating_based_on_db_status(orch):
    """codex P1 :304 精神（#255 改锁）：多 worker 下另一 worker 的 create 对 delete 不可见时，
    须基于 DB CREATING 状态拒删——跨进程安全（第一道守卫）。不依赖进程内锁状态。"""
    Instance.objects.create(
        name='booting', port=19015, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    # 不持有锁（模拟另一 worker 的 create 已释放/本进程无状态）——仍被 DB 状态守卫拒删
    with pytest.raises(InstanceBusy):
        orch.delete('booting')
    assert Instance.objects.filter(name='booting').exists()


# ───────────────────────────── codex R7 review 反证 + TDD ─────────────────────────────


# ◀ R7 1 → R8 F1 (4772692556) P1 :430 → #255 —— created_at+60s → 跨进程 lease → DistributedLock ◀
# R7 用 created_at 时间窗口保护跨 worker 的活动 create；R8 改用 lease_expires_at（DB lease）。
# #255 进一步收敛进 ProvisionResource 分布式锁：锁被持有 = 有活动 create（跨进程可见），
# reconcile 锁探测（try_acquire）成功 = 无持有（崩溃中断）→ 收敛。崩溃即 TTL 自动释放，
# 取代 DB lease 的等待兜底。


@pytest.mark.django_db
def test_reconcile_protects_active_create_with_held_lock(orch):
    """#255：锁被持有 = 有活动 create（跨进程可见）→ reconcile 不收敛。

    多 worker 下另一 worker 的合法长 create（cp -a/run > 60s）持有 ProvisionResource 锁；
    reconcile 锁探测（try_acquire 失败）即知有活动 create，即使本进程无任何状态、created_at
    远旧也不收敛——长 create 不再被误判为崩溃中断（对应原 R8 F1 的 lease 未过期保护）。
    """
    inst = Instance.objects.create(
        name='active', port=19016, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    inst.created_at = timezone.now() - timedelta(seconds=300)  # 远超 R7 的 60s grace
    inst.save(update_fields=['created_at'])
    # 模拟另一 worker 的活动 create：持有该名字的 ProvisionResource 锁
    lease = orch._deps.lock.acquire(  # pylint: disable=protected-access
        ProvisionResource('active'), LEASE_TTL,
    )
    try:
        orch.list()
    finally:
        lease.release()

    inst.refresh_from_db()
    assert inst.status == Instance.STATUS_CREATING  # 锁保护，不收敛


@pytest.mark.django_db
def test_reconcile_converges_when_lock_unheld(orch):
    """#255 对照：锁未被持有（无活动 create）= 崩溃中断 → 收敛为 error。

    进程崩溃后锁随 TTL 自动过期；下次 list 的锁探测成功（try_acquire 取得）→ 按中断收敛
    （对应原 R8 F1 的 lease 已过期收敛）。
    """
    Instance.objects.create(
        name='stale', port=19017, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )

    orch.list()

    inst = Instance.objects.get(name='stale')
    assert inst.status == Instance.STATUS_ERROR


@pytest.mark.django_db
def test_reconcile_converges_when_no_lock_evidence(orch):
    """#255：无锁证据（迁移前旧行/异常，无创建活动持有）= 可收敛。

    保守处理无锁信息的行；新行经 create_reserve 总持有锁（与 R8 的 lease=None 收敛等价）。
    """
    Instance.objects.create(
        name='legacy', port=19018, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )

    orch.list()

    assert Instance.objects.get(name='legacy').status == Instance.STATUS_ERROR


@pytest.mark.django_db
def test_create_reserve_holds_lock_while_provisioning(orch):
    """#255：create_reserve 获取 ProvisionResource 锁（跨进程双创建防护 + 租约起点）。

    reserve 返回后锁被持有（in-flight 语义由锁承载）——并发同名 create_reserve 被 try_acquire
    挡下（InstanceExists），create_complete 期间锁仍持有（reconcile 锁探测不收敛、delete 拒删）。
    """
    inst = orch.create_reserve('demo')
    try:
        # reserve 后锁仍被持有（provisioning 在飞）
        assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
            ProvisionResource('demo'), LEASE_TTL,
        ) is None, 'create_reserve 后锁须仍持有（在飞）'
        # 并发同名 reserve 被锁挡下 → InstanceExists（同双创建防护语义）
        with pytest.raises(InstanceExists):
            orch.create_reserve('demo')
    finally:
        orch._cmd._release_create_lease('demo')  # pylint: disable=protected-access


@pytest.mark.django_db
def test_create_renews_lock_before_run(orch, monkeypatch):
    """#255：create_complete 在 render 后、run 前 checkpoint 续约锁（覆盖随后的 docker run）。

    保护续约不被移除——若移除续约，长 docker pull 窗口锁可能过期，reconcile 会把行误收敛。
    续约把 TTL 起点推到 run 之前（替代原 DB lease_expires_at 续约 save）。
    """
    renew_calls = []
    real_renew = orch._cmd._renew_create_lease  # pylint: disable=protected-access

    def spy_renew(name):
        renew_calls.append(name)
        return real_renew(name)

    monkeypatch.setattr(orch._cmd, '_renew_create_lease', spy_renew)  # pylint: disable=protected-access
    orch.create('demo')
    assert renew_calls, 'create 须在 run 前续约锁（_renew_create_lease 须被调用）'


# ◀ R9-2 (4773052706) P1 —— reconcile 拒绝同名但 label 不匹配的外来容器 ◀

@pytest.mark.django_db
def test_reconcile_rejects_foreign_container_without_matching_label(orch, runtime):
    """codex R9-2 (P1)：reconcile self-heal 分支采用容器 ID 前须校验 label。

    同名外来容器（openclaw.instance label 不匹配本实例名）的 container_id 不得被采纳——
    否则后续 DELETE 的 live-ID 比对通过，误删不属于本 orch 的容器。
    """
    from datetime import timedelta

    from django.utils import timezone

    inst = Instance.objects.create(
        name='foreign', port=19021, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    # 同名容器，但 instance_name label 不匹配——属于其他 orch / 手动创建
    runtime.containers['foreign'] = ContainerInfo(
        container_id='foreign-id',
        name=container_name('foreign'),
        running=True, status='running', image='img:tag',
        instance_name='other-instance',  # ← label 不匹配！
    )

    orch.list()

    inst.refresh_from_db()
    assert inst.status == Instance.STATUS_ERROR, 'label 不匹配的外来容器应收敛 error'
    assert inst.container_id == '', '外来容器的 ID 不得被采纳（否则后续 delete 会误删）'


# ◀ R9-1 (4773052706) P1 —— delete 清理资源前重新校验行身份（PK guard）◀

@pytest.mark.django_db
def test_delete_skips_rmtree_when_row_gone_before_cleanup(orch, runtime, config, monkeypatch):
    """codex R9-1 (P1)：delete 在 rmtree 前重新查行身份——若行已被另一 delete 删除，跳过 rmtree。

    覆盖双 delete 竞态：delete A 完成（rmtree + inst.delete()）→ delete B（stale，在内存中
    持有旧 Instance 对象）的 rmtree 前检查发现行已不存在 → 跳过 rmtree，保护 recreate 的
    新目录（recreate 必须等旧行 delete 后才 INSERT，此时旧行已不在 = 旧 delete 已完成。
    stale delete B 再前进时，行已不存在 → 跳过）。
    """
    orch.create('demo')
    instance_dir = config.root / 'instances' / 'demo'
    marker = instance_dir / 'marker.txt'
    marker.write_text('first')

    # 正常第一个 delete 完成（行已删）
    orch.delete('demo')
    assert not Instance.objects.filter(name='demo').exists()

    # recreate —— 新行、新目录、新 PK
    orch.create('demo')
    _ = Instance.objects.get(name='demo')  # 行已重建（DoesNotExist 即失败）
    assert (instance_dir / 'home' / 'workspace' / 'note.md').exists()  # 新 provision 已完成

    # monkeypatch Instance.objects.filter：**第二次**对 name='demo' 的查询返回空
    #（模拟 stale delete 的 re-validation；stale 对象在真实竞态中是内存中的旧对象，但
    # 重新查行时当前行已被另一 delete 删掉或已被 recreate 替换。这里测的是
    # 「行不存在」分支的保护 —— recreate 之前的窗口）。
    # 为了触发代码路径：正常 `delete` 入口查行须返回非 None（否则入口 return False，
    # 不走到 PK guard），然后 rmtree 前的检查返回 None（模拟竞态）。
    real_filter = Instance.objects.filter
    call_no = {'n': 0}

    def fake_filter(*args, **kwargs):
        if kwargs.get('name') == 'demo':
            call_no['n'] += 1
            if call_no['n'] == 1:
                return real_filter(*args, **kwargs)  # 入口查行 → 当前行（recreate 的行）
            # 第二次及之后 → 返回空（模拟行已被外部删除 / recreate 替换）
            return Instance.objects.none()
        return real_filter(*args, **kwargs)

    monkeypatch.setattr(Instance.objects, 'filter', fake_filter)
    rmtree_calls = []
    orch._deps.dir_remover = lambda p: rmtree_calls.append(p)  # pylint: disable=unnecessary-lambda

    result = orch.delete('demo')
    assert result is True
    assert rmtree_calls == [], '行已不存在时 PK guard 须跳过 rmtree（新目录属于 recreate）'  # pylint: disable=use-implicit-booleaness-not-comparison
    assert marker.exists() or (instance_dir / 'home' / 'workspace' / 'note.md').exists(), (
        'recreate 的新目录不应被 stale delete 删除'
    )


# ◀ 2 (3644601354) P2 :509 —— _build_default 仍急切 read_text() 模板文件 ◀

@pytest.mark.django_db
def test_fleet_get_survives_missing_template_file(tmp_path, settings):
    """codex R7 P2 :509：Fleet._build_default() 仍急切 Path.read_text() 模板 JSON。
    模板文件缺失时 Fleet.get() 崩溃 → list/delete 全部 500，运维无法恢复。
    """
    from containers.orchestrator import Fleet

    # 用正确的模板文件路径，但模板 JSON 本身是无效内容——模拟文件存在但格式错误
    bad_template = tmp_path / 'broken.json'
    bad_template.write_text('not valid json {{{')

    settings.OPENCLAW_FLEET = {
        'ROOT': str(tmp_path / 'fleet'),
        'TEMPLATE': str(tmp_path / 'template'),
        'TEMPLATE_JSON': str(bad_template),
        'IMAGE': 'img:tag',
        'PORT_POOL_START': 19000,
        'PORT_POOL_END': 19999,
        'LLM_API_KEY': '',  # ADR 0005：stub 须镜像 base.py 的 fleet 键（编排改经 settings 取）
        'PORT_BIND_HOST': '127.0.0.1',  # #295：stub 镜像 base.py 新增端口发布 host 键
    }
    Fleet.reset()
    try:
        orch = Fleet.get()
        # 即使模板文件缺失，Fleet 也应能构造 orchestractor
        # 只有 create() 展开模板时才会失败
        items = orch.list()
        assert items == []
    finally:
        Fleet.reset()


@pytest.mark.django_db
def test_fleet_build_default_injects_hosts_from_settings(tmp_path, settings):
    """#295 验收 4：Fleet._build_default 从 settings 装配探测 host 与端口发布 host。

    生产后端容器化后，探测 host 注入 OPENCLAW_FLEET_WS['HOST']（host.docker.internal），
    端口发布 host 注入 OPENCLAW_FLEET['PORT_BIND_HOST']（0.0.0.0）——三处装配都要落地到
    注入点（_deps.health / _deps.runtime / _deps.port_in_use），否则生产 compose 注入配置
    不生效；其中端口占用探测与端口发布 host 须同源（codex P2：publish_host 变 0.0.0.0 时
    probe 仍测 loopback 会误报空闲 → 选中被非 loopback 占用的端口 → run 失败）。
    """
    from containers.orchestrator import Fleet

    settings.OPENCLAW_FLEET = {
        'ROOT': str(tmp_path / 'fleet'),
        'TEMPLATE': str(tmp_path / 'template'),
        'TEMPLATE_JSON': str(tmp_path / 'tpl.json'),
        'IMAGE': 'img:tag',
        'PORT_POOL_START': 19000,
        'PORT_POOL_END': 19999,
        'LLM_API_KEY': '',
        'PORT_BIND_HOST': '0.0.0.0',  # 生产：宿主侧 0.0.0.0 发布，host-gateway 可达
    }
    settings.OPENCLAW_FLEET_WS = {'SCHEME': 'ws', 'HOST': 'host.docker.internal'}
    Fleet.reset()
    try:
        orch = Fleet.get()
        assert orch._deps.runtime._publish_host == '0.0.0.0'
        assert orch._deps.health._host == 'host.docker.internal'
        # codex P2：端口占用探测与端口发布 host 同源，0.0.0.0 时能检测非 loopback 占用
        assert orch._deps.port_in_use._host == '0.0.0.0'
    finally:
        Fleet.reset()


# ◀ 3 (3644601364) P2 :400 —— runtime lookup 异常传播终止整个 list 响应 ◀

@pytest.mark.django_db
def test_list_survives_runtime_lookup_failure_for_one_instance(orch, runtime):
    """codex R7 P2 :400：_build_item 的 runtime.get() 抛非 NotFound 异常时
    ThreadPoolExecutor.map 终止整个 list。单个容器 daemon 抖动不应让其他容器不可见。
    """
    # 创建两个实例：一个正常，一个模拟 runtime 异常
    orch.create('good')
    orch.create('bad')

    class _FlakyGet:
        def __init__(self, real_get):
            self._real = real_get

        def __call__(self, name):
            if name == 'bad':
                raise RuntimeError('daemon unavailable')
            return self._real(name)

    runtime.get = _FlakyGet(runtime.get)

    items = orch.list()
    names = {it['name'] for it in items}
    assert 'good' in names, '正常实例不应被异常实例的 runtime 错误隐藏'
    assert 'bad' in names, '异常实例应降级展示，非整个 list 500'


# ───────────────────────────── codex R8 review 反证 + TDD ─────────────────────────────


# ◀ F4 (4772692556) P2 —— integration smoke 把 JSON 内容当 template_json 传入 ◀

def test_smoke_template_json_is_a_readable_file_path():
    """codex R8 F4：integration smoke 的 template_json 必须是 create() 可读的**文件路径**。

    create() 惰性用 ``Path(template_json).read_text()`` 读模板（R7 :509）。smoke 若传
    ``.read_text()`` 的文本内容，``Path(<json 文本>)`` 不是存在的文件路径，smoke 在触及
    Docker 前即 FileNotFoundError，无法验证真实 create/list/delete 链路。
    """
    from containers.tests.test_integration import _SMOKE_TEMPLATE_JSON

    path = Path(_SMOKE_TEMPLATE_JSON)
    assert path.exists(), (
        f'smoke template_json 须为存在的文件路径（create() 按 Path.read_text 读），'
        f'实际传入: {_SMOKE_TEMPLATE_JSON!r}'
    )
    assert isinstance(json.loads(path.read_text(encoding='utf-8')), dict)


# ◀ F3 (4772692556) P2 —— reconcile creating 行时 runtime.get 无防护，daemon 抖动即整 list 500 ◀

@pytest.mark.django_db
def test_list_survives_runtime_lookup_failure_during_reconcile(orch):
    """codex R8 F3：_reconcile_creating 的 runtime.get() 在主线程、进线程池前执行且无防护。

    中断的 creating 行进入收敛路径时，若 daemon 临时不可用使 runtime.get 抛异常，整个
    GET /api/v1/containers/ 返回 500，隐藏所有已持久化 instance。须逐行 catch 降级
    （保持 CREATING/pending，下次 list 再对账），与 _build_item 的 R7 :400 容错对称。
    """
    from datetime import timedelta

    from django.utils import timezone

    inst = Instance.objects.create(
        name='stuck', port=19021, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    # 超过 provisioning 时间窗口 → 进入 reconcile 收敛路径（触发 runtime.get）
    inst.created_at = timezone.now() - timedelta(seconds=120)
    inst.save(update_fields=['created_at'])

    class _FlakyGet:
        def __call__(self, name):
            raise RuntimeError('daemon unavailable')

    orch._deps.runtime.get = _FlakyGet()

    # list 不应因 reconcile 的 runtime 异常而 500
    items = orch.list()
    names = {it['name'] for it in items}
    assert 'stuck' in names, 'daemon 抖动不应隐藏已持久化实例'
    stuck = next(it for it in items if it['name'] == 'stuck')
    # 保守保持 creating/pending（无法判定真实状态时不误收敛）
    assert stuck['status'] == 'creating'
    assert stuck['health'] == 'pending'


@pytest.mark.django_db
def test_list_survives_lock_probe_failure_during_reconcile(orch, monkeypatch):
    """#255 审查修正：reconcile 锁探测抛错（Redis 临时不可用）→ 逐行降级，不 500。

    对齐 R8 F3 的 runtime.get 容错——Redis down 时锁探测失败须保持 creating/pending
    （下次 list 再对账），而非让整个 GET /containers/ 500 隐藏全部已持久化 instance。
    """
    Instance.objects.create(
        name='stuck', port=19023, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )

    class _LockProbeFails:
        def try_acquire(self, *args, **kwargs):
            raise RuntimeError('redis down')

    monkeypatch.setattr(orch._deps, 'lock', _LockProbeFails())  # pylint: disable=protected-access

    items = orch.list()
    names = {it['name'] for it in items}
    assert 'stuck' in names, 'Redis 抖动不应隐藏已持久化实例'
    stuck = next(it for it in items if it['name'] == 'stuck')
    # 保守保持 creating/pending（无法判定真实状态时不误收敛）
    assert stuck['status'] == 'creating'
    assert stuck['health'] == 'pending'


# ───────────────────────────── #297 异步化：reserve/complete/submit ─────────────────────────────


@pytest.mark.django_db
def test_create_reserve_returns_creating_row(orch):
    """#297：create_reserve 同步预占 creating 行——锁被持有（防被收敛/拒删）。

    #255：create 在飞语义由 ProvisionResource 锁承载（原 inflight 集合 + DB lease 已移除）。
    """
    inst = orch.create_reserve('demo')
    assert inst.status == Instance.STATUS_CREATING
    # 后台完成前不落盘（mkdir/cp -a 未执行）
    assert not (orch._deps.config.root / 'instances' / 'demo').exists()
    # reserve 后锁仍被持有（provisioning 在飞：reconcile 锁探测不收敛、delete 拒删）
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is None, 'create_reserve 后 ProvisionResource 锁须仍持有（在飞）'


@pytest.mark.django_db
def test_create_reserve_rejects_duplicate_name(orch):
    """#297：reserve 阶段并发同名仍 InstanceExists（view 409）——不因异步化丢失错误语义。"""
    orch.create_reserve('demo')
    with pytest.raises(InstanceExists):
        orch.create_reserve('demo')


@pytest.mark.django_db
def test_create_unreleased_lease_expires_then_retry_succeeds(orch):
    """#255 AC：崩溃（未 release）租约到期后，retry 可获锁解除阻塞。

    模拟进程崩溃：向同一锁 acquire 一个**短 TTL** 的租约且不 release（等同死进程持有、其
    租约还剩 TTL）。租约随 TTL 自动过期后，并发同名 create_reserve 不再被挡——重试方
    try_acquire 成功，恢复创建能力。FakeLockSync 以内存 TTL 模拟该语义（真 Redis 的
    SET NX PX 崩溃自动释放由 common/lock 真 Redis smoke 覆盖）。
    """
    # 崩溃模拟：持有短 TTL 租约不 release（create_reserve 后进程挂掉、租约未续约）
    crashed = orch._deps.lock.acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), timedelta(milliseconds=20),
    )
    assert crashed is not None
    with pytest.raises(InstanceExists):
        orch.create_reserve('demo')  # 崩溃期间并发同名被挡

    time.sleep(0.1)  # 让崩溃租约的 TTL（20ms）走完——5× 余量，防调度抖动（FakeLockSync 用 time.monotonic）

    # 租约到期 → retry 可获锁（创建能力恢复）
    inst = orch.create_reserve('demo')
    assert inst is not None
    # 收尾：后台未跑，手动释放锁防占位泄漏到后续断言
    orch._cmd._release_create_lease('demo')  # pylint: disable=protected-access


@pytest.mark.django_db
def test_create_reserve_rolls_back_on_missing_template(orch, monkeypatch):
    """#297：reserve 阶段 renderer 惰性构造失败（模板缺失）→ 回滚 creating 行 + 释放锁。

    模板损坏是确定性配置错误，须同步暴露（客户端可改配置重试），而非后台线程失败留下无主
    creating 行（占名占端口，且 DELETE 拒删 CREATING 行）。
    """
    config = orch._deps.config  # pylint: disable=protected-access
    # 把 template_json 指向不存在路径——reserve 读模板触发 FileNotFoundError
    bad_config = FleetConfig(
        root=config.root,
        template_dir=config.template_dir,
        template_json=str(orch._deps.config.root / 'no-such-template.json'),
        image=config.image,
        port_start=config.port_start,
        port_end=config.port_end,
        llm_api_key=config.llm_api_key,
    )
    orch._deps.config = bad_config  # pylint: disable=protected-access
    with pytest.raises(FileNotFoundError):
        orch.create_reserve('demo')
    assert not Instance.objects.filter(name='demo').exists()
    # #255：失败后锁已释放（可被重获），不残留占位
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is not None


@pytest.mark.django_db
def test_create_reserve_rejects_residual_dir(orch, config):
    """#297：reserve 阶段残留目录预检 → InstanceDirExists（view 409），不留无主 creating 行。

    残留目录（DB 无行的 orphan）若拖到后台 mkdir 才失败，客户端拿到 202 却落 ERROR 行，
    且无「先清理」提示——同步预检在请求线程暴露。
    """
    (config.root / 'instances' / 'demo').mkdir(parents=True)
    with pytest.raises(InstanceDirExists):
        orch.create_reserve('demo')
    assert not Instance.objects.filter(name='demo').exists()
    # #255：失败后锁已释放（可被重获），不残留占位
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is not None


@pytest.mark.django_db
def test_create_complete_releases_lock(orch, runtime):
    """#297 + #255：create_complete 收尾 finally 释放锁——后台完成不可留下锁卡住并发同名。"""
    inst = orch.create_reserve('demo')
    # 后台完成前锁仍被持有（在飞）
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is None
    orch._cmd.create_complete(inst)  # pylint: disable=protected-access
    # 完成后锁已释放（可被重获）
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is not None
    # 完成的行已 running + run_spec 落过
    inst.refresh_from_db()
    assert inst.status == Instance.STATUS_RUNNING
    assert runtime.run_specs[0].name == 'demo'


@pytest.mark.django_db
def test_create_complete_releases_lock_on_failure(config, health, tmp_path):
    """#297 + #255：create_complete 后台失败（run 抛异常）finally 仍释放锁——不泄漏锁占位。"""
    _seed_template(tmp_path / 'template')

    class _RunFails(FakeRuntime):
        def run(self, spec):
            raise RuntimeError('daemon down')

    orch = InstanceOrchestrator(
        runtime=_RunFails(), config=config, health_probe=health)
    inst = orch.create_reserve('demo')
    with pytest.raises(RuntimeError):
        orch._cmd.create_complete(inst)  # pylint: disable=protected-access
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is not None, '失败后锁须已释放'
    assert not Instance.objects.filter(name='demo').exists()


@pytest.mark.django_db(transaction=True)
def test_create_async_background_thread(orch):
    """#297：submit_create 经真后台线程完成 provisioning 并落库（close_old_connections 生效）。

    @django_db(transaction=True)：pytest 不开事务包裹，后台线程的 DB 写入真实可见。
    线程 join 保证断言时 provisioning 已完成；完成后行 running + 目录落盘。
    收尾显式删除行/目录——transaction=True 不自动回滚，防残留端口行污染后续测试。
    """
    import threading

    inst = orch.create_reserve('demo')
    # #255：后台完成前锁仍被持有（在飞）
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is None

    done = threading.Event()

    def _submit(task, *args):
        def _wrapped():
            try:
                task(*args)
            finally:
                done.set()
        threading.Thread(target=_wrapped, daemon=True).start()

    orch._cmd._submit_task = _submit  # pylint: disable=protected-access
    try:
        orch.submit_create(inst)

        assert done.wait(timeout=10), '后台 create 线程 10s 内未完成'
        inst.refresh_from_db()
        assert inst.status == Instance.STATUS_RUNNING
        assert (orch._deps.config.root / 'instances' / 'demo' / 'home' / 'workspace' / 'note.md').exists()
        assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
            ProvisionResource('demo'), LEASE_TTL,
        ) is not None, '后台完成后锁须已释放'
    finally:
        # transaction=True 不回滚——显式清理行 + 目录，不污染后续测试的端口池断言
        Instance.objects.filter(name='demo').delete()
        import shutil

        shutil.rmtree(orch._deps.config.root / 'instances' / 'demo', ignore_errors=True)


@pytest.mark.django_db
def test_create_sync_wrapper_still_works(orch, runtime):
    """#297：create() 同步封装（reserve + complete）语义不变——既有调用方/单测零破坏。"""
    inst = orch.create('demo')
    assert inst.status == Instance.STATUS_RUNNING
    assert runtime.run_specs[0].name == 'demo'
    # #255：同步 create 后锁已释放（可被重获）
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is not None


@pytest.mark.django_db
def test_background_failure_preserves_error_row(config, health, tmp_path):
    """codex P1（#297 后台）：非 bind 失败且目录清理成功时，后台路径保留 ERROR 行。

    原 create_complete 非 bind 失败删行回滚；但 POST 已返 202、行对客户端可见，删行会让
    已接受的实例静默消失——客户端轮询看不到 error 态、无法经 delete 清理。后台线程入口
    _run_create_complete 传 preserve_error_row=True，失败保留 ERROR 行（list 显示 error）。
    """
    _seed_template(tmp_path / 'template')

    class _RunFails(FakeRuntime):
        def run(self, spec):
            raise RuntimeError('daemon down')  # 非 bind 冲突（ConfigStore.write/run 失败同类）

    orch = InstanceOrchestrator(
        runtime=_RunFails(), config=config, health_probe=health)
    inst = orch.create_reserve('demo')
    # 后台路径：preserve_error_row=True → 失败保留 ERROR 行（不抛到外层，_run_create_complete 兜底）
    orch._cmd._run_create_complete(inst)  # pylint: disable=protected-access
    row = Instance.objects.get(name='demo')
    assert row.status == Instance.STATUS_ERROR
    # #255：失败后锁已释放（可被重获），不残留占位
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is not None
    # 同步路径对照：create_complete(preserve_error_row=False) 仍删行回滚（历史契约）
    inst2 = orch.create_reserve('sync-demo')
    with pytest.raises(RuntimeError):
        orch._cmd.create_complete(inst2)  # pylint: disable=protected-access
    assert not Instance.objects.filter(name='sync-demo').exists()


@pytest.mark.django_db
def test_bind_conflict_exhaustion_finalizes_row(config, health, tmp_path):
    """codex P2（e947dde 新轮）：全部候选端口 bind 冲突耗尽时，行须转到失败终态。

    #295 的 bind 冲突重试：最后一轮冲突后 next_free 抛 PortPoolExhausted（池内已无空闲），
    该异常在冲突处理内抛出，绕过 preserve_error_row/同步回滚分支——行残留 creating +
    lease 续约，轮询显示 pending 达 10 分钟、DELETE 拒删。正确行为：后台路径（POST 已返
    202）行转 ERROR（可经 list + delete 感知/清理）；同步 create() 删行回滚。
    """
    _seed_template(tmp_path / 'template')
    small_config = FleetConfig(
        root=config.root,
        template_dir=config.template_dir,
        template_json=config.template_json,
        image=config.image,
        port_start=19000,
        port_end=19002,  # 小端口池（3 个候选）→ 全冲突即耗尽
        llm_api_key=config.llm_api_key,
    )
    runtime = FakeRuntime()
    runtime.fail_bind_ports = {19000, 19001, 19002}  # 池内全部端口被宿主监听占用

    # ── 后台路径（preserve_error_row=True）：池耗尽 → 行转 ERROR ──
    orch = InstanceOrchestrator(
        runtime=runtime, config=small_config, health_probe=health)
    inst = orch.create_reserve('demo')
    orch._cmd._run_create_complete(inst)  # pylint: disable=protected-access
    row = Instance.objects.get(name='demo')
    assert row.status == Instance.STATUS_ERROR, (
        f'后台池耗尽须转 ERROR（不得残留 creating + 锁续约），got {row.status!r}'
    )
    assert orch._deps.lock.try_acquire(  # pylint: disable=protected-access
        ProvisionResource('demo'), LEASE_TTL,
    ) is not None, '后台池耗尽失败后锁须已释放'

    # ── 同步路径（preserve_error_row=False）：池耗尽 → 删行 + 抛异常 ──
    runtime2 = FakeRuntime()
    runtime2.fail_bind_ports = {19000, 19001, 19002}
    orch2 = InstanceOrchestrator(
        runtime=runtime2, config=small_config, health_probe=health)
    inst2 = orch2.create_reserve('sync-demo')
    with pytest.raises(PortAllocationError):
        orch2._cmd.create_complete(inst2)  # pylint: disable=protected-access
    assert not Instance.objects.filter(name='sync-demo').exists()


# ───────────────────────────── A3：root 属主 cleanup ─────────────────────────────


@pytest.mark.django_db
def test_delete_chowns_root_owned_home_before_rmtree(orch, runtime):
    """A3：容器以 root 跑（docker_runtime user=0:0），bind-mount home 内由容器写入的文件
    （session/cache 等）属主为 root，host 非 root rmtree 会 PermissionError。

    delete 须在 stop+remove 前，容器还在（root 权限）时同步 chown home 给 host uid，
    让 host rmtree 能清。验证 exec_sync 被调且 cmd = chown -R <host_uid> HOME_BIND。
    """
    orch.create('demo')
    orch.delete('demo')
    chowns = [
        cmd for name, cmd in runtime.sync_exec_calls
        if name == 'demo' and cmd[:1] == ['chown']
    ]
    assert chowns, 'delete 须在 stop 前容器内 chown home 给 host uid（A3 root 属主 cleanup）'
    assert chowns[0] == ['chown', '-R', str(os.getuid()), HOME_BIND]
