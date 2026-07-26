"""models 序列化器 —— 写入校验 + 回读（spec §4 零信任 / §7 / r28 §1）。

ModelProviderWriteSerializer：provider_id / api_key_env_id 经 RegexValidator（复用 model 层），
api 走 ChoiceField 限两值（r28 §1.3），base_url 必填，models 至少一条且每条有 id（无 model
则无法派生 primary 引用）。models 整体作为 JSON 落 models_json，逐条只强校验 id——其余字段
（reasoning/input/cost/contextWindow/maxTokens）由前端表单收集、原样透传（r28 §1.2）。

ModelProviderReadSerializer：回读仅暴露 api_key_env_id（marker），**绝无明文 apiKey 字段**
（spec 验收：apiKey 不落明文）。
"""
from rest_framework import serializers

from models.models import (
    ALLOWED_API_KEY_ENV_IDS,
    API_CHOICES,
    ENV_ID_VALIDATOR,
    PROVIDER_ID_VALIDATOR,
    ModelProvider,
)


class ModelProviderWriteSerializer(serializers.Serializer):
    """POST/PUT /containers/<name>/models/providers[/ <pid>] 入参校验。"""

    provider_id = serializers.CharField(max_length=64, validators=[PROVIDER_ID_VALIDATOR])
    api = serializers.ChoiceField(choices=API_CHOICES)
    base_url = serializers.CharField(max_length=512)
    api_key_env_id = serializers.CharField(max_length=128, validators=[ENV_ID_VALIDATOR])
    auth_header = serializers.BooleanField(default=True)
    models = serializers.JSONField()

    def validate_api_key_env_id(self, value: str) -> str:
        # 容器仅注入 ALLOWED_API_KEY_ENV_IDS（spec §5.2 单一共享 key）；引用未注入 env 会让
        # OpenClaw 热加载失败、provider 不可用（#36）。regex 管格式，本处管「容器真持有」。
        if value not in ALLOWED_API_KEY_ENV_IDS:
            raise serializers.ValidationError(
                f'apiKey env id 须为容器已注入的 env（当前仅：{sorted(ALLOWED_API_KEY_ENV_IDS)}）',
            )
        return value

    def validate_models(self, value):
        if not isinstance(value, list) or not value:
            raise serializers.ValidationError('须至少一条 model（用于派生默认模型引用）')
        for item in value:
            if not isinstance(item, dict) or not item.get('id'):
                raise serializers.ValidationError('每条 model 须含非空 id')
        return value


class ModelProviderReadSerializer(serializers.Serializer):
    """GET 回读；apiKey 仅以 env id（marker）形式暴露，无明文。"""

    id = serializers.IntegerField(read_only=True)
    provider_id = serializers.CharField(read_only=True)
    api = serializers.CharField(read_only=True)
    base_url = serializers.CharField(read_only=True)
    api_key_env_id = serializers.CharField(read_only=True)
    auth_header = serializers.BooleanField(read_only=True)
    models = serializers.JSONField(read_only=True, source='models_json')
    created_at = serializers.DateTimeField(read_only=True)
