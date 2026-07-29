"""生产环境 settings：SECRET_KEY/ALLOWED_HOSTS 必须来自环境，缺失即 fail-fast。"""
import os

from django.core.exceptions import ImproperlyConfigured

from security.credential_cipher import CredentialKeySettings

from .base import *

SECRET_KEY = os.environ['DJANGO_SECRET_KEY']  # 生产强制注入，缺失即 KeyError
DEBUG = False
ALLOWED_HOSTS = [
    h.strip() for h in os.environ.get('DJANGO_ALLOWED_HOSTS', '').split(',') if h.strip()
]
if not ALLOWED_HOSTS:
    raise ImproperlyConfigured('生产必须设置 DJANGO_ALLOWED_HOSTS')

# 持久化凭证使用独立的 AES-256-GCM 密钥环；生产缺失或格式错误时拒绝启动。
CREDENTIAL_ENCRYPTION_KEYS = CredentialKeySettings(os.environ).load()

# ---- 安全响应头基线（issue #199 问题6-3，Django deployment checklist）----
# SECURE_SSL_REDIRECT 由 env 控制且默认 False：自签证书/IP 直连的内网部署强开会导致
# HTTP→HTTPS 死循环；确认 HTTPS 终结（反代/daemon）就绪后显式开启。
SECURE_SSL_REDIRECT = os.environ.get('DJANGO_SECURE_SSL_REDIRECT', '').lower() in (
    '1', 'true', 'yes',
)
# HSTS 仅在 HTTPS 响应上下发（SecurityMiddleware 只在 is_secure() 时加头），HTTP 部署无副作用。
SECURE_HSTS_SECONDS = int(os.environ.get('DJANGO_SECURE_HSTS_SECONDS', '31536000'))
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
