"""integration: 真实 docker daemon 端到端 smoke —— issue #39 验收闭环。

默认 skip（CI 无 daemon / 无模板 / 无镜像）。手动验证 spec §5 真实链路：
  export RUN_INTEGRATION=1
  export OPENCLAW_TEMPLATE_DIR=/path/to/researcher   # git clone ACautomata/researcher
  export OPENCLAW_IMAGE=acautomata/openclaw-docker-cn-im:latest
  export LLM_API_KEY=sk-...
  uv run python -m pytest containers/tests/test_integration.py -v

覆盖：cp -a 预填充 home → 渲染 openclaw.json → docker run → list(running) → delete(连数据删)。
"""
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get('RUN_INTEGRATION'),
    reason='需真 docker daemon + researcher 模板 + 镜像；设 RUN_INTEGRATION=1 启用',
)

BASE_DIR = Path(__file__).resolve().parents[3]


@pytest.mark.django_db
def test_create_list_delete_real_container(tmp_path):
    pytest.importorskip('docker')
    from containers.docker_runtime import DockerRuntime
    from containers.orchestrator import FleetConfig, InstanceOrchestrator

    template_dir = os.environ.get('OPENCLAW_TEMPLATE_DIR')
    if not template_dir or not Path(template_dir).is_dir():
        pytest.skip('需 OPENCLAW_TEMPLATE_DIR 指向 researcher clone')
    image = os.environ.get('OPENCLAW_IMAGE', 'acautomata/openclaw-docker-cn-im:latest')
    config = FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=Path(template_dir),
        template_json=(BASE_DIR / 'deploy' / 'openclaw.json').read_text(),
        image=image,
        port_start=19000,
        port_end=19999,
        llm_api_key=os.environ.get('LLM_API_KEY', ''),
    )
    orch = InstanceOrchestrator(runtime=DockerRuntime(), config=config)

    inst = orch.create('smoke')
    try:
        items = {i['name']: i for i in orch.list()}
        assert inst.name in items
        assert items[inst.name]['status'] == 'running'
        assert items[inst.name]['port'] == inst.port
    finally:
        assert orch.delete('smoke') is True

    # issue #39 验收：删除连数据删，instances/<name>/ 清除
    assert not (tmp_path / 'fleet' / 'instances' / 'smoke').exists()
    assert not __import__('containers.models', fromlist=['Instance']).Instance.objects.filter(
        name='smoke'
    ).exists()
