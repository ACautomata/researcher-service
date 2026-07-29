"""生产/Docker settings fail-fast 校验函数。

抽到独立模块（不被 prod.py 顶层副作用拖累），便于单测直接 import + 调用；
prod.py 启动时调用一次，行为不变。校验项必须含「让运维启动时立即知道」的指引
（错误消息指向 deploy/README.md / deploy/.env.example）。
"""
from __future__ import annotations

import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured


def validate_prod_env(env: os.environ | dict) -> None:
    """生产/Docker 启动 fail-fast 校验。

    校验项（任一缺失即 ImproperlyConfigured，运维启动时即拒绝）：
    - ``DJANGO_SECRET_KEY`` —— 由 SECRET_KEY = env[...] KeyError 自然覆盖
    - ``DJANGO_ALLOWED_HOSTS`` —— 缺失/空/纯空白/纯逗号 → 失防 host header 注入
      （codex P2 :2902641 review：原仅 strip() 过不了 ``", , "``（split 后非空元素），
      让生产启动成功但 ALLOWED_HOSTS 解析后空 → DisallowedHost 全面拒请求；现与 prod.py
      一致先 split+filter 判空）。
    - ``OPENCLAW_TEMPLATE_DIR`` —— 缺失/空/纯空白/相对路径 → base.py 模板解析后
      HomeProvisioner.copytree 找不到源（绝对路径校验：相对路径会被 cwd 静默吞，重复
      issue #195「卡 creating」错配，复用 2902641 + P2 :2902641 review）
    - ``CREDENTIAL_ENCRYPTION_KEYS`` —— CredentialKeySettings 内部校验
    """
    allowed_hosts_str = env.get('DJANGO_ALLOWED_HOSTS', '').strip()
    # 与 prod.py 同样的 split+filter 规则：仅算非空白项；空/纯逗号/纯空白都拒
    # （codex P2 :2902641 review 点过的 ", ,"/", , "/等）。
    allowed_hosts = [h.strip() for h in allowed_hosts_str.split(',') if h.strip()]
    if not allowed_hosts:
        raise ImproperlyConfigured(
            '生产必须设置 DJANGO_ALLOWED_HOSTS（逗号分隔非空主机名，至少一项；'
            '参见 deploy/README.md 与 deploy/.env.example）。',
        )

    template_dir = env.get('OPENCLAW_TEMPLATE_DIR', '').strip()
    if not template_dir:
        raise ImproperlyConfigured(
            '生产必须设置 OPENCLAW_TEMPLATE_DIR（绝对路径到 researcher 克隆，cp -a 预填充源）。'
            'Docker 化部署由 compose/K8s environment 注入；参见 deploy/README.md 与'
            'deploy/.env.example。',
        )
    if not Path(template_dir).is_absolute():
        # codex P2 :2902641 review：相对路径被 validator 通过会让 prod 启动看似正常，
        # 但 HomeProvisioner 用 cwd 解析后 FileNotFoundError，重复 issue #195 错配。
        raise ImproperlyConfigured(
            'OPENCLAW_TEMPLATE_DIR 必须是绝对路径（spec §5.6 cp -a 源在镜像化后端内'
            'BASE_DIR 是容器路径，相对路径会被 cwd 静默吞）；当前值：'
            f'{template_dir!r}。参见 deploy/README.md。',
        )
