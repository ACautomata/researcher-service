"""containers API 测试共享 fixture：Fleet.override 注入 FakeRuntime 编排层。

API 测试不碰真 docker daemon；orchestrator 用 tmp 目录 + FakeRuntime + FakeHealthProbe。
#297 异步化：注入 inline 同步 submit_task，使后台 provisioning 在请求线程同步跑完
（API 测试断言落盘结果；真线程行为由 test_orchestrator 的 @django_db(transaction=True) 覆盖）。

#255：autouse 注入 FakeLockSync 到 ``LockFleet`` sync 槽——orchestrator 构造默认
``lock or LockFleet.get(sync=True)`` 经此拿到内存 fake（双创建互斥 / 租约 TTL 过期语义
同构），CI/单测无真 Redis。真 Redis adapter 行为由 common/lock 可选 smoke 覆盖。
"""
import pytest

from common.lock.fakes import FakeLockSync
from common.lock.locator import LockFleet
from containers.orchestrator import Fleet, FleetConfig, InstanceOrchestrator
from containers.tests.fakes import FakeHealthProbe, FakeRuntime


@pytest.fixture(autouse=True)
def _fake_provision_lock():
    """#255：每 case 把 FakeLockSync 注入 LockFleet sync 槽（orchestrator 默认锁来源）。

    ``LockFleet.override(FakeLockSync(), sync=True)`` → orchestrator 构造默认取到内存 fake，
    create/list/delete 的锁语义（双创建互斥、租约 TTL 自动释放、reconcile 锁探测）可验，
    不依赖真 Redis。case 结束 reset 复原，防跨测试状态泄漏（对齐 Fleet fixture 先例）。
    """
    LockFleet.override(FakeLockSync(), sync=True)
    yield
    LockFleet.reset()


def _seed_template(template_dir):
    (template_dir / 'workspace').mkdir(parents=True)
    (template_dir / 'workspace' / 'note.md').write_text('hi')
    (template_dir / 'wiki').mkdir()


@pytest.fixture
def fleet(tmp_path):
    template = tmp_path / 'template'
    _seed_template(template)
    tpl_file = tmp_path / 'openclaw.json'
    tpl_file.write_text('{}')
    runtime = FakeRuntime()
    health = FakeHealthProbe()
    config = FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=template,
        template_json=str(tpl_file),
        image='img:tag',
        port_start=19000,
        port_end=19999,
        llm_api_key='sk-test',
    )
    # inline 同步执行器：后台任务（_run_create_complete）在 submit 时同步跑完——API 测试
    # 在请求线程内拿到 provisioning 完成后的落盘结果；create() 同步封装语义被原样保留。
    def submit_inline(task, *args):
        task(*args)

    orch = InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health, submit_task=submit_inline,
    )
    Fleet.override(orch)
    yield {'orch': orch, 'runtime': runtime, 'health': health, 'config': config}
    Fleet.reset()
