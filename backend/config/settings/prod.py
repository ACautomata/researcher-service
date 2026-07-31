"""生产环境 settings：SECRET_KEY/ALLOWED_HOSTS 必须来自环境，缺失即 fail-fast。"""
import os

from django.core.exceptions import ImproperlyConfigured

from security.credential_cipher import CredentialKeySettings

from ._validation import validate_prod_env
from .base import *

SECRET_KEY = os.environ['DJANGO_SECRET_KEY']  # 生产强制注入，缺失即 KeyError
DEBUG = False
ALLOWED_HOSTS = [
    h.strip() for h in os.environ.get('DJANGO_ALLOWED_HOSTS', '').split(',') if h.strip()
]

# REDIS_URL（issue #252 / parent #243）：DistributedLock（backend/common/lock）的连接配置
# （非凭证，区别于 LLM_API_KEY 敏感值）。生产强制注入，缺失即 KeyError；base.py 的开发
# 可跑默认仅适用本地，生产镜像/部署必须显式提供，否则 LockFleet 首次用锁才连接失败。
# 非空/非空白由下方 validate_prod_env 进一步 fail-fast（对齐 SECRET_KEY/LLM_API_KEY 先例）。
REDIS_URL = os.environ['REDIS_URL']

# 生产/Docker 部署必须显式提供 researcher 模板路径（spec §5.6 cp -a 源）。
# base.py 的 TEMPLATE_DEFAULT = BASE_DIR.parent/'researcher' 仅适用开发/CI——后端镜像内
# BASE_DIR 是容器路径，不会有宿主 researcher 克隆；不设 OPENCLAW_TEMPLATE_DIR 会让
# HomeProvisioner.copytree 在第一个创建容器的请求上 FileNotFoundError，
# 与 issue #195 修复的「容器创建卡 creating」同类错配（codex P1 :287325b 警示）。
# 三层优先级见 base.py：OPENCLAW_TEMPLATE_DIR > RESEARCHER_DIR > 默认；这里只校顶层。
validate_prod_env(os.environ)

# 持久化凭证使用独立的 AES-256-GCM 密钥环；生产缺失或格式错误时拒绝启动。
CREDENTIAL_ENCRYPTION_KEYS = CredentialKeySettings(os.environ).load()
