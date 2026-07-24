"""containers API 测试共享 fixture：Fleet.override 注入 FakeRuntime 编排层。

API 测试不碰真 docker daemon；orchestrator 用 tmp 目录 + FakeRuntime + FakeHealthProbe。
"""
import pytest

from containers.orchestrator import Fleet, FleetConfig, InstanceOrchestrator
from containers.tests.fakes import FakeHealthProbe, FakeRuntime


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
    orch = InstanceOrchestrator(runtime=runtime, config=config, health_probe=health)
    Fleet.override(orch)
    yield {'orch': orch, 'runtime': runtime, 'health': health, 'config': config}
    Fleet.reset()
