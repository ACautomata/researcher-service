"""issue #201 问题 1：WSGI 入口已禁用——承认「单 Daphne 进程单 worker」部署前提。

config.wsgi 保留文件但 import 即 fail-fast（RuntimeError），任何 WSGI 服务器引用
config.wsgi:application 时在启动期即拒绝，而非上线后跨 loop 炸共享 WS client。
"""
import importlib
import sys

import pytest


def test_wsgi_entry_import_fails_fast():
    sys.modules.pop('config.wsgi', None)
    try:
        with pytest.raises(RuntimeError, match='ASGI'):
            importlib.import_module('config.wsgi')
    finally:
        sys.modules.pop('config.wsgi', None)
