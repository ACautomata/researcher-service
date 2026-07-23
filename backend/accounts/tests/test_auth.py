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
def test_register_rejects_weak_password(api):
    # 8 位纯数字：过 min_length=8，但 AUTH_PASSWORD_VALIDATORS（NumericPasswordValidator）应拒
    resp = api.post('/api/v1/auth/register', {'username': 'eve', 'password': '12345678'})
    assert resp.status_code == 400
    assert not User.objects.filter(username='eve').exists()


@pytest.mark.django_db
def test_register_rejects_duplicate_username(api):
    # 重复用户名应 400 而非 500（spec §4 零信任 + DB 唯一约束转校验错误）
    User.objects.create_user(username='alice', password='strong-pass-123')
    resp = api.post(
        '/api/v1/auth/register',
        {'username': 'alice', 'password': 'another-pass-1'},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_register_rejects_invalid_username(api):
    # UnicodeUsernameValidator 拒含空格等非法字符（Django 标准 username 语法）
    resp = api.post(
        '/api/v1/auth/register',
        {'username': 'bad user', 'password': 'strong-pass-1'},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_register_rejects_password_similar_to_username(api):
    # UserAttributeSimilarityValidator 拒与用户名相似的密码（需传 prospective user）
    # password == username 完全相同，相似度 1.0 > 默认阈值 0.7
    resp = api.post(
        '/api/v1/auth/register',
        {'username': 'alicealice', 'password': 'alicealice'},
    )
    assert resp.status_code == 400


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
    assert 'refresh' not in data  # refresh 走 httpOnly cookie（spec §3）
    # 解码 access：期望值（user_id）来自创建返回的实例，非用代码同样方式重算。
    # simplejwt 5.5 把 user_id claim 序列化为字符串，用 int() 容忍。
    payload = jwt.decode(data['access'], settings.SECRET_KEY, algorithms=['HS256'])
    assert payload['token_type'] == 'access'
    assert int(payload['user_id']) == bob.id


@pytest.mark.django_db
def test_login_sets_refresh_cookie(api):
    # spec §3：refresh 走 httpOnly cookie，不暴露给 JS
    User.objects.create_user(username='carol', password='strong-pass-789')
    resp = api.post(
        '/api/v1/auth/login',
        {'username': 'carol', 'password': 'strong-pass-789'},
    )
    assert resp.status_code == 200
    cookie = resp.cookies.get('refresh_token')
    assert cookie is not None
    assert cookie['httponly'] is True


@pytest.mark.django_db
def test_token_refresh_from_cookie(api):
    # spec §3：用 httpOnly cookie 里的 refresh 换新 access
    User.objects.create_user(username='dave', password='strong-pass-000')
    api.post('/api/v1/auth/login', {'username': 'dave', 'password': 'strong-pass-000'})
    resp = api.post('/api/v1/auth/token/refresh')
    assert resp.status_code == 200
    assert 'access' in resp.json()


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
