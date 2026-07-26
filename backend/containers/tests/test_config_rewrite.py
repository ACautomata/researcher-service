"""seam: InstanceOrchestrator.rewrite_config —— model CRUD 后重渲染 openclaw.json（spec §7）。

DB（ModelProvider）改后重渲染该容器 instances/<name>/openclaw.json，经 OpenClaw watch 热加载
生效（#36 已证：无需 restart）。复用 containers conftest 的 fleet fixture（FakeRuntime + tmp root）。
"""
import json

import pytest

from containers.orchestrator import InstanceNotFound
from models.models import API_ANTHROPIC, API_OPENAI, ModelProvider


def _make_provider(inst, pid='my-openai', api=API_OPENAI, **kw):
    return ModelProvider.objects.create(
        instance=inst, provider_id=pid, api=api,
        base_url=kw.get('base_url', 'https://x/v1'),
        api_key_env_id=kw.get('env', 'ZHIPU_API_KEY'),
        auth_header=True,
        models_json=kw.get('models', [{'id': 'g', 'name': 'G'}]),
    )


def _config(fleet, name):
    return json.loads(
        (fleet['config'].root / 'instances' / name / 'openclaw.json').read_text(),
    )


@pytest.mark.django_db
def test_rewrite_no_providers_preserves_base_invariants(fleet):
    # 无托管 provider → base 透传，gateway 安全不变量仍强制（spec §5.2）
    fleet['orch'].create('demo')
    fleet['orch'].rewrite_config('demo')
    cfg = _config(fleet, 'demo')
    assert cfg['gateway']['port'] == 18789
    assert cfg['gateway']['bind'] == 'lan'
    assert cfg['gateway']['auth']['token'] == '${GATEWAY_TOKEN}'


@pytest.mark.django_db
def test_rewrite_writes_provider_into_config_file(fleet):
    inst = fleet['orch'].create('demo')
    _make_provider(
        inst, pid='my-openai', api=API_OPENAI, env='ZHIPU_API_KEY',
        base_url='https://open.bigmodel.cn/api/paas/v4',
        models=[{'id': 'glm-4-plus', 'name': 'GLM-4 Plus'}],
    )
    fleet['orch'].rewrite_config('demo')
    cfg = _config(fleet, 'demo')
    prov = cfg['models']['providers']['my-openai']
    assert prov['api'] == 'openai-completions'                       # r28 修正点
    assert prov['baseUrl'] == 'https://open.bigmodel.cn/api/paas/v4'
    assert prov['apiKey'] == {'source': 'env', 'provider': 'default', 'id': 'ZHIPU_API_KEY'}
    assert cfg['agents']['defaults']['model']['primary'] == 'my-openai/glm-4-plus'


@pytest.mark.django_db
def test_rewrite_after_delete_has_no_dangling_refs(fleet):
    inst = fleet['orch'].create('demo')
    a = _make_provider(inst, pid='pa', api=API_ANTHROPIC, env='AA_KEY',
                       models=[{'id': 'a1', 'name': 'A1'}])
    _make_provider(inst, pid='pb', api=API_OPENAI, env='BB_KEY',
                   models=[{'id': 'b1', 'name': 'B1'}])
    fleet['orch'].rewrite_config('demo')
    a.delete()                                                        # 删 primary
    fleet['orch'].rewrite_config('demo')
    cfg = _config(fleet, 'demo')
    assert 'pa' not in cfg['models']['providers']
    # primary/fallbacks/aliases 全部不含已删 provider（spec 验收：无悬空引用）
    model = cfg['agents']['defaults']['model']
    assert model['primary'] == 'pb/b1'
    assert 'pa/' not in json.dumps(cfg['agents']['defaults'])


@pytest.mark.django_db
def test_rewrite_creates_config_dir_if_missing(fleet):
    # 容器行存在但 openclaw.json 尚未落盘（如直建 Instance 行）时，rewrite 仍可写
    from containers.models import Instance
    inst = Instance.objects.create(
        name='solo', port=19001, token='t', home_dir=str(fleet['config'].root / 'instances' / 'solo' / 'home'),
        container_id='', status=Instance.STATUS_RUNNING, image='img:tag',
    )
    _make_provider(inst, pid='p', models=[{'id': 'm', 'name': 'M'}])
    fleet['orch'].rewrite_config('solo')
    cfg = _config(fleet, 'solo')
    assert 'p' in cfg['models']['providers']


@pytest.mark.django_db
def test_rewrite_missing_instance_raises(fleet):
    with pytest.raises(InstanceNotFound):
        fleet['orch'].rewrite_config('nope')
