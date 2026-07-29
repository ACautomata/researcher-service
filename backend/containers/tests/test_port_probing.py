"""seam: issue #201 问题 2 —— 端口分配 O(1) 级：仅对候选端口做宿主 bind 校验。

原 _used_ports 每次 create 对全池 19000–19999 约 1000 口逐个 socket bind 探测，
阻塞单根 REST 视图线程。修复后：已用集 = DB 记账 ∪ fleet 容器 label 端口，
bind 实测只对 allocator 给出的候选做（被占则换下一候选，行为等价）。
"""
import pytest

from containers.orchestrator import FleetConfig, InstanceOrchestrator
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
        port_end=19999,   # 全池 1000 口：旧实现每次 create 探测 ~1000 次
        llm_api_key='sk-test',
    )


@pytest.fixture
def health():
    return FakeHealthProbe()


@pytest.mark.django_db
def test_create_does_not_probe_full_port_pool(config, health, tmp_path):
    # 端口分配不再对全池 1000 口 bind 探测——仅校验 allocator 给出的候选。
    _seed_template(tmp_path / 'template')
    runtime = FakeRuntime()
    probe_calls = []

    def probe(port):
        probe_calls.append(port)
        return False

    orch = InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health, port_in_use=probe,
    )
    inst = orch.create('demo')
    assert inst.port == 19000
    # 仅候选端口 1 次校验（旧实现 = 全池约 1000 次探测）
    assert probe_calls == [19000]


@pytest.mark.django_db
def test_create_candidate_probe_skips_occupied_only(config, health, tmp_path):
    # 候选被占只多探下一候选（行为等价于旧全池探测的跳过语义）。
    _seed_template(tmp_path / 'template')
    runtime = FakeRuntime()
    probe_calls = []

    def probe(port):
        probe_calls.append(port)
        return port == 19000   # 模拟 19000 宿主被占

    orch = InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health, port_in_use=probe,
    )
    inst = orch.create('demo')
    assert inst.port == 19001
    assert probe_calls == [19000, 19001]
