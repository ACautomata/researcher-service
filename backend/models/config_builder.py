"""ProviderConfigBuilder —— openclaw.json models.providers 合并纯逻辑（spec §7 / r28）。

纯领域逻辑（无 IO / 无 Django）：消费 ProviderSpec 列表，把 DB model provider 合并进
base openclaw.json cfg，供 InstanceOrchestrator 写盘经 OpenClaw watch 热加载生效。

规则（r28）：
- 空 providers → base 透传（P0 兼容：无托管 provider 时沿用模板默认 minimax）。
- 非空 → DB provider **全量替换** models.providers（DB 单一来源）；agents.defaults.model
  按入参序重算 primary/fallbacks 与 agents.defaults.models 别名 —— 删除任一 provider
  后天然无悬空引用（级联清理）。
- apiKey 永远写 SecretRef {source:env, provider:default, id:<env_id>}，**不落明文**（r28 §2）。
- api 取值（openai-completions / anthropic-messages）由 serializer 校验后经 ProviderSpec.api 原样写入。
"""
import copy
from dataclasses import dataclass

# SecretRef.provider 固定引用 deploy/openclaw.json 既有的 secrets.providers.default（r28 §2.1）
DEFAULT_SECRET_PROVIDER = 'default'


@dataclass(frozen=True)
class ProviderSpec:
    """ProviderConfigBuilder 的输入契约（与 Django ModelProvider 解耦，便于纯单测）。

    models 为已校验的模型条目列表，每项形如
    {id, name, reasoning, input[], cost{input,output,cacheRead,cacheWrite},
     contextWindow, maxTokens}（r28 §1.2，落盘时按 provider 形态原样输出）。
    """

    provider_id: str
    api: str                       # openai-completions | anthropic-messages
    base_url: str
    api_key_env_id: str            # SecretRef.id（env 变量名）
    auth_header: bool
    models: list[dict]


class ProviderConfigBuilder:
    """把 base openclaw.json cfg 与 DB providers 合并为可写盘的 cfg dict。"""

    def build(self, base_cfg: dict, providers: list[ProviderSpec]) -> dict:
        cfg = copy.deepcopy(base_cfg)
        if not providers:
            return cfg
        providers_map: dict[str, dict] = {}
        refs: list[str] = []        # "<pid>/<mid>" 按序
        aliases: dict[str, dict] = {}
        for spec in providers:
            providers_map[spec.provider_id] = self._render_provider(spec)
            for model in spec.models:
                ref = f'{spec.provider_id}/{model["id"]}'
                refs.append(ref)
                aliases[ref] = {'alias': model.get('name') or model['id']}
        cfg.setdefault('models', {})['providers'] = providers_map
        defaults = cfg.setdefault('agents', {}).setdefault('defaults', {})
        defaults['model'] = {'primary': refs[0], 'fallbacks': refs[1:]}
        defaults['models'] = aliases
        return cfg

    def _render_provider(self, spec: ProviderSpec) -> dict:
        return {
            'baseUrl': spec.base_url,
            'apiKey': {
                'source': 'env',
                'provider': DEFAULT_SECRET_PROVIDER,
                'id': spec.api_key_env_id,
            },
            'api': spec.api,
            'authHeader': spec.auth_header,
            'models': [copy.deepcopy(m) for m in spec.models],
        }
