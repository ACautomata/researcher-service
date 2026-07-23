"""seam: 后端 JWT 认证闭环（register/login/me + 401 拦截）—— issue #37 P0 骨架。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §3（本地账号 + JWT 签发）/§4（输入 0 信任，经 Serializer）。
"""
import jwt

import pytest
from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

User = get_user_model()


@pytest.fixture
def api():
    return APIClient()


@pytest.mark.django_db
def test_register_creates_user(api):
    resp = api.post(
        '/api/v1/auth/register',
        {'username': 'alice', 'password': 'strong-pass-123'},
    )
    assert resp.status_code == 201
    assert resp.json()['username'] == 'alice'
    assert User.objects.filter(username='alice').exists()


@pytest.mark.django_db
def test_login_returns_jwt(api):
    bob = User.objects.create_user(username='bob', password='strong-pass-456')
    resp = api.post(
        '/api/v1/auth/login',
        {'username': 'bob', 'password': 'strong-pass-456'},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert 'access' in data
    assert 'refresh' in data
    # 解码 access：期望值（user_id）来自创建返回的实例，非用代码同样方式重算。
    # simplejwt 5.5 把 user_id claim 序列化为字符串，用 int() 容忍。
    payload = jwt.decode(data['access'], settings.SECRET_KEY, algorithms=['HS256'])
    assert payload['token_type'] == 'access'
    assert int(payload['user_id']) == bob.id


@pytest.mark.django_db
def test_me_rejects_without_token(api):
    # 全局 IsAuthenticated 拦截（spec §3）：无 token → 401
    resp = api.get('/api/v1/auth/me')
    assert resp.status_code == 401


@pytest.mark.django_db
def test_me_returns_user_with_token(api):
    bob = User.objects.create_user(username='bob', password='strong-pass-456')
    login = api.post(
        '/api/v1/auth/login',
        {'username': 'bob', 'password': 'strong-pass-456'},
    )
    token = login.json()['access']
    resp = api.get('/api/v1/auth/me', HTTP_AUTHORIZATION=f'Bearer {token}')
    assert resp.status_code == 200
    assert resp.json()['username'] == 'bob'
