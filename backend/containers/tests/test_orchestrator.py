"""seam: InstanceOrchestrator 生命周期编排 —— issue #39 容器编排控制面。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §5.4（生命周期）/§5.5（状态机 + 失败回滚）/§5.6（bind-mount home）。
用 FakeRuntime + FakeHealthProbe 覆盖业务逻辑（CI 无 docker daemon）；真实 DockerRuntime 走 integration。
"""
import threading
import time

import pytest
from django.db import IntegrityError

from containers.models import Instance
from containers.orchestrator import (
    FleetConfig,
    InstanceCleanupError,
    InstanceExists,
    InstanceOrchestrator,
)
from containers.runtime import ContainerInfo, container_name
from containers.tests.fakes import FakeHealthProbe, FakeRuntime


def _seed_template(template):
    (template / 'workspace').mkdir(parents=True)
    (template / 'workspace' / 'note.md').write_text('hi')
    (template / 'wiki').mkdir()


@pytest.fixture
def config(tmp_path):
    return FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=tmp_path / 'template',
        template_json='{}',
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
    return InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)


# ---------------------------- create（§5.5 状态机 creating→running）----------------------------


@pytest.mark.django_db
def test_create_provisions_home_and_renders_config(orch, config):
    # spec §5.5/§5.6：cp -a 预填充 home + 渲染 openclaw.json 落到 instances/<name>/
    inst = orch.create('demo')
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
        name='other', port=19000, token='t', home_dir='/h', image='img:tag'
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
    # spec §10 name 唯一；DB 唯一约束 → 第二次 IntegrityError（API 层转 400，见 test_api）
    orch.create('demo')
    with pytest.raises(Exception):
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
    runtime.fail_after_create = RuntimeError('port already allocated')
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


# --- delete：:126 rmtree 失败保留 DB 行 + 标 REMOVING（不吞错、可重试）---


@pytest.mark.django_db
def test_delete_preserves_row_when_dir_cleanup_fails(config, health, runtime, tmp_path):
    # codex P1 :126：root 容器改 home 属主 → rmtree 失败不应被 ignore_errors 吞。
    # 须保留 DB 行（可重试）+ 标 REMOVING + raise InstanceCleanupError。
    _seed_template(tmp_path / 'template')

    def fail_rmtree(path, **kwargs):
        raise OSError('permission denied')

    orch = InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health, dir_remover=fail_rmtree
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
    # codex P2 :133：creating 中（容器未起）不应被 runtime.get 缺失误判 stopped
    Instance.objects.create(
        name='booting', port=19005, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    item = orch.list()[0]
    assert item['status'] == 'creating'
    assert item['health'] == 'pending'         # 未起，不探


@pytest.mark.django_db
def test_list_probes_health_concurrently(orch):
    # codex P2 :156：N running 容器健康探测须并发，非 N×timeout 串行
    probe = _ConcurrencyProbe()
    orch._health = probe
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
        runtime=runtime, config=config, health_probe=health, port_in_use=lambda p: False
    )
    inst = orch.create('demo')
    assert inst.port == 19001


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


# --- list：:226 creating 行 runtime 对账自愈 ---


@pytest.mark.django_db
def test_list_reconciles_creating_row_when_container_running(orch, runtime):
    # codex P2 :226：进程在最终 save 前崩溃（Docker 已起容器）留下 creating 行。
    # list 须对账 runtime：容器实际 running 则就地自愈为 running，不再永久 pending。
    Instance.objects.create(
        name='crashed', port=19007, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    # daemon 里容器实际已在跑（上次崩溃前 Docker 已 start）
    runtime.containers['crashed'] = ContainerInfo(
        container_id='realid',
        name=container_name('crashed'),
        running=True,
        status='running',
        image='img:tag',
    )
    item = orch.list()[0]
    assert item['status'] == 'running'
    # 行已自愈落盘（后续 list 不再重复对账）
    inst = Instance.objects.get(name='crashed')
    assert inst.status == Instance.STATUS_RUNNING
    assert inst.container_id == 'realid'


@pytest.mark.django_db
def test_list_keeps_creating_when_container_not_yet_running(orch):
    # codex P2 :226 对照：容器尚未起（正常 provisioning 中）→ 仍 creating/pending，不误判。
    Instance.objects.create(
        name='booting', port=19008, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    item = orch.list()[0]
    assert item['status'] == 'creating'
    assert item['health'] == 'pending'
