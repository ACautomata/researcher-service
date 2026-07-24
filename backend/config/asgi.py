"""
ASGI config for config project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/6.0/howto/deployment/asgi/
"""

import os

from channels.routing import ProtocolTypeRouter
from django.core.asgi import get_asgi_application

# 生产入口默认 prod：prod settings 强制 DJANGO_SECRET_KEY（缺失即 fail-fast），
# 避免误用 dev（DEBUG=True / ALLOWED_HOSTS=*）。开发用 manage.py（默认 dev）。
# pytest-django 已设 DJANGO_SETTINGS_MODULE=dev（pyproject.toml），setdefault 不覆盖。
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.prod')

django_asgi_app = get_asgi_application()

from accounts.middleware import JwtAuthMiddleware  # noqa: E402 — 须在 settings 就绪后 import


async def _no_ws_routes(scope, receive, send):
    """T02 占位：尚无 WS 业务路由（chat consumer 留 P1 chat ticket）。

    握手已过 JwtAuthMiddleware（scope['user'] 已注入认证用户）。T02 仅验证握手验 JWT
    生效，无路由可派：accept 表示握手成功，随即正常关闭等待 P1 接管。
    """
    await send({'type': 'websocket.accept'})
    await send({'type': 'websocket.close', 'code': 1000})


# T02：WS 握手走 JwtAuthMiddleware 验同一 JWT（spec §3）；具体 chat consumer 路由留 P1 chat ticket。
application = ProtocolTypeRouter(
    {
        'http': django_asgi_app,
        'websocket': JwtAuthMiddleware(_no_ws_routes),
    }
)
