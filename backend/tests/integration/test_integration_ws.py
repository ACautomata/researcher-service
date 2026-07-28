"""L4: 真浏览器 WebSocket 经 Vite /ws proxy 连 daphne ASGI，握手成功 (issue #183)。

契约范围止于「握手成功」——不发 chat.send（留 T7）。L4 是 #178 spec 的 ASGI 层：
pytest-django 的 ``live_server``（WSGI）不服务 WebSocket；须 daphne ASGI LiveServer。

运行（须装 integration.txt + ``playwright install chromium`` + frontend ``npm ci``）::

  cd backend
  uv run python -m pytest -m integration tests/integration/test_integration_ws.py -v
"""
import pytest

# 真链路集成测试（issue #157/#178）：CI integration job env 齐备时真跑；backend-unit job 经
# `-m "not integration"` 排除，默认 `python -m pytest` 不跑（不污染单元回归）。
pytestmark = pytest.mark.integration


# ═══════════════════════════════════════════════════════════════════════════════
# helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _login_ws(page, username: str, password: str) -> str:
    """注册 + 登录（经 Vite proxy → daphne HTTP 路径），返回 access token。

    daphne 的 ``ProtocolTypeRouter`` 同时处理 http + websocket 两种 scope——register/login/me
    等 REST 端点经 daphne 的 HTTP → django_asgi_app 路径，与 Channels 握手共享同一进程。
    所以 L4 可以直接在 page_ws 浏览器上走 L1 已证的 HTTP login 链路取 JWT 后创 WS。

    token 从 ``window.__pinia`` getter 提取（不走 auth store 反序列化，避免间接依赖）。
    """
    page.wait_for_function(
        "() => !!window.__pinia && !!window.__apiFetch",
        timeout=15000,
    )
    # 注册：忽略 409（同名已存在——test DB 可能有残留行），仅 201 是新建
    register_result = page.evaluate(
        """
        async ({username, password}) => {
            const resp = await fetch('/api/v1/auth/register', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, password}),
            });
            return {ok: resp.ok, status: resp.status};
        }
        """,
        {'username': username, 'password': password},
    )
    assert register_result['status'] in (201, 409), (
        f'register must return 201 or 409, got status={register_result["status"]}, ok={register_result["ok"]}'
    )
    page.wait_for_function(
        "() => !!window.__pinia._s && !!window.__pinia._s.get('auth')",
        timeout=10000,
    )
    # 登录：store.login() 走 fetch /api/v1/auth/login，success→pinia token 有值
    login_result = page.evaluate(
        """
        async ({username, password}) => {
            const store = window.__pinia._s.get('auth');
            try {
                // 直接调 fetch 验证 login API 返回 → 排除 store.login() 内部逻辑干扰
                const resp = await fetch('/api/v1/auth/login', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({username, password}),
                });
                const body = await resp.json();
                // 然后走 store.login() 过程
                await store.login(username, password);
                return {ok: true, token: store.token, piniaS: !!window.__pinia._s};
            } catch (e) {
                return {ok: false, err: String(e)};
            }
        }
        """,
        {'username': username, 'password': password},
    )
    assert login_result['ok'], (
        f'login must succeed, got err={login_result.get("err")!r}, '
        f'token={login_result.get("token")!r}'
    )

    token = login_result.get('token', '')
    assert isinstance(token, str) and len(token) > 0, (
        f'expected non-empty access token after login, got {token!r}, '
        f'result keys={sorted(login_result.keys())!r}'
    )
    return token


def _username_suffix_ws() -> str:
    import hashlib
    import time as _time_mod
    return hashlib.sha1(str(_time_mod.monotonic_ns()).encode()).hexdigest()[:8]


# ═══════════════════════════════════════════════════════════════════════════════
# L0: health check via daphne（ensure the daphne + Vite chain works）
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db(transaction=True)
def test_l4_health_via_daphne(page_ws):
    """L4 冒烟：真浏览器经 Vite proxy → daphne HTTP path 打 /api/health。

    这条 case 不碰 DB（health 端点无 DB 依赖），仅证明 daphne 起活 + Vite proxy 通。
    若此 case 红 → daphne fixture 或 Vite proxy 编排有问题；绿 → daphne HTTP 栈正常。
    """
    result = page_ws.evaluate(
        """
        async () => {
            const resp = await fetch('/api/health');
            const body = await resp.json();
            return { status: resp.status, body };
        }
        """,
    )
    assert result['status'] == 200, f'health must return 200, got {result}'
    assert result['body'] == {'status': 'ok'}, f'health body mismatch: {result["body"]}'


