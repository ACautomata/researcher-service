"""Integration test settings（issue #183）：daphne ASGI 子进程用。

dev 超集，DB 指向文件级 test DB（非 in-memory），使 daphne 子进程可在
独立 Python 进程中读写同一 SQLite 文件。

pytest-django 的 dev.py ``TEST['NAME']`` 缺省时 Django SQLite backend 返回
``:memory:``——每个数据库连接获得独立、transient 的 in-memory DB。测试进程
与 daphne 子进程是不同进程，pytest-django 的 in-memory DB 对 daphne 不可见。

本 settings 通过覆盖 ``NAME``（而非仅 ``TEST['NAME']``）强制文件级 SQLite，
``manage.py migrate`` 和 daphne 进程均读写该文件（codex #190 P2）。
"""
from .dev import *

# 覆盖默认 NAME（而非仅 TEST['NAME']）：manage.py migrate / daphne 子进程
# 的 Django ORM 读 NAME 而非 TEST['NAME']，后者仅 pytest-django 使用。
DATABASES['default']['NAME'] = str(BASE_DIR / 'test_db_file.sqlite3')
