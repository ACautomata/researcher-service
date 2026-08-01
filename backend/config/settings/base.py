"""Base Django settings —— dev/prod 共享。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §2（目录）/§3（auth）/§4（零信任）。
P0 骨架：5 app + DRF（全局 IsAuthenticated）+ simplejwt + drf-spectacular。
T02：OIDC 占位端点 + Channels JWT middleware（config.asgi 接入握手验 JWT）。
"""
import os
from pathlib import Path

# backend/
BASE_DIR = Path(__file__).resolve().parent.parent.parent

SECRET_KEY = os.environ.get(
    'DJANGO_SECRET_KEY', 'django-insecure-dev-only-key-change-in-prod',
)

DEBUG = False

ALLOWED_HOSTS: list[str] = []

INSTALLED_APPS = [
    'daphne',  # Channels 要求 daphne 在 django.contrib.staticfiles 之前，保证 runserver 走 ASGI
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # 第三方
    'rest_framework',
    'drf_spectacular',
    'channels',  # P0 仅注册；ASGI ProtocolTypeRouter 在 P1 chat ticket 接入
    # 本项目 5 app（spec §2）
    'accounts',
    'containers',
    'wiki',
    'models',
    'chat',
    'security',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'
ASGI_APPLICATION = 'config.asgi.application'

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    },
}

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# zh-hans：全栈为中文 UI，让 DRF/Django 校验消息（密码强度、用户名唯一等）本地化为中文，
# 与 LoginSerializer 的「用户名或密码错误」一致；无 LocaleMiddleware 时活动语言即此默认值。
LANGUAGE_CODE = 'zh-hans'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ---- DRF：全局零信任（spec §3 拦截落点 + §4 输入 0 信任）----
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    # 除显式 AllowAny 的白名单端点外，全部要求认证
    'DEFAULT_PERMISSION_CLASSES': (
        'rest_framework.permissions.IsAuthenticated',
    ),
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
}

# ---- drf-spectacular：OpenAPI 契约（spec §4，前端/执行 agent 权威来源）----
SPECTACULAR_SETTINGS = {
    'TITLE': 'OpenClaw Fleet API',
    'DESCRIPTION': '多 OpenClaw 容器管理面板后端',
    'VERSION': '0.1.0',
    'SERVE_INCLUDE_SCHEMA': False,
}

# ---- OIDC 通用登录（spec §3）----
# provider 注册表：{<provider名>: {'issuer','client_id','scope'}}，不绑死厂商；
# 接具体 IdP 只加配置。骨架期留空 → oauth login/callback 端点返回 501。
OAUTH_PROVIDERS: dict = {}

# ---- 容器编排控制面（spec §5：Docker SDK 编排多 OpenClaw 容器）----
# ROOT：instances/<name>/ 落盘根（开发默认 <repo>/fleet，生产 /srv/openclaw）
# TEMPLATE：共享只读 researcher 模板（cp -a 预填充源，spec §5.1/§5.6）
# TEMPLATE_JSON：openclaw.json 模板来源（deploy/openclaw.json，与单容器 compose 共用一份）
# IMAGE：镜像 tag（官方稳定 browser 变体，ADR 0003；生产建议 pin digest，spec §5.4 / r27 §4.1）
# 端口池 19000–19999（避开单容器 compose 占用的 18789，spec §5.3）
# ⚠ 安全：控制面经 docker.from_env() 挂 /var/run/docker.sock（等价 root；本地/可信部署可接受，
#   生产应限制 Django 网络面或改用 rootless/远程 TLS daemon —— spec §5.4 明示风险）。
FLEET_ROOT = Path(os.environ.get('OPENCLAW_FLEET_ROOT', str(BASE_DIR.parent / 'fleet')))
# 模板单一来源：researcher 仓库克隆（含 workspace/wiki/skills，spec §5.6 cp -a 预填充源）。
# 默认 BASE_DIR.parent/'researcher' = 与本仓库并排克隆的 researcher（对齐
# deploy/docker-compose.yml 与 deploy/.env.example 的 RESEARCHER_DIR=../researcher 主约定，
# compose 相对路径基准为 deploy/）。researcher 不含 fleet 自身 → HomeProvisioner.copytree
# 无递归（区别于把 root/TEMPLATE 指向仓库根本身）。
#
# ⚠ 此默认仅适用开发/CI。生产部署（含 Docker 镜像化后端）**必须**显式设
# ``OPENCLAW_TEMPLATE_DIR``（绝对路径到运维侧部署的 researcher 克隆，或共享卷挂载点）；
# ``prod.py`` 启动时 fail-fast 校验。镜像内 ``BASE_DIR`` 是容器内路径，``<repo>/researcher``
# 在打包后的后端镜像里必然不存在，不能作为生产兜底。
# CI 经 OPENCLAW_TEMPLATE_DIR=/tmp/fleet-template（rsync 干净模板）覆盖。
TEMPLATE_DEFAULT = str(BASE_DIR.parent / 'researcher')
# codex P2 :141：模板路径须兑现 deploy/.env.example 承诺的 RESEARCHER_DIR。
# 优先级：OPENCLAW_TEMPLATE_DIR（绝对路径，CI/生产覆盖）> RESEARCHER_DIR（deploy/ 相对，
# 与 compose/.env.example 同基准）> 默认 <repo>/researcher。相对 RESEARCHER_DIR 相对
# <repo>/deploy 解析（与 .env.example 注释「相对路径基准是 deploy/」一致），否则用户设了
# RESEARCHER_DIR 仍 copytree 到默认不存在路径 → 容器创建卡 creating（本 PR 要修的同类错配）。
_DEPLOY_DIR = BASE_DIR.parent / 'deploy'
_OPENCLAW_TEMPLATE_DIR_ENV = os.environ.get('OPENCLAW_TEMPLATE_DIR')
_RESEARCHER_DIR_ENV = os.environ.get('RESEARCHER_DIR')
if _OPENCLAW_TEMPLATE_DIR_ENV:
    _FLEET_TEMPLATE = _OPENCLAW_TEMPLATE_DIR_ENV
