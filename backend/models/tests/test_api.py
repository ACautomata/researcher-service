"""seam: models REST API —— 每容器 model provider CRUD（spec §7 / issue #47）。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §3（全局 IsAuthenticated）/§4（零信任，经 Serializer）/
§7（API：GET/POST/PUT/DELETE /containers/<name>/models/providers[/<pid>]，写后重渲染热加载）。

端点（挂在 /api/v1/containers/<name>/models/）：
  GET/POST        providers/          —— 列表 / 新建
  GET/PUT/DELETE  providers/<pid>/    —— 回读 / 改 / 删（连级联清理 + 重渲染）
fleet fixture（本 conftest）注入 FakeRuntime，写盘验收 instances/<name>/openclaw.json。
"""
import json

import pytest

PROVIDERS = '/api/v1/containers/demo/models/providers/'
_VALID = {
    'provider_id': 'my-openai',
    'api': 'openai-completions',
    'base_url': 'https://open.bigmodel.cn/api/paas/v4',
    'api_key_env_id': 'LLM_API_KEY',
    'auth_header': True,
    'models': [{'id': 'glm-4-plus', 'name': 'GLM-4 Plus', 'reasoning': False,
                'input': ['text'], 'contextWindow': 131072, 'maxTokens': 8192}],
}


def _config_file(fleet, name='demo'):
    return json.loads(
        (fleet['config'].root / 'instances' / name / 'openclaw.json').read_text()
    )


# ---------------------------- 认证拦截（spec §3）----------------------------


@pytest.mark.django_db
def test_list_requires_auth(api):
    assert api.get(PROVIDERS).status_code == 401


@pytest.mark.django_db
def test_create_requires_auth(api):
    assert api.post(PROVIDERS, _VALID, format='json').status_code == 401


@pytest.mark.django_db
def test_delete_requires_auth(api):
    assert api.delete(PROVIDERS + 'x/').status_code == 401


# ---------------------------- 列表 / 新建 ----------------------------


@pytest.mark.django_db
def test_list_empty(authed, demo_instance):
    assert authed.get(PROVIDERS).json() == []


@pytest.mark.django_db
def test_create_returns_provider_and_rewrites_config(authed, fleet, demo_instance):
    resp = authed.post(PROVIDERS, _VALID, format='json')
    assert resp.status_code == 201
    data = resp.json()
    assert data['provider_id'] == 'my-openai'
    assert data['api'] == 'openai-completions'
    assert data['api_key_env_id'] == 'LLM_API_KEY'   # 仅 env id（marker）
    assert 'api_key' not in data                         # 无明文字段
    # 验收：保存即重渲染生效
    cfg = _config_file(fleet)
    prov = cfg['models']['providers']['my-openai']
    assert prov['api'] == 'openai-completions'
    assert prov['apiKey'] == {'source': 'env', 'provider': 'default', 'id': 'LLM_API_KEY'}
    assert cfg['agents']['defaults']['model']['primary'] == 'my-openai/glm-4-plus'


@pytest.mark.django_db
def test_list_shows_created_provider(authed, demo_instance):
    authed.post(PROVIDERS, _VALID, format='json')
    items = authed.get(PROVIDERS).json()
    assert len(items) == 1
    assert items[0]['provider_id'] == 'my-openai'


@pytest.mark.django_db
def test_create_rejects_invalid_payload(authed, demo_instance):
    bad = dict(_VALID, api='bogus')
    assert authed.post(PROVIDERS, bad, format='json').status_code == 400


@pytest.mark.django_db
def test_create_rejects_duplicate_provider_id(authed, demo_instance):
    authed.post(PROVIDERS, _VALID, format='json')
    resp = authed.post(PROVIDERS, _VALID, format='json')
    # unique(instance, provider_id) → 409
    assert resp.status_code == 409


@pytest.mark.django_db
def test_create_on_missing_instance_returns_404(authed):
    resp = authed.post('/api/v1/containers/nope/models/providers/', _VALID, format='json')
    assert resp.status_code == 404


@pytest.mark.django_db
def test_create_rejects_invalid_name(authed):
    resp = authed.post('/api/v1/containers/Bad..Name/models/providers/', _VALID, format='json')
    assert resp.status_code == 400


# ---------------------------- 回读 / 改 / 删 ----------------------------


@pytest.mark.django_db
def test_get_single_provider(authed, demo_instance):
    authed.post(PROVIDERS, _VALID, format='json')
    resp = authed.get(PROVIDERS + 'my-openai/')
    assert resp.status_code == 200
    assert resp.json()['provider_id'] == 'my-openai'


@pytest.mark.django_db
def test_get_unknown_provider_returns_404(authed, demo_instance):
    assert authed.get(PROVIDERS + 'nope/').status_code == 404


@pytest.mark.django_db
def test_put_updates_and_rewrites_config(authed, fleet, demo_instance):
    authed.post(PROVIDERS, _VALID, format='json')
    update = dict(_VALID, base_url='https://api.deepseek.com/v1',
                  models=[{'id': 'deepseek-chat', 'name': 'DeepSeek Chat'}])
    resp = authed.put(PROVIDERS + 'my-openai/', update, format='json')
    assert resp.status_code == 200
    cfg = _config_file(fleet)
    prov = cfg['models']['providers']['my-openai']
    assert prov['baseUrl'] == 'https://api.deepseek.com/v1'
    assert prov['apiKey']['id'] == 'LLM_API_KEY'
    assert cfg['agents']['defaults']['model']['primary'] == 'my-openai/deepseek-chat'


