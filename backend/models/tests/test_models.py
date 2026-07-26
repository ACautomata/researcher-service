"""seam: ModelProvider Django model —— 每容器 model provider 记账（spec §10）。

DB 为单一来源（渲染到 openclaw.json 经热加载生效，spec §7）。字段照 spec §10：
instance(FK CASCADE) / provider_id / api / base_url / api_key_env_id / auth_header /
models_json(JSON) / created_at；unique(instance, provider_id)。
"""
import pytest

from containers.models import Instance
from models.config_builder import ProviderSpec
from models.models import (
    API_ANTHROPIC,
    API_OPENAI,
    ENV_ID_VALIDATOR,
    PROVIDER_ID_VALIDATOR,
    ModelProvider,
)


@pytest.fixture
def instance(db):
    return Instance.objects.create(
        name='demo', port=19000, token='gw-tok',
        home_dir='/tmp/demo/home', container_id='cid',
        status=Instance.STATUS_RUNNING, image='img:tag',
    )


def _provider(instance, **kw):
    defaults = {
        'instance': instance, 'provider_id': 'my-openai', 'api': API_OPENAI,
        'base_url': 'https://open.bigmodel.cn/api/paas/v4',
        'api_key_env_id': 'ZHIPU_API_KEY', 'auth_header': True,
        'models_json': [{'id': 'glm-4-plus', 'name': 'GLM-4 Plus'}],
    }
    defaults.update(kw)
    return ModelProvider.objects.create(**defaults)


@pytest.mark.django_db
def test_create_round_trips_fields(instance):
    p = _provider(instance)
    assert p.provider_id == 'my-openai'
    assert p.api == API_OPENAI
    assert p.base_url == 'https://open.bigmodel.cn/api/paas/v4'
    assert p.api_key_env_id == 'ZHIPU_API_KEY'
    assert p.auth_header is True
    assert p.models_json == [{'id': 'glm-4-plus', 'name': 'GLM-4 Plus'}]
    assert p.created_at is not None


@pytest.mark.django_db
def test_unique_instance_provider_id(instance):
    _provider(instance, provider_id='dup')
    with pytest.raises(Exception):
        _provider(instance, provider_id='dup')


@pytest.mark.django_db
def test_same_provider_id_allowed_across_instances(instance, db):
    other = Instance.objects.create(
        name='other', port=19001, token='t2', home_dir='/tmp/other/home',
        container_id='', status=Instance.STATUS_RUNNING, image='img:tag',
    )
    _provider(instance, provider_id='shared')
    _provider(other, provider_id='shared')  # 不同容器可同名 provider
    assert ModelProvider.objects.count() == 2


@pytest.mark.django_db
def test_cascade_delete_with_instance(instance):
    _provider(instance)
    assert ModelProvider.objects.count() == 1
    instance.delete()
    assert ModelProvider.objects.count() == 0


@pytest.mark.django_db
def test_as_spec_returns_provider_spec_with_parsed_models(instance):
    p = _provider(instance, api=API_ANTHROPIC, models_json=[
        {'id': 'm1', 'name': 'M1', 'reasoning': True},
    ])
    spec = p.as_spec()
    assert isinstance(spec, ProviderSpec)
    assert spec.provider_id == 'my-openai'
    assert spec.api == API_ANTHROPIC
    assert spec.models == [{'id': 'm1', 'name': 'M1', 'reasoning': True}]


def test_validators_reject_invalid_shapes():
    with pytest.raises(Exception):
        PROVIDER_ID_VALIDATOR('Bad/Name')      # 大写/分隔符
    with pytest.raises(Exception):
        PROVIDER_ID_VALIDATOR('1starts-digit')  # 数字开头
    PROVIDER_ID_VALIDATOR('my-openai')         # 合法不抛
    with pytest.raises(Exception):
        ENV_ID_VALIDATOR('lowercase')          # 必须 [A-Z] 开头
    ENV_ID_VALIDATOR('LLM_API_KEY')            # 合法不抛
