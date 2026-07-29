"""WSGI 入口已禁用（issue #201 问题 1：承认「单 Daphne 进程单 loop」部署前提）。

本服务仅支持 ASGI（Daphne）单进程单 worker 部署：

- REST sync 视图经 async_to_sync 驱动 ChatFleet pool 的共享 WS client，仅在 ASGI 下
  SyncToAsync 派生线程中才把协程调度回 client 所在主 loop；WSGI worker 线程会新建
  临时 loop，跨 loop set_result 会炸 client 的 recv loop（全面板聊天不可用）。
- 配对/编排的并发保护含进程内锁，多 worker 即失效。

请改用 ASGI 入口（生产）：daphne config.asgi:application。
本模块保留仅为显式 fail-fast——任何 WSGI 服务器（gunicorn/uwsgi/mod_wsgi）引用
config.wsgi:application 时在 import 期即拒启动，而非上线后随机炸连接。
"""

raise RuntimeError(
    'config.wsgi 已禁用（issue #201）：本服务仅支持 ASGI（Daphne）单进程单 worker 部署，'
    '请改用 `daphne config.asgi:application`',
)
