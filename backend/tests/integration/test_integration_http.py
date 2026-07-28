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
import os
import time as _time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import docker
import pytest
from django.conf import settings

from containers.docker_runtime import DockerRuntime
from containers.models import Instance
from containers.orchestrator import Fleet, FleetConfig, InstanceOrchestrator
from containers.tests.fakes import FakeHealthProbe

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


# ═══════════════════════════════════════════════════════════════════════════════
# L2a: 容器列表降级契约（issue #181）
# ═══════════════════════════════════════════════════════════════════════════════


# InstanceSerializer 出参字段契约（源真相 containers/serializers.py InstanceSerializer）。
# 抽到模块级供「空 fleet 降级」与「非空 schema」两个 L2a case 共用——避免契约断言漂移。
_REQUIRED_INSTANCE_FIELDS = {
    'name': str,
    'port': (int, float),
    'status': str,
    'health': str,
    'image': str,
    'container_id': str,
    'created_at': str,
    'pairing': dict,
}


def _assert_instance_dto_contract(item: dict) -> None:
    """断言单条 list item 字段类型与 ``InstanceSerializer`` 对齐（含 pairing 子契约）。

    ``window.__listInstances`` 经 Vite proxy 打真后端 ``GET /api/v1/containers/``，body
    由 ``InstanceSerializer(many=True)`` 序列化；本块是 L2a schema 锁定，被 L2a-b（真实 list 路径
    序列化 STATUS_CREATING 行）复用。
    """
    for field, typ in _REQUIRED_INSTANCE_FIELDS.items():
        assert field in item, f'InstanceDTO missing field: {field}'
        assert isinstance(item[field], typ), (
            f'InstanceDTO.{field} must be {typ}, got {type(item[field]).__name__}: {item[field]!r}'
        )
    # pairing 子契约（PairingSnapshotDTO）。默认快照 build_pairing_status_default 总含四字段
    # （status/device_id/scopes/pairing_request_id）；status 必为 str，可选字段存在时按类型对齐
    # —— 防 serializer/translation 类型回归（如 scopes:""）漏过（codex #187 R3 P2 线494）。
    pairing = item['pairing']
    assert isinstance(pairing.get('status'), str), f'pairing.status must be str, got {pairing!r}'
    if pairing.get('device_id') is not None:
        assert isinstance(pairing['device_id'], str), (
            f'pairing.device_id must be str, got {pairing["device_id"]!r}'
        )
    if pairing.get('pairing_request_id') is not None:
        assert isinstance(pairing['pairing_request_id'], str), (
            f'pairing.pairing_request_id must be str, got {pairing["pairing_request_id"]!r}'
        )
    if pairing.get('scopes') is not None:
        scopes = pairing['scopes']
        assert isinstance(scopes, list), f'pairing.scopes must be array, got {scopes!r}'
        assert all(isinstance(s, str) for s in scopes), (
            f'pairing.scopes must be string[], got {scopes!r}'
        )


def _login(page, username: str, password: str) -> None:
    """L2a 共用登录链路：注册 + store.login() 复位 refreshExhausted 后 jwt 注入链路可用。"""
    page.wait_for_function(
        "() => !!window.__pinia && !!window.__apiFetch && !!window.__listInstances",
        timeout=15000,
    )
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
    page.wait_for_function(
        "() => !!window.__pinia._s && !!window.__pinia._s.get('auth')",
        timeout=10000,
    )
    page.evaluate(
        """
        async ({username, password}) => {
            const store = window.__pinia._s.get('auth');
            await store.login(username, password);
        }
        """,
        {'username': username, 'password': password},
    )


def _list_instances(page) -> dict:
    """经 ``window.__listInstances()`` → Vite proxy → 后端 ``GET /api/v1/containers/`` 取列表。"""
    return page.evaluate(
        """
        async () => {
            try {
                const data = await window.__listInstances();
                return {ok: true, data};
            } catch (e) {
                return {ok: false, err: String(e)};
            }
        }
        """,
    )


