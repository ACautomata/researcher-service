"""Integration test settings（issue #183）：daphne ASGI 子进程用。

dev 超集，DB 指向文件级 test DB（非 in-memory），使 daphne 子进程可在
独立 Python 进程中读写同一 SQLite 文件。

pytest-django 的 dev.py ``TEST['NAME']`` 缺省时 Django SQLite backend 返回
``:memory:``——每个数据库连接获得独立、transient 的 in-memory DB。测试进程
与 daphne 子进程是不同进程，pytest-django 的 in-memory DB 对 daphne 不可见。

本 settings 通过覆盖 ``NAME``（而非仅 ``TEST['NAME']``）强制文件级 SQLite，
``manage.py migrate`` 和 daphne 进程均读写该文件（codex #190 P2）。
"""
import copy

from .dev import *

# 深拷贝 DATABASES，避免 from .dev import * 的别名引用（codex #190 P2）。
# star import 使 DATABASES 指向 dev 模块的同一 dict 对象；不拷贝直接覆写
# NAME 会同等修改 config.settings.dev.DATABASES，干扰同一进程内的 pytest-django。
DATABASES = copy.deepcopy(DATABASES)
DATABASES['default']['NAME'] = str(BASE_DIR / 'test_db_file.sqlite3')
