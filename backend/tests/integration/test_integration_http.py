"""前后端联调集成测试（issue #179）：前端经 Vite proxy 真打后端 API 契约断言。

seam：真浏览器（Playwright）经 Vite dev server proxy 打 pytest-django 起的 live Django
后端，断言 HTTP 响应状态码 + JSON 契约。源真相在后端 serializer（config/views.py）。

L0（#179）：health 契约 + 每测试独立 browser context 隔离。后续 HTTP case（L1/L2a/L2b/L3，
#180-#183）与 ASGI（L4，#184）以此 fixture 为模板。

运行（须装 integration.txt + `playwright install chromium` + 本地 Colima DOCKER_HOST）::

  cd backend
  python -m pytest -m integration tests/integration/test_integration_http.py -v
"""
import base64 as _b64
import hashlib
import hmac
import json
import time as _time
from datetime import UTC, datetime, timedelta

import pytest
from django.conf import settings

# 真链路集成测试（issue #157/#178）：CI integration job env 齐备时真跑；backend-unit job 经
# `-m "not integration"` 排除，默认 `python -m pytest` 不跑（不污染单元回归）。
pytestmark = pytest.mark.integration


# ═══════════════════════════════════════════════════════════════════════════════
# helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _username_suffix() -> str:
    """短唯一后缀，避免同 py 进程多次 register 撞用户名。"""
    return hashlib.sha1(str(_time.monotonic_ns()).encode()).hexdigest()[:8]


def _b64_decode(s: str) -> bytes:
    """urlsafe base64 decode with padding fix."""
    padded = s + '=' * (4 - len(s) % 4)
    return _b64.urlsafe_b64decode(padded)


def _forged_expired_token_from_real(access_token: str, hours_ago: int = 1) -> str:
    """从真 access token payload 取所有 claims，只改 exp 为过去 → HMAC 重签。

    不引 Django ORM/RefreshToken，只做 base64 decode + HMAC-SHA256 重签。
    适用 Playwright sync_playwright 内 Greenlet event loop 触发 SynchronousOnlyOperation 场景。
    """
    header_b64, payload_b64, _sig = access_token.split('.')
    payload = json.loads(_b64_decode(payload_b64).decode('utf-8'))
    payload['exp'] = int((datetime.now(UTC) - timedelta(hours=hours_ago)).timestamp())
    new_payload_b64 = (
        _b64.urlsafe_b64encode(json.dumps(payload).encode('utf-8'))
        .decode('utf-8')
        .rstrip('=')
    )
    signing_input = f'{header_b64}.{new_payload_b64}'
    new_sig = (
        _b64.urlsafe_b64encode(
            hmac.new(
                settings.SECRET_KEY.encode('utf-8'),
                signing_input.encode('utf-8'),
                hashlib.sha256,
            ).digest(),
        )
        .decode('utf-8')
        .rstrip('=')
    )
    return f'{signing_input}.{new_sig}'


# ═══════════════════════════════════════════════════════════════════════════════
# L0: health + browser context isolation (#179)
# ═══════════════════════════════════════════════════════════════════════════════


def test_health_returns_ok_via_vite_proxy(page):
    """L0：经 Vite proxy 打真后端 GET /api/health，断言 2xx + ``{status:"ok"}``。

    源真相：``config/views.py`` ``HealthResponseSerializer``。经 ``page.evaluate`` 走真浏览器
    ``fetch``，路径 浏览器 → Vite(5173) proxy → Django live server，坐实三节点链路贯通
    （mock fetch / APIClient 测不到的 proxy 真链路）。
    """
    result = page.evaluate(
        """
        async () => {
            const resp = await fetch('/api/health');
            const body = await resp.json();
            return { status: resp.status, body };
        }
        """,
    )
    assert 200 <= result['status'] < 300
    # 期望值来自后端 HealthResponseSerializer 契约，非用代码同样方式重算
    assert result['body'] == {'status': 'ok'}


def test_browser_context_starts_clean(page):
    """每 case 独立 browser context：起始无 token/cookie/localStorage 残留。

    context 隔离是 L1/L2 401→refresh/logout 分支能从干净态精确触发的前提（#178 user story
    10）。新 context 的 localStorage 与 cookie 必须为空。
    """
    state = page.evaluate(
        """
        () => ({
            localStorageKeys: localStorage.length,
            cookie: document.cookie,
        })
        """,
    )
    assert state['localStorageKeys'] == 0
    assert state['cookie'] == ''


# ═══════════════════════════════════════════════════════════════════════════════
# L1: auth contract + 401→refresh retry chain (issue #180)
# ═══════════════════════════════════════════════════════════════════════════════


# ── Cycle 1: LoginResponse.refresh drift ─────────────────────────────────────


