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
    ConfigurationError,
    Fleet,
    FleetConfig,
    InstanceBusy,
    InstanceCleanupError,
    InstanceExists,
    InstanceOrchestrator,
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
    # codex P2 :133：creating 中（容器未起）不应被 runtime.get 缺失误判 stopped。
    # codex R3 :319：须标记为在飞（模拟 create 正在 provisioning），否则被视为中断行收敛。
    Instance.objects.create(
        name='booting', port=19005, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    orch._inflight_creates.add('booting')      # 模拟该名字的 create 仍在飞
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
    orch._cfg = dataclasses.replace(config, root=new_root)
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
    orch._inflight_creates.add('booting')      # 模拟在飞，区别于崩溃中断（:319）
    item = orch.list()[0]
    assert item['status'] == 'creating'
    assert item['health'] == 'pending'


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
    orch._provisioner = HomeProvisioner(tmp_path / 'no-such-template')
    with pytest.raises(Exception):
        orch.create('demo')
    assert runtime.run_specs == []                 # 从未调 run
    assert runtime.removed == []                   # 回滚未 remove（没创建任何容器）


@pytest.mark.django_db
def test_create_rollback_removes_when_run_attempted_and_start_fails(config, health, tmp_path):
    # codex P1 :232 对照 + R1 :112：本次确实 run 过（docker create 成功 start 失败）
    # → 残留命名容器须 best-effort remove（否则重试同名 docker 冲突）。
    _seed_template(tmp_path / 'template')
    runtime = FakeRuntime()
    runtime.fail_after_create = RuntimeError('port already allocated')
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

    runtime.run = _RunConflict.run.__get__(runtime)   # 保留 containers，run 抛冲突
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
        runtime=_RunFails(), config=config, health_probe=health, dir_remover=fail_rmtree
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
        runtime=runtime, config=config, health_probe=health, dir_remover=fail_rmtree
    )

    with pytest.raises(InstanceCleanupError):
        orch.create('demo')

    inst = Instance.objects.get(name='demo')
    assert inst.status == Instance.STATUS_ERROR
    assert inst.container_id.startswith('fakeid-demo-')


@pytest.mark.django_db
def test_create_keeps_inflight_until_final_save(orch, monkeypatch):
    # codex P2 :269：DELETE 在 run() 返回后、最终 save() 前的窗口不得竞删——in-flight 标记
    # 须保留到 save 之后。验证：最终 save（status=running）执行期间 'demo' 仍在 _inflight_creates；
    # create 返回后已释放。（_reserve_row 的 INSERT 先于 add，本就不在飞，非本测试关注点。）
    real_save = Instance.save
    inflight_at_save = []

    def spy_save(instance, *args, **kwargs):
        if instance.name == 'demo':
            inflight_at_save.append('demo' in orch._inflight_creates)
        return real_save(instance, *args, **kwargs)

    monkeypatch.setattr(Instance, 'save', spy_save)
    orch.create('demo')
    # 最终 save（reserve 的 INSERT 之后、add 之后）执行时必须仍标记在飞 → delete 会被拒删
    assert inflight_at_save, 'create 应至少触发一次 save'
    assert inflight_at_save[-1] is True, '最终 save 期间 in-flight 标记须仍保留（:269）'
    # create 完整返回后标记已释放，后续 delete 可正常进行
    assert 'demo' not in orch._inflight_creates


# --- delete：:257 在飞 create 拒删 ---


