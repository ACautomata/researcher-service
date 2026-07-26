"""models app —— 每容器 OpenClaw model provider 记账（spec §7 / §10，r28）。

ModelProvider 是 DB 单一来源：CRUD 改它 → InstanceOrchestrator.rewrite_config 重渲染
openclaw.json 的 models.providers + agents.defaults.model → OpenClaw watch 热加载生效。

字段（spec §10）：instance(FK CASCADE) / provider_id / api / base_url / api_key_env_id /
auth_header / models_json(JSON) / created_at。unique(instance, provider_id) 防同容器重名 provider。

零信任（spec §4）：provider_id（进 openclaw.json map key + <pid>/<mid> 引用）与
api_key_env_id（SecretRef env 变量名）各经 RegexValidator 拒非法形态。api 走 choices 限两值
（r28 §1.3：仅暴露 openai-completions / anthropic-messages 两个稳定取值）。
"""
from django.core.validators import RegexValidator
from django.db import models

from containers.models import Instance
from models.config_builder import ProviderSpec

# r28 §1.3：CRUD 表单只暴露这两个稳定取值
API_OPENAI = 'openai-completions'
API_ANTHROPIC = 'anthropic-messages'
API_CHOICES = [
    (API_OPENAI, 'openai-completions'),
    (API_ANTHROPIC, 'anthropic-messages'),
]

# provider_id = openclaw.json models.providers 的 map key（r28 §1：minimax / vllm / my-proxy），
# 亦拼成 <pid>/<mid> 引用进 agents.defaults.model。须小写 DNS-label 风格：禁路径分隔符 / 大写 / 数字开头。
PROVIDER_ID_VALIDATOR = RegexValidator(
    regex=r'^[a-z][a-z0-9-]{0,63}$',
    message='provider_id 须以小写字母开头，1–64 位，仅含小写字母、数字、连字符',
)

# r28 §2.1：SecretRef.id = env 变量名，须 ^[A-Z][A-Z0-9_]{0,127}$
ENV_ID_VALIDATOR = RegexValidator(
    regex=r'^[A-Z][A-Z0-9_]{0,127}$',
    message='apiKey env id 须大写字母开头，仅含大写字母、数字、下划线',
)

# 容器进程实际持有的凭证 env（spec §5.2：全面板共享一个 LLM_API_KEY；DockerRuntime 仅注入它）。
# 容器 env 在 docker run 时固定，OpenClaw watch 热加载无法新增 env（#36 已证：缺 env 则 reload
# 失败停留 last-known-good）—— 故 SecretRef.id 只能引用已注入的 env。API 层据此收紧（builder
# 层仍 env-agnostic，便于未来 fleet 注入更多 env 时仅放宽本集合）。
ALLOWED_API_KEY_ENV_IDS = frozenset({'LLM_API_KEY'})


class ModelProvider(models.Model):
    """一个容器的一个 model provider 行（DB 单一来源，spec §10）。"""

    instance = models.ForeignKey(
        Instance, on_delete=models.CASCADE, related_name='model_providers',
    )
    provider_id = models.CharField(max_length=64, validators=[PROVIDER_ID_VALIDATOR])
    api = models.CharField(max_length=32, choices=API_CHOICES)
    base_url = models.CharField(max_length=512)
    # SecretRef.id（env 变量名），不存真 key（r28 §2：只存 marker 不落明文）
    api_key_env_id = models.CharField(max_length=128, validators=[ENV_ID_VALIDATOR])
    auth_header = models.BooleanField(default=True)
    # r28 §1.2 模型条目列表：每项 {id,name,reasoning,input[],cost{},contextWindow,maxTokens}
    models_json = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = (
            models.UniqueConstraint(
                fields=['instance', 'provider_id'],
                name='unique_instance_provider_id',
            ),
        )
        ordering = ('created_at', 'id')

    def __str__(self) -> str:
        return f'{self.instance_id}/{self.provider_id}'

    def as_spec(self) -> ProviderSpec:
        """转 ProviderConfigBuilder 输入契约（models_json 原样落盘为 models[]）。"""
        return ProviderSpec(
            provider_id=self.provider_id,
            api=self.api,
            base_url=self.base_url,
            api_key_env_id=self.api_key_env_id,
            auth_header=self.auth_header,
            models=list(self.models_json or []),
        )