def test_login_response_has_no_refresh_field(page):
    """L1：登录响应仅含 {access}，无 refresh 字段（源真相 AccessTokenSerializer）。

    注册→登录→解析 JSON body → 断言 refresh 字段不存在。测出漂移则改前端（#180 acceptance 2）。
    """
    suffix = _username_suffix()
    username = f'l1norefresh-{suffix}'
    password = 'testpass1234'

    # 1) 注册
    result = page.evaluate(
        """
        async ({username, password}) => {
            const resp = await fetch('/api/v1/auth/register', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, password}),
            });
            const body = await resp.json();
            return {status: resp.status, body};
        }
        """,
        {'username': username, 'password': password},
    )
    assert result['status'] == 201, f'unexpected register status {result["status"]}'

    # 2) 登录，只取 body
    login_result = page.evaluate(
        """
        async ({username, password}) => {
            const resp = await fetch('/api/v1/auth/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, password}),
            });
            const body = await resp.json();
            return {status: resp.status, body};
        }
        """,
        {'username': username, 'password': password},
    )
    assert login_result['status'] == 200
    body = login_result['body']

    # 源真相 AccessTokenSerializer 只返 {access}；refresh 走 httpOnly cookie 不进 body
    assert 'access' in body, 'login must return access token'
    assert isinstance(body['access'], str)
    assert 'refresh' not in body, (
        'login body must NOT contain refresh field — '
        'frontend LoginResponse interface MUST drop `refresh: string`'
    )


# ── Cycle 2: register→login→me flow ──────────────────────────────────────────


def test_l1_register_login_me_flow(page):
    """L1：真浏览器注册→登录→me 全链路（#180 acceptance 1）。

    走 LoginView UI 真实交互：填表、提交、自动跳 /；再经 fetch 调 /api/v1/auth/me
    断言 {id, username, email} 与注册用户对齐。
    """
    suffix = _username_suffix()
    username = f'l1me-{suffix}'
    password = 'testpass1234'

    # 1) 导航到 /login（SPA 路由，vite dev server fallback 到 index.html）
    base = page.url.rstrip('/')
    page.goto(f'{base}/login', wait_until='domcontentloaded')

    # 2) 切到注册模式
    page.click('[data-test="switch-register"]')
    page.wait_for_timeout(200)

    # 3) 填表 + 提交注册（自动注册→登录→跳转 /）
    page.fill('input[placeholder="用户名"]', username)
    page.fill('input[placeholder="密码"]', password)
    page.click('button:has-text("注册")')

    # 注册成功后自动 login→push /；等 Vue 路由离开 /login
    page.wait_for_url(f'{base}/', timeout=10000)
    page.wait_for_timeout(500)

    # 4) 从 Pinia 拿 token 后调 /me
    me = page.evaluate(
        """
        async () => {
            const pinia = window.__pinia;
            if (!pinia) throw new Error('__pinia not mounted');
            const auth = pinia.state.value?.auth;
            if (!auth) throw new Error('auth store not found');
            const token = auth.token;
            const resp = await fetch('/api/v1/auth/me', {
                headers: {'Authorization': `Bearer ${token}`},
            });
            const body = await resp.json();
            return {status: resp.status, body};
        }
        """,
    )
    assert me['status'] == 200
    assert me['body']['username'] == username, f'me username mismatch: {me["body"]}'
    assert isinstance(me['body']['id'], (int, float))
    assert 'email' in me['body']


# ── Cycle 3: httpOnly refresh cookie ─────────────────────────────────────────


def test_login_sets_httponly_refresh_cookie(page):
    """L1：登录后浏览器携带 httpOnly refresh cookie（#180 acceptance 3）。

    注册→登录→调 Playwright context.cookies() 过滤 refresh_token，
    断言 httpOnly=true, path=/api/v1/auth。jsdom 测不到——是真浏览器价值点。
    """
    suffix = _username_suffix()
    username = f'l1cookie-{suffix}'
    password = 'testpass1234'

    # register
    page.evaluate(
        """
        async ({username, password}) => {
            await fetch('/api/v1/auth/register', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, password}),
            });
        }
        """,
        {'username': username, 'password': password},
    )
    # login
    page.evaluate(
        """
        async ({username, password}) => {
            await fetch('/api/v1/auth/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, password}),
            });
        }
        """,
        {'username': username, 'password': password},
    )

    cookies = page.context.cookies()
    refresh_cookies = [c for c in cookies if c['name'] == 'refresh_token']
    assert refresh_cookies, 'login must set refresh_token cookie'
    rc = refresh_cookies[0]
    assert rc['httpOnly'], 'refresh_token must be httpOnly'
    assert rc['path'] == '/api/v1/auth', f'refresh_token path must be /api/v1/auth, got {rc["path"]}'


# ── Cycle 4: 401→refresh→retry silent renewal ────────────────────────────────


