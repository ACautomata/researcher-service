"""L4: 真浏览器 WebSocket 经 Vite /ws proxy 连 daphne ASGI，握手成功 (issue #183)。

契约范围止于「握手成功」——不发 chat.send（留 T7）。L4 是 #178 spec 的 ASGI 层：
pytest-django 的 ``live_server``（WSGI）不服务 WebSocket；须 daphne ASGI LiveServer。

运行（须装 integration.txt + ``playwright install chromium`` + frontend ``npm ci``）::

  cd backend
  uv run python -m pytest -m integration tests/integration/test_integration_ws.py -v
"""
import os
import time

import docker
import pytest

from containers.docker_runtime import DockerRuntime
from containers.tests.integration_helpers import GatewayReadinessWaiter
from integration.openclaw.adapters import HttpHealthProbe

# 真链路集成测试（issue #157/#178）：CI integration job env 齐备时真跑；backend-unit job 经
# `-m "not integration"` 排除，默认 `python -m pytest` 不跑（不污染单元回归）。
pytestmark = pytest.mark.integration

# 翻译器工具帧终态白名单（codex #193 P2 R3）：生产 ``ChatEventTranslator._translate_tool`` 对
# result+isError=true **故意**发 ``state='error'``（backend/chat/event_translate.py:227），本断言须
# 接纳之，否则真实工具失败会被误报为契约失败。回归守护钉在 tests/test_ws_event_contract.py。
_ACCEPTED_TOOL_STATES = ('running', 'done', 'error')


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


# ═══════════════════════════════════════════════════════════════════════════════
# L4 T7: chat.send 真实事件流端到端契约（配对→发→解析，issue #184）
# ═══════════════════════════════════════════════════════════════════════════════

# approve 后轮询配对至 paired 的独立超时（对齐 wire _PAIRING_APPROVAL_TIMEOUT：approve 异步生效）
_PAIRING_APPROVAL_TIMEOUT = 60.0
_PAIRING_POLL_INTERVAL = 1.0
# 网关冷启动就绪轮询（对齐 wire _GATEWAY_READINESS_TIMEOUT：create 后网关 WS server 需数秒 boot）
_GATEWAY_READINESS_TIMEOUT = 60.0
_GATEWAY_POLL_INTERVAL = 1.0


def _docker_daemon_reachable_ws() -> bool:
    """探测 Docker daemon 可达（#184 T7 case 级 skipif 门控，对齐 test_integration_http）。

    经 skipif 字符串条件引用，仅在 case 实际运行时探测，backend-unit job（``-m "not integration"``
    collection 即排除）不连 daemon。daphne 经 HTTP 创建容器需 daemon 可达 + ghcr 镜像。
    """
    try:
        docker.from_env(timeout=2).ping()
    except Exception:  # pylint: disable=broad-except
        return False
    return True


def _pairing_env_ready() -> bool:
    """T7 需 ghcr 编排 env：OPENCLAW_TEMPLATE_DIR（模板）+ LLM_API_KEY（容器注入）。

    daphne 子进程继承 os.environ（conftest daphne_server ``env_integration = {**os.environ, ...}``），
    故测试运行时这两个 env 齐备即 daphne 创建容器可用。缺一则 skip（本地无 env 优雅跳过）。
    """
    return bool(os.environ.get('OPENCLAW_TEMPLATE_DIR')) and bool(os.environ.get('LLM_API_KEY'))


