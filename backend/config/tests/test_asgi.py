"""seam: config.asgi 装配 —— WS 握手经 JwtAuthMiddleware 验同一 JWT（issue #38 T02）。

直接对真实 ``config.asgi.application``（ProtocolTypeRouter）发起 WS 握手：
有效 token 通过 middleware；无 token / 无效 token 握手被拒。
（T02 尚无 WS 业务路由，握手通过后由占位 app 优雅关闭，见 config/asgi.py。）
"""
import pytest
from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.tokens import RefreshToken

User = get_user_model()


@sync_to_async
def _access(username):
    user = User.objects.create_user(username=username, password='strong-pass-1')
    return str(RefreshToken.for_user(user).access_token)


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_asgi_ws_no_token_rejected():
    from config.asgi import application

    comm = WebsocketCommunicator(application, '/ws/chat/')
    connected, _ = await comm.connect()
    assert connected is False
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_asgi_ws_invalid_token_rejected():
    from config.asgi import application

    comm = WebsocketCommunicator(application, '/ws/chat/?token=garbage')
    connected, _ = await comm.connect()
    assert connected is False
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_asgi_ws_valid_token_passes_middleware():
    # 有效 JWT 握手通过 JwtAuthMiddleware；T02 无业务路由，占位 app 优雅关闭（能连上即证明握手被验通过）
    from config.asgi import application

    token = await _access('asgiuser')
    comm = WebsocketCommunicator(application, f'/ws/chat/?token={token}')
    connected, _ = await comm.connect()
    assert connected is True
    await comm.disconnect()
