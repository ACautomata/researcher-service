"""回归测试:conftest ``vite_dev_server`` teardown 必须收掉整棵进程树(codex #185 P1)。

契约:POSIX 上 ``npm run dev`` 把 vite 作子孙进程拉起;teardown 若只对 npm 发信号,
vite 孤儿会继续监听 5173,下一个 function 级 fixture 因 ``--strictPort`` 绑不上而失败。
用 parent→child(port-holder) 模型替代真 npm+vite(隔离重资源,无 docker/playwright 依赖),
断言 ``_terminate_process_group`` 后 child 被收、端口释放。

源真相:``conftest._terminate_process_group``——经 importlib 按 path 加载,不依赖 pytest
import mode,也不触发 playwright 顶部 import(conftest 顶部无重依赖)。
"""
import importlib.util
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

# 真链路集成测试同档(#157/#178):CI integration job env 齐备时真跑;backend-unit job
# 经 `-m "not integration"` 排除(本 case 仅 subprocess,无重依赖,但与 conftest 同家)。
pytestmark = pytest.mark.integration

_CONFTEST = Path(__file__).resolve().parent / 'conftest.py'

_PARENT_SRC = (
    "import subprocess, sys, time\n"
    "subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])\n"
    "time.sleep(3600)\n"
)
_CHILD_SRC = (
    "import os, socket, sys, time\n"
    "s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(1)\n"
    "open(sys.argv[1], 'w').write(f'{s.getsockname()[1]} {os.getpid()}')\n"
    "time.sleep(3600)\n"
)


def _load_terminate_group():
    spec = importlib.util.spec_from_file_location('integration_conftest_under_test', _CONFTEST)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._terminate_process_group


def _port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _spawn_tree(tmp_path: Path):
    """parent→child 模型:child 绑随机端口写 marker,parent 长驻(模拟 npm→vite)。"""
    child = tmp_path / 'child.py'
    parent = tmp_path / 'parent.py'
    child.write_text(_CHILD_SRC)
    parent.write_text(_PARENT_SRC)
    marker = tmp_path / 'marker.txt'
    proc = subprocess.Popen(
        [sys.executable, str(parent), str(child), str(marker)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,   # 与 conftest fixture 一致:子树隔离进独立进程组
    )
    for _ in range(40):
        if marker.exists() and marker.stat().st_size:
            break
        time.sleep(0.25)
    else:
        proc.kill()
        pytest.fail('child never bound port (marker empty)')
    child_port, child_pid = map(int, marker.read_text().split())
    assert _port_open(child_port), 'child port not open before teardown'
    return proc, child_port, child_pid


def test_terminate_process_group_kills_descendant(tmp_path):
    """整组 teardown 必须杀掉 holding-port 的子孙(非仅 parent)。"""
    terminate_group = _load_terminate_group()
    proc, child_port, child_pid = _spawn_tree(tmp_path)
    try:
        terminate_group(proc)
        # 子孙被收:进程不在 + 端口释放(给 OS 一瞬回收时间)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and (_alive(child_pid) or _port_open(child_port)):
            time.sleep(0.1)
        assert not _alive(child_pid), 'orphaned child survived teardown (port leak)'
        assert not _port_open(child_port), 'port still bound after teardown'
    finally:
        # 测试失败也别泄漏孤儿进程
        if _alive(child_pid):
            try:
                os.kill(child_pid, 9)
            except ProcessLookupError:
                pass
