"""issue #199 回归：注册开关（问题1）、auth 限速 + token 吊销（问题3）。

- 注册关 → 403 / 开 → 201；
- 连续超限登录 → 429（base.py 'auth': 10/minute，conftest 每测试清 cache）；
- logout 把 cookie 中 refresh 加入黑名单 → 旧 refresh 再刷新 401；
- ROTATE_REFRESH_TOKENS：refresh 后旧 refresh 即入黑名单（401），新 refresh 回写 cookie。
"""
import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APIClient

User = get_user_model()


@pytest.fixture
def api():
    return APIClient()


def _login(api, username='alice', password='strong-pass-1'):
    return api.post(
        '/api/v1/auth/login', {'username': username, 'password': password}, format='json',
    )


# ── 问题1：注册开关 ────────────────────────────────────────


@pytest.mark.django_db
def test_register_forbidden_when_registration_disabled(api):
    with override_settings(REGISTRATION_ENABLED=False):
        resp = api.post(
            '/api/v1/auth/register', {'username': 'mallory', 'password': 'strong-pass-1'},
        )
    assert resp.status_code == 403
    assert not User.objects.filter(username='mallory').exists()


@pytest.mark.django_db
def test_register_created_when_registration_enabled(api):
    with override_settings(REGISTRATION_ENABLED=True):
        resp = api.post(
            '/api/v1/auth/register', {'username': 'alice', 'password': 'strong-pass-1'},
        )
    assert resp.status_code == 201
    assert User.objects.filter(username='alice').exists()


# ── 问题3：auth 端点限速 ──────────────────────────────────


@pytest.mark.django_db
def test_login_throttled_after_burst(api):
    User.objects.create_user(username='bob', password='strong-pass-1')
    # base.py 'auth' scope = 10/minute：连续爆破超过配额 → 429
    responses = [
        _login(api, 'bob', 'wrong-pass-1') for _ in range(11)
    ]
    assert responses[-1].status_code == 429


# ── 问题3：logout 吊销 refresh / 轮换黑名单 ───────────────


@pytest.mark.django_db
def test_logout_blacklists_refresh_token(api):
    User.objects.create_user(username='eve', password='strong-pass-1')
    login = _login(api, 'eve')
    access = login.json()['access']
    old_refresh = login.cookies['refresh_token'].value
    resp = api.post('/api/v1/auth/logout', HTTP_AUTHORIZATION=f'Bearer {access}')
    assert resp.status_code == 204
    # 旧 refresh 已入服务端黑名单：即便客户端绕过被清的 cookie 直接提交也 401
    stale = APIClient()
    stale.cookies['refresh_token'] = old_refresh
    assert stale.post('/api/v1/auth/token/refresh').status_code == 401


@pytest.mark.django_db
def test_refresh_rotates_and_blacklists_old_token(api):
    User.objects.create_user(username='dave', password='strong-pass-1')
    _login(api, 'dave')
    old_refresh = api.cookies['refresh_token'].value
    resp = api.post('/api/v1/auth/token/refresh')
    assert resp.status_code == 200
    assert 'access' in resp.json()
    assert 'refresh' not in resp.json()  # refresh 不出 body（spec §3，对齐 login）
    # 轮换出的新 refresh 回写 httpOnly cookie（否则下一轮刷新必 401）
    new_refresh = api.cookies['refresh_token'].value
    assert new_refresh != old_refresh
    # BLACKLIST_AFTER_ROTATION：旧 refresh 再用 → 401
    stale = APIClient()
    stale.cookies['refresh_token'] = old_refresh
    assert stale.post('/api/v1/auth/token/refresh').status_code == 401
    # 新 refresh 可继续刷新
    assert api.post('/api/v1/auth/token/refresh').status_code == 200


@pytest.mark.django_db
def test_logout_tolerates_invalid_refresh_cookie(api):
    # 幂等：伪造/已失效的 refresh cookie 不阻断登出（TokenError 吞掉）
    User.objects.create_user(username='fred', password='strong-pass-1')
    login = _login(api, 'fred')
    access = login.json()['access']
    api.cookies['refresh_token'] = 'not-a-real-token'
    resp = api.post('/api/v1/auth/logout', HTTP_AUTHORIZATION=f'Bearer {access}')
    assert resp.status_code == 204
