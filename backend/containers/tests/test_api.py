"""seam: containers REST API —— issue #39 容器管理控制面。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §3（全局 IsAuthenticated 拦截）/§4（零信任，经 Serializer）/
§9.3（容器管理页后端契约：列表 status/health/port + 新建 + 删除）。

端点：GET/POST /api/v1/containers/、DELETE /api/v1/containers/<name>。
fleet fixture（conftest）注入 FakeRuntime，故不碰真 daemon。
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from containers.orchestrator import InstanceCleanupError, InstanceExists

User = get_user_model()


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def authed(api):
    # force_authenticate 跳过 JWT 编码细节；401 拦截由无 token 用例单独覆盖
    user = User.objects.create_user(username='alice', password='strong-pass-1')
    api.force_authenticate(user=user)
    return api


# ---------------------------- 认证拦截（spec §3）----------------------------


@pytest.mark.django_db
def test_list_requires_auth(api):
    assert api.get('/api/v1/containers/').status_code == 401


@pytest.mark.django_db
def test_create_requires_auth(api):
    assert api.post('/api/v1/containers/', {'name': 'demo'}, format='json').status_code == 401


@pytest.mark.django_db
def test_delete_requires_auth(api):
    assert api.delete('/api/v1/containers/demo').status_code == 401


# ---------------------------- 创建（spec §9.3 新建）----------------------------


@pytest.mark.django_db
def test_create_returns_instance(authed, fleet):
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 201
    data = resp.json()
    assert data['name'] == 'demo'
    assert data['port'] == 19000  # 端口池最小空闲
    assert data['status'] == 'running'
    assert data['image'] == 'img:tag'
    # 落盘验收（issue #39：宿主 instances/<name>/ 落盘）
    assert (fleet['config'].root / 'instances' / 'demo' / 'home' / 'workspace' / 'note.md').exists()
    assert (fleet['config'].root / 'instances' / 'demo' / 'openclaw.json').exists()


@pytest.mark.django_db
def test_create_rejects_invalid_name(authed):
    # spec §4 零信任：非法 name → 400 非 500
    resp = authed.post('/api/v1/containers/', {'name': 'Bad/Name'}, format='json')
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_rejects_missing_name(authed):
    resp = authed.post('/api/v1/containers/', {}, format='json')
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_rejects_duplicate(authed, fleet):
    # 重复 name → 400（UniqueValidator），非 409/500
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 400


# ---------------------------- 列表（spec §9.3 status/health/port）----------------------------


@pytest.mark.django_db
def test_list_empty(authed):
    assert authed.get('/api/v1/containers/').json() == []


@pytest.mark.django_db
def test_list_shows_created_instance(authed, fleet):
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    items = authed.get('/api/v1/containers/').json()
    assert len(items) == 1
    assert items[0]['name'] == 'demo'


@pytest.mark.django_db
def test_list_health_turns_healthy_when_reachable(authed, fleet):
    # issue #39 验收：列表 health 随外部 /health 探测变 healthy
    port = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json').json()['port']
    # 默认 running 但 gateway 未探通 → unhealthy
    assert authed.get('/api/v1/containers/').json()[0]['health'] == 'unhealthy'
    fleet['health'].set_reachable(port, True)
    assert authed.get('/api/v1/containers/').json()[0]['health'] == 'healthy'


# ---------------------------- 删除（spec §5.4 连数据删）----------------------------


@pytest.mark.django_db
def test_delete_removes_instance_and_dir(authed, fleet):
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    resp = authed.delete('/api/v1/containers/demo')
    assert resp.status_code == 204
    # issue #39 验收：instances/<name>/ 一并清除
    assert not (fleet['config'].root / 'instances' / 'demo').exists()
    assert authed.get('/api/v1/containers/').json() == []


@pytest.mark.django_db
def test_delete_missing_returns_404(authed):
    assert authed.delete('/api/v1/containers/nope').status_code == 404


@pytest.mark.django_db
def test_delete_rejects_invalid_name(authed):
    # 路径参数也校验（spec §4）：防 URL path 注入
    resp = authed.delete('/api/v1/containers/Bad..Name')
    assert resp.status_code == 400


# ---------------------------- codex R1 并发/清理失败转译（:84/:126） ----------------------------


@pytest.mark.django_db
def test_create_returns_409_on_concurrent_duplicate(authed, fleet, monkeypatch):
    # codex R1 :84：orchestrator InstanceExists（并发绕 UniqueValidator）→ 409，非裸 500
    def _raise(name):
        raise InstanceExists(name)

    monkeypatch.setattr(fleet['orch'], 'create', _raise)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 409


@pytest.mark.django_db
def test_delete_returns_409_when_cleanup_fails(authed, fleet, monkeypatch):
    # codex R1 :126：home 清理失败 → 409 + DB 行保留（可重试），非吞错 204
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')

    def _fail(name):
        raise InstanceCleanupError(name, str(fleet['config'].root))

    monkeypatch.setattr(fleet['orch'], 'delete', _fail)
    resp = authed.delete('/api/v1/containers/demo')
    assert resp.status_code == 409
