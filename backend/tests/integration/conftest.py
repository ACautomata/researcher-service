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