@pytest.mark.django_db
def test_put_change_provider_id_rewrites_refs(authed, fleet, demo_instance):
    # 改 provider_id（PUT 用路径 pid 定位，body 给新 pid）—— 重渲染后引用随之更新
    authed.post(PROVIDERS, _VALID, format='json')
    update = dict(_VALID, provider_id='renamed',
                  models=[{'id': 'g', 'name': 'G'}])
    resp = authed.put(PROVIDERS + 'my-openai/', update, format='json')
    assert resp.status_code == 200
    cfg = _config_file(fleet)
    assert 'my-openai' not in cfg['models']['providers']
    assert 'renamed' in cfg['models']['providers']
    assert cfg['agents']['defaults']['model']['primary'] == 'renamed/g'


@pytest.mark.django_db
def test_put_colliding_provider_id_returns_409(authed, demo_instance):
    # PUT 改 provider_id 撞同容器既有 pid（unique 约束）→ 409，非裸 500
    authed.post(PROVIDERS, _VALID, format='json')                      # my-openai
    authed.post(PROVIDERS, dict(_VALID, provider_id='backup'), format='json')
    collide = dict(_VALID, provider_id='backup')                       # 想把 my-openai 改成 backup
    resp = authed.put(PROVIDERS + 'my-openai/', collide, format='json')
    assert resp.status_code == 409


@pytest.mark.django_db
def test_delete_removes_provider_and_cascades(authed, fleet, demo_instance):
    authed.post(PROVIDERS, _VALID, format='json')
    resp = authed.delete(PROVIDERS + 'my-openai/')
    assert resp.status_code == 204
    # 列表已空
    assert authed.get(PROVIDERS).json() == []
    # 重渲染后：providers 无残留，agents.defaults.model 不含悬空引用
    cfg = _config_file(fleet)
    providers = cfg.get('models', {}).get('providers', {})
    assert 'my-openai' not in providers
    assert 'my-openai/' not in json.dumps(cfg.get('agents', {}).get('defaults', {}))


@pytest.mark.django_db
def test_delete_unknown_provider_returns_404(authed, demo_instance):
    assert authed.delete(PROVIDERS + 'nope/').status_code == 404


@pytest.mark.django_db
def test_two_providers_primary_and_fallback(authed, fleet, demo_instance):
    authed.post(PROVIDERS, _VALID, format='json')
    second = dict(_VALID, provider_id='backup', api='anthropic-messages',
                  models=[{'id': 'm', 'name': 'M'}])
    authed.post(PROVIDERS, second, format='json')
    cfg = _config_file(fleet)
    model = cfg['agents']['defaults']['model']
    assert model['primary'] == 'my-openai/glm-4-plus'
    assert model['fallbacks'] == ['backup/m']


# ---------------------------- codex #65 意见3：rewrite 失败回滚 DB ----------------------------


@pytest.mark.django_db
def test_create_rolls_back_db_when_config_write_fails(authed, fleet, demo_instance, monkeypatch):
    # rewrite 写盘失败 → DB 须回滚（无 orphan provider 行）+ 503，非裸 500；文件停留在上一份
    from containers.orchestrator import ConfigWriteError
    monkeypatch.setattr(
        fleet['orch'], 'rewrite_config',
        lambda name: (_ for _ in ()).throw(ConfigWriteError(name, '/x/openclaw.json')),
    )
    resp = authed.post(PROVIDERS, _VALID, format='json')
    assert resp.status_code == 503
    # 无 orphan：列表仍空
    assert authed.get(PROVIDERS).json() == []


@pytest.mark.django_db
def test_delete_rolls_back_db_when_config_write_fails(authed, fleet, demo_instance, monkeypatch):
    from containers.orchestrator import ConfigWriteError
    authed.post(PROVIDERS, _VALID, format='json')
    monkeypatch.setattr(
        fleet['orch'], 'rewrite_config',
        lambda name: (_ for _ in ()).throw(ConfigWriteError(name, '/x/openclaw.json')),
    )
    resp = authed.delete(PROVIDERS + 'my-openai/')
    assert resp.status_code == 503
    # DB 回滚：provider 仍在
    assert len(authed.get(PROVIDERS).json()) == 1


@pytest.mark.django_db
def test_rewrite_failure_leaves_existing_config_intact(fleet, demo_instance):
    # 原子写：rewrite 写盘失败不污染既有 openclaw.json（先写一份合法配置，再让它「写盘失败」）
    import json as _json
    from containers.models import Instance
    from models.models import API_OPENAI, ModelProvider
    cfg_path = fleet['config'].root / 'instances' / 'demo' / 'openclaw.json'
    good = _json.loads(cfg_path.read_text())  # create 时落盘的合法配置
    inst = Instance.objects.get(name='demo')

    class _BoomBuilder:
        def build(self, base, providers):
            raise OSError('disk full')  # 模拟 tmp.write_text 失败
    fleet['orch']._provider_builder = _BoomBuilder()
    ModelProvider.objects.create(
        instance=inst, provider_id='p', api=API_OPENAI, base_url='https://x/v1',
        api_key_env_id='LLM_API_KEY', models_json=[{'id': 'm', 'name': 'M'}],
    )
    import pytest as _pytest
    with _pytest.raises(Exception):
        fleet['orch'].rewrite_config('demo')
    # 既有 openclaw.json 原样保留（未被截断/污染）
    assert _json.loads(cfg_path.read_text()) == good
    # 残留 tmp 已清
    assert not cfg_path.with_name(cfg_path.name + '.tmp').exists()
