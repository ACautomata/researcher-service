"""backend 级 pytest 共享 fixture。"""
import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True)
def _clear_django_cache():
    """每个测试前后清 Django cache。

    issue #199：DRF throttle 历史存默认 cache（locmem），跨测试不清则全套件的
    auth 端点请求共享 10/minute 配额，会互相触发 429 误伤既有用例。
    """
    cache.clear()
    yield
    cache.clear()
