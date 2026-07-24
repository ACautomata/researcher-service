"""seam: OIDC 通用 login/callback 占位端点（spec §3）—— issue #38 T02。

spec §3：端点 `GET /api/v1/auth/oauth/<provider>/login`（302 重定向到 IdP）+
`GET /api/v1/auth/oauth/<provider>/callback`（换 token），骨架期 provider 未配置时返回 **501**。
属授权白名单（AllowAny）：无 token 也可访问（不应 401）。
"""
import pytest
from rest_framework.test import APIClient


@pytest.fixture
def api():
    return APIClient()


def _configured(settings):
    settings.OAUTH_PROVIDERS = {
        'acme': {'issuer': 'https://idp.example.com', 'client_id': 'abc', 'scope': 'openid'}
    }


def test_oidc_login_unconfigured_returns_501(api):
    # provider 注册表为空 → 501（spec §3 骨架期）
    resp = api.get('/api/v1/auth/oauth/acme/login')
    assert resp.status_code == 501


def test_oidc_callback_unconfigured_returns_501(api):
    resp = api.get('/api/v1/auth/oauth/acme/callback')
    assert resp.status_code == 501


def test_oidc_login_unknown_provider_returns_501(api, settings):
    # 注册表有别的 provider，但请求的 provider 未配置 → 同样 501
    _configured(settings)
    resp = api.get('/api/v1/auth/oauth/ghost/login')
    assert resp.status_code == 501


def test_oidc_login_is_allow_any(api):
    # 授权白名单：无 token 不应 401（spec §3 白名单含 oauth login/callback）
    resp = api.get('/api/v1/auth/oauth/acme/login')
    assert resp.status_code != 401


def test_oidc_callback_is_allow_any(api):
    resp = api.get('/api/v1/auth/oauth/acme/callback')
    assert resp.status_code != 401


def test_oidc_login_configured_provider_still_501_placeholder(api, settings):
    # 配置完整但真实 IdP 集成属 out-of-scope（map #25）：骨架期仍 501，提示未接入
    _configured(settings)
    resp = api.get('/api/v1/auth/oauth/acme/login')
    assert resp.status_code == 501


def test_oidc_login_incomplete_provider_config_returns_501(api, settings):
    # 配置缺键（缺 client_id）→ 经 Serializer 校验视为未配置完整，501（spec §4 输入 0 信任）
    settings.OAUTH_PROVIDERS = {'acme': {'issuer': 'https://idp.example.com'}}
    resp = api.get('/api/v1/auth/oauth/acme/login')
    assert resp.status_code == 501
