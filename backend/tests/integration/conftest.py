"""联调集成测试共享 fixtures（issue #179）。

编排三节点链路：真浏览器（Playwright）→ Vite dev server proxy → pytest-django 起的
live Django 后端。live server 复用 pytest-django 的 ``live_server`` fixture（随机端口隔离）；
vite dev server 由本 conftest 起 subprocess，经 ``VITE_API_TARGET`` 注入 live server 端口
（dev 行为不变，测试时指向 live server，端口隔离得以保留）。

每 case 独立 browser context（token/cookie/localStorage 全清）—— 是 L1/L2 401→refresh/
logout 分支能从干净态精确触发的前提（#178 user story 10）。

运行前提（CI integration job / 本地）：装 ``requirements/integration.txt`` +
``playwright install chromium`` + frontend ``npm ci``（vite dev server 依赖）。
"""
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

# vite 冷启动就绪轮询（首次 ts 转译较慢）
_VITE_READINESS_TIMEOUT = 30.0
_VITE_POLL_INTERVAL = 0.5

BACKEND_DIR = Path(__file__).resolve().parents[2]   # backend/
FRONTEND_DIR = BACKEND_DIR.parent / 'frontend'


def _resolve_port() -> int:
    """返回 vite dev server 端口。

    CI/默认:随机选 free ephemeral 端口,避免遗留 Vite 抢旧端口的时候就绪探针认错服务器
    (codex #185 P2)。设 ``INTEGRATION_VITE_PORT`` env(如 ``5173``)时为固定值
    (本地 debug 时方便 curl/lsof 确认)。
    """
    if 'INTEGRATION_VITE_PORT' in os.environ:
        return int(os.environ['INTEGRATION_VITE_PORT'])
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def _port_open(host: str, port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(_VITE_POLL_INTERVAL)
        return s.connect_ex((host, port)) == 0


@pytest.fixture
def vite_dev_server(live_server):
    """起 vite dev server，proxy target 经 ``VITE_API_TARGET`` 指向 ``live_server.url``。

    dev 行为不变（``VITE_API_TARGET`` 缺省 :8000）；测试时本 fixture 注入 live server 随机
    端口，坐实 浏览器→Vite proxy→live Django 三节点链路（#179 acceptance）。
    """
    env = {**os.environ, 'VITE_API_TARGET': live_server.url}
    port = _resolve_port()
    # --host 127.0.0.1：强制 IPv4 loopback。vite 8 默认 listen [::1]（localhost→IPv6），
    # 与 readiness 探测 / 浏览器 goto 统一到 127.0.0.1，避开 v4/v6 解析歧义（CI/ubuntu 同稳）。
    proc = subprocess.Popen(
        ['npm', 'run', 'dev', '--', '--port', str(port), '--strictPort', '--host', '127.0.0.1'],
        cwd=str(FRONTEND_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + _VITE_READINESS_TIMEOUT
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ''
                raise RuntimeError(f'vite dev server exited early (code {proc.returncode}):\n{out}')
            if _port_open('127.0.0.1', port):
                break
            time.sleep(_VITE_POLL_INTERVAL)
        else:
            raise RuntimeError(
                f'vite dev server not ready on :{port} within {_VITE_READINESS_TIMEOUT}s',
            )
        yield f'http://127.0.0.1:{port}'
    finally:
        _terminate_process_group(proc)


def _terminate_process_group(proc: subprocess.Popen) -> None:
    """收掉 vite dev server 子进程树（npm→vite）。

    POSIX 上 ``npm run dev`` 把 vite 作子孙进程拉起;teardown 若只对 npm 发信号,
    vite 孤儿会继续监听 5173,下一个 function 级 fixture 因 ``--strictPort`` 绑不上而
    失败,后续 case 叠加泄漏。配合 ``start_new_session=True``(见 fixture)把 npm 树
    隔离进独立进程组(pgid==npm.pid),这里对整组收信号。
    """
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)


# 每次导航自动重装 dev hook 的 init script（test 侧 own，main.ts 不放测试代码，#188）。
# add_init_script 在每页脚本前注入，异步 IIFE poll 等 Vue mount（#app.__vue_app__，app.mount 挂）
# 再装 hook——不延迟 fixture yield（page.url 保持根路径，不破坏 L1 base 计算），且 test 内再
# page.goto 也会重装（导航清空 window）。pinia 经 app.use(pinia)→globalProperties.$pinia（probe
# 实证 gpPinia=True）；前端 api 经动态 import /src/...（vite dev serve 源码，同一模块实例）。
_TEST_HOOKS_INIT_SCRIPT = """
(async () => {
    while (!document.querySelector('#app') || !document.querySelector('#app').__vue_app__) {
        await new Promise(r => setTimeout(r, 50));
    }
    const app = document.querySelector('#app').__vue_app__;
    window.__pinia = app.config.globalProperties.$pinia;
    const [{ apiFetch }, { listInstances }, { getTree }] = await Promise.all([
        import('/src/api/client.ts'),
        import('/src/api/containers.ts'),
        import('/src/api/wiki.ts'),
    ]);
    window.__apiFetch = apiFetch;
    window.__listInstances = listInstances;
    window.__getTree = getTree;
})();
"""


@pytest.fixture
def page(vite_dev_server):
    """每 case 独立 browser context + page：token/cookie/localStorage 全清。

    每 case 新启 browser（彻底隔离；case 少时不计启动成本，后续 L1-L4 case 增多可改为
    session 级 browser 复用 + function 级 new_context）。dev hook（``__pinia`` / ``__apiFetch`` /
    ``__listInstances`` / ``__getTree``）经 ``context.add_init_script`` 在每次导航后异步注入
    （#188，main.ts 不放测试代码）——不延迟 yield、test 内再导航也重装。
    """
    # playwright 仅在 requirements/integration.txt（#179），backend-unit job 不装（只装 dev.txt）。
    # 不能顶部 import——否则 backend-unit 收集本 conftest 即 ImportError 红整个 job；而 pytest
    # importorskip 在 conftest 顶层不受支持（抛 Skipped 被当 collection error，已实测）。故延迟到
    # fixture 内：只有真正跑 integration case 才 import，deselect 的单元回归不受影响。
    # （Python 规则 #4「顶部 import」的 spec 驱动例外：playwright 是 spec #179 明令的可选依赖。）
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            context = browser.new_context()
            context.add_init_script(_TEST_HOOKS_INIT_SCRIPT)
            pg = context.new_page()
            # 指向 vite dev server origin：相对路径 fetch('/api/health') 经 vite proxy 打后端
            pg.goto(vite_dev_server, wait_until='domcontentloaded')
            yield pg
        finally:
            browser.close()


# ═══════════════════════════════════════════════════════════════════════════════
# L4 WebSocket fixtures（issue #183）：daphne ASGI LiveServer + Vite proxy + Playwright
# ═══════════════════════════════════════════════════════════════════════════════

# daphne ASGI 冷启动就绪轮询（对齐 Vite _VITE_READINESS_TIMEOUT 模式）
_DAPHNE_READINESS_TIMEOUT = 15.0
_DAPHNE_POLL_INTERVAL = 0.5

# daphne 子进程就绪 stdout 哨兵（daphne 的 ASGI/TCP server 启动完成后打印的启动 marker）
_DAPHNE_LISTENING_MARKER = 'Listening on'


def _run_manage_py(argv: list[str], env: dict[str, str]) -> None:
    """调 ``manage.py <argv>`` 在给定 env 下仿 Django CLI（如 migrate）。"""
    proc = subprocess.run(
        [sys.executable, 'manage.py', *argv],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f'manage.py {" ".join(argv)} failed (code {proc.returncode}):\n'
            f'stdout={proc.stdout}\nstderr={proc.stderr}',
        )


def _find_free_port() -> int:
    """返回空闲 TCP 端口（bind + release；用于 daphne subprocess）。"""
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


@pytest.fixture
def daphne_server(request, django_db_setup):
    """起 daphne 单进程 ASGI LiveServer（fixed port，同一 test DB）。

    本 fixture 负责 test DB 的创建（migrate）与 daphne 进程的启停。pytest-django
    的 ``django_db_setup`` 仅创建空的 test DB 文件（``CREATE DATABASE`` 等价物），
    不建表——需 ``migrate`` 用 integration.py 设置连接 test DB 创建表。

    此后 daphne 子进程启动，其 Django ORM 连接同一文件级 SQLite，读写表结构与数据。
    测试进程通过 ``@django_db(transaction=True)`` TransactionTestCase 连接相同的
    dev.py settings，pytest-django 会根据 dev settings 创建 in-memory DB 用于测试
    ORM——所以 test 进程和 daphne 进程各有独立 DB，不共享数据。

    Teardown：``_terminate_process_group`` 收掉 daphne 进程树（与 vite_dev_server 同模式）。
    """
    port = _find_free_port()

    # 1. migrate：用 integration.py settings → 文件级 SQLite（test_db_file.sqlite3）
    #    test 进程通过 pytest-django 默认 dev.py → in-memory DB，两者独立。
    #    daphne 进程 migrate 创建表；test 进程通过 HTTP (register/login/etc.)
    #    向 daphne 发请求，daphne ORM 读写的就是这些表。
    env_integration = {**os.environ, 'DJANGO_SETTINGS_MODULE': 'config.settings.integration'}
    _run_manage_py(['migrate', '--noinput'], env_integration)

    # 2. 启动 daphne（用 sys.executable -m daphne 而非硬编码 .venv/bin/daphne，
    #    兼容 CI 环境（无 .venv，codex #190 P1）和本地开发环境。
    proc = subprocess.Popen(
        [
            sys.executable, '-m', 'daphne',
            '-b', '127.0.0.1',
            '-p', str(port),
            '--verbosity', '0',
            'config.asgi:application',
        ],
        cwd=str(BACKEND_DIR),
        env=env_integration,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + _DAPHNE_READINESS_TIMEOUT
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ''
                raise RuntimeError(
                    f'daphne exited early (code {proc.returncode}):\n{out}',
                )
            if _port_open('127.0.0.1', port):
                break
            time.sleep(_DAPHNE_POLL_INTERVAL)
        else:
            raise RuntimeError(
                f'daphne not listening on :{port} within {_DAPHNE_READINESS_TIMEOUT}s',
            )
        yield f'http://127.0.0.1:{port}'
    finally:
        _terminate_process_group(proc)


@pytest.fixture
def vite_dev_server_ws(daphne_server):
    """起 vite dev server，proxy target 经 ``VITE_API_TARGET`` 指向 daphne ASGI server。

    L4 必须 ASGI（WebSocket 走 Channels ASGI 栈）—— ``live_server`` 是 WSGI，
    不服务 WebSocket。本 fixture 用 daphne_server 替代 live_server，其余编排
    与 ``vite_dev_server`` 一致（复用 ``_resolve_port`` + ``_port_open`` +
    ``_terminate_process_group``）。
    """
    env = {**os.environ, 'VITE_API_TARGET': daphne_server}
    port = _resolve_port()
    proc = subprocess.Popen(
        ['npm', 'run', 'dev', '--', '--port', str(port), '--strictPort', '--host', '127.0.0.1'],
        cwd=str(FRONTEND_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + _VITE_READINESS_TIMEOUT
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ''
                raise RuntimeError(f'vite dev server exited early (code {proc.returncode}):\n{out}')
            if _port_open('127.0.0.1', port):
                break
            time.sleep(_VITE_POLL_INTERVAL)
        else:
            raise RuntimeError(
                f'vite dev server not ready on :{port} within {_VITE_READINESS_TIMEOUT}s',
            )
        yield f'http://127.0.0.1:{port}'
    finally:
        _terminate_process_group(proc)


@pytest.fixture
def page_ws(vite_dev_server_ws):
    """L4 用 Playwright page：每 case 独立 browser context + 导航到 Vite（ASGI 后端）。

    与 ``page`` fixture 等价，仅依赖链不同：daphne_server → vite_dev_server_ws → page_ws，
    而非 live_server → vite_dev_server → page。dev hook（``__pinia`` / ``__apiFetch`` 等）
    经 ``context.add_init_script`` 同态注入。
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            context = browser.new_context()
            context.add_init_script(_TEST_HOOKS_INIT_SCRIPT)
            pg = context.new_page()
            pg.goto(vite_dev_server_ws, wait_until='domcontentloaded')
            yield pg
        finally:
            browser.close()
