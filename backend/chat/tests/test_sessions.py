"""seam: chat sessions REST —— 网关权威会话（issue #81 / spec #76）。

后端零 session 持久化，4 端点经该容器已配对长连接代理网关会话 RPC：
- GET    /api/v1/containers/<name>/chat/sessions/                 → sessions.list（派生标题替代旧 title）
- GET    /api/v1/containers/<name>/chat/sessions/<key>/history    → chat.history（透传 messages + 分页）
- POST   /api/v1/containers/<name>/chat/sessions/                 → sessions.create{key,label}
- DELETE /api/v1/containers/<name>/chat/sessions/<key>/           → sessions.delete（admin 级）

覆盖：每端点成功路径（代理正确 RPC + 翻译正确）、404/400/401/409/502 错误语义、
网关畸形数据防御（非 dict 项跳过）、chat.Session 删表 migration 正反应用。
"""
import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from rest_framework.test import APIClient

from chat.chat_client import ChatConnectError, ChatSendError
from chat.pool import ChatFleet, NotPaired
from containers.models import Instance

User = get_user_model()
pytestmark = pytest.mark.django_db

LIST_URL = '/api/v1/containers/demo/chat/sessions/'
HISTORY_URL = '/api/v1/containers/demo/chat/sessions/sk-1/history'
DELETE_URL = '/api/v1/containers/demo/chat/sessions/sk-1/'

