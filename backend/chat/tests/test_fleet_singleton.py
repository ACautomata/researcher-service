"""seam: issue #201 问题 4 —— ChatFleet.get() 并发首调只建一个 pool。

原 lazy 单例无锁：两线程同时首次调用可各建一个 pool，多建者泄漏（client/recv 协程孤儿）。
修复：threading.Lock 双检。本文件独立成文，避免触碰 #196/#199 正在改动的 test_pool.py。
"""
import threading
import time

from chat import pool as pool_module
from chat.pool import ChatFleet


def test_fleet_get_concurrent_first_call_builds_single_pool(monkeypatch):
    # 并发首调只建一个 pool（threading.Lock 双检）
    created = []

    class SlowPool:
        def __init__(self):
            created.append(1)
            time.sleep(0.05)  # 放大竞态窗口

    monkeypatch.setattr(pool_module, 'ChatConnectionPool', SlowPool)
    ChatFleet.reset()
    try:
        barrier = threading.Barrier(8)
        results = []

        def worker():
            barrier.wait()
            results.append(ChatFleet.get())

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len(created) == 1
        assert len({id(r) for r in results}) == 1
    finally:
        ChatFleet.reset()  # 清理单例，避免跨测试污染