class _RaisingRuntime:
    """所有 docker 操作必抛 + 记录调用计数（L2a daemon-independent 守护，#181；codex #187 P2 线598）。

    实现 ContainerRuntime Protocol（结构子类型）：每个 docker 方法 raise 并计数，模拟 daemon
    完全不可达。**关键：保留真实 InstanceOrchestrator.list() 生产路径**（不替 list），仅注入本 runtime
    ——空 fleet 时 list() 在 ``orchestrator.py:580`` ``if not insts: return []`` 短路、STATUS_CREATING
    行 ``_build_item`` 透传不碰 runtime（``orchestrator.py:491``），故空 fleet 下 runtime.calls==0。
    若回归让 list 在短路前 / creating 行之外调 runtime，本类抛错 → view 500 → 联调断言红，回归被捕获。
    这正是 codex #187 P2 线598 所要求：fake list 会绕过生产路径让该回归假绿，必须走真实 list +
    raising runtime。
    """

    _MSG = 'RaisingRuntime: docker daemon deliberately unavailable (L2a degradation guard)'

    def __init__(self) -> None:
        self.calls = 0

    def _raise(self) -> None:
        self.calls += 1
        raise RuntimeError(self._MSG)

    def run(self, spec):  # 结构子类型，签名对齐 ContainerRuntime
        self._raise()

    def list_fleet(self) -> None:
        self._raise()

    def get(self, name):
        self._raise()

    def stop(self, name):
        self._raise()

    def remove(self, name):
        self._raise()

    def exec_in_container(self, name, cmd):
        self._raise()

    def exec_sync(self, name, cmd):
        self._raise()


def _override_fleet_with_raising_runtime(tmp_path) -> _RaisingRuntime:
    """注入真实 InstanceOrchestrator（RaisingRuntime）到 Fleet 单例，返回 runtime 供调用计数断言。

    保留生产 list() 路径（不替 list），仅把 runtime 换成 docker 访问必抛的替身（codex #187 P2 线598）。
    ``Fleet.override`` 在测试进程设类变量，threaded live server 同进程同类变量可见——HTTP 请求在
    live server 线程调 ``Fleet.get().list()`` 用本 orchestrator。调用方须 finally ``Fleet.reset()`` 还原。
    """
    cfg = FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=tmp_path / 'template',
        template_json='{}',
        image='img:tag',
        port_start=19000,
        port_end=19999,
        llm_api_key='sk-test',
    )
    runtime = _RaisingRuntime()
    Fleet.override(
        InstanceOrchestrator(runtime=runtime, config=cfg, health_probe=FakeHealthProbe()),
    )
    return runtime


def _reset_fleet() -> None:
    """还原 ``Fleet`` 单例（null → 下次 get 重建默认 orchestrator），防 L2a 替身泄漏到后续 case。"""
    Fleet.reset()


