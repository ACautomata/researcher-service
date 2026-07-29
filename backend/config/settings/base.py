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
    # issue #199 问题3：refresh token 服务端吊销（logout/轮换后旧 token 入黑名单）；
    # 迁移由 simplejwt 自带，装 app 后 migrate 即可
    'rest_framework_simplejwt.token_blacklist',
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
    # issue #199 问题3：auth 端点组限速（login/register/refresh 挂 ScopedRateThrottle，
    # scope='auth'）防口令爆破/账号枚举；不做全局 anon 限速以免误伤 schema 等端点。
    'DEFAULT_THROTTLE_RATES': {
        'auth': os.environ.get('DRF_THROTTLE_RATE_AUTH', '10/minute'),
    },
}

# ---- simplejwt：refresh 轮换 + 轮换后旧 token 入黑名单（issue #199 问题3）----
# ROTATE：/token/refresh 每次换新 refresh，旧 refresh 即失效（配合 BLACKLIST）；
# BLACKLIST_AFTER_ROTATION 依赖 INSTALLED_APPS 的 token_blacklist（simplejwt 自带迁移）。
SIMPLE_JWT = {
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
}

# ---- 注册开关（issue #199 问题1）----
# 默认**关闭**：控制面无对象级授权 + docker.sock 等价 root，开放注册 ≈ 开放的宿主 root
# 后门。首用户经 `createsuperuser` 创建；确需自助注册的部署显式 REGISTRATION_ENABLED=true。
# dev.py 默认开启以方便本地开发（部署前检查清单须确认生产开关状态）。
REGISTRATION_ENABLED = os.environ.get('REGISTRATION_ENABLED', '').lower() in (
    '1', 'true', 'yes',
)

# ---- 凭据加密密钥环（issue #199 问题6-1）----
# base 不提供默认值：dev/prod 各自加载（dev 未注入时启动随机生成 + warning，prod env 必配）。
# 直接以 base 启动或新增 settings 模块忘记配置时，经 security.checks 在管理命令启动期
# fail-fast（ImproperlyConfigured），而非首次读写凭据才炸（对齐 prod.py fail-fast 风格）。
CREDENTIAL_ENCRYPTION_KEYS: tuple | None = None

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
# IMAGE：镜像 tag（生产建议 pin digest，spec §5.4 / r27 §4.1）
# 端口池 19000–19999（避开单容器 compose 占用的 18789，spec §5.3）
# ⚠ 安全：控制面经 docker.from_env() 挂 /var/run/docker.sock（等价 root；本地/可信部署可接受，
#   生产应限制 Django 网络面或改用 rootless/远程 TLS daemon —— spec §5.4 明示风险）。
FLEET_ROOT = Path(os.environ.get('OPENCLAW_FLEET_ROOT', str(BASE_DIR.parent / 'fleet')))
OPENCLAW_FLEET = {
    'ROOT': str(FLEET_ROOT),
    'TEMPLATE': os.environ.get('OPENCLAW_TEMPLATE_DIR', '/srv/openclaw/template/researcher'),
    'TEMPLATE_JSON': str(BASE_DIR.parent / 'deploy' / 'openclaw.json'),
    'IMAGE': os.environ.get('OPENCLAW_IMAGE', 'acautomata/openclaw-docker-cn-im:latest'),
    'PORT_POOL_START': 19000,
    'PORT_POOL_END': 19999,
}