# 实测校准前的网关 payload（字段名「待实测」，REST 解析层集中校准，对齐 _parse_commands 模式）
GATEWAY_SESSIONS = {
    'sessions': [
        {'key': 'sk-1', 'derivedTitle': '文献综述初稿', 'updatedAt': '2026-07-20T10:00:00Z'},
        {'key': 'sk-2', 'derivedTitle': '', 'updatedAt': '2026-07-19T09:00:00Z'},
        {'key': 'sk-3'},  # 无派生标题/时间 → fallback
    ],
}
GATEWAY_HISTORY = {
    'messages': [
        {'role': 'user', 'content': '你好'},
        {'role': 'assistant', 'content': '你好，有什么可以帮你？'},
    ],
    'hasMore': True,
    'nextOffset': 42,
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
    """记录 4 个会话 RPC 调用、返回预设 payload / 抛预设错误的 client 替身。"""

    def __init__(self, *, sessions=None, history=None, created=None, deleted=None, error=None):
        self._sessions = sessions if sessions is not None else {}
        self._history = history if history is not None else {}
        self._created = created if created is not None else {}
        self._deleted = deleted if deleted is not None else {}
        self._error = error
        self.calls = []  # [(method, args, kwargs)]

    def _record(self, method, *args, **kwargs):
        self.calls.append((method, args, kwargs))
        if self._error is not None:
            raise self._error

    async def list_sessions(self, *args, **kwargs):
        self._record('list_sessions', *args, **kwargs)
        return self._sessions

    async def get_history(self, *args, **kwargs):
        self._record('get_history', *args, **kwargs)
        return self._history

    async def create_session(self, *args, **kwargs):
        self._record('create_session', *args, **kwargs)
        return self._created

    async def delete_session(self, *args, **kwargs):
        self._record('delete_session', *args, **kwargs)
        return self._deleted


class _FakePool:
    def __init__(self, client):
        self._client = client

    async def get_or_create(self, instance):
        return self._client


@pytest.fixture
def override_pool():
    def _set(pool):
        ChatFleet.override(pool)
        return pool

    yield _set
    ChatFleet.reset()


# ---------------------------------------------------------------------------
# GET sessions/ → sessions.list
# ---------------------------------------------------------------------------

def test_list_sessions_success(authed, instance, override_pool):
    """成功 → 200 {sessions:[...]}，代理 sessions.list，派生标题替代旧 title。"""
    client = _FakeClient(sessions=GATEWAY_SESSIONS)
    override_pool(_FakePool(client))
    resp = authed.get(LIST_URL)
    assert resp.status_code == 200
    assert resp.json() == {
        'sessions': [
            {'session_key': 'sk-1', 'title': '文献综述初稿', 'updated_at': '2026-07-20T10:00:00Z'},
            {'session_key': 'sk-2', 'title': '', 'updated_at': '2026-07-19T09:00:00Z'},
            {'session_key': 'sk-3', 'title': '', 'updated_at': ''},
        ],
    }
    assert client.calls[0][0] == 'list_sessions'


def test_list_sessions_malformed_items_skipped(authed, instance, override_pool):
    """防御：非 dict 项 / 缺 key 项跳过，不污染响应（对网关输入 0 信任）。"""
    client = _FakeClient(sessions={'sessions': [
        {'key': 'sk-1', 'derivedTitle': 'ok'},
        'not-a-dict',
        {'derivedTitle': 'no-key'},
        42,
    ]})
    override_pool(_FakePool(client))
    resp = authed.get(LIST_URL)
    assert resp.status_code == 200
    assert resp.json() == {'sessions': [{'session_key': 'sk-1', 'title': 'ok', 'updated_at': ''}]}


# ---------------------------------------------------------------------------
# GET sessions/<key>/history → chat.history
# ---------------------------------------------------------------------------

def test_history_success(authed, instance, override_pool):
    """成功 → 200，代理 chat.history(sessionKey)，透传 messages + hasMore/nextOffset。"""
    client = _FakeClient(history=GATEWAY_HISTORY)
    override_pool(_FakePool(client))
    resp = authed.get(HISTORY_URL)
    assert resp.status_code == 200
    assert resp.json() == {
        'messages': GATEWAY_HISTORY['messages'],
        'hasMore': True,
        'nextOffset': 42,
    }
    method, args, kwargs = client.calls[0]
    assert method == 'get_history'
    assert args[0] == 'sk-1'


def test_history_passes_pagination_anchor(authed, instance, override_pool):
    """limit/messageId 锚点 query 透传给网关（向回翻页）。"""
    client = _FakeClient(history=GATEWAY_HISTORY)
    override_pool(_FakePool(client))
    resp = authed.get(f'{HISTORY_URL}?limit=50&messageId=m-9')
    assert resp.status_code == 200
    _, _, kwargs = client.calls[0]
    assert kwargs.get('limit') == 50
    assert kwargs.get('message_id') == 'm-9'


def test_history_malformed_messages_skipped(authed, instance, override_pool):
    """防御：messages 中非 dict 项跳过。"""
    client = _FakeClient(history={'messages': [{'role': 'user'}, 'bad', 7], 'hasMore': False})
    override_pool(_FakePool(client))
    resp = authed.get(HISTORY_URL)
    assert resp.status_code == 200
    assert resp.json()['messages'] == [{'role': 'user'}]


# ---------------------------------------------------------------------------
# POST sessions/ → sessions.create
# ---------------------------------------------------------------------------

def test_create_session_success(authed, instance, override_pool):
    """成功 → 201 {session_key,...}，代理 sessions.create{key,label}。"""
    client = _FakeClient(created={'key': 'sk-new', 'label': '新会话'})
    override_pool(_FakePool(client))
    resp = authed.post(LIST_URL, {'label': '新会话'}, format='json')
    assert resp.status_code == 201
    assert resp.json()['session_key'] == 'sk-new'
    method, args, kwargs = client.calls[0]
    assert method == 'create_session'
    assert kwargs.get('label') == '新会话'


def test_create_session_without_label(authed, instance, override_pool):
    """免标题新建（网关后续派生）：不传 label → 201，后端生成 key 透传。"""
    client = _FakeClient(created={'key': 'sk-auto'})
    override_pool(_FakePool(client))
    resp = authed.post(LIST_URL, {}, format='json')
    assert resp.status_code == 201
    assert resp.json()['session_key'] == 'sk-auto'


@pytest.mark.parametrize('body', [
    '[]',          # JSON 数组 → .get AttributeError 路径（旧实现 500）
    '"label"',     # JSON 字符串
    '123',         # JSON 数字
])
def test_create_session_non_object_body_400(authed, instance, override_pool, body):
    """codex P1：非对象 body 必须 400（DRF serializer 边界），不得 500。"""
    client = _FakeClient(created={'key': 'sk-new'})
    override_pool(_FakePool(client))
    resp = authed.post(LIST_URL, body, content_type='application/json')
    assert resp.status_code == 400
    assert client.calls == []  # pylint: disable=use-implicit-booleaness-not-comparison


def test_create_session_non_string_label_400(authed, instance, override_pool):
    """label 非 str（如 {"label": 42}）→ 400，不静默吞掉。"""
    client = _FakeClient(created={'key': 'sk-new'})
    override_pool(_FakePool(client))
    resp = authed.post(LIST_URL, {'label': 42}, format='json')
    assert resp.status_code == 400
    assert client.calls == []  # pylint: disable=use-implicit-booleaness-not-comparison


# ---------------------------------------------------------------------------
# DELETE sessions/<key>/ → sessions.delete
# ---------------------------------------------------------------------------

def test_delete_session_success(authed, instance, override_pool):
    """成功 → 204，代理 sessions.delete（admin 级）。"""
    client = _FakeClient(deleted={'ok': True})
    override_pool(_FakePool(client))
    resp = authed.delete(DELETE_URL)
    assert resp.status_code == 204
    method, args, kwargs = client.calls[0]
    assert method == 'delete_session'
    assert args[0] == 'sk-1'


# ---------------------------------------------------------------------------
# 错误语义（对齐 CommandListView）：404 / 400 / 401 / 409 / 502
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('method,url', [
    ('get', LIST_URL),
    ('get', HISTORY_URL),
    ('post', LIST_URL),
    ('delete', DELETE_URL),
])
def test_unknown_container_404(authed, override_pool, method, url):
    override_pool(_FakePool(_FakeClient(sessions=GATEWAY_SESSIONS)))
    resp = getattr(authed, method)(url.replace('/demo/', '/nope/'))
    assert resp.status_code == 404


@pytest.mark.parametrize('path', [
    '/api/v1/containers/bad$name/chat/sessions/',
    '/api/v1/containers/bad$name/chat/sessions/sk-1/history',
])
def test_invalid_name_400(authed, override_pool, path):
    override_pool(_FakePool(_FakeClient()))
    resp = authed.get(path)
    assert resp.status_code == 400


@pytest.mark.parametrize('method,url', [
    ('get', LIST_URL),
    ('get', HISTORY_URL),
    ('delete', DELETE_URL),
])
def test_requires_auth(api, instance, override_pool, method, url):
    override_pool(_FakePool(_FakeClient()))
    resp = getattr(api, method)(url)
    assert resp.status_code in (401, 403)


@pytest.mark.parametrize('method,url', [
    ('get', LIST_URL),
    ('get', HISTORY_URL),
    ('delete', DELETE_URL),
])
def test_unpaired_409(authed, instance, override_pool, method, url):
    class _NotPairedPool:
        async def get_or_create(self, instance):
            raise NotPaired('pending', 'req-9')

    override_pool(_NotPairedPool())
    resp = getattr(authed, method)(url)
    assert resp.status_code == 409


@pytest.mark.parametrize('method,url', [
    ('get', LIST_URL),
    ('get', HISTORY_URL),
    ('delete', DELETE_URL),
])
def test_gateway_reject_502(authed, instance, override_pool, method, url):
    """网关拒绝（缺 scope）→ 502（固定文案，不外泄原始异常）。"""
    client = _FakeClient(error=ChatSendError('missing scope operator.admin'))
    override_pool(_FakePool(client))
    resp = getattr(authed, method)(url)
    assert resp.status_code == 502
    assert 'operator.admin' not in resp.content.decode()


@pytest.mark.parametrize('method,url', [
    ('get', LIST_URL),
    ('get', HISTORY_URL),
    ('delete', DELETE_URL),
])
def test_pool_connect_failure_502(authed, instance, override_pool, method, url):
    """配对有效但网关离线/握手失败 → get_or_create 抛连接异常 → 502（非 500）。"""
    class _ConnectFailPool:
        async def get_or_create(self, instance):
            raise ChatConnectError('gateway offline')

    override_pool(_ConnectFailPool())
    resp = getattr(authed, method)(url)
    assert resp.status_code == 502


# ---------------------------------------------------------------------------
# 删表 migration 正反应用（chat.Session → 无表）
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_session_drop_migration_reversible():
    """0004_delete_session 可正反应用：apply 后 chat_session 无表，unapply 后复有表。"""
    executor = MigrationExecutor(connection)
    # 迁移到删表之后：chat_session 表不存在
    executor.migrate([('chat', '0004_delete_session')])
    with connection.cursor() as cur:
        tables_after = set(connection.introspection.table_names(cur))
    assert 'chat_session' not in tables_after
    # 回滚到删表之前（0003_session）：chat_session 表复存在
    executor.migrate([('chat', '0003_session')])
    with connection.cursor() as cur:
        tables_before = set(connection.introspection.table_names(cur))
    assert 'chat_session' in tables_before
