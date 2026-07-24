"""chat 序列化器 —— 配对状态出参（issue #40 / spec §4 零信任）。

PairingStatusSerializer：配对状态出参。绝不外泄私钥（private_key_pem）与
device_token（凭证）——仅暴露 status/device_id/scopes/pairing_request_id。
"""
from rest_framework import serializers

from chat.models import Pairing


class PairingStatusSerializer(serializers.Serializer):
    """配对状态出参（read-only）。"""

    status = serializers.CharField(read_only=True)
    device_id = serializers.CharField(read_only=True)
    scopes = serializers.SerializerMethodField()
    pairing_request_id = serializers.CharField(read_only=True)
    detail = serializers.CharField(read_only=True, required=False)

    def get_scopes(self, obj: Pairing) -> list[str]:
        return obj.scopes_list()
