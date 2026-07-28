"""Integration test settings（issue #183）：daphne ASGI 子进程用。

dev 超集，DB 指向文件级 test DB（非 in-memory），使 daphne 子进程可在
独立 Python 进程中读写同一 SQLite 文件。

pytest-django 的 dev.py ``TEST['NAME']`` 缺省时 Django SQLite backend 返回
``:memory:``——每个数据库连接获得独立、transient 的 in-memory DB。测试进程
与 daphne 子进程是不同进程，pytest-django 的 in-memory DB 对 daphne 不可见。

本 settings 通过 ``TEST['NAME']`` 强制文件级 SQLite，daphne fixture 在启动
daphne 前先 ``manage.py migrate`` 建表，此后 daphne ORM 读写该文件。
"""
from .dev import *  # noqa: F401,F403 — Django settings 分层惯例

# 强制文件级 SQLite test DB（非 in-memory），daphne 子进程可跨进程读写。
DATABASES['default']['TEST'] = {  # noqa: F405
    'NAME': str(BASE_DIR / 'test_db_file.sqlite3'),  # noqa: F405
}
