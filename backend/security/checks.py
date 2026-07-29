"""启动期系统检查（issue #199 问题6-1）。

base settings 不内置 CREDENTIAL_ENCRYPTION_KEYS——直接以 base 启动或新增 settings
模块忘记配置时，在 runserver/migrate/check 等管理命令启动期 fail-fast
（ImproperlyConfigured），而非首次读写凭据才炸 AttributeError（对齐 prod.py
fail-fast 风格）。pytest-django 不跑系统检查，测试内直接调本函数断言。
"""
from django.conf import settings
from django.core.checks import register
from django.core.exceptions import ImproperlyConfigured


@register('security')
def check_credential_encryption_keys(app_configs, **kwargs):
    """CREDENTIAL_ENCRYPTION_KEYS 缺失（None/空）即拒绝启动。"""
    if not getattr(settings, 'CREDENTIAL_ENCRYPTION_KEYS', None):
        raise ImproperlyConfigured(
            'CREDENTIAL_ENCRYPTION_KEYS 未配置：请在 settings 模块加载密钥环'
            '（见 config/settings/dev.py 与 config/settings/prod.py）',
        )
    return []
