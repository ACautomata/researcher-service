"""containers models —— OpenClaw 实例记账（spec §5.5 / §10）。

Instance 记录每容器的编排状态：name（容器名后缀/目录名）、port（宿主映射端口）、
token（GATEWAY_TOKEN，env 注入不落盘 JSON，DB 仅存值供后端 WS 握手）、home_dir（bind-mount
宿主路径 instances/<name>/home）、container_id（docker 容器 id，run 前空）、status（状态机）、
image（创建时 pin 的镜像 tag）、created_at。

name 经 RegexValidator 防路径/docker-name 注入（小写 DNS-label，禁 / .. 空格等）—— spec §4 零信任。
"""
from django.core.validators import RegexValidator
from django.db import models

# spec §5.3：容器名 openclaw-gw-<name>；name 须小写 DNS-label 风格，
# 首字母（禁纯数字/下划线开头 Docker 名），3–30 字符，仅 [a-z0-9-]，
# 拒路径分隔符 / .. / 空格 / 大写（同时防 instances/<name>/ 目录穿越与注入）。
NAME_VALIDATOR = RegexValidator(
    regex=r'^[a-z][a-z0-9-]{2,29}$',
    message='name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符',
)


class Instance(models.Model):
    """一个 OpenClaw 容器实例的记账行（spec §5.5 状态机 + §10 字段）。"""

    STATUS_CREATING = 'creating'
    STATUS_RUNNING = 'running'
    STATUS_STOPPED = 'stopped'
    STATUS_REMOVING = 'removing'
    STATUS_ERROR = 'error'
    STATUS_CHOICES = [
        (STATUS_CREATING, 'creating'),
        (STATUS_RUNNING, 'running'),
        (STATUS_STOPPED, 'stopped'),
        (STATUS_REMOVING, 'removing'),
        (STATUS_ERROR, 'error'),
    ]

    name = models.CharField(max_length=30, unique=True, validators=[NAME_VALIDATOR])
    port = models.IntegerField()
    token = models.CharField(max_length=127)
    home_dir = models.CharField(max_length=512)
    # run 前未知；空串而非 NULL（避免 null-string 反模式，Django 官方建议）
    container_id = models.CharField(max_length=128, blank=True, default='')
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_CREATING)
    image = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return self.name
