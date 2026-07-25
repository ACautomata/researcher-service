"""seam: chat sessions REST —— issue #41 会话列表后端持久化（spec §9.4 会话列表）。

GET/POST /api/v1/containers/<name>/chat/sessions/：列表 / 新建（后端生成 session_key）。
覆盖：空列表、新建返回 key、无 title、列表倒序、按容器隔离、未知容器 404、未认证 401。
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from chat.models import Session
from containers.models import Instance

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def authed(api):
    user = User.objects.create_user(username='alice', password='strong-pass-1')
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def instance():
    return Instance.objects.create(
        name='demo', port=19000, token='gw-tok',
        home_dir='/tmp/x', container_id='cid', status=Instance.STATUS_RUNNING,
        image='img:tag',
    )


def test_list_sessions_empty(authed, instance):
    resp = authed.get('/api/v1/containers/demo/chat/sessions/')
    assert resp.status_code == 200
    assert resp.json() == []


def test_create_session_returns_key(authed, instance):
    resp = authed.post('/api/v1/containers/demo/chat/sessions/', {'title': '文献综述'}, format='json')
    assert resp.status_code == 201
    data = resp.json()
    assert data['session_key']
    assert data['title'] == '文献综述'
    assert Session.objects.filter(instance=instance, session_key=data['session_key']).exists()


def test_create_session_without_title(authed, instance):
    resp = authed.post('/api/v1/containers/demo/chat/sessions/', {}, format='json')
    assert resp.status_code == 201
    assert resp.json()['title'] == ''


def test_list_sessions_returns_created_newest_first(authed, instance):
    Session.objects.create(instance=instance, session_key='k1', title='A')
    Session.objects.create(instance=instance, session_key='k2', title='B')
    resp = authed.get('/api/v1/containers/demo/chat/sessions/')
    assert resp.status_code == 200
    titles = [s['title'] for s in resp.json()]
    assert titles == ['B', 'A']  # 倒序，最新在前


def test_list_sessions_isolated_per_container(authed, instance):
    other = Instance.objects.create(
        name='other', port=19001, token='t', home_dir='/tmp/y', image='img:tag',
    )
    Session.objects.create(instance=instance, session_key='k1', title='demo-sess')
    Session.objects.create(instance=other, session_key='k2', title='other-sess')
    resp = authed.get('/api/v1/containers/demo/chat/sessions/')
    titles = [s['title'] for s in resp.json()]
    assert titles == ['demo-sess']


def test_sessions_unknown_container_404(authed):
    resp = authed.get('/api/v1/containers/nope/chat/sessions/')
    assert resp.status_code == 404


def test_sessions_require_auth(api):
    resp = api.get('/api/v1/containers/demo/chat/sessions/')
    assert resp.status_code == 401
