"""README 契约测试：chat wire schema 集成测试段（issue #161）。

被测 seam：``backend/README.md`` —— 开发者读取的公开文档。
真值源：issue #161 验收标准（README 须含 ghcr wire schema 集成测试段：env 三件套 +
怎么跑 + 门控说明）+ 代码现实（``chat/tests/test_integration_wire.py`` 实际路径、
ci.yml integration job 实际 env、pyproject 实际 ``integration`` marker）。

重构 README 措辞不破坏本测试，只要关键事实（路径/env 名/门控命令/镜像）齐全。
对齐 ``test_ci_workflow.py`` 的「用契约测试守护配置/文档」模式。
"""

from __future__ import annotations

from pathlib import Path

import pytest

# backend/tests/test_readme_wire_integration.py -> backend/tests/ -> backend/
README = Path(__file__).resolve().parents[1] / "README.md"


def _load() -> str:
    if not README.exists():
        pytest.fail(f"README 不存在：{README}")
    return README.read_text(encoding="utf-8")


def test_readme_documents_wire_schema_integration_section() -> None:
    """AC1：README 含 ghcr wire schema 集成测试段——测试路径 + env 三件套 + ghcr 镜像。

    真值源：chat/tests/test_integration_wire.py 实际路径、ci.yml integration job env、
    test 文件 _WIRE_IMAGE 默认 ghcr 镜像。env 名/路径/镜像取自代码现实，非措辞断言。
    """
    text = _load()
    assert "chat/tests/test_integration_wire.py" in text, "README 未指向 wire schema 集成测试文件"
    for env_var in ("OPENCLAW_IMAGE", "OPENCLAW_TEMPLATE_DIR", "LLM_API_KEY"):
        assert env_var in text, f"README 未列出 wire 集成测试 env：{env_var}"
    assert "ghcr.io/openclaw" in text, "README 未说明 ghcr 官方镜像"


def test_readme_documents_integration_marker_gate() -> None:
    """AC3：README 说明门控用 ``-m "integration"`` marker（非 RUN_INTEGRATION env）。

    真值源：pyproject 注册的 ``integration`` marker + ci.yml 双轨（backend-unit 排除 /
    integration job 真跑）+ test_integration_wire.py 的 ``pytestmark =
    pytest.mark.integration``（无 skip、env 缺失直接 fail）。issue #155 spec 原设想
    ``skipif(not RUN_INTEGRATION)`` 已被 #157 重构为 marker 门控，README 须反映现实。
    """
    text = _load()
    assert '-m "integration"' in text, "README 未说明 integration marker 门控命令"
    assert "RUN_INTEGRATION" not in text or "marker" in text, (
        "README 提到 RUN_INTEGRATION 须同时说明 marker 门控（现实已弃用 RUN_INTEGRATION）"
    )
