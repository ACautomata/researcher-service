"""seam: issue #201 问题 2/4 —— docker client 显式 timeout + _cached_client 并发双检。

- docker.from_env 显式 timeout（默认 60s，OPENCLAW_DOCKER_CLIENT_TIMEOUT env 可调，
  非法值回退默认）——daemon 卡死时不再无界阻塞单根 REST 视图线程；
- _cached_client lazy 缓存加 threading.Lock 双检：并发首调只建一个 client（防泄漏 daemon 连接）。
"""
import threading
import time

import pytest

pytest.importorskip('docker')  # docker_runtime 顶部 import docker
from containers.docker_runtime import DockerRuntime


def _capture_from_env(monkeypatch):
    captured = {}

    def fake_from_env(**kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr('containers.docker_runtime.docker.from_env', fake_from_env)
    return captured


def test_default_client_factory_sets_explicit_timeout(monkeypatch):
    # issue #201 问题 2：docker client 显式 timeout，默认 60s（原依赖 docker-py 隐式默认）
    captured = _capture_from_env(monkeypatch)
    monkeypatch.delenv('OPENCLAW_DOCKER_CLIENT_TIMEOUT', raising=False)
    DockerRuntime()._client()
    assert captured['timeout'] == 60.0


def test_default_client_factory_timeout_env_override(monkeypatch):
    # OPENCLAW_DOCKER_CLIENT_TIMEOUT 可调；非法值回退默认
    captured = _capture_from_env(monkeypatch)
    monkeypatch.setenv('OPENCLAW_DOCKER_CLIENT_TIMEOUT', '5')
    DockerRuntime()._client()
    assert captured['timeout'] == 5.0

    captured.clear()
    monkeypatch.setenv('OPENCLAW_DOCKER_CLIENT_TIMEOUT', 'not-a-number')
    DockerRuntime()._client()
    assert captured['timeout'] == 60.0


def test_client_lazy_cache_concurrent_single_factory_call():
    # issue #201 问题 4：并发首调只建一个 client（threading.Lock 双检）
    calls = []
    barrier = threading.Barrier(8)

    def factory():
        calls.append(1)
        time.sleep(0.05)  # 放大竞态窗口
        return object()

    rt = DockerRuntime(client_factory=factory)
    results = []

    def worker():
        barrier.wait()
        results.append(rt._client())

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1
    assert len({id(c) for c in results}) == 1
