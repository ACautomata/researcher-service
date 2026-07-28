"""前后端联调集成测试（issue #179）：前端经 Vite proxy 真打后端 API 契约断言。

seam：真浏览器（Playwright）经 Vite dev server proxy 打 pytest-django 起的 live Django
后端，断言 HTTP 响应状态码 + JSON 契约。源真相在后端 serializer（config/views.py）。

L0（#179）：health 契约 + 每测试独立 browser context 隔离。后续 HTTP case（L1/L2a/L2b/L3，
#180-#183）与 ASGI（L4，#184）以此 fixture 为模板。

运行（须装 integration.txt + `playwright install chromium` + 本地 Colima DOCKER_HOST）::

  cd backend
  python -m pytest -m integration tests/integration/test_integration_http.py -v
"""
import pytest

# 真链路集成测试（issue #157/#178）：CI integration job env 齐备时真跑；backend-unit job 经
# `-m "not integration"` 排除，默认 `python -m pytest` 不跑（不污染单元回归）。
pytestmark = pytest.mark.integration


def test_health_returns_ok_via_vite_proxy(page):
    """L0：经 Vite proxy 打真后端 GET /api/health，断言 2xx + ``{status:"ok"}``。

    源真相：``config/views.py`` ``HealthResponseSerializer``。经 ``page.evaluate`` 走真浏览器
    ``fetch``，路径 浏览器 → Vite(5173) proxy → Django live server，坐实三节点链路贯通
    （mock fetch / APIClient 测不到的 proxy 真链路）。
    """
    result = page.evaluate(
        """
        async () => {
            const resp = await fetch('/api/health');
            const body = await resp.json();
            return { status: resp.status, body };
        }
        """,
    )
    assert 200 <= result['status'] < 300
    # 期望值来自后端 HealthResponseSerializer 契约，非用代码同样方式重算
    assert result['body'] == {'status': 'ok'}


def test_browser_context_starts_clean(page):
    """每 case 独立 browser context：起始无 token/cookie/localStorage 残留。

    context 隔离是 L1/L2 401→refresh/logout 分支能从干净态精确触发的前提（#178 user story
    10）。新 context 的 localStorage 与 cookie 必须为空。
    """
    state = page.evaluate(
        """
        () => ({
            localStorageKeys: localStorage.length,
            cookie: document.cookie,
        })
        """,
    )
    assert state['localStorageKeys'] == 0
    assert state['cookie'] == ''
