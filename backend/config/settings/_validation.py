"""生产/Docker settings fail-fast 校验函数。

抽到独立模块（不被 prod.py 顶层副作用拖累），便于单测直接 import + 调用；
prod.py 启动时调用一次，行为不变。校验项必须含「让运维启动时立即知道」的指引
（错误消息指向 deploy/README.md / .env.example）。
"""
from __future__ import annotations

import os

from django.core.exceptions import ImproperlyConfigured


def validate_prod_env(env: os.environ | dict) -> None:
    """生产/Docker 启动 fail-fast 校验。

    校验项（任一缺失即 ImproperlyConfigured，运维启动时即拒绝）：
    - ``DJANGO_SECRET_KEY`` —— 由 SECRET_KEY = env[...] KeyError 自然覆盖
    - ``DJANGO_ALLOWED_HOSTS`` —— 空字符串/未设/纯空白 → 失防 host header 注入
    - ``OPENCLAW_TEMPLATE_DIR`` —— base.py 默认 ``<repo>/researcher`` 仅适用开发；
      镜像化后端内 BASE_DIR 是容器路径，该路径必不存在，不设会首创建容器时
      HomeProvisioner.copytree FileNotFoundError，与 issue #195「卡 creating」同类
      （codex P1 :287325b 警示）
    - ``CREDENTIAL_ENCRYPTION_KEYS`` —— CredentialKeySettings 内部校验
    """
    if not env.get('DJANGO_ALLOWED_HOSTS', '').strip():
        raise ImproperlyConfigured('生产必须设置 DJANGO_ALLOWED_HOSTS')
    if not env.get('OPENCLAW_TEMPLATE_DIR', '').strip():
        raise ImproperlyConfigured(
            '生产必须设置 OPENCLAW_TEMPLATE_DIR（绝对路径到 researcher 克隆，cp -a 预填充源）。'
            'Docker 化部署由 compose/K8s environment 注入；参见 deploy/README.md 与'
            'deploy/.env.example。',
        )