def test_401_triggers_silent_refresh_and_retry(page):
    """L1：注入过期 access → 调保护端点 → 自动 refresh→重试成功（#180 acceptance 4）。

    从浏览器拿真实 access token（Pinia store）→ Python 侧篡改 exp 为过去 → 注入回
    Pinia → 调保护端点。apiFetch 自动触发 forceRefresh→httpOnly cookie 换新→重试。
    不动后端 settings、不引时序。不调 Django ORM（避免 sync_playwright 内
    SynchronousOnlyOperation）。
    """
    suffix = _username_suffix()
    username = f'l1refresh-{suffix}'
    password = 'testpass1234'

    # 1) 注册
    page.evaluate(
        """
        async ({username, password}) => {
            await fetch('/api/v1/auth/register', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, password}),
            });
        }
        """,
        {'username': username, 'password': password},
    )

    # 2) 用 store.login() 建立完整会话——复位 refreshExhausted（page fixture 初始导航
    #    的 hydrate() 无 refresh cookie 返回 400 致 refreshExhausted=true）
    login = page.evaluate(
        """
        async ({username, password}) => {
            const store = window.__pinia._s.get('auth');
            await store.login(username, password);
            return {ok: true, access: store.token};
        }
        """,
        {'username': username, 'password': password},
    )
    assert login['ok']

    # 3) 从真实 token 的 payload 篡改 exp 为过去（无 ORM）
    forged_token = _forged_expired_token_from_real(login['access'], hours_ago=1)

    # 4) 注入毒化 token
    page.evaluate(
        """
        (token) => { window.__pinia.state.value.auth.token = token; }
        """,
        forged_token,
    )

    # 5) 诊断：确认 httpOnly refresh cookie 在 browser context 中存在
    cookies = page.context.cookies()
    refresh_tokens = [c for c in cookies if c['name'] == 'refresh_token']
    assert refresh_tokens, 'refresh cookie must exist before calling __apiFetch'

    # 6) 直接用 __apiFetch 调 /me —— apiFetch 收到 401 → auth.forceRefresh() → 换新 → 重试成功
    result = page.evaluate(
        """
        async () => {
            const resp = await window.__apiFetch('/api/v1/auth/me');
            if (!resp.ok) {
                return {ok: false, status: resp.status};
            }
            const body = await resp.json();
            return {ok: true, status: resp.status, body};
        }
        """,
    )
    assert result['ok'], f'me after silent refresh failed: status={result.get("status")}'
    assert result['body']['username'] == username
    # token 应已从 store 更新（不再是毒化值）
    final_token = page.evaluate("() => window.__pinia.state.value.auth.token")
    assert final_token != forged_token, 'token should be refreshed to a new one'


# ── Cycle 5: logout exhausts refresh → redirect /login ───────────────────────


def test_logout_exhausts_refresh_and_redirects_to_login(page):
    """L1：logout 后调保护端点 → refreshExhausted 置真 → 重定向 /login（#180 acceptance 5）。

    注册→登录→logout（清 httpOnly refresh cookie）→调 /me → refresh 端点返回 400 → 触发
    clearSession + redirect /login。验证 refreshExhausted 置真。
    """
    suffix = _username_suffix()
    username = f'l1logout-{suffix}'
    password = 'testpass1234'

    # 1) 注册
    page.evaluate(
        """
        async ({username, password}) => {
            await fetch('/api/v1/auth/register', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, password}),
            });
        }
        """,
        {'username': username, 'password': password},
    )

    # 2) 用 store.login() 建立完整登录态（复位 refreshExhausted）
    login = page.evaluate(
        """
        async ({username, password}) => {
            const store = window.__pinia._s.get('auth');
            await store.login(username, password);
            return {status: 200};
        }
        """,
        {'username': username, 'password': password},
    )
    assert login['status'] == 200

    # 3) 确认 refresh cookie 存在 + Pinia token 已设
    cookies = page.context.cookies()
    assert any(c['name'] == 'refresh_token' for c in cookies), (
        'refresh_token cookie must exist after login'
    )
    token = page.evaluate("() => window.__pinia.state.value.auth.token")
    assert token, 'login must set Pinia token'

    # 4) 调真实 auth.logout() action → 后端清 httpOnly cookie + store 自动更新
    page.evaluate(
        """
        async () => {
            const store = window.__pinia._s.get('auth');
            await store.logout();
        }
        """,
    )

    # 5) logout 后 httpOnly cookie 应被后端清除
    cookies_after_logout = page.context.cookies()
    assert not any(c['name'] == 'refresh_token' for c in cookies_after_logout), (
        'logout must clear refresh_token cookie on backend'
    )

    # 6) logout 后 store 应已清
    store_after_logout = page.evaluate(
        """
        () => ({
            token: window.__pinia.state.value.auth.token,
            refreshExhausted: window.__pinia.state.value.auth.refreshExhausted,
        })
        """,
    )
    assert store_after_logout['token'] == '', 'logout must clear token'
    assert store_after_logout['refreshExhausted'] is True, 'logout must set refreshExhausted'

    # 7) 再调保护端点 → refresh 失效 → redirect /login
    page.evaluate(
        """
        async () => {
            try {
                await window.__apiFetch('/api/v1/auth/me');
            } catch (_) {
                // expected ApiError after redirect
            }
        }
        """,
    )
    page.wait_for_timeout(500)
    current_path = page.evaluate("() => window.location.pathname")
    assert current_path == '/login', (
        f'after logout + protected request, must redirect to /login, got {current_path}'
    )