def _cleanup_container_ws(page_ws, container_name: str, runtime: DockerRuntime | None = None) -> None:
    """teardown：经 daphne HTTP DELETE 删容器；非 2xx 或 evaluate 抛错时直连 Docker 兜底（codex #193 P2）。

    daphne 是独立 OS 进程，测试进程的 ``Fleet`` 单例跨进程不可见，故主路径走 HTTP DELETE（经
    daphne ``Fleet.delete``：处理 ``openclaw-gw-`` 前缀 + Instance 行 + 端口回收）。``__apiFetch``
    即 ``apiFetch``，非 2xx 不抛（仅 401 不可刷新才抛），故须检 ``resp.ok``。page.evaluate 抛错
    （浏览器/页面崩溃）或 DELETE 非 2xx（daphne ``Fleet.delete`` 异常）→ 直连 ``DockerRuntime``
    stop/remove 兜底，对齐 ``test_integration_http._delete_container`` / ``WireTestContext`` 的幂等清理
    （NotFound 吞；``container_name`` 即 instance name，``DockerRuntime`` 内部加前缀）。``runtime``
    可注入（默认 ``DockerRuntime()``）供 ``test_ws_teardown_fallback`` 用 fake 隔离验证兜底分支，不连
    真 Docker。``except Exception`` 仅吞清理自身异常——try 体的原始失败在 finally 结束后照常上抛，不被掩盖。
    """
    deleted = False
    try:
        result = page_ws.evaluate(
            """
            async (name) => {
                const resp = await window.__apiFetch(
                    `/api/v1/containers/${name}`, {method: 'DELETE'});
                return {ok: resp.ok, status: resp.status};
            }
            """,
            container_name,
        )
        deleted = bool(result and result.get('ok'))
    except Exception:  # pylint: disable=broad-except  页面/浏览器崩溃→跳 Docker 兜底
        deleted = False
    if deleted:
        return
    # Docker 兜底：stop/remove 各自独立隔离——stop 失败仍尝试 remove（force-removal），清理自身异常
    # 一律吞掉，绝不从 finally 上抛掩盖原始 assert/timeout 失败（codex #193 P2 R2：名实相符 docstring）。
    docker = runtime or DockerRuntime()
    for _op in (docker.stop, docker.remove):
        try:
            _op(container_name)
        except Exception:  # pylint: disable=broad-except  清理失败不阻断后续 remove、不掩盖原始失败
            pass


