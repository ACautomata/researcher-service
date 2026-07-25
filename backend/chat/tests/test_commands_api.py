"""seam: chat commands REST API —— T07 斜杠命令清单代理（issue #43 / spec §8.4）。

端点：GET /api/v1/containers/<name>/chat/commands
→ 经该容器 pool client 发 commands.list（需 operator.read），把网关清单翻译成前端补全契约：
  [{name, description, aliases[]}]——aliases 为精确斜杠别名（textAliases，如 /model、/m）。

验收映射：
- 拉取成功 → 200 命令清单（验收 1：输入 `/` 弹该容器命令清单）
- 响应外层键名/includeArgs 元数据按实测校准（验收 3）：payload 主键 `commands`，回退兼容单数 `command`
- 容器不存在 → 404；非法 name → 400；未配对 → 409；网关拒绝/离线 → 502
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from chat.chat_client import ChatConnectError, ChatSendError
from chat.pool import ChatFleet, NotPaired
from containers.models import Instance

User = get_user_model()
pytestmark = pytest.mark.django_db

URL = '/api/v1/containers/demo/chat/commands'

# 实测校准后的网关 payload（spec §8.2 标待实测：外层键名 + includeArgs 元数据）
GATEWAY_PAYLOAD = {
    'commands': [
        {'name': 'model', 'description': '切换模型', 'textAliases': ['/model', '/m'], 'nativeName': 'model'},
        {'name': 'wiki', 'description': '在 wiki 中检索/写入', 'textAliases': ['/wiki'], 'nativeName': 'wiki'},
        {'name': 'compact', 'description': '压缩会话上下文', 'textAliases': ['/compact']},
    ]
}


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def authed(api):
    user = User.objects.create_user(username='alice', password='strong-pass-1')
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def instance(db):
    return Instance.objects.create(
        name='demo', port=19000, token='gw-tok',
        home_dir='/tmp/x', container_id='cid', status=Instance.STATUS_RUNNING,
        image='img:tag',
    )


class _FakeClient:
    """记录 list_commands 调用、返回预设 payload 的 client 替身。"""

    def __init__(self, payload=None, error=None):
        self.calls = 0
        self._payload = payload if payload is not None else {}
        self._error = error

    async def list_commands(self):
        self.calls += 1
        if self._error is not None:
            raise self._error
        return self._payload


class _FakePool:
    def __init__(self, client):
        self._client = client

    async def get_or_create(self, instance):
        return self._client


@pytest.fixture
def override_pool():
    holder = {}

    def _set(pool):
        ChatFleet.override(pool)
        holder['pool'] = pool
        return pool

    yield _set
    ChatFleet.reset()


def test_commands_success(authed, instance, override_pool):
    """验收 1：成功 → 200 命令清单（name/description/aliases，aliases 取 textAliases）。"""
    client = _FakeClient(payload=GATEWAY_PAYLOAD)
    override_pool(_FakePool(client))
    resp = authed.get(URL)
    assert resp.status_code == 200
    assert resp.json() == [
        {'name': 'model', 'description': '切换模型', 'aliases': ['/model', '/m']},
        {'name': 'wiki', 'description': '在 wiki 中检索/写入', 'aliases': ['/wiki']},
        {'name': 'compact', 'description': '压缩会话上下文', 'aliases': ['/compact']},
    ]
    assert client.calls == 1


def test_commands_singular_key_fallback(authed, instance, override_pool):
    """验收 3：响应外层键名按实测校准——payload 主键非 `commands` 时回退兼容单数 `command`。"""
    client = _FakeClient(payload={'command': {'name': 'new', 'description': '新建会话',
                                              'textAliases': ['/new']}})
    override_pool(_FakePool(client))
    resp = authed.get(URL)
    assert resp.status_code == 200
    assert resp.json() == [{'name': 'new', 'description': '新建会话', 'aliases': ['/new']}]


def test_commands_alias_fallback_to_name(authed, instance, override_pool):
    """textAliases 缺失时：aliases 回退为 `/{name}`（保证前端补全至少有一个可点斜杠别名）。"""
    client = _FakeClient(payload={'commands': [{'name': 'model', 'description': '切换模型'}]})
    override_pool(_FakePool(client))
    resp = authed.get(URL)
    assert resp.status_code == 200
    assert resp.json() == [{'name': 'model', 'description': '切换模型', 'aliases': ['/model']}]


def test_commands_malformed_items_skipped(authed, instance, override_pool):
    """防御：清单中非 dict 项/缺 name 项跳过，不污染响应（对网关输入 0 信任）。"""
    client = _FakeClient(payload={'commands': [
        {'name': 'model', 'description': 'ok', 'textAliases': ['/model']},
        'not-a-dict',
        {'description': 'no-name'},
        42,
    ]})
    override_pool(_FakePool(client))
    resp = authed.get(URL)
    assert resp.status_code == 200
    assert resp.json() == [{'name': 'model', 'description': 'ok', 'aliases': ['/model']}]


def test_commands_unknown_container_404(authed, override_pool):
    override_pool(_FakePool(_FakeClient(payload=GATEWAY_PAYLOAD)))
    resp = authed.get(URL)
    assert resp.status_code == 404


def test_commands_invalid_name_400(authed, override_pool):
    override_pool(_FakePool(_FakeClient(payload=GATEWAY_PAYLOAD)))
    resp = authed.get('/api/v1/containers/bad$name/chat/commands')
    assert resp.status_code == 400


def test_commands_unpaired_409(authed, instance, override_pool):
    class _NotPairedPool:
        async def get_or_create(self, instance):
            raise NotPaired('pending', 'req-9')
    override_pool(_NotPairedPool())
    resp = authed.get(URL)
    assert resp.status_code == 409


def test_commands_gateway_reject_502(authed, instance, override_pool):
    client = _FakeClient(error=ChatSendError('missing scope operator.read'))
    override_pool(_FakePool(client))
    resp = authed.get(URL)
    assert resp.status_code == 502


def test_commands_pool_connect_failure_502(authed, instance, override_pool):
    """配对有效但网关离线/握手失败 → get_or_create 抛连接异常 → 502（非 500）。"""
    class _ConnectFailPool:
        async def get_or_create(self, instance):
            raise ChatConnectError('gateway offline')
    override_pool(_ConnectFailPool())
    resp = authed.get(URL)
    assert resp.status_code == 502


def test_commands_requires_auth(api, instance, override_pool):
    override_pool(_FakePool(_FakeClient(payload=GATEWAY_PAYLOAD)))
    resp = api.get(URL)
    assert resp.status_code in (401, 403)
