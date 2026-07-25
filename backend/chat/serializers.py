"""chat 序列化器 —— 配对状态出参（issue #40 / spec §4 零信任）。

PairingStatusSerializer：配对状态出参。绝不外泄私钥（private_key_pem）与
device_token（凭证）——仅暴露 status/device_id/scopes/pairing_request_id。
"""
from rest_framework import serializers

from chat.models import Pairing, Session


class ApprovalResolveSerializer(serializers.Serializer):
    """审批回覆入参（T06，spec §8.2）：定义 OpenAPI request body（codex R2 P2）。

    与 ApprovalResolveView 校验一致：id/kind 必填，decision 仅 approve/deny。
    """

    id = serializers.CharField()
    kind = serializers.CharField()
    decision = serializers.ChoiceField(choices=('approve', 'deny'))


class PairingStatusSerializer(serializers.Serializer):
    """配对状态出参（read-only）。"""

    status = serializers.CharField(read_only=True)
    device_id = serializers.CharField(read_only=True)
    scopes = serializers.SerializerMethodField()
    pairing_request_id = serializers.CharField(read_only=True)
    detail = serializers.CharField(read_only=True, required=False)

    def get_scopes(self, obj: Pairing) -> list[str]:
        return obj.scopes_list()


class SessionSerializer(serializers.ModelSerializer):
    """会话出参（session_key/created_at 只读；title 新建时入参）。"""

    class Meta:
        model = Session
        fields = ['id', 'session_key', 'title', 'created_at']
        read_only_fields = ['id', 'session_key', 'created_at']
