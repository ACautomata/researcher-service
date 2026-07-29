"""chat.asgi_guard —— 「单 Daphne 进程单 loop」部署前提的 fail-fast 守卫（issue #201 问题 1）。

本服务承认的部署前提：仅支持 ASGI（Daphne）单进程单 worker。REST sync 视图经
async_to_sync 驱动 ChatFleet pool 的共享 WS client——只有当调用线程是 SyncToAsync
派生线程（Daphne 下 Django sync view 的工作线程）时，async_to_sync 才把协程经
call_soon_threadsafe 调度回主 loop，与 client 建连/recv 所在 loop 同 loop，
future 的 set_result 才是同 loop 线程安全的。

一旦从非 SyncToAsync 派生线程触达（WSGI worker / 管理命令 / 后台线程 / 测试线程），
async_to_sync 会新建临时 loop 跑完即关，于是 client 建连 loop 的 recv task 对另一
loop 的 future 跨 loop set_result → RuntimeError 逃出 _handle → recv loop 死亡、
全面板在途 run 收到「容器连接断开」。入口 fail-fast 503 替代炸连接。

完整的「client 专属 loop + run_coroutine_threadsafe」重构为 follow-up（待 #196/#197
合入后进行）；本守卫是承认前提路线下的启动期/运行期保护。
"""
from asgiref.sync import SyncToAsync


def on_synctoasync_thread() -> bool:
    """当前线程是否为 SyncToAsync 派生线程（asgiref sync.py 的机制）。

    SyncToAsync 在其派生工作线程执行前会在 threadlocal 上设置 main_event_loop；
    AsyncToSync.__call__ 也凭同一 threadlocal 判断能否调度回主 loop。
    本守卫与之对齐：threadlocal 无 main_event_loop ⇒ 非派生线程 ⇒ async_to_sync
    将走「新建临时 loop」路径，不允许触达共享 pool client。
    """
    return getattr(SyncToAsync.threadlocal, 'main_event_loop', None) is not None