@pytest.fixture
def l2a_creating_instance():
    """种一条 ``STATUS_CREATING`` Instance 行供 L2a-b 真实 ``list()`` 路径序列化（#181）。

    必须在 ``page``（sync_playwright）之前实例化——Playwright sync API 的 Greenlet event loop 内
    Django ORM 触发 ``SynchronousOnlyOperation``（同 L1 forged-token 不调 ORM 的原因）。fixture 按
    参数声明顺序先于 ``page`` 实例化，故种行在 sync_playwright 上下文之外。test 的
    ``django_db(transaction=True)`` 下 commit，threaded live server 线程跨 DB 连接可见（spec #178）。
    """
    return Instance.objects.create(
        name=f'l2a-real-{_username_suffix()}',
        port=19001,
        image='ghcr.io/openclaw/openclaw:2026.6.34-browser',
        status=Instance.STATUS_CREATING,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# L2a-a: 空 fleet 降级契约——daemon 不可用时仍返 ``[]``（issue #181；codex #187 P2 线 464）
# ═══════════════════════════════════════════════════════════════════════════════


def test_l2a_empty_fleet_returns_array_without_daemon(page, tmp_path):
    """L2a-a：daemon 不可用时 ``GET /api/v1/containers/`` 仍返 ``[]``（#181；codex #187 P2 线464/598）。

    保留真实 ``InstanceOrchestrator.list()`` 生产路径，仅注入 docker 访问必抛的 ``RaisingRuntime``。
    空 fleet 时 ``list()`` 在 ``orchestrator.py:580`` ``if not insts: return []`` 短路——不进
    ``_reconcile_creating``、不碰 runtime。故断言 ``[]`` **且** ``runtime.calls == 0``，真正坐实
    「空 fleet 不连 daemon」。若回归让 list 在空 fleet 也碰 runtime，runtime 抛错 → view 500 →
    断言红，回归被捕获。codex #187 P2 线598 明确：fake list（替掉生产 ``list()``）会让该回归假绿，
    故必须走真实 ``list()`` + raising runtime。

    登录后经 ``window.__listInstances()`` 走真 ``apiJson``→``apiFetch`` 链路（JWT 注入 + 401 重试）。
    """
    suffix = _username_suffix()
    username = f'l2a-empty-{suffix}'
    password = 'testpass1234'

    runtime = _override_fleet_with_raising_runtime(tmp_path)
    try:
        _login(page, username, password)
        result = _list_instances(page)
        assert result['ok'], f'listInstances() rejected: {result.get("err")}'
        data = result['data']

        # 降级契约：空 fleet → []，且全程不碰 docker daemon（list 短路在 reconcile 之前）
        assert isinstance(data, list), f'containers list must be an array, got {type(data).__name__}'
        assert data == [], f'empty fleet must degrade to [], got {data!r}'
        assert runtime.calls == 0, (
            f'empty-fleet list must short-circuit without touching docker, '
            f'but RaisingRuntime was called {runtime.calls} time(s)'
        )
    finally:
        _reset_fleet()


# ═══════════════════════════════════════════════════════════════════════════════
# L2a-b: 非空 fleet schema 契约——InstanceSerializer/InstanceDTO 字段对齐（issue #181；codex #187 P2 线 533）
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db(transaction=True)
def test_l2a_nonempty_fleet_fields_align_to_serializer(l2a_creating_instance, page, tmp_path):
    """L2a-b：非空响应字段类型与 ``InstanceSerializer`` 对齐（#181；codex #187 P2 线533/598）。

    走真实 ``InstanceOrchestrator.list()`` 生产路径：``l2a_creating_instance`` fixture 种一条
    ``STATUS_CREATING`` Instance 行（``_build_item`` 对 creating 行透传不碰 runtime，``orchestrator.py:491``），
    注入 ``RaisingRuntime`` 证明即便 daemon 全坏非空 list 仍能序列化返 2xx。view 经真
    ``InstanceSerializer(many=True)`` 序列化该行，``_assert_instance_dto_contract`` 字段类型断言
    可达——解决 codex 线533（旧空 fleet early return 使字段断言死代码）。

    注：``_reconcile_creating`` 对 CREATING 行会调一次 ``runtime.get``（被 ``orchestrator.py:551``
    catch、不阻断 list），故本 case 不查精确 ``runtime.calls``；daemon-independent 由
    ``result['ok']`` + 非空序列化守护（若回归让 creating 行也走 runtime，runtime 抛错 → 500 → 红）。
    """
    suffix = _username_suffix()
    username = f'l2a-nonempty-{suffix}'
    password = 'testpass1234'
    instance_name = l2a_creating_instance.name

    _override_fleet_with_raising_runtime(tmp_path)
    try:
        _login(page, username, password)
        result = _list_instances(page)
        assert result['ok'], f'listInstances() rejected: {result.get("err")}'
        data = result['data']

        # 非空契约：一条 CREATING 行经真实 list() + 真 serializer 序列化后必为长度 1 的数组
        assert isinstance(data, list), f'containers list must be an array, got {type(data).__name__}'
        assert len(data) == 1, f'one CREATING row must yield 1 item, got {len(data)}: {data!r}'

        # 每元素字段类型与 InstanceSerializer 对齐——原断言从「dead code」复活成可达的 schema 条约
        assert data[0]['name'] == instance_name, f'item name mismatch: {data[0]!r}'
        _assert_instance_dto_contract(data[0])
    finally:
        _reset_fleet()


# ═══════════════════════════════════════════════════════════════════════════════
# L2b + L3: 容器创建契约 + wiki tree（issue #182；需 Docker daemon）
# ═══════════════════════════════════════════════════════════════════════════════


def _docker_daemon_reachable() -> bool:
    """探测 Docker daemon 是否可达（#178 user story 8/14：L2b/L3/L4 case 级 skipif 门控）。

    ``docker.from_env`` 与后端 ``DockerRuntime`` 读同一 ``DOCKER_HOST``（CI 默认 socket，本地
    Colima 经 .envrc 指 socket）；``timeout=2`` 界定探测，daemon 不可达（无 Colima /
    DOCKER_HOST 未指 / socket 缺失）即返 False → case skip。经 skipif 字符串条件引用，故仅在
    case 实际运行时探测，backend-unit job（``-m "not integration"`` 收集即排除）collection
    阶段不连 daemon。不同于 ``test_integration_wire.py`` 的「无 skip 强制 env」，本文件按
    #178 spec 对 L2b/L3 做 daemon 门控：本地无 daemon 优雅跳过，CI integration job 真跑。
    """
    try:
        docker.from_env(timeout=2).ping()
    except Exception:  # pylint: disable=broad-exception-caught
        return False
    return True


def _delete_container(name: str) -> None:
    """teardown：删容器 + DB 行 + 端口回收（端口自动——Instance 行删后回池，ports.py）。

    主路径 ``Fleet.get().delete(name)``（与 live server 线程共享同类级单例）；CREATING 行抛
    ``InstanceBusy`` 或行已不在时兜底直连 ``DockerRuntime`` stop/remove，对齐
    ``WireTestContext.__exit__`` 的幂等清理——防本 case 失败残留容器占用端口池。
    """
    try:
        Fleet.get().delete(name)
    except Exception:  # pylint: disable=broad-exception-caught
        try:
            runtime = DockerRuntime()
            runtime.stop(name)
            runtime.remove(name)
        except Exception:  # pylint: disable=broad-exception-caught
            pass


def _override_fleet_with_real_runtime(tmp_path) -> None:
    """override Fleet 用真实 DockerRuntime，但 root=tmp_path/fleet（模板外）。

    本地（worktree）默认 Fleet root=<repo>/fleet ⊂ OPENCLAW_TEMPLATE_DIR（仓库根，含 worktree），
    ``HomeProvisioner.copytree(template, home)`` 会把含 home 自身的模板树递归拷入 home →
    ``[Errno 63] File name too long`` 无限递归。CI 经 rsync 把 workspace 拷成 /tmp/fleet-template
    干净模板（ci.yml）可免此患；本测试统一把 root 指到 tmp_path（模板外）让本地+CI 一致，复刻
    ``test_integration_wire.py:_build_orchestrator`` 的隔离模式。template/image/port/key 仍取
    settings/env（与生产默认 Fleet 同源，仅 root 不同）→ HTTP 契约（serializer/status）不变。
    本地跑须 ``--basetemp=$HOME/...``（Colima virtiofs 仅共享 $HOME，bind-mount tmp_path 需在
    $HOME 内；CI Linux /tmp 无此限）。调用方须 finally ``Fleet.reset()`` 还原防泄漏。
    """
    cfg = settings.OPENCLAW_FLEET
    Fleet.override(
        InstanceOrchestrator(
            runtime=DockerRuntime(),
            config=FleetConfig(
                root=tmp_path / 'fleet',
                template_dir=Path(cfg['TEMPLATE']),
                template_json=cfg['TEMPLATE_JSON'],
                image=cfg['IMAGE'],
                port_start=cfg['PORT_POOL_START'],
                port_end=cfg['PORT_POOL_END'],
                llm_api_key=os.environ.get('LLM_API_KEY', ''),
            ),
        ),
    )


def _seed_wiki_page(fleet_root: Path, name: str) -> tuple[str, str]:
    """host 侧直写 bind-mount seed 一个 group+page，让 L3 inner-shape 断言可达。

    新建容器 home 经 ``HomeProvisioner`` 从模板 copytree；模板无 ``wiki/main`` →
    ``BindMountWikiFileSystem.build_tree`` 返 ``{groups: []}``（空树，adapters.py:106）。若直接
    ``getTree`` 则 group/page 字段类型断言成死代码（同 codex #187 对 L2a 空 fleet early-return
    的批评）。故 host 侧（与后端 wiki service 同一 bind-mount）写一页 ``wiki/main/l3seed/hello.md``，
    让 ``getTree`` 返非空树、嵌套 shape 断言可达。``fleet_root`` 为本 case override 的 Fleet root
    （tmp_path/fleet），home=<fleet_root>/instances/<name>/home。返回 (group_name, page_path)。
    """
    home = fleet_root / 'instances' / name / 'home'
    group_dir = home / 'wiki' / 'main' / 'l3seed'
    group_dir.mkdir(parents=True, exist_ok=True)
    (group_dir / 'hello.md').write_text('# Hello\n', encoding='utf-8')
    return 'l3seed', 'l3seed/hello.md'


@pytest.mark.skipif('not _docker_daemon_reachable()', reason='L2b/L3 需可达 Docker daemon (#182)')
@pytest.mark.django_db(transaction=True)
def test_l2b_create_and_l3_wiki_tree_contract(page, tmp_path, request):
    """L2b+L3：真起 OpenClaw 容器 → InstanceDTO 契约；复用容器读 wiki tree → shape 契约（#182）。

    L2b——经 ``__apiFetch``（前端 JWT 拦截器，``createInstance`` 的底层 ``apiFetch``）``POST
    /containers/`` 真起一个 OpenClaw 容器，断言**真实 201** + ``InstanceDTO`` 字段类型与
    ``InstanceSerializer`` 对齐（复用 L2a ``_assert_instance_dto_contract``，含 pairing 子契约）。
    用 ``__apiFetch`` 而非 ``createInstance``：create 状态码契约显著（201/409/503，
    ``views.py:88`` 成功唯返 201），``apiFetch`` 暴露真实 ``resp.status`` 让 201 显式可断；
    URL/method/body 与 ``createInstance`` 同，前端认证链路（JWT 注入 + 401 重试）覆盖不变。

    L3——复用该容器 host 侧 seed 一页（``_seed_wiki_page``）后，经 ``__getTree``（前端 wiki api
    模块，含 ``base(name)`` URL builder + ``apiJson``）读 ``GET /containers/<name>/wiki/tree``，
    断言 ``getTree`` resolve（``apiJson`` 仅 2xx resolve，wiki view 成功唯返 200）+
    ``{groups:[{kind,name,pages:[{path,title}]}]}`` 嵌套 shape（源真相 ``wiki/serializers.py``
    ``WikiTreeSerializer``）。seed 让 groups 非空 → group/page 字段类型断言可达（非死代码）。

    Fleet override：root 指 tmp_path/fleet（模板外，避 ``HomeProvisioner.copytree`` 递归，见
    ``_override_fleet_with_real_runtime``）；``request.addfinalizer(Fleet.reset)`` 保证还原。
    teardown：``_delete_container`` 删容器 + DB 行 + 端口回收（finally 兜底）。无 daemon 时
    skipif 跳过（#182 acceptance）。串行跑，不验端口池并发原子性（#178 out of scope）。
    """
    suffix = _username_suffix()
    username = f'l2b-{suffix}'
    password = 'testpass1234'
    # Instance.name 经 NAME_VALIDATOR（小写 DNS-label）；suffix 8 hex → 合规
    container_name = f'l2b-{suffix}'

    # override Fleet root 到 tmp_path/fleet（模板外，避 HomeProvisioner.copytree 递归）。
    # addfinalizer 保证 Fleet.reset() 必跑（即便 _login 失败也不泄漏替身到后续 case）。
    _override_fleet_with_real_runtime(tmp_path)
    request.addfinalizer(Fleet.reset)

    _login(page, username, password)
    try:
        # ── L2b: create → 真实 201 + InstanceDTO 契约 ──────────────────────────
        created = page.evaluate(
            """
            async (name) => {
                const resp = await window.__apiFetch('/api/v1/containers/', {
                    method: 'POST',
                    body: JSON.stringify({name}),
                });
                if (!resp.ok) {
                    return {ok: false, status: resp.status};
                }
                const body = await resp.json();
                return {ok: true, status: resp.status, body};
            }
            """,
            container_name,
        )
        assert created['ok'], f'create rejected: status={created.get("status")}'
        assert created['status'] == 201, (
            f'create must return 201 (InstanceListCreateView views.py:88), got {created["status"]}'
        )
        assert created['body']['name'] == container_name, (
            f'created name mismatch: {created["body"]!r}'
        )
        _assert_instance_dto_contract(created['body'])

        # ── L3: host seed 页 → __getTree → 嵌套 shape 契约 ─────────────────────
        seed_group, seed_page = _seed_wiki_page(tmp_path / 'fleet', container_name)
        tree = page.evaluate(
            """
            async (name) => {
                try {
                    const data = await window.__getTree(name);
                    return {ok: true, data};
                } catch (e) {
                    return {ok: false, status: e && e.status, err: String(e)};
                }
            }
            """,
            container_name,
        )
        assert tree['ok'], f'getTree rejected: status={tree.get("status")}, err={tree.get("err")}'
        data = tree['data']
        # 外层 shape（WikiTreeSerializer）：groups 必为数组
        assert isinstance(data, dict), f'tree root must be object, got {type(data).__name__}'
        assert isinstance(data.get('groups'), list), (
            f'tree.groups must be array, got {type(data.get("groups")).__name__}'
        )
        # seed 让 groups 非空 → 嵌套断言可达（防死代码，对齐 L2a-b seed 思路）
        seeded_group = next(
            (g for g in data['groups'] if g.get('name') == seed_group), None,
        )
        assert seeded_group is not None, (
            f'seeded group {seed_group!r} not in tree; groups={data["groups"]!r}'
        )
        # 嵌套契约：group {kind:str, name:str, pages:array}（WikiTreeGroupSerializer）
        assert isinstance(seeded_group.get('kind'), str), (
            f'group.kind must be str, got {seeded_group!r}'
        )
        assert isinstance(seeded_group.get('name'), str), (
            f'group.name must be str, got {seeded_group!r}'
        )
        assert isinstance(seeded_group.get('pages'), list), (
            f'group.pages must be array, got {seeded_group!r}'
        )
        seeded_page = next(
            (p for p in seeded_group['pages'] if p.get('path') == seed_page), None,
        )
        assert seeded_page is not None, (
            f'seeded page {seed_page!r} not in group; pages={seeded_group["pages"]!r}'
        )
        # 嵌套契约：page {path:str, title:str}（WikiTreePageSerializer）
        assert isinstance(seeded_page.get('path'), str), (
            f'page.path must be str, got {seeded_page!r}'
        )
        assert isinstance(seeded_page.get('title'), str), (
            f'page.title must be str, got {seeded_page!r}'
        )
    finally:
        _delete_container(container_name)
