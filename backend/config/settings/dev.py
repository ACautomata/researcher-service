"""开发/测试环境 settings。"""
import os
import warnings

from security.credential_cipher import CredentialKeySettings

from .base import *  # noqa: F401,F403 — Django settings 分层惯例

DEBUG = True
ALLOWED_HOSTS = ['*']

# issue #199 问题1：本地开发默认开放注册（base 默认关闭）；显式 env 可覆盖。
REGISTRATION_ENABLED = os.environ.get('REGISTRATION_ENABLED', 'true').lower() in (
    '1', 'true', 'yes',
)

# issue #199 问题6-2：不再硬编码公开仓库可知的默认密钥。env 未注入时启动随机生成
# 密钥环并告警——随机密钥仅本进程有效，重启后旧密文不可解（本地一次性开发库可接受），
# 需要跨重启解密本地数据时显式 export CREDENTIAL_ENCRYPTION_KEYS。
if os.environ.get('CREDENTIAL_ENCRYPTION_KEYS'):
    CREDENTIAL_ENCRYPTION_KEYS = CredentialKeySettings(os.environ).load()
else:
    warnings.warn(
        'CREDENTIAL_ENCRYPTION_KEYS 未配置：dev 启动随机生成密钥环，'
        '重启后本地已加密凭据不可解密（如需持久请 export 该环境变量）',
        stacklevel=1,
    )
    CREDENTIAL_ENCRYPTION_KEYS = (os.urandom(32),)
