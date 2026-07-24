"""seam: Channels JWT middleware 握手验同一 JWT（spec §3）—— issue #38 T02。

spec §3：WebSocket 用自定义 Channels JWT middleware 在握手时验同一 JWT
（与 REST 同 simplejwt 后端、同密钥/算法）。有效 token 放行并注入 user；
无 token / 无效 token 握手期拒绝。
"""
import pytest
from asgiref.sync import sync_to_async
from channels.generic.websocket import WebsocketConsumer
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.middleware import JwtAuthMiddleware

User = get_user_model()


class _ProbeConsumer(WebsocketConsumer):
    """探针：握手成功即把 scope['user'] 用户名发给客户端，便于断言 middleware 注入结果。"""

    def connect(self):
        self.accept()
        user = self.scope.get('user')
        self.send(text_data=getattr(user, 'username', '<none>'))
        self.close()


def _app():
    return JwtAuthMiddleware(_ProbeConsumer.as_asgi())


@sync_to_async
def _access(username):
    user = User.objects.create_user(username=username, password='strong-pass-1')
    return str(RefreshToken.for_user(user).access_token)


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_valid_token_subprotocol_accepted():
    # 浏览器 WS 不能自定义头，token 经 Sec-WebSocket-Protocol 携带（spec §1）
    token = await _access('proto')
    comm = WebsocketCommunicator(_app(), '/ws/chat/', subprotocols=['access_token', token])
    connected, _ = await comm.connect()
    assert connected is True
    assert await comm.receive_from() == 'proto'
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_query_param_token_rejected():
    # 安全：token 不走 URL query（会进访问日志/浏览器历史/Referer 泄漏 access token）。
    # 即便 query 带合法 token，也不应被采信——握手拒绝并返回 4401 close frame。
    token = await _access('wsuser')
    comm = WebsocketCommunicator(_app(), f'/ws/chat/?token={token}')
    connected, subprotocol = await comm.connect()
    assert connected is True
    assert subprotocol is None
    msg = await comm.receive_output(timeout=1)
    assert msg['type'] == 'websocket.close'
    assert msg['code'] == 4401
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_no_token_rejected():
    comm = WebsocketCommunicator(_app(), '/ws/chat/')
    connected, subprotocol = await comm.connect()
    assert connected is True
    assert subprotocol is None
    msg = await comm.receive_output(timeout=1)
    assert msg['type'] == 'websocket.close'
    assert msg['code'] == 4401
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_garbage_token_rejected():
    comm = WebsocketCommunicator(_app(), '/ws/chat/', subprotocols=['access_token', 'not-a-jwt'])
    connected, subprotocol = await comm.connect()
    assert connected is True
    assert subprotocol == 'access_token'
    msg = await comm.receive_output(timeout=1)
    assert msg['type'] == 'websocket.close'
    assert msg['code'] == 4401
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_other_secret_token_rejected():
    # 与 REST「同一 JWT」：非本服务签发的 token 必须拒（验签失败）
    import jwt as pyjwt

    forged = pyjwt.encode({'user_id': 1, 'token_type': 'access'}, 'other-secret', algorithm='HS256')
    comm = WebsocketCommunicator(_app(), '/ws/chat/', subprotocols=['access_token', forged])
    connected, subprotocol = await comm.connect()
    assert connected is True
    assert subprotocol == 'access_token'
    msg = await comm.receive_output(timeout=1)
    assert msg['type'] == 'websocket.close'
    assert msg['code'] == 4401
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_valid_token_single_subprotocol_accepted():
    # 浏览器 new WebSocket(url, ['access_token.<jwt>']) 会把整个字符串作为一个 subprotocol
    token = await _access('single_proto')
    comm = WebsocketCommunicator(_app(), '/ws/chat/', subprotocols=[f'access_token.{token}'])
    connected, _ = await comm.connect()
    assert connected is True
    assert await comm.receive_from() == 'single_proto'
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_inactive_user_token_rejected():
    # 已签发且未过期的 token，在用户被删除/禁用后必须被拒（与 REST get_user 行为一致）
    token = await _access('inactive_user')
    user = await sync_to_async(User.objects.get)(username='inactive_user')
    await sync_to_async(user.delete)()
    comm = WebsocketCommunicator(_app(), '/ws/chat/', subprotocols=['access_token', token])
    connected, subprotocol = await comm.connect()
    assert connected is True
    assert subprotocol == 'access_token'
    msg = await comm.receive_output(timeout=1)
    assert msg['type'] == 'websocket.close'
    assert msg['code'] == 4401
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_asgi_application_wired():
    # 开发服务器 runserver 必须经 daphne 走 ASGI，WS 握手才会进入 ProtocolTypeRouter
    from django.conf import settings

    assert 'daphne' in settings.INSTALLED_APPS
    assert settings.ASGI_APPLICATION == 'config.asgi.application'
