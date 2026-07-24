"""seam: HealthProbe —— 外部 /health 探测（spec §5.4/§12 兜底：控制面外部 HTTP 探 /health）。

验证错误处理契约：连不上 / 5xx / 超时 统一 False（不可误报 healthy，否则 issue #39 列表
「变 healthy」验收失真）。用 monkeypatch 替换 urlopen，不连真端口。
"""
import io
import urllib.error
import urllib.request

from containers.orchestrator import HealthProbe


class _FakeResponse(io.BytesIO):
    status: int

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_2xx_is_reachable(monkeypatch):
    resp = _FakeResponse(b'{"status":"ok"}')
    resp.status = 200
    monkeypatch.setattr(urllib.request, 'urlopen', lambda *a, **k: resp)
    assert HealthProbe().is_reachable(19000) is True


def test_connection_refused_is_unreachable(monkeypatch):
    def _boom(*a, **k):
        raise urllib.error.URLError('connection refused')

    monkeypatch.setattr(urllib.request, 'urlopen', _boom)
    assert HealthProbe().is_reachable(19000) is False


def test_5xx_is_unreachable(monkeypatch):
    def _server_error(*a, **k):
        raise urllib.error.HTTPError('u', 503, 'Service Unavailable', {}, None)

    monkeypatch.setattr(urllib.request, 'urlopen', _server_error)
    assert HealthProbe().is_reachable(19000) is False
