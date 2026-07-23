"""生产环境 settings：SECRET_KEY/ALLOWED_HOSTS 必须来自环境，缺失即 fail-fast。"""
import os

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F401,F403 — Django settings 分层惯例

SECRET_KEY = os.environ['DJANGO_SECRET_KEY']  # 生产强制注入，缺失即 KeyError
DEBUG = False
ALLOWED_HOSTS = [
    h.strip() for h in os.environ.get('DJANGO_ALLOWED_HOSTS', '').split(',') if h.strip()
]
if not ALLOWED_HOSTS:
    raise ImproperlyConfigured('生产必须设置 DJANGO_ALLOWED_HOSTS')
