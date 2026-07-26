"""seam: wiki compile 触发器真实执行路径 —— codex PR #62 意见1（P1）。

回归：`DockerCompileExecutor` 不得引用不存在的 `Fleet.get().client`（InstanceOrchestrator
无公开 client 属性，必抛 AttributeError 被吞，compile 永不执行）。应经 orchestrator 公开
`exec_in_container` 入口（委托 runtime.exec_in_container）。用 FakeRuntime 注入断言 exec 被调用。
"""
import pytest

from containers.models import Instance
from containers.orchestrator import Fleet, FleetConfig, InstanceOrchestrator
from containers.tests.fakes import FakeHealthProbe, FakeRuntime
from wiki.compile import DockerCompileExecutor

pytestmark = pytest.mark.django_db


@pytest.fixture
def fleet(tmp_path):
    template = tmp_path / 'template'
    (template / 'workspace').mkdir(parents=True)
    tpl = tmp_path / 'openclaw.json'
    tpl.write_text('{}')
    runtime = FakeRuntime()
    config = FleetConfig(
        root=tmp_path / 'fleet', template_dir=template, template_json=str(tpl),
        image='img:tag', port_start=19000, port_end=19999, llm_api_key='sk-test',
    )
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=FakeHealthProbe())
    Fleet.override(orch)
    yield runtime
    Fleet.reset()


def test_docker_compile_executor_goes_through_orchestrator(fleet):
    """真实 executor 经 orchestrator.exec_in_container 触发容器内 wiki compile（非 .client）。"""
    inst = Instance.objects.create(
        name='demo', port=19000, token='t', home_dir='/tmp/x',
        container_id='cid', status=Instance.STATUS_RUNNING, image='img:tag',
    )
    DockerCompileExecutor().execute(inst)
    # FakeRuntime 记录 exec 调用：命令含 wiki compile，目标是该实例容器
    assert any('compile' in ' '.join(cmd) for _, cmd in fleet.exec_calls), \
        f'compile 未经 orchestrator exec 触发: {fleet.exec_calls}'


def test_compile_executor_failure_does_not_raise(fleet, monkeypatch):
    """exec 失败 best-effort 不阻断写操作（r29 §2.4）。"""
    def boom(name, cmd):
        raise RuntimeError('daemon down')
    monkeypatch.setattr(Fleet.get(), 'exec_in_container', boom)
    inst = Instance(name='demo', container_id='cid')
    DockerCompileExecutor().execute(inst)  # 不应抛
