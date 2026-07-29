"""seam: issue #201 问题 3 —— 配对并发：attempt_version 原子取号 + 身份唯一仲裁。

进程内每实例锁（PairingService._instance_locks）跨进程无效；本测试用 monkeypatch
让两线程各持一把锁（模拟两个 worker 进程并发 ensure_paired 同一实例），断言：
- attempt_version 数据库原子取号无重号；
- 身份唯一：两次握手复用同一 deviceId（「条件写入空身份字段」仲裁，败者读 DB 已有身份）；
- 无裸 IntegrityError/500，最终落库 paired 且身份与握手使用的一致。
"""
import threading

import pytest

from chat.models import Pairing
from chat.pairing import PairingService
from chat.tests.fakes import FakeTransport
from containers.models import Instance

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def instance(transactional_db):
    return Instance.objects.create(
        name='demo', port=19000, token='gw-tok',
        home_dir='/tmp/x', container_id='cid', status=Instance.STATUS_RUNNING,
        image='img:tag',
    )


def test_concurrent_ensure_paired_atomic_version_and_unique_identity(instance, monkeypatch):
    # 模拟多进程：每线程一把实例锁（进程内 threading.Lock 跨进程本不可见）
    locks: dict = {}
    locks_mutex = threading.Lock()

    def _per_thread_lock(cls, instance_id):
        with locks_mutex:
            key = (instance_id, threading.get_ident())
            lock = locks.get(key)
            if lock is None:
                lock = threading.Lock()
                locks[key] = lock
            return lock

    monkeypatch.setattr(PairingService, '_lock_for', classmethod(_per_thread_lock))

    taken_versions: list[int] = []
    used_identity_ids: list[str] = []
    record_lock = threading.Lock()

    real_next = PairingService._next_attempt_version

    def _spy_next(self, pairing):
        version = real_next(pairing)  # 原实现是 staticmethod，只收 pairing
        with record_lock:
            taken_versions.append(version)
        return version

    monkeypatch.setattr(PairingService, '_next_attempt_version', _spy_next)

    real_handshake = PairingService._run_handshake
    # 握手栅栏：保证两线程都完成取号/身份仲裁、都进入握手后才放行，
    # 否则一方先行 paired，另一方走幂等 fast-path，并发路径未被真实执行。
    handshake_barrier = threading.Barrier(2)

    def _spy_handshake(self, url, token, identity):
        with record_lock:
            used_identity_ids.append(identity.device_id)
        handshake_barrier.wait(timeout=10)
        return real_handshake(self, url, token, identity)

    monkeypatch.setattr(PairingService, '_run_handshake', _spy_handshake)

    svc = PairingService(transport=FakeTransport.hello_ok())
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def _worker():
        try:
            barrier.wait()
            svc.ensure_paired(instance)
        except BaseException as e:  # pylint: disable=broad-exception-caught
            errors.append(e)

    threads = [threading.Thread(target=_worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # 无裸 IntegrityError/500
    assert not errors
    # 两线程都真实执行了握手（未被 fast-path 短路）
    assert len(used_identity_ids) == 2
    # 原子取号无重号（SQLITE_LOCKED 重试可能多取，但绝不重复）
    assert len(taken_versions) >= 2
    assert len(set(taken_versions)) == len(taken_versions)
    # 身份唯一：两次握手使用同一 deviceId，且与最终落库一致
    assert len(set(used_identity_ids)) == 1
    pairing = Pairing.objects.get(instance=instance)
    assert pairing.status == Pairing.STATUS_PAIRED
    assert pairing.device_id == used_identity_ids[0]
    assert pairing.device_token  # 胜出版本的结果已落库
