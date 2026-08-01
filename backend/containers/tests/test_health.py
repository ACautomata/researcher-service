"""seam: HealthProbe —— 外部 /health 探测（spec §5.4/§12 兜底：控制面外部 HTTP 探 /health）。

验证错误处理契约：连不上 / 5xx / 超时 统一 False（不可误报 healthy，否则 issue #39 列表
「变 healthy」验收失真）。用 monkeypatch 替换 urlopen，不连真端口。
"""
import io
import urllib.error
import urllib.request

from integration.openclaw.adapters import HttpHealthProbe


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
    assert HttpHealthProbe().is_reachable(19000) is True


def test_connection_refused_is_unreachable(monkeypatch):
    def _boom(*a, **k):
        raise urllib.error.URLError('connection refused')

    monkeypatch.setattr(urllib.request, 'urlopen', _boom)
    assert HttpHealthProbe().is_reachable(19000) is False


def test_5xx_is_unreachable(monkeypatch):
    def _server_error(*a, **k):
        raise urllib.error.HTTPError('u', 503, 'Service Unavailable', {}, None)

    monkeypatch.setattr(urllib.request, 'urlopen', _server_error)
    assert HttpHealthProbe().is_reachable(19000) is False


def test_timeout_is_unreachable(monkeypatch):
    def _timeout(*a, **k):
        raise TimeoutError('timed out')

    monkeypatch.setattr(urllib.request, 'urlopen', _timeout)
    assert HttpHealthProbe().is_reachable(19000) is False


def test_http_health_probe_uses_injected_host(monkeypatch):
    """#295：探测 URL 用构造注入 host（默认 127.0.0.1 保持本地零回归）。

    生产后端容器化后，gateway 端口经宿主 0.0.0.0 发布，控制面须经
    ``host.docker.internal``（host-gateway）寻址——host 不再写死 loopback。
    用 monkeypatch 捕获 urlopen 的第一个位置参数（URL 串），断言含注入 host。
    """
    seen = {}

    def _capture(url, *a, **k):
        seen['url'] = url
        resp = _FakeResponse(b'{"status":"ok"}')
        resp.status = 200
        return resp

    monkeypatch.setattr(urllib.request, 'urlopen', _capture)
    assert HttpHealthProbe(host='10.0.0.5').is_reachable(19000) is True
    assert seen['url'] == 'http://10.0.0.5:19000/health'