@pytest.mark.skipif(
    'not _docker_daemon_reachable_ws() or not _pairing_env_ready()',
    reason='L4 T7 需可达 Docker daemon + OPENCLAW_TEMPLATE_DIR/LLM_API_KEY（#184）',
)
@pytest.mark.django_db(transaction=True)
def test_l4_chat_send_event_stream(page_ws):  # pylint: disable=too-many-statements,too-many-locals
    """T7（#184）：配对→chat.send→真实事件流端到端契约（构建于 T6 ASGI+gateway 编排之上）。

    全链路（前端真浏览器原生 WebSocket → Vite /ws proxy → daphne Channels → ChatConsumer →
    ChatFleet pool → 真 ghcr gateway）端到端贯通，断言：

    - 配对全流程（challenge→控制面自动 approve→deviceToken 持久化）经 HTTP /pairing/ 走通
      （阶段3 自动 approve：PairingService 经容器内 exec 自动 approve，一步 paired）：
      daphne ensure_paired 写文件级 DB Pairing 行，ChatConsumer 经 ChatFleet.get_or_create
      从该行重建 client 连 gateway（复用后端 pairing.py，#184 验收#1）。
    - 前端 ChatWebSocket 发 chat.send 后收到真实 LLM 事件流，onText/onDone 正确解析 text/done
      帧（#184 验收#2）。tool/approval 帧若触发则断言其翻译结构（不强求触发）。
    - chat.history 的 content 多态（user=str / assistant=list，ADR-0003）经 HTTP 到达前端，
      前端 apiJson 透传不崩（#184 验收#3）。

    与 wire 测试（chat/tests/test_integration_wire.py）的本质区别：wire 直用 OpenClawChatClient
    连容器 gateway（绕过前端+ChatConsumer）；本测试经前端原生 WS → ChatConsumer → ChatFleet 全链路，
    是 #178 spec 的最深层 chat 端到端（不用 stub gateway、不用 WebsocketCommunicator——后者绕过
    前端原生 WS，与 L4 目标相悖，#184 验收#4）。``integration`` marker 隔离（#184 验收#5）。
    """
    suffix = _username_suffix_ws()
    username = f'l4t7-{suffix}'
    password = 'testpass1234'
    # Instance.name 经 NAME_VALIDATOR（小写 DNS-label）；suffix 8 hex → 合规
    container_name = f'l4t7-{suffix}'

    token = _login_ws(page_ws, username, password)
    assert isinstance(token, str) and token, f'expected non-empty token, got {token!r}'

    try:
        # ── 1. HTTP 创建容器（daphne Fleet.create → 真容器，Instance 行在文件级 DB）──
        created = page_ws.evaluate(
            """
            async (name) => {
                const resp = await window.__apiFetch('/api/v1/containers/', {
                    method: 'POST',
                    body: JSON.stringify({name}),
                });
                const body = resp.ok ? await resp.json() : null;
                return {ok: resp.ok, status: resp.status, body};
            }
            """,
            container_name,
        )
        assert created['ok'] and created['status'] == 202, (
            f'create must return 202 (#297 异步化：同步预占 creating 行即返), '
            f'got status={created.get("status")}, body={created.get("body")}'
        )

        # ── 1b. 网关冷启动就绪等待（对齐 wire GatewayReadinessWaiter：create 后网关 WS server
        #     需数秒 boot；不等就连配对 → WS connect 被拒 → PairingError 502）──
        port = created['body']['port']
        GatewayReadinessWaiter(
            HttpHealthProbe(),
            timeout=_GATEWAY_READINESS_TIMEOUT,
            interval=_GATEWAY_POLL_INTERVAL,
        ).wait(port)

        # ── 2. 触发配对并轮询至 paired（阶段3 自动 approve：控制面 PairingService 经容器内
        #     exec 自动 approve，一步 paired；approve 不再由测试手动触发）──
        paired = False
        last_pair: dict = {}
        deadline = time.monotonic() + _PAIRING_APPROVAL_TIMEOUT
        while time.monotonic() < deadline:
            last_pair = page_ws.evaluate(
                """
                async (name) => {
                    const resp = await window.__apiFetch(`/api/v1/containers/${name}/pairing/`, {
                        method: 'POST',
                        body: JSON.stringify({}),
                    });
                    const body = await resp.json();
                    return {status: resp.status, body};
                }
                """,
                container_name,
            )
            if (last_pair.get('body') or {}).get('status') == 'paired':
                paired = True
                break
            time.sleep(_PAIRING_POLL_INTERVAL)
        assert paired, (
            f'pairing not paired within {_PAIRING_APPROVAL_TIMEOUT}s (阶段3 自动 approve); '
            f'last status={(last_pair.get("body") or {}).get("status")}, body={last_pair.get("body")}'
        )

        # ── 5. 前端 ChatWebSocket → start → send → 收真实事件流 ──
        session_key = f'agent:main:l4t7-{suffix}'
        message = 'Say hello in one short sentence.'
        page_ws.evaluate(
            """
            async ({token, container, sessionKey, message}) => {
                const { ChatWebSocket } = await import('/src/chat/ws.ts');
                window.__l4events = [];
                window.__l4done = false;
                window.__l4ws = new ChatWebSocket(`ws://${location.host}/ws/chat/`, token, {
                    onReady: (c) => window.__l4events.push({kind:'ready', container:c}),
                    onText: (runId, delta, replace) => window.__l4events.push(
                        {kind:'text', runId, delta, replace}),
                    onDone: (runId) => { window.__l4events.push({kind:'done', runId});
                        window.__l4done = true; },
                    onError: (msg, runId) => { window.__l4events.push(
                        {kind:'error', msg, runId}); window.__l4done = true; },
                    onTool: (t) => window.__l4events.push(
                        {kind:'tool', runId:t.runId, name:t.name, state:t.state}),
                    onApproval: (c) => window.__l4events.push(
                        // codex #193 P2 R3：子类型（exec/plugin）必须独立于 ``kind`` 判别符——
                        // 原 ``{kind:'approval', kind:c.kind}`` 第二个 kind 覆盖判别符，致下方
                        // ``kind=='approval'`` 过滤永不命中、审批断言成死代码。改用 subtype 字段。
                        {kind:'approval', id:c.id, subtype:c.kind, command:c.command}),
                    onClose: () => window.__l4events.push({kind:'close'}),
                });
                window.__l4ws.start(container);
                window.__l4ws.send(sessionKey, message);
                return {ok: true};
            }
            """,
            {'token': token, 'container': container_name,
             'sessionKey': session_key, 'message': message},
        )

        # 等 done/error（真实 LLM 回复，给足超时）
        page_ws.wait_for_function('() => window.__l4done === true', timeout=120000)
        events = page_ws.evaluate('() => window.__l4events')

        # ── 6. 断言事件流契约（#184 验收#2：text/done 前端正确解析）──
        kinds = [e.get('kind') for e in events]
        assert 'ready' in kinds, f'must receive ready frame, got kinds={kinds}'
        assert 'text' in kinds, (
            f'must receive text frame (LLM stream delta translated), got kinds={kinds}'
        )
        assert 'done' in kinds, (
            f'must receive done frame (final translated), got kinds={kinds}, events={events}'
        )
        # text 帧结构契约：runId 非空 + delta 字符串（前端 onText 正确解析）
        text_events = [e for e in events if e.get('kind') == 'text']
        for te in text_events:
            assert isinstance(te.get('runId'), str) and te['runId'], (
                f'text frame must carry non-empty runId, got {te!r}'
            )
            assert isinstance(te.get('delta'), str), (
                f'text frame delta must be string, got {type(te.get("delta")).__name__}'
            )
        # done 帧结构契约：runId 非空
        done_events = [e for e in events if e.get('kind') == 'done']
        for de in done_events:
            assert isinstance(de.get('runId'), str) and de['runId'], (
                f'done frame must carry non-empty runId, got {de!r}'
            )
        # tool/approval 帧若触发，断言翻译结构（不强求触发，#184「若触发」）
        tool_events = [e for e in events if e.get('kind') == 'tool']
        for te in tool_events:
            assert te.get('state') in _ACCEPTED_TOOL_STATES, (
                f'tool frame state must be running/done/error, got {te!r}'
            )
            assert isinstance(te.get('name'), str) and te['name'], (
                f'tool frame must carry non-empty name, got {te!r}'
            )
        approval_events = [e for e in events if e.get('kind') == 'approval']
        for ae in approval_events:
            assert isinstance(ae.get('id'), str) and ae['id'], (
                f'approval frame must carry non-empty id, got {ae!r}'
            )
            # 子类型（exec/plugin）须独立于 ``kind`` 判别符记录（codex #193 P2 R3）：原 ``kind:c.kind``
            # 覆盖 'approval' 判别符致本过滤永不命中、断言成死代码；改用 subtype 字段后此处才真正被覆盖。
            subtype = ae.get('subtype')
            assert isinstance(subtype, str) and subtype, (
                f'approval frame must carry non-empty subtype (exec/plugin), got {ae!r}'
            )

        # ── 7. chat.history content 多态契约（ADR-0003：user=str / assistant=list）──
        # 经生产 chat API adapter ``getSessionHistory``（``encodeURIComponent(sessionKey)`` URL 构造 +
        # ``apiJson`` 多态解析），真覆盖前端 history flow——勿绕过 adapter 手搓 __apiFetch+resp.json()
        # （codex #193 P2：否则 adapter 回归时本测试仍过）。``getSessionHistory`` 非 2xx 经 apiJson 抛
        # ApiError，这里捕获回填 status/error 保留可读断言信息；成功则透传 messages 供多态断言。
        history = page_ws.evaluate(
            """
            async ({name, key}) => {
                const { getSessionHistory } = await import('/src/api/chat.ts');
                try {
                    const data = await getSessionHistory(name, key);
                    return {ok: true, status: 200, messages: data.messages};
                } catch (e) {
                    return {ok: false, status: (e && e.status) || null,
                            error: String((e && e.message) || e)};
                }
            }
            """,
            {'name': container_name, 'key': session_key},
        )
        assert history['ok'], (
            f'getSessionHistory must succeed, got status={history.get("status")}, '
            f'error={history.get("error")}'
        )
        messages = history.get('messages') or []
        assert isinstance(messages, list) and messages, (
            f'history must return non-empty messages, got {messages!r}'
        )
        user_msgs = [m for m in messages if isinstance(m, dict) and m.get('role') == 'user']
        asst_msgs = [m for m in messages if isinstance(m, dict) and m.get('role') == 'assistant']
        assert user_msgs, 'history must contain user message (the prompt just sent)'
        assert asst_msgs, 'history must contain assistant message (LLM reply)'
        # 多态契约（#184 验收#3）：user content=str、assistant content=list；前端 apiJson 透传不崩
        for m in user_msgs:
            assert isinstance(m.get('content'), str), (
                f'user message.content must be str (ADR-0003), '
                f'got {type(m.get("content")).__name__}'
            )
        for m in asst_msgs:
            assert isinstance(m.get('content'), list), (
                f'assistant message.content must be list (ADR-0003), '
                f'got {type(m.get("content")).__name__}'
            )
    finally:
        # teardown：HTTP DELETE 容器（daphne Fleet.delete 处理 container_name 前缀 + DB 行 + 端口回收）；
        # 非 2xx 或 page 崩溃时 DockerRuntime stop/remove 兜底，防真容器残留（codex #193 P2）。
        _cleanup_container_ws(page_ws, container_name)
