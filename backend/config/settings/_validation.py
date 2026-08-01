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
    - ``LLM_API_KEY`` —— 缺失/空/纯空白 → 空 key 会静默注入 OpenClaw 容器，到首次
      创建/对话才暴露（issue #195 同类错配；ADR 0005 + spec §5.2：全面板共享必填敏感值，
      base 默认空串保持 dev/integration 宽容，生产由本校验强制非空）
    - ``REDIS_URL`` —— 缺失/空/纯空白 → DistributedLock（backend/common/lock）的连接
      配置（非凭证），缺失会让 LockFleet 首次用锁时才连接失败（issue #252；对齐
      SECRET_KEY/LLM_API_KEY fail-fast 先例，base 给开发可跑默认，生产强制非空）
    - ``CREDENTIAL_ENCRYPTION_KEYS`` —— CredentialKeySettings 内部校验
    - ``OPENCLAW_TEMPLATE_JSON`` —— 缺失/空/相对路径/不存在 → base.py 默认指向镜像内
      不存在的 /deploy/openclaw.json，首次创建容器才裸 500（CD 镜像 context=backend 不含
      deploy/，<repo>/deploy 相对路径在容器内失效）；生产须注入挂载文件路径，启动期校验
      已存在且是文件，避免「创建容器 500」在运维触发后才暴露。
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

    # ADR 0005 + spec §5.2：LLM_API_KEY 是全面板共享的必填敏感值，base.py 声明默认空串
    # （dev/integration 宽容，integration CI 靠 env 注入跑真容器）；生产缺省空串会把空 key
    # 静默注入 OpenClaw 容器，到首次创建/对话才暴露（issue #195 同类错配），故强制非空。
    llm_api_key = env.get('LLM_API_KEY', '').strip()
    if not llm_api_key:
        raise ImproperlyConfigured(
            '生产必须设置 LLM_API_KEY（全面板共享的必填敏感值，spec §5.2；缺省空串会'
            '把空 key 静默注入 OpenClaw 容器，首次创建/对话才暴露）。'
            'Docker 化部署由 compose/K8s environment 注入，勿写盘；参见 deploy/README.md '
            '与 deploy/.env.example。',
        )

    # issue #252：REDIS_URL 是 DistributedLock（backend/common/lock）的连接配置
    # （非凭证，区别于 LLM_API_KEY 敏感值）。base.py 提供开发可跑默认（env 可覆盖），
    # dev.py 显式本地默认；生产缺省会让 LockFleet 首次用锁时才连接失败，违背 fail-fast
    # 「启动时即知」初衷（对齐 SECRET_KEY/LLM_API_KEY 先例），故生产强制非空。
    redis_url = env.get('REDIS_URL', '').strip()
    if not redis_url:
        raise ImproperlyConfigured(
            '生产必须设置 REDIS_URL（DistributedLock 的 Redis 连接配置，非凭证；缺省会让'
            ' LockFleet 首次用锁时才连接失败）。Docker 化部署由 compose/K8s environment '
            '注入；参见 deploy/README.md 与 deploy/.env.example。',
        )

    template_dir = env.get('OPENCLAW_TEMPLATE_DIR', '').strip()
    if not template_dir:
        raise ImproperlyConfigured(
            '生产必须设置 OPENCLAW_TEMPLATE_DIR（绝对路径到 researcher 克隆，cp -a 预填充源）。'
            'Docker 化部署由 compose/K8s environment 注入；参见 deploy/README.md 与'
            'deploy/.env.example。',
        )
    template_path = Path(template_dir)
    if not template_path.is_absolute():
        # codex P2 :2902641 review：相对路径被 validator 通过会让 prod 启动看似正常，
        # 但 HomeProvisioner 用 cwd 解析后 FileNotFoundError，重复 issue #195 错配。
        raise ImproperlyConfigured(
            'OPENCLAW_TEMPLATE_DIR 必须是绝对路径（spec §5.6 cp -a 源在镜像化后端内'
            'BASE_DIR 是容器路径，相对路径会被 cwd 静默吞）；当前值：'
            f'{template_dir!r}。参见 deploy/README.md。',
        )
    if not template_path.is_dir():
        # codex P2 :292d349 review：绝对路径但不存在 / 指向普通文件（如拼错的
        # /srv/openclaw/template/reseacher）被 validator 放行会让 prod 启动看似正常，
        # 首次创建容器时 HomeProvisioner.copytree 才抛 FileNotFoundError/NotADirectory，
        # 违背 fail-fast「启动时即知」初衷（issue #195 同类错配）。启动期校验已存在且是目录。
        raise ImproperlyConfigured(
            'OPENCLAW_TEMPLATE_DIR 必须是已存在且可读的目录（HomeProvisioner 以 cp -a '
            '预填充 home 源）；当前值 'f'{template_dir!r} 不存在或不是目录。'
            '参见 deploy/README.md 与 deploy/.env.example。',
        )
    # codex P2 :55：is_dir 仅判文件类型，不判权限位——目录存在但当前进程无读/遍历权限时，
    # HomeProvisioner.copytree 递归拷贝仍抛 PermissionError，同样违背 fail-fast「启动即知」。
    # os.access(R_OK|X_OK)：R_OK=可列目录条目，X_OK=可遍历进入子目录（POSIX 目录语义，
    # copytree 递归两者皆需）。
    if not os.access(template_path, os.R_OK | os.X_OK):
        raise ImproperlyConfigured(
            'OPENCLAW_TEMPLATE_DIR 已存在且是目录，但当前进程无读/遍历权限'
            f'（{template_dir!r}）——HomeProvisioner.copytree 预填充会抛 PermissionError。'
            '修正目录属主/权限（chmod r-x）后重启。参见 deploy/README.md。',
        )

    # OPENCLAW_TEMPLATE_JSON：openclaw.json 模板文件（配置单一来源，与单容器 compose 共用
    # 一份 deploy/openclaw.json）。base.py 默认 <repo>/deploy/openclaw.json 仅适用开发/CI；
    # 生产镜像化后端（context=backend + COPY . /app）里 BASE_DIR.parent/deploy 解析成
    # /deploy 且不存在 → 首次创建容器裸 500（FileNotFoundError，view 未捕获）。fail-fast
    # 让运维启动时即知，而非首次创建容器才暴露。挂载文件路径由 compose 注入（与
    # OPENCLAW_TEMPLATE_DIR 同款，非敏感固定项）。
    template_json = env.get('OPENCLAW_TEMPLATE_JSON', '').strip()
    if not template_json:
        raise ImproperlyConfigured(
            '生产必须设置 OPENCLAW_TEMPLATE_JSON（openclaw.json 模板文件路径，配置单一来源）。'
            '镜像化后端内默认 <repo>/deploy/openclaw.json 解析到 /deploy 且不存在，首次'
            '创建容器即 500。Docker 化部署由 compose 挂载文件并注入路径；参见 deploy/README.md '
            '与 deploy/.env.example。',
        )
    template_json_path = Path(template_json)
    if not template_json_path.is_absolute():
        raise ImproperlyConfigured(
            'OPENCLAW_TEMPLATE_JSON 必须是绝对路径（镜像内 BASE_DIR 是容器路径，相对路径'
            '会被 cwd 静默吞 → 首次创建容器 500）；当前值：'
            f'{template_json!r}。参见 deploy/README.md。',
        )
    if not template_json_path.is_file():
        raise ImproperlyConfigured(
            'OPENCLAW_TEMPLATE_JSON 必须是已存在的文件（ConfigRenderer 以 JSON 解析模板，'
            '缺文件/目录会在首次创建容器时 FileNotFoundError）；当前值 '
            f'{template_json!r} 不存在或不是文件。参见 deploy/README.md 与 deploy/.env.example。',
        )
