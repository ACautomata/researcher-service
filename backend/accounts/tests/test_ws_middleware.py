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
async def test_ws_valid_token_query_param_accepted():
    token = await _access('wsuser')
    comm = WebsocketCommunicator(_app(), f'/ws/chat/?token={token}')
    connected, _ = await comm.connect()
    assert connected is True
    # middleware 已把认证用户注入 scope['user']
    assert await comm.receive_from() == 'wsuser'
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_valid_token_subprotocol_accepted():
    # 浏览器 WS 不能自定义头，token 也可经 Sec-WebSocket-Protocol 携带（spec §1）
    token = await _access('proto')
    comm = WebsocketCommunicator(_app(), '/ws/chat/', subprotocols=['access_token', token])
    connected, _ = await comm.connect()
    assert connected is True
    assert await comm.receive_from() == 'proto'
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_no_token_rejected():
    comm = WebsocketCommunicator(_app(), '/ws/chat/')
    connected, _ = await comm.connect()
    assert connected is False
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_garbage_token_rejected():
    comm = WebsocketCommunicator(_app(), '/ws/chat/?token=not-a-jwt')
    connected, _ = await comm.connect()
    assert connected is False
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ws_other_secret_token_rejected():
    # 与 REST「同一 JWT」：非本服务签发的 token 必须拒（验签失败）
    import jwt as pyjwt

    forged = pyjwt.encode({'user_id': 1, 'token_type': 'access'}, 'other-secret', algorithm='HS256')
    comm = WebsocketCommunicator(_app(), f'/ws/chat/?token={forged}')
    connected, _ = await comm.connect()
    assert connected is False
    await comm.disconnect()
