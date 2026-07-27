"""chat 序列化器 —— 配对状态出参（issue #40 / spec §4 零信任）。

PairingStatusSerializer：配对状态出参。绝不外泄私钥（private_key_pem）与
device_token（凭证）——仅暴露 status/device_id/scopes/pairing_request_id。
"""
from rest_framework import serializers

from chat.models import Pairing


class ApprovalResolveSerializer(serializers.Serializer):
    """审批回覆入参（T06，spec §8.2）：定义 OpenAPI request body（codex R2 P2）。

    与 ApprovalResolveView 校验一致：id/kind 必填，decision 为 allow-once/allow-always/deny。
    issue #154 实测（ghcr 2026.6.34）：decision 值已校准为 allow-once/allow-always/deny（非 approve/deny）。
    kind 仅用于派生 method 名（{kind}.approval.resolve），不放入 params。
    """

    id = serializers.CharField()
    kind = serializers.CharField()
    decision = serializers.ChoiceField(choices=('allow-once', 'allow-always', 'deny'))

    # APPROVAL_FIELD_ID/KIND/DECISION 常量由集成包单源管理（issue #105），
    # 此处字段名与常量值一致：id → APPROVAL_FIELD_ID, kind → APPROVAL_FIELD_KIND,
    # decision → APPROVAL_FIELD_DECISION。


class SessionCreateSerializer(serializers.Serializer):
    """会话新建入参（T2，issue #81）：label 可选（免标题新建，网关后续派生）。

    对 request.data 强制 is_valid()：非对象 body（[]/"x"/123）→ 400（而非 .get AttributeError 500）；
    非 str label → 400。trim 后空串视为未提供（→ None，网关派生标题）。
    """

    label = serializers.CharField(required=False, allow_blank=True, max_length=128, trim_whitespace=True)

    def validate_label(self, value):
        # 0 信任：只接受真正的 str 入参——int/bool/list 等经 CharField 会被静默 str() 强转，
        # 违反「非法类型 → 400」边界；此处显式拒绝原始非 str 值。
        raw = self.initial_data.get('label')
        if raw is not None and not isinstance(raw, str):
            raise serializers.ValidationError('label 须为字符串')
        return value


class PairingStatusSerializer(serializers.Serializer):
    """配对状态出参（read-only）。"""

    status = serializers.CharField(read_only=True)
    device_id = serializers.CharField(read_only=True)
    scopes = serializers.SerializerMethodField()
    pairing_request_id = serializers.CharField(read_only=True)
    detail = serializers.CharField(read_only=True, required=False)

    def get_scopes(self, obj: Pairing) -> list[str]:
        return obj.scopes_list()