elif _RESEARCHER_DIR_ENV:
    _researcher_path = Path(_RESEARCHER_DIR_ENV)
    _FLEET_TEMPLATE = str(
        _researcher_path if _researcher_path.is_absolute() else _DEPLOY_DIR / _researcher_path,
    )
else:
    _FLEET_TEMPLATE = TEMPLATE_DEFAULT
# 折叠 deploy/../（相对 RESEARCHER_DIR 解析产生的 ..），使 ../researcher → <repo>/researcher，
# 与默认值同形；不 resolve 符号链接，避免改变调用方意图路径。
_FLEET_TEMPLATE = os.path.normpath(_FLEET_TEMPLATE)
# TEMPLATE_JSON 同理：默认 <repo>/deploy/openclaw.json 仅适用开发/CI；生产镜像化后端里该
# 路径必然不存在（backend 镜像构建上下文不含 deploy/，context=backend + COPY . /app →
# 镜像内 TEMPLATE_JSON 解析到 /deploy/openclaw.json，首次创建容器即裸 500）。
# 生产经 OPENCLAW_TEMPLATE_JSON 注入挂载文件路径（CD 分发 deploy/openclaw.json 到宿主并
# 挂载进后端容器，配置单一来源仍在本仓库）；prod.py 的 validate_prod_env fail-fast 校验。
# Codex P2：validator 校验时先 strip（带空格路径能通过校验），此处须存 strip 后的同一路径，
# 否则运行时 read_text() 找带空格路径 → 首次创建容器复现 500。None/空 → 回退默认 dev 路径。
_OPENCLAW_TEMPLATE_JSON_ENV = (os.environ.get('OPENCLAW_TEMPLATE_JSON') or '').strip()
OPENCLAW_FLEET = {
    'ROOT': str(FLEET_ROOT),
    'TEMPLATE': _FLEET_TEMPLATE,
    'TEMPLATE_JSON': _OPENCLAW_TEMPLATE_JSON_ENV or str(BASE_DIR.parent / 'deploy' / 'openclaw.json'),
    'IMAGE': os.environ.get('OPENCLAW_IMAGE', 'ghcr.io/openclaw/openclaw:2026.6.34-browser'),
    'PORT_POOL_START': 19000,
    'PORT_POOL_END': 19999,
    # 全面板共享 LLM_API_KEY（spec §5.2，敏感值）。ADR 0005 配置边界：settings 是唯一 env 读取处，
    # 编排经 settings.OPENCLAW_FLEET['LLM_API_KEY'] 取值，不再 runtime 裸读 os.environ。
    # 默认空串保持 dev/integration 宽容（integration CI 靠 env 注入跑真容器，base 不强制非空）；
    # 生产必填 fail-fast 在 prod.py 的 validate_prod_env（issue #250）。
    'LLM_API_KEY': os.environ.get('LLM_API_KEY', ''),
}

# ---- 设备配对 WS 连接（ADR 0005 配置边界：settings 声明，pairing 经 settings 取值）----
# 默认 ws://127.0.0.1（loopback，容器端口仅绑 loopback），本地零配置可用；
# lan 绑定/生产切 wss 由部署经 env 注入（wss 由网关 tls.enabled 决定）。
OPENCLAW_FLEET_WS = {
    'SCHEME': os.environ.get('OPENCLAW_FLEET_WS_SCHEME', 'ws'),
    'HOST': os.environ.get('OPENCLAW_FLEET_WS_HOST', '127.0.0.1'),
}

# ---- DistributedLock 的 Redis 连接配置（issue #252 / parent #243，ADR 0005 配置边界）----
# REDIS_URL 是 backend/common/lock 的 DistributedLock Port 的连接配置（非凭证，区别于
# LLM_API_KEY 敏感值）。settings 是唯一 env 读取处，LockFleet 经 settings.REDIS_URL 取值。
# 默认 redis://localhost:6379/0 保持本地开发可跑（env 可覆盖）；dev.py 显式同一本地默认
# （#247 D5：base/dev/prod 各自直接显式配置，非单点默认）；生产由 prod.py 硬读 +
# validate_prod_env fail-fast 强制非空。本票纯 settings 字符串，不引入 redis/channels-redis/
# django-redis 运行时依赖（与 Port/Adapter 解耦）。
REDIS_URL = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
