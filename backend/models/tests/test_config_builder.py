"""seam: ProviderConfigBuilder —— openclaw.json models.providers 合并纯逻辑（spec §7 / r28）。

消费 ProviderSpec 列表，把 DB model provider 合并进 base openclaw.json cfg：
- 空 providers → base 透传（P0 兼容：无托管 provider 时沿用模板默认）。
- 非空 → 全量替换 models.providers（DB 单一来源）；agents.defaults.model 按序重算
  primary/fallbacks/aliases —— 删除任一 provider 天然无悬空引用。
- apiKey 永远写 SecretRef {source:env,provider:default,id:<env_id>}，不落明文（r28 §2）。
- api 取值（openai-completions/anthropic-messages）经 serializer 校验后原样写入。
"""
import copy

from models.config_builder import ProviderConfigBuilder, ProviderSpec


def _spec(pid='my-anthropic', api='anthropic-messages', base_url='https://x/anthropic',  # pylint: disable=too-many-positional-arguments
          env='LLM_API_KEY', auth=True, models=None):
    return ProviderSpec(
        provider_id=pid,
        api=api,
        base_url=base_url,
        api_key_env_id=env,
        auth_header=auth,
        models=models if models is not None else [{'id': 'm1', 'name': 'M1'}],
    )


# ---------------------------- 空 providers：透传 ----------------------------


def test_empty_providers_passes_base_through():
    base = {'models': {'mode': 'merge', 'providers': {'minimax': {'api': 'anthropic-messages'}}},
            'agents': {'defaults': {'model': {'primary': 'minimax/x'}}}}
    out = ProviderConfigBuilder().build(base, [])
    # 深拷贝：不 mutate 入参
    assert out == base
    assert out is not base


def test_empty_providers_does_not_mutate_input():
    base = {'models': {'providers': {'minimax': {}}}}
    snapshot = copy.deepcopy(base)
    ProviderConfigBuilder().build(base, [])
    assert base == snapshot


# ---------------------------- 单 provider：完整形态 + SecretRef ----------------------------


def test_single_anthropic_provider_renders_full_shape():
    base = {'secrets': {'providers': {'default': {'source': 'env'}}}}
    out = ProviderConfigBuilder().build(base, [_spec(
        pid='my-anthropic', api='anthropic-messages',
        base_url='https://api.minimaxi.com/anthropic', env='LLM_API_KEY',
        models=[{'id': 'MiniMax-M3', 'name': 'MiniMax M3', 'reasoning': True,
                 'input': ['text', 'image'], 'cost': {'input': 0.3, 'output': 1.2,
                 'cacheRead': 0.06, 'cacheWrite': 0.375},
                 'contextWindow': 1048576, 'maxTokens': 524288}],
    )])
    prov = out['models']['providers']['my-anthropic']
    # r28 §1.1 provider 级字段
    assert prov['baseUrl'] == 'https://api.minimaxi.com/anthropic'
    assert prov['api'] == 'anthropic-messages'
    assert prov['authHeader'] is True
    assert prov['models'][0]['id'] == 'MiniMax-M3'
    # r28 §2：apiKey 必为 SecretRef，不落明文
    assert prov['apiKey'] == {'source': 'env', 'provider': 'default', 'id': 'LLM_API_KEY'}
    assert not isinstance(prov['apiKey'], str)


def test_single_provider_sets_primary_and_empty_fallbacks():
    out = ProviderConfigBuilder().build({}, [_spec(pid='p', models=[{'id': 'm', 'name': 'M'}])])
    model = out['agents']['defaults']['model']
    assert model['primary'] == 'p/m'
    assert model['fallbacks'] == []
    assert out['agents']['defaults']['models'] == {'p/m': {'alias': 'M'}}


# ---------------------------- api 取值：openai vs anthropic（r28 修正点）-----------------------------


def test_openai_provider_writes_openai_completions_api():
    # r28 §6 修正点：openai-compatible 必须写 openai-completions，旧 _infer_provider 写死 anthropic-messages 是 bug
    out = ProviderConfigBuilder().build({}, [_spec(api='openai-completions')])
    assert out['models']['providers']['my-anthropic']['api'] == 'openai-completions'


def test_anthropic_provider_writes_anthropic_messages_api():
    out = ProviderConfigBuilder().build({}, [_spec(api='anthropic-messages')])
    assert out['models']['providers']['my-anthropic']['api'] == 'anthropic-messages'


# ---------------------------- 多 provider：primary/fallbacks 顺序 ----------------------------


def test_multiple_providers_primary_first_rest_fallbacks():
    a = _spec(pid='pa', models=[{'id': 'a1', 'name': 'A1'}])
    b = _spec(pid='pb', models=[{'id': 'b1', 'name': 'B1'}, {'id': 'b2', 'name': 'B2'}])
    out = ProviderConfigBuilder().build({}, [a, b])
    model = out['agents']['defaults']['model']
    # 入参序决定 primary/fallbacks；多模型 provider 展开为多个 ref
    assert model['primary'] == 'pa/a1'
    assert model['fallbacks'] == ['pb/b1', 'pb/b2']
    assert out['agents']['defaults']['models'] == {
        'pa/a1': {'alias': 'A1'}, 'pb/b1': {'alias': 'B1'}, 'pb/b2': {'alias': 'B2'},
    }


# ---------------------------- 删除级联：无悬空引用 ----------------------------


def test_deleted_provider_leaves_no_dangling_references():
    # 模拟「先有两个 provider，删除第一个」：重新 build 后 primary/fallbacks/aliases 里不得出现被删 pid
    a = _spec(pid='pa', models=[{'id': 'a1', 'name': 'A1'}])
    b = _spec(pid='pb', models=[{'id': 'b1', 'name': 'B1'}])
    out = ProviderConfigBuilder().build({}, [b])  # 仅剩 b
    providers = out['models']['providers']
    assert 'pa' not in providers and 'pb' in providers
    model = out['agents']['defaults']['model']
    assert model['primary'] == 'pb/b1'
    assert 'pa/' not in str(model) and 'pa/' not in str(out['agents']['defaults']['models'])


# ---------------------------- 非空替换模板 providers（DB 单一来源）-----------------------------


def test_managed_providers_replace_template_providers():
    base = {'models': {'mode': 'merge', 'providers': {'minimax': {'api': 'anthropic-messages'}}},
            'agents': {'defaults': {'model': {'primary': 'minimax/MiniMax-M3'}}}}
    out = ProviderConfigBuilder().build(base, [_spec(pid='my-openai', api='openai-completions',
                                                     models=[{'id': 'g', 'name': 'G'}])])
    # 模板里的 minimax 被全量替换；mode 保留
    assert out['models']['mode'] == 'merge'
    assert list(out['models']['providers'].keys()) == ['my-openai']
    # agents.defaults.model 重算，不残留 minimax
    assert out['agents']['defaults']['model']['primary'] == 'my-openai/g'


def test_apikey_never_plaintext_even_if_env_id_looks_like_value():
    # 防御：env id 是变量名，不是 key 本体；输出必须仍是 SecretRef 结构
    out = ProviderConfigBuilder().build({}, [_spec(env='MY_PROVIDER_KEY')])
    assert out['models']['providers']['my-anthropic']['apiKey'] == {
        'source': 'env', 'provider': 'default', 'id': 'MY_PROVIDER_KEY',
    }
