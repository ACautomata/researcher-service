"""开发/测试环境 settings。"""
import os

from security.credential_cipher import CredentialKeySettings

from .base import *  # noqa: F401,F403 — Django settings 分层惯例

DEBUG = True
ALLOWED_HOSTS = ['*']

# issue #252 / #247 D5：REDIS_URL 在 base/dev/prod 各自直接显式配置（非单点默认）。
# dev 显式本地默认 redis://localhost:6379/0（本地零配置可跑）；生产由 prod.py 硬读 +
# validate_prod_env fail-fast 强制非空。
REDIS_URL = 'redis://localhost:6379/0'

# 开发/测试可由环境覆盖；默认值只用于本地非生产数据库，与生产密钥严格隔离。
CREDENTIAL_ENCRYPTION_KEYS = CredentialKeySettings({
    'CREDENTIAL_ENCRYPTION_KEYS': os.environ.get(
        'CREDENTIAL_ENCRYPTION_KEYS',
        'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
    ),
}).load()
