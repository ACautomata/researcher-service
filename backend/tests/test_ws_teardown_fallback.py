"""L4 T7 WS teardown fallback 契约测试（codex #193 P2，issue #184）。

被测 seam：``tests.integration.test_integration_ws._cleanup_container_ws`` —— T7 case 的
容器 teardown。daphne 是独立 OS 进程，主路径经 HTTP DELETE（``__apiFetch``=``apiFetch``，
非 2xx 不抛）走 daphne ``Fleet.delete``；非 2xx 或 page.evaluate 抛错（浏览器/页面崩溃）
时须直连 ``DockerRuntime.stop/remove`` 兜底，否则真容器残留 + 原始失败被 finally 吞掉。

真值源：codex #193 P2 意见（非 2xx 或 evaluate 失败 → 须 out-of-band Docker 清理）。
隔离：fake page + fake runtime（不连真 Docker、不起浏览器），对齐 silent-failure 回归守护。
"""

from __future__ import annotations

import pytest

from tests.integration.test_integration_ws import _cleanup_container_ws


class _FakePage:
    """模拟 Playwright page：``evaluate`` 返回预设结果或抛预设异常。"""

    def __init__(self, result: object = None, exc: BaseException | None = None) -> None:
        self._result = result
        self._exc = exc

    def evaluate(self, script: str, *args: object, **kwargs: object) -> object:
        if self._exc is not None:
            raise self._exc
        return self._result


class _FakeRuntime:
    """记录 stop/remove 调用（替代真 DockerRuntime，无 daemon）。"""

    def __init__(self) -> None:
        self.stopped: list[str] = []
        self.removed: list[str] = []
        self.stop_exc: BaseException | None = None

    def stop(self, name: str) -> None:
        self.stopped.append(name)
        if self.stop_exc is not None:
            raise self.stop_exc

    def remove(self, name: str) -> None:
        self.removed.append(name)


def test_delete_ok_skips_docker_fallback():
    """主路径成功（daphne Fleet.delete 2xx）→ 不动 Docker（不重复清理）。"""
    page = _FakePage(result={'ok': True, 'status': 204})
    runtime = _FakeRuntime()

    _cleanup_container_ws(page, 'l4t7-deadbeef', runtime=runtime)

    assert runtime.stopped == []
    assert runtime.removed == []


def test_delete_non_2xx_triggers_docker_fallback():
    """DELETE 非 2xx（apiFetch 不抛，须检 resp.ok）→ DockerRuntime stop/remove 兜底。"""
    page = _FakePage(result={'ok': False, 'status': 500})
    runtime = _FakeRuntime()

    _cleanup_container_ws(page, 'l4t7-deadbeef', runtime=runtime)

    assert runtime.stopped == ['l4t7-deadbeef']
    assert runtime.removed == ['l4t7-deadbeef']


def test_page_crash_triggers_docker_fallback():
    """page.evaluate 抛错（浏览器/页面崩溃）→ 吞异常后 Docker stop/remove 兜底。"""
    page = _FakePage(exc=RuntimeError('Target closed'))
    runtime = _FakeRuntime()

    _cleanup_container_ws(page, 'l4t7-deadbeef', runtime=runtime)

    assert runtime.stopped == ['l4t7-deadbeef']
    assert runtime.removed == ['l4t7-deadbeef']


def test_stop_failure_still_removes_and_does_not_propagate():
    """Docker stop 抛错（daemon 不可用）→ remove 仍执行（force-removal），且不掩盖原始失败（不 propagate）。

    回归守护（codex #193 P2 R2）：stop/remove 须各自独立隔离——stop 失败不阻断 remove，
    清理自身异常一律吞掉，绝不从 finally 上抛替换原始 assert/timeout 失败。
    """
    page = _FakePage(result={'ok': False, 'status': 500})  # 触发 Docker 兜底
    runtime = _FakeRuntime()
    runtime.stop_exc = RuntimeError('daemon unavailable')

    _cleanup_container_ws(page, 'l4t7-deadbeef', runtime=runtime)  # 不应抛

    assert runtime.stopped == ['l4t7-deadbeef']  # stop 被尝试（虽抛错）
    assert runtime.removed == ['l4t7-deadbeef']  # remove 仍执行（force-removal）


@pytest.mark.parametrize('bad_result', [None, {}, {'ok': False, 'status': 404}])
def test_delete_unusable_result_triggers_docker_fallback(bad_result: object):
    """evaluate 返回不可用结果（None / 缺字段 / 非 2xx）→ Docker stop/remove 兜底。"""
    page = _FakePage(result=bad_result)
    runtime = _FakeRuntime()

    _cleanup_container_ws(page, 'l4t7-deadbeef', runtime=runtime)

    assert runtime.stopped == ['l4t7-deadbeef']
    assert runtime.removed == ['l4t7-deadbeef']

