"""
ASGI config for config project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/6.0/howto/deployment/asgi/
"""

import os

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application
from django.urls import path

# 生产入口默认 prod：prod settings 强制 DJANGO_SECRET_KEY（缺失即 fail-fast），
# 避免误用 dev（DEBUG=True / ALLOWED_HOSTS=*）。开发用 manage.py（默认 dev）。
# pytest-django 已设 DJANGO_SETTINGS_MODULE=dev（pyproject.toml），setdefault 不覆盖。
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.prod')

django_asgi_app = get_asgi_application()

from accounts.middleware import JwtAuthMiddleware  # noqa: E402 — 须在 settings 就绪后 import
from chat.consumers import ChatConsumer  # noqa: E402

# T05：/ws/chat/ → ChatConsumer（对话桥接）；WS 握手经 JwtAuthMiddleware 验同一 JWT（spec §3）
websocket_routes = URLRouter([
    path('ws/chat/', ChatConsumer.as_asgi()),
])

application = ProtocolTypeRouter(
    {
        'http': django_asgi_app,
        'websocket': JwtAuthMiddleware(websocket_routes),
    }
)
