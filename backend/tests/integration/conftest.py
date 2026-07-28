"""联调集成测试共享 fixtures（issue #179）。

编排三节点链路：真浏览器（Playwright）→ Vite dev server(5173) proxy → pytest-django 起的
live Django 后端。live server 复用 pytest-django 的 ``live_server`` fixture（随机端口隔离）；
vite dev server 由本 conftest 起 subprocess，经 ``VITE_API_TARGET`` 注入 live server 端口
（dev 行为不变，测试时指向 live server，端口隔离得以保留）。

每 case 独立 browser context（token/cookie/localStorage 全清）—— 是 L1/L2 401→refresh/
logout 分支能从干净态精确触发的前提（#178 user story 10）。

运行前提（CI integration job / 本地）：装 ``requirements/integration.txt`` +
``playwright install chromium`` + frontend ``npm ci``（vite dev server 依赖）。
"""
import os
import socket
import subprocess
import time
from pathlib import Path

import pytest

# vite dev server 固定端口（#178：经 vite proxy 是核心链路；pytest 默认串行不引 xdist，
# 固定端口不冲突）。可经 env 覆盖（本地已占 5173 时）。
VITE_PORT = int(os.environ.get('INTEGRATION_VITE_PORT', '5173'))

# vite 冷启动就绪轮询（首次 ts 转译较慢）
_VITE_READINESS_TIMEOUT = 30.0
_VITE_POLL_INTERVAL = 0.5

BACKEND_DIR = Path(__file__).resolve().parents[2]   # backend/
FRONTEND_DIR = BACKEND_DIR.parent / 'frontend'


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
    # --host 127.0.0.1：强制 IPv4 loopback。vite 8 默认 listen [::1]（localhost→IPv6），
    # 与 readiness 探测 / 浏览器 goto 统一到 127.0.0.1，避开 v4/v6 解析歧义（CI/ubuntu 同稳）。
    proc = subprocess.Popen(
        ['npm', 'run', 'dev', '--', '--port', str(VITE_PORT), '--strictPort', '--host', '127.0.0.1'],
        cwd=str(FRONTEND_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.monotonic() + _VITE_READINESS_TIMEOUT
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ''
                raise RuntimeError(f'vite dev server exited early (code {proc.returncode}):\n{out}')
            if _port_open('127.0.0.1', VITE_PORT):
                break
            time.sleep(_VITE_POLL_INTERVAL)
        else:
            raise RuntimeError(
                f'vite dev server not ready on :{VITE_PORT} within {_VITE_READINESS_TIMEOUT}s',
            )
        yield f'http://127.0.0.1:{VITE_PORT}'
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture
def page(vite_dev_server):
    """每 case 独立 browser context + page：token/cookie/localStorage 全清。

    每 case 新启 browser（彻底隔离；case 少时不计启动成本，后续 L1-L4 case 增多可改为
    session 级 browser 复用 + function 级 new_context）。
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
            pg = context.new_page()
            # 指向 vite dev server origin：相对路径 fetch('/api/health') 经 vite proxy 打后端
            pg.goto(vite_dev_server, wait_until='domcontentloaded')
            yield pg
        finally:
            browser.close()
