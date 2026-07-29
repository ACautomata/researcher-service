"""chat 测试共享 fixture（issue #201 问题 1）。

REST→pool 的部署前提守卫（chat.asgi_guard.on_synctoasync_thread）要求调用线程是
SyncToAsync 派生线程（Daphne 下 Django sync view 的工作线程）。Django/DRF test client
在测试线程直调视图、不经 ASGI 调度，这里 autouse 模拟该 threadlocal 标记，
保持既有 API 测试走正常路径（守卫语义本身由 test_asgi_guard.py 覆盖）。
"""
import asyncio

import pytest
from asgiref.sync import SyncToAsync


@pytest.fixture(autouse=True)
def _simulate_synctoasync_view_thread():
    """模拟 Daphne 下 sync view 线程：SyncToAsync.threadlocal.main_event_loop 已设置。

    只设置标记、loop 不运行：async_to_sync 对非 running 的 main loop 仍走「临时 loop」
    旧路径，不改变既有测试的异步执行语义。
    """
    loop = asyncio.new_event_loop()
    SyncToAsync.threadlocal.main_event_loop = loop
    try:
        yield
    finally:
        if getattr(SyncToAsync.threadlocal, 'main_event_loop', None) is loop:
            del SyncToAsync.threadlocal.main_event_loop
        loop.close()
