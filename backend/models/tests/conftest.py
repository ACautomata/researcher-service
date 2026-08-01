"""models API 测试共享 fixture：Fleet.override 注入 FakeRuntime + authed APIClient。

照 containers/tests/conftest.py 的 fleet fixture（models API 测试需真实 instance 落盘 +
openclaw.json 可写，以验收「CRUD 后重渲染生效」）。api/authed 照 containers/tests/test_api.py。
#297 异步化：注入 inline 同步 executor，使后台 provisioning 在请求线程同步跑完——
demo_instance fixture 拿到落盘结果后，models CRUD 用例才能经 API 触达 config 重渲染。
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from containers.orchestrator import Fleet, FleetConfig, InstanceOrchestrator
from containers.tests.fakes import FakeHealthProbe, FakeRuntime

User = get_user_model()


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
    # inline 同步执行器（对齐 containers/tests/conftest.py）：后台任务在 submit 时同步跑完，
    # models 用例的落盘/状态断言拿到 provisioning 完成后的结果。
    def submit_inline(task, *args):
        task(*args)

    orch = InstanceOrchestrator(
        runtime=runtime, config=config, health_probe=health, submit_task=submit_inline,
    )
    Fleet.override(orch)
    yield {'orch': orch, 'runtime': runtime, 'health': health, 'config': config}
    Fleet.reset()


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def authed(api):
    user = User.objects.create_user(username='alice', password='strong-pass-1')
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def demo_instance(authed, fleet):
    """经 API 建一个容器 demo，返回其 name（带真实落盘目录 + openclaw.json）。

    #297 异步化：POST 返 202（同步预占 creating 行）；inline executor 使后台 provisioning
    在请求内同步跑完，随后行已 running（models CRUD 用例触达 config 重渲染的前提）。
    """
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 202
    return 'demo'
