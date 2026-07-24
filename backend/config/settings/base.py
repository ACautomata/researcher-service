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
    'DJANGO_SECRET_KEY', 'django-insecure-dev-only-key-change-in-prod'
)

DEBUG = False

ALLOWED_HOSTS: list[str] = []

INSTALLED_APPS = [
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

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LANGUAGE_CODE = 'en-us'
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
