"""seam: ModelProviderSerializer —— 写入校验（spec §4 零信任 / §7 字段 / r28 §1）。

api 枚举两值；provider_id / api_key_env_id 各经 RegexValidator；models 至少一条且每条有 id；
base_url 必填。读序列化器回读 apiKey 仅 env id（不落明文）。
"""
import pytest

from models.serializers import ModelProviderReadSerializer, ModelProviderWriteSerializer


def _valid_payload(**over):
    base = {
        'provider_id': 'my-openai',
        'api': 'openai-completions',
        'base_url': 'https://open.bigmodel.cn/api/paas/v4',
        'api_key_env_id': 'ZHIPU_API_KEY',
        'auth_header': True,
        'models': [
            {'id': 'glm-4-plus', 'name': 'GLM-4 Plus', 'reasoning': False,
             'input': ['text'], 'contextWindow': 131072, 'maxTokens': 8192},
        ],
    }
    base.update(over)
    return base


def test_valid_payload_accepted():
    ser = ModelProviderWriteSerializer(data=_valid_payload())
    assert ser.is_valid(), ser.errors


def test_invalid_api_rejected():
    ser = ModelProviderWriteSerializer(data=_valid_payload(api='something-else'))
    assert not ser.is_valid()
    assert 'api' in ser.errors


def test_invalid_provider_id_rejected():
    ser = ModelProviderWriteSerializer(data=_valid_payload(provider_id='Bad/Name'))
    assert not ser.is_valid()
    assert 'provider_id' in ser.errors


def test_invalid_api_key_env_id_rejected():
    # 小写 / 含非法字符 → 拒（env 变量名须大写起）
    ser = ModelProviderWriteSerializer(data=_valid_payload(api_key_env_id='lowercase'))
    assert not ser.is_valid()
    assert 'api_key_env_id' in ser.errors


def test_missing_base_url_rejected():
    payload = _valid_payload()
    del payload['base_url']
    ser = ModelProviderWriteSerializer(data=payload)
    assert not ser.is_valid()
    assert 'base_url' in ser.errors


def test_empty_models_rejected():
    # provider 至少一条 model：无 model 则无法派生 primary 引用（r28 §6）
    ser = ModelProviderWriteSerializer(data=_valid_payload(models=[]))
    assert not ser.is_valid()
    assert 'models' in ser.errors


def test_model_missing_id_rejected():
    ser = ModelProviderWriteSerializer(data=_valid_payload(models=[{'name': 'no-id'}]))
    assert not ser.is_valid()
    assert 'models' in ser.errors


def test_auth_header_defaults_true_when_omitted():
    payload = _valid_payload()
    del payload['auth_header']
    ser = ModelProviderWriteSerializer(data=payload)
    assert ser.is_valid(), ser.errors
    assert ser.validated_data['auth_header'] is True


@pytest.mark.django_db
def test_read_serializer_exposes_env_id_not_plaintext():
    # 回读只暴露 api_key_env_id（marker），无任何明文 key 字段
    from containers.models import Instance
    from models.models import ModelProvider
    inst = Instance.objects.create(
        name='demo', port=19000, token='t', home_dir='/h',
        container_id='', status=Instance.STATUS_RUNNING, image='img',
    )
    p = ModelProvider.objects.create(
        instance=inst, provider_id='p', api='anthropic-messages',
        base_url='https://x', api_key_env_id='LLM_API_KEY',
        models_json=[{'id': 'm', 'name': 'M'}],
    )
    data = ModelProviderReadSerializer(p).data
    assert data['api_key_env_id'] == 'LLM_API_KEY'
    assert 'api_key' not in data          # 绝无明文字段
    assert data['provider_id'] == 'p'
    assert data['models'] == [{'id': 'm', 'name': 'M'}]
