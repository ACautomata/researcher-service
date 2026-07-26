"""开发/测试环境 settings。"""
import os

from security.credential_cipher import CredentialKeySettings

from .base import *  # noqa: F401,F403 — Django settings 分层惯例

DEBUG = True
ALLOWED_HOSTS = ['*']

# 开发/测试可由环境覆盖；默认值只用于本地非生产数据库，与生产密钥严格隔离。
CREDENTIAL_ENCRYPTION_KEYS = CredentialKeySettings({
    'CREDENTIAL_ENCRYPTION_KEYS': os.environ.get(
        'CREDENTIAL_ENCRYPTION_KEYS',
        'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
    ),
}).load()