@pytest.mark.django_db
def test_delete_rejects_while_create_in_flight(orch):
    # codex P1 :257：目标仍在 provisioning（create 在飞）→ InstanceBusy（view 409），
    # 防 delete 与在飞 create 竞态（create 收尾 save(running) 会 resurrect 已删行）。
    Instance.objects.create(
        name='booting', port=19010, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    orch._inflight_creates.add('booting')          # 模拟 create 在飞
    with pytest.raises(InstanceBusy):
        orch.delete('booting')
    assert Instance.objects.filter(name='booting').exists()  # 行未被删


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
def test_create_marks_inflight_before_reserving_row(orch, monkeypatch):
    # codex R5 :238：DB 行一旦可见，name 必须已在 in-flight guard 中。
    real_reserve = orch._reserve_row
    guarded_at_reserve = []

    def spy_reserve(name):
        guarded_at_reserve.append(name in orch._inflight_creates)
        return real_reserve(name)

    monkeypatch.setattr(orch, '_reserve_row', spy_reserve)
    orch.create('demo')
    assert guarded_at_reserve == [True]
    assert 'demo' not in orch._inflight_creates


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

    orch = InstanceOrchestrator(runtime=_PreflightFails(), config=config, health_probe=health)
    with pytest.raises(RuntimeError):
        orch.create('demo')

    assert not Instance.objects.filter(name='demo').exists()
    assert 'demo' not in orch._inflight_creates


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
    assert items == []

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
    """codex P1 :304：_inflight_creates 仅本进程可见；多 worker 下另一 worker 的 create 不可见。

    delete 须基于 DB CREATING 状态拒删——跨进程安全。不依赖本进程 _inflight_creates。
    """
    Instance.objects.create(
        name='booting', port=19015, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    # 不加入 _inflight_creates（模拟另一 worker 的 create）
    with pytest.raises(InstanceBusy):
        orch.delete('booting')
    assert Instance.objects.filter(name='booting').exists()


# ───────────────────────────── codex R7 review 反证 + TDD ─────────────────────────────


# ◀ 1 (3644601349) P1 :430 —— _reconcile_creating 靠进程内 _inflight_creates 区分活动/中断 ◀

@pytest.mark.django_db
def test_reconcile_does_not_convert_fresh_creating_to_error(orch, runtime):
    """codex R7 P1 :430：_inflight_creates 仅本进程可见；多 worker 下另一 worker 刚创建的
    CREATING 行（容器未起）被本进程的 _reconcile_creating 误判为中断 → 收敛 error →
    后续 delete 的 CREATING 守卫失效。

    created_at 在 _inflight_creates 不可靠时提供跨进程时间窗口保护——
    足够新的 CREATING 行不应被收敛（允许足够时间 provisioning）。
    """
    from datetime import timedelta
    from django.utils import timezone

    # 刚创建的 CREATING 行（模拟另一 worker 刚刚 INSERT，_inflight_creates 不可见）
    inst = Instance.objects.create(
        name='fresh', port=19016, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    # 强制 created_at 为「现在」（DB auto_now_add 可能略有延迟）
    inst.created_at = timezone.now()
    inst.save(update_fields=['created_at'])
    # runtime 无容器（container 尚未启动）
    # _inflight_creates 不含 'fresh'（模拟跨 worker）

    orch.list()

    inst.refresh_from_db()
    # 刚创建的 CREATING 行应保持 CREATING，不被收敛为 error
    assert inst.status == Instance.STATUS_CREATING


@pytest.mark.django_db
def test_reconcile_still_converts_stale_creating_to_error(orch):
    """codex R7 P1 对照：足够旧的 CREATING 行（远超 provisioning 时间窗口）仍被收敛。

    确保时间窗口保护不阻碍真正的崩溃中断行被收敛。
    """
    from datetime import timedelta
    from django.utils import timezone

    inst = Instance.objects.create(
        name='stale', port=19017, token='t', home_dir='/h',
        status=Instance.STATUS_CREATING, image='img:tag',
    )
    # 设为 5 分钟前——远超合理 provisioning 时间
    inst.created_at = timezone.now() - timedelta(seconds=300)
    inst.save(update_fields=['created_at'])

    orch.list()

    inst.refresh_from_db()
    assert inst.status == Instance.STATUS_ERROR


# ◀ 2 (3644601354) P2 :509 —— _build_default 仍急切 read_text() 模板文件 ◀

@pytest.mark.django_db
def test_fleet_get_survives_missing_template_file(tmp_path, settings):
    """codex R7 P2 :509：Fleet._build_default() 仍急切 Path.read_text() 模板 JSON。
    模板文件缺失时 Fleet.get() 崩溃 → list/delete 全部 500，运维无法恢复。
    """
    from containers.orchestrator import Fleet, InstanceOrchestrator

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