# ═══════════════════════════════════════════════════════════════════════════════
# L4: 握手成功
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db(transaction=True)
def test_l4_ws_handshake_via_vite_proxy(page_ws):
    """L4: 真浏览器原生 WebSocket → Vite /ws proxy → daphne → ChatConsumer，握手成功（#183）。

    注册+登录后，在浏览器上下文中创建原生 ``WebSocket('ws://<vite>/ws/chat/', ['access_token', <jwt>])``，
    断言 Channels handshake 成功（ws.readyState==OPEN 且 close code≠4401）。不发 chat.send（留 T7）。

    验证：
    - daphne ASGI LiveServer 正常起停（fixture 管理）
    - Vite /ws proxy（ws:true）正确转发 → Channels ASGI handshake
    - JwtAuthMiddleware 验 JWT 通过，ChatConsumer.accept() 握手成功
    """
    suffix = _username_suffix_ws()
    username = f'l4-handshake-{suffix}'
    password = 'testpass1234'

    token = _login_ws(page_ws, username, password)
    assert isinstance(token, str) and len(token) > 0, f'expected non-empty access token, got {token!r}'

    # 浏览器原生 WebSocket（非 jsdom mock！）经 Vite /ws proxy 连 daphne Channels。
    # subprotocol ['access_token', <jwt>] 触发 JwtAuthMiddleware → 验签成功 → accept()。
    # 收集 onerror/onclose 事件的详细错误信息以诊断 flaky 失败的根因
    # P1（codex #190）：JwtAuthMiddleware 在 auth 失败时 accept-then-close(4401)，
    #   浏览器 onopen 仍会触发。须在 onopen 后等待短暂窗口测 close code 验证 auth 成功。
    # P2（codex #190）：15s 超时避免 promise 挂死（Vite/daphne 既不 onopen 也不 onclose）。
    result = page_ws.evaluate(
        """
        async (token) => {
            return await new Promise((resolve) => {
                let settled = false;
                const done = (val) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(handshakeTimeout);
                    resolve(val);
                };
                const ws = new WebSocket(
                    `ws://${location.host}/ws/chat/`,
                    ['access_token', token],
                );
                const detail = {};
                // P2: handshake 超时保护
                const handshakeTimeout = setTimeout(() => {
                    if (!settled) {
                        ws.close();
                        done({open: false, reason: 'timeout', readyState: ws.readyState, detail});
                    }
                }, 15000);
                // P1: auth 验证窗口 — onopen 后等待 200ms 看服务器是否发 4401 close
                let authCheckTimer = null;
                ws.onopen = () => {
                    detail.opened = true;
                    authCheckTimer = setTimeout(() => {
                        if (settled) return;
                        // 200ms 内无 close — auth 成功，关闭连接后返回成功
                        ws.close(1000, 'test-done');
                        done({open: true, readyState: 1, detail, authVerified: true});
                    }, 200);
                };
                ws.onerror = () => {
                    detail.errorFired = true;
                    // 浏览器 WS onerror 不接受 event 参数，readyState 此时为 3 (CLOSED)
                    // 原因在随后的 onclose 里给出（code/reason/wasClean）
                };
                ws.onclose = (e) => {
                    detail.closeCode = e.code;
                    detail.closeReason = e.reason;
                    detail.wasClean = e.wasClean;
                    if (!detail.opened) {
                        done({open: false, reason: 'onclose', code: e.code, readyState: 3, detail});
                    } else if (authCheckTimer !== null) {
                        // onopen 已触发 — 检查是否为 auth 拒绝
                        clearTimeout(authCheckTimer);
                        done({open: false, reason: 'auth_rejected', code: e.code, readyState: 3, detail});
                    }
                };
            });
        }
        """,
        token,  # codex #190 P1: 将 JWT 作为 evaluate 参数传入 JS 回调
    )

    assert result.get('open'), (
        f'WS handshake must succeed, got: reason={result.get("reason")!r}, '
        f'code={result.get("code")!r}, readyState={result.get("readyState")!r}, '
        f'detail={result.get("detail")!r}'
    )
    assert result.get('readyState') == 1, (
        f'ws.readyState must be OPEN (1) after onopen, got {result.get("readyState")!r}'
    )
    assert result.get('authVerified'), (
        f'auth verification must pass (close code 4401 not received within 200ms after onopen), '
        f'got result={result}'
    )
