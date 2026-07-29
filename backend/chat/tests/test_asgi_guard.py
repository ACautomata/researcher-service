"""seam: chat.asgi_guard —— 「单 Daphne 进程单 loop」部署前提 fail-fast 守卫（issue #201 问题 1）。

- 非 SyncToAsync 派生线程触达 REST→pool 入口 → 503，且**不触达 pool/async_to_sync**
  （不会新建临时 loop、不炸 client recv loop）；
- SyncToAsync 派生线程（conftest autouse fixture 模拟 threadlocal 标记）正常路径不回归。
"""
import threading

import pytest

from chat import views as chat_views
from chat.asgi_guard import on_synctoasync_thread
from chat.pool import ChatFleet, NotPaired
from chat.views import SessionListCreateView
from containers.models import Instance

pytestmark = pytest.mark.django_db


@pytest.fixture
def instance(db):
    return Instance.objects.create(
        name='demo', port=19000, token='gw-tok',
        home_dir='/tmp/x', container_id='cid', status=Instance.STATUS_RUNNING,
        image='img:tag',
    )


def _run_in_plain_thread(fn):
    """在普通（非 SyncToAsync 派生）线程执行 fn，返回其结果。"""
    box = {}

    def _target():
        box['result'] = fn()

    t = threading.Thread(target=_target)
    t.start()
    t.join()
    return box['result']


def test_plain_thread_is_not_synctoasync_thread():
    # 守卫判定本身：测试线程有 conftest 标记，普通线程没有
    assert on_synctoasync_thread() is True
    assert _run_in_plain_thread(on_synctoasync_thread) is False


def test_client_or_error_503_in_plain_thread_without_touching_pool(instance, monkeypatch):
    """普通线程调 _client_or_error → 503，且 async_to_sync/ChatFleet 未被触达（不炸 client）。"""

    def _boom(*args, **kwargs):
        raise AssertionError('守卫失效：非派生线程触达了 async_to_sync/pool')

    monkeypatch.setattr(chat_views, 'async_to_sync', _boom)
    monkeypatch.setattr(ChatFleet, 'get', classmethod(lambda cls: _boom()))

    client, err = _run_in_plain_thread(
        lambda: SessionListCreateView()._client_or_error(instance, 'demo'),
    )
    assert client is None
    assert err.status_code == 503
    assert 'ASGI' in err.data['detail']


def test_rpc_or_502_503_in_plain_thread_without_running_thunk():
    """普通线程调 _rpc_or_502 → 503，thunk/async_to_sync 均未执行。"""
    payload, err = _run_in_plain_thread(
        lambda: SessionListCreateView._rpc_or_502(
            'demo', 'sessions.list',
            lambda: (_ for _ in ()).throw(AssertionError('守卫失效：thunk 被执行')),
        ),
    )
    assert payload is None
    assert err.status_code == 503


def test_synctoasync_thread_normal_path_not_regressed(instance, monkeypatch):
    """SyncToAsync 派生线程（conftest 标记）守卫放行：未配对 → 409 语义不回归。"""

    class _Pool:
        async def get_or_create(self, inst):
            raise NotPaired('unpaired')

    monkeypatch.setattr(ChatFleet, 'get', classmethod(lambda cls: _Pool()))
    client, err = SessionListCreateView()._client_or_error(instance, 'demo')
    assert client is None
    assert err is not None
    assert err.status_code == 409  # 守卫放行 → 走正常「未配对」语义
