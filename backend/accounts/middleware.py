"""accounts Channels JWT middleware —— WS 握手验同一 JWT（spec §3）。

spec §3：WebSocket 用自定义 Channels JWT middleware 在握手时验同一 JWT
（与 REST 同 simplejwt 后端、同 SECRET_KEY/算法）。浏览器 WS 不能自定义
Authorization 头，token 经 Sec-WebSocket-Protocol（`access_token` + JWT）携带。
有效：注入 scope['user'] 放行；无效/缺失：握手期 close(4401) 拒绝。

安全：token 不走 URL query（`?token=` 会进访问日志/浏览器历史/Referer，泄漏
access token），仅经 subprotocol 通道——握手帧不进 URL 日志。
"""
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError

User = get_user_model()

# 握手拒绝码：4401 取自「HTTP 401 语义映射到 WS close code」的社区惯例（4000-4999 为应用私有段）
WS_CLOSE_UNAUTHORIZED = 4401


@database_sync_to_async
def _authenticate(token: str):
    """复用 DRF 的 JWTAuthentication 验签——保证与 REST 握手验的是同一 JWT 规则。"""
    try:
        validated = JWTAuthentication().get_validated_token(token)
        return JWTAuthentication().get_user(validated)
    except (InvalidToken, TokenError, AuthenticationFailed):
        return None


class JwtAuthMiddleware:
    """ASGI middleware：仅拦截 websocket，握手期验 JWT。

    非 websocket 连接（http/lifespan）原样透传给内层 app。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'websocket':
            return await self.app(scope, receive, send)

        token = self._extract_token(scope)
        user = await _authenticate(token) if token else None
        if user is None:
            scope['user'] = AnonymousUser()
            await send({'type': 'websocket.close', 'code': WS_CLOSE_UNAUTHORIZED})
            return
        scope['user'] = user
        return await self.app(scope, receive, send)

    @staticmethod
    def _extract_token(scope) -> str | None:
        # Sec-WebSocket-Protocol 支持两种 wire format：
        #   1) new WebSocket(url, ['access_token', <jwt>])  → subprotocols = ['access_token', <jwt>]
        #   2) new WebSocket(url, ['access_token.<jwt>'])    → subprotocols = ['access_token.<jwt>']
        # token 不走 URL query（会进访问日志/浏览器历史/Referer 泄漏 access token）。
        subprotocols = scope.get('subprotocols') or []
        if len(subprotocols) >= 2 and subprotocols[0] == 'access_token':
            return subprotocols[1]
        for proto in subprotocols:
            if isinstance(proto, str) and proto.startswith('access_token.'):
                return proto[len('access_token.'):]
        return None
