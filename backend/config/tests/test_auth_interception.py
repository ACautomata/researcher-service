"""seam: 全局 token 拦截 + 授权白名单（spec §3）—— issue #38 T02。

spec §3：DRF 全局 DEFAULT_PERMISSION_CLASSES=[IsAuthenticated]；授权白名单
（register/login/oauth/token refresh）单独 AllowAny。验收标准：
- 无 token 的非白名单 REST 一律 401；
- 白名单端点无 token 可访问（不返回 401）。
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

User = get_user_model()


@pytest.fixture
def api():
    return APIClient()


# ---- 非白名单 REST：无 token 一律 401 ----


@pytest.mark.django_db
def test_protected_endpoint_no_token_returns_401(api):
    # 非白名单受保护端点：无 token → 401（全局 IsAuthenticated 拦截）
    assert api.get('/api/protected').status_code == 401


@pytest.mark.django_db
def test_protected_endpoint_garbage_token_returns_401(api):
    resp = api.get('/api/protected', HTTP_AUTHORIZATION='Bearer not-a-jwt')
    assert resp.status_code == 401


@pytest.mark.django_db
def test_protected_endpoint_with_token_returns_200(api):
    User.objects.create_user(username='carol', password='strong-pass-789')
    token = api.post(
        '/api/v1/auth/login', {'username': 'carol', 'password': 'strong-pass-789'}, format='json',
    ).json()['access']
    resp = api.get('/api/protected', HTTP_AUTHORIZATION=f'Bearer {token}')
    assert resp.status_code == 200


# ---- 白名单：无 token 可访问（非 401）----


@pytest.mark.django_db
def test_whitelist_register_no_token_not_401(api):
    resp = api.post('/api/v1/auth/register', {'username': 'w1', 'password': 'strong-pass-1'})
    assert resp.status_code == 201


@pytest.mark.django_db
def test_whitelist_login_no_token_not_401(api):
    User.objects.create_user(username='w2', password='strong-pass-1')
    resp = api.post('/api/v1/auth/login', {'username': 'w2', 'password': 'strong-pass-1'}, format='json')
    assert resp.status_code == 200


@pytest.mark.django_db
def test_whitelist_token_refresh_no_token_not_401(api):
    # 无 cookie 时 refresh 返回 400（无有效 refresh），但绝不能是 401（白名单放行）
    assert api.post('/api/v1/auth/token/refresh').status_code != 401


@pytest.mark.django_db
def test_whitelist_oidc_login_no_token_not_401(api):
    assert api.get('/api/v1/auth/oauth/acme/login').status_code != 401


@pytest.mark.django_db
def test_whitelist_oidc_callback_no_token_not_401(api):
    assert api.get('/api/v1/auth/oauth/acme/callback').status_code != 401
