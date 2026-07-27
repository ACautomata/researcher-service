"""seam: chat approval REST API —— T06 权限审批回退路径（issue #42 / spec §8.4）。

端点：POST /api/v1/containers/<name>/chat/approval/resolve
body {id, kind, decision} → 经该容器 pool client 发 approval.resolve（需 operator.approvals）。
WS 路径（consumer resolve）为主；REST 为回退/外部触发。受全局 IsAuthenticated 保护。

验收映射：
- 回覆成功 → 200 {ok:true, id, decision}（验收 2：批准/拒绝后结果回写）
- 缺字段 → 400；容器不存在 → 404；非法 name → 400；未配对 → 409；网关拒绝 → 502
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from chat.chat_client import ChatSendError
from chat.pool import ChatFleet, NotPaired
from containers.models import Instance

User = get_user_model()
pytestmark = pytest.mark.django_db

URL = '/api/v1/containers/demo/chat/approval/resolve'


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
    """记录 resolve_approval / broadcast_approval_resolved 的 client 替身。"""

    def __init__(self, payload=None):
        self.resolved = []
        self.broadcasts = []  # (approval_id, decision)
        self._payload = payload if payload is not None else {}

    async def resolve_approval(self, approval_id, kind, decision):
        self.resolved.append((approval_id, kind, decision))
        return self._payload

    async def broadcast_approval_resolved(self, approval_id, decision):
        self.broadcasts.append((approval_id, decision))


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


def test_resolve_success(authed, instance, override_pool):
    client = _FakeClient()
    override_pool(_FakePool(client))
    resp = authed.post(URL, {'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'}, format='json')
    assert resp.status_code == 200
    assert resp.json() == {'ok': True, 'id': 'ap-1', 'decision': 'allow-once'}
    assert client.resolved == [('ap-1', 'exec', 'allow-once')]


def test_resolve_returns_authoritative_decision(authed, instance, override_pool):
    """codex P1：first-answer-wins —— 响应用网关权威 decision，非回声请求值。"""
    client = _FakeClient(payload={'id': 'ap-1', 'decision': 'deny'})
    override_pool(_FakePool(client))
    resp = authed.post(URL, {'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'}, format='json')
    assert resp.status_code == 200
    assert resp.json()['decision'] == 'deny'  # 请求 allow-once，权威记录 deny


def test_resolve_broadcasts_authoritative_to_ws_subscribers(authed, instance, override_pool):
    """codex R2 P2：REST 路径的权威回执经 pool client fan-out 给 WS 订阅者（副本收敛）。"""
    client = _FakeClient(payload={'id': 'ap-1', 'decision': 'deny'})
    override_pool(_FakePool(client))
    resp = authed.post(URL, {'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'}, format='json')
    assert resp.status_code == 200
    assert client.broadcasts == [('ap-1', 'deny')]  # 权威 decision fan-out 给 WS 订阅者


def test_resolve_missing_field_400(authed, instance, override_pool):
    override_pool(_FakePool(_FakeClient()))
    resp = authed.post(URL, {'id': 'ap-1'}, format='json')  # 缺 kind/decision
    assert resp.status_code == 400


def test_resolve_invalid_decision_400(authed, instance, override_pool):
    override_pool(_FakePool(_FakeClient()))
    resp = authed.post(URL, {'id': 'ap-1', 'kind': 'exec', 'decision': 'approve'}, format='json')
    assert resp.status_code == 400


def test_resolve_unknown_container_404(authed, override_pool):
    override_pool(_FakePool(_FakeClient()))
    resp = authed.post(URL, {'id': 'a', 'kind': 'exec', 'decision': 'allow-once'}, format='json')
    assert resp.status_code == 404


def test_resolve_unpaired_409(authed, instance, override_pool):
    class _NotPairedPool:
        async def get_or_create(self, instance):
            raise NotPaired('pending', 'req-9')
    override_pool(_NotPairedPool())
    resp = authed.post(URL, {'id': 'a', 'kind': 'exec', 'decision': 'allow-once'}, format='json')
    assert resp.status_code == 409


def test_resolve_gateway_reject_502(authed, instance, override_pool):
    async def fail(*args):
        raise ChatSendError('missing scope operator.approvals')

    client = _FakeClient()
    client.resolve_approval = fail
    override_pool(_FakePool(client))
    resp = authed.post(URL, {'id': 'a', 'kind': 'exec', 'decision': 'deny'}, format='json')
    assert resp.status_code == 502


def test_resolve_pool_connect_failure_502(authed, instance, override_pool):
    """codex P2：配对有效但网关离线/握手失败时，get_or_create 抛连接异常 → 502（非 500）。"""
    from chat.chat_client import ChatConnectError

    class _ConnectFailPool:
        async def get_or_create(self, instance):
            raise ChatConnectError('gateway offline')
    override_pool(_ConnectFailPool())
    resp = authed.post(URL, {'id': 'a', 'kind': 'exec', 'decision': 'allow-once'}, format='json')
    assert resp.status_code == 502


def test_resolve_requires_auth(api, instance, override_pool):
    override_pool(_FakePool(_FakeClient()))
    resp = api.post(URL, {'id': 'a', 'kind': 'exec', 'decision': 'allow-once'}, format='json')
    assert resp.status_code in (401, 403)
