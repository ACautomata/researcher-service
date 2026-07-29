"""security app 配置（issue #199：注册启动期系统检查）。"""
from django.apps import AppConfig


class SecurityConfig(AppConfig):
    name = 'security'
    verbose_name = 'credential security'

    def ready(self):
        # 注册启动期系统检查（CREDENTIAL_ENCRYPTION_KEYS fail-fast）
        from . import checks  # noqa: F401 — import 即注册
