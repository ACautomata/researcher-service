"""containers 序列化器 —— 创建入参校验 + 实例出参（spec §4 零信任）。

InstanceCreateSerializer：name 经 NAME_VALIDATOR（RegexValidator，小写 DNS-label）+
UniqueValidator（DB 唯一）。name 直接进 instances/<name>/ 路径与 docker 容器名，故严禁
路径分隔符 / .. / 空格 / 大写（防目录穿越与 docker-name 注入）。

InstanceSerializer：出参（list/detail），接收 orchestrator 返回的 dict（含 health/status 聚合）。
"""
from rest_framework import serializers
from rest_framework.validators import UniqueValidator

from .models import NAME_VALIDATOR, Instance


class InstanceCreateSerializer(serializers.Serializer):
    """POST /containers 入参：仅需 name（端口/token/home 由 orchestrator 决定）。"""

    name = serializers.CharField(
        max_length=30,
        validators=[NAME_VALIDATOR, UniqueValidator(queryset=Instance.objects.all())],
    )


class InstanceSerializer(serializers.Serializer):
    """实例出参（read-only）；instance 可为 dict（orchestrator.list/detail 返回）。"""

    name = serializers.CharField(read_only=True)
    port = serializers.IntegerField(read_only=True)
    status = serializers.CharField(read_only=True)
    health = serializers.CharField(read_only=True)
    image = serializers.CharField(read_only=True)
    container_id = serializers.CharField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)
