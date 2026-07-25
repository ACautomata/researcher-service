"""chat models —— 设备配对记账（issue #40 / spec §10 chat.Pairing）。

Pairing 记录每容器的配对状态：instance(FK) / device_id / 公私钥 PEM / device_token /
scopes_json / status 状态机 / pairing_request_id（待批准时的宿主 approve 引用）。

设备身份（私钥）按容器持久化在 DB，deviceId 跨进程稳定；approve 后重连沿用同一身份。
"""
import json

from django.db import models

from containers.models import Instance


class Pairing(models.Model):
    """一个容器实例的设备配对记账行（spec §10 chat.Pairing）。"""

    STATUS_UNPAIRED = 'unpaired'
    STATUS_PENDING = 'pending'
    STATUS_PAIRED = 'paired'
    STATUS_ERROR = 'error'
    STATUS_CHOICES = [
        (STATUS_UNPAIRED, 'unpaired'),
        (STATUS_PENDING, 'pending'),
        (STATUS_PAIRED, 'paired'),
        (STATUS_ERROR, 'error'),
    ]

    instance = models.OneToOneField(
        Instance, on_delete=models.CASCADE, related_name='pairing'
    )
    device_id = models.CharField(max_length=64, blank=True, default='')
    public_key_pem = models.TextField(blank=True, default='')
    private_key_pem = models.TextField(blank=True, default='')
    device_token = models.CharField(max_length=255, blank=True, default='')
    scopes_json = models.TextField(blank=True, default='[]')
    pairing_request_id = models.CharField(max_length=128, blank=True, default='')
    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, default=STATUS_UNPAIRED
    )
    updated_at = models.DateTimeField(auto_now=True)
    attempt_version = models.PositiveIntegerField(default=0)

    def scopes_list(self) -> list[str]:
        """协商 scopes（hello-ok.auth.scopes）；空则返回 []。"""
        try:
            return json.loads(self.scopes_json) or []
        except (ValueError, TypeError):
            return []

    def __str__(self) -> str:
        return f'{self.instance.name}:{self.status}'


class Session(models.Model):
    """一个容器实例下的对话会话记账行（spec §9.4 会话列表 / §8.2 sessionKey）。

    session_key 由后端生成（uuid hex，唯一），透传给网关；会话历史由网关按 session_key 维护。
    title 为前端展示名（可空）。无 user_id——对齐 Instance 现状，按 instance 隔离；REST 受全局
    IsAuthenticated 保护。
    """

    instance = models.ForeignKey(
        Instance, on_delete=models.CASCADE, related_name='sessions'
    )
    session_key = models.CharField(max_length=64, unique=True)
    title = models.CharField(max_length=128, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f'{self.instance.name}:{self.title or self.session_key[:8]}'
