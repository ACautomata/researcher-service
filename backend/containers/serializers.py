"""containers 序列化器 —— 创建入参校验 + 实例出参（spec §4 零信任）。

InstanceCreateSerializer：name 经 NAME_VALIDATOR（RegexValidator，小写 DNS-label）+
UniqueValidator（DB 唯一）。name 直接进 instances/<name>/ 路径与 docker 容器名，故严禁
路径分隔符 / .. / 空格 / 大写（防目录穿越与 docker-name 注入）。

InstanceSerializer：出参（list/detail），接收 orchestrator 返回的 dict（含 health/status 聚合）。
附加 pairing 字段：每个实例的当前配对状态，避免前端每行单独轮询配对端点。
"""
from rest_framework import serializers
from rest_framework.validators import UniqueValidator

from chat.models import Pairing
from .models import NAME_VALIDATOR, Instance


class InstanceCreateSerializer(serializers.Serializer):
    """POST /containers 入参：仅需 name（端口/token/home 由 orchestrator 决定）。"""

    name = serializers.CharField(
        max_length=30,
        validators=[NAME_VALIDATOR, UniqueValidator(queryset=Instance.objects.all())],
    )


class _PairingStatusSerializer(serializers.Serializer):
    """容器列表嵌套的配对状态快照（只读）。"""

    status = serializers.CharField(read_only=True)
    device_id = serializers.CharField(read_only=True)
    scopes = serializers.SerializerMethodField()
    pairing_request_id = serializers.CharField(read_only=True)

    def get_scopes(self, obj: Pairing) -> list[str]:
        return obj.scopes_list()


class InstanceSerializer(serializers.Serializer):
    """实例出参（read-only）；instance 可为 dict（orchestrator.list/detail 返回）。

    pairing 字段由后端批量组装，替代前端 per-row 轮询。
    """

    name = serializers.CharField(read_only=True)
    port = serializers.IntegerField(read_only=True)
    status = serializers.CharField(read_only=True)
    health = serializers.CharField(read_only=True)
    image = serializers.CharField(read_only=True)
    container_id = serializers.CharField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)
    pairing = serializers.SerializerMethodField()

    def get_pairing(self, obj: dict) -> dict:
        # view 层已批量预取并注入 pairing 快照
        if isinstance(obj, dict):
            pre = obj.get('pairing')
            if pre is not None:
                return pre
        # 非批量路径兜底（如测试直接序列化 Instance 对象）
        name = obj.get('name') if isinstance(obj, dict) else obj.name
        pairing = Pairing.objects.filter(instance__name=name).first()
        if pairing is None:
            return {'status': Pairing.STATUS_UNPAIRED, 'device_id': '',
                    'scopes': [], 'pairing_request_id': ''}
        return _PairingStatusSerializer(pairing).data
