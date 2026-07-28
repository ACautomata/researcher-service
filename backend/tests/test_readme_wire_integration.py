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
_WIRE_SECTION_HEADER = "### chat wire schema 集成测试"
_SMOKE_SECTION_HEADER = "### integration smoke"


def _load() -> str:
    if not README.exists():
        pytest.fail(f"README 不存在：{README}")
    return README.read_text(encoding="utf-8")


def _extract_section(text: str, header: str) -> str:
    """提取 ``header`` 起的 markdown 子段（到下一 ``#`` 标题或文末），尊重 ``` 代码栅栏。

    全 README 子串搜 env 名会被容器 smoke 段的同名 env 蒙混（codex #170 P2 假阴性）；
    本助手把断言限定到目标子段内，删段内 env 表即被检出。栅栏内的 ``#`` 注释不算标题。
    """
    start = text.find(header)
    assert start != -1, f"README 缺少段标题：{header!r}"
    lines = text[start:].split("\n")
    out = [lines[0]]
    in_fence = False
    for line in lines[1:]:
        if line.strip().startswith("```"):
            in_fence = not in_fence
            out.append(line)
            continue
        if not in_fence and line.startswith("#"):
            break
        out.append(line)
    return "\n".join(out)


def test_readme_documents_wire_schema_integration_section() -> None:
    """AC1：README 含 ghcr wire schema 集成测试段——测试路径 + env 三件套 + ghcr 镜像。

    断言限定在 wire 子段内（codex #170 P2）：容器 smoke 段与配置表已含同名 env，
    全 README 搜会假阴性（删 wire env 表仍 green）。真值源：chat/tests/test_integration_wire.py
    实际路径、ci.yml integration job env、test 文件 _WIRE_IMAGE 默认 ghcr 镜像。
    """
    section = _extract_section(_load(), _WIRE_SECTION_HEADER)
    assert "chat/tests/test_integration_wire.py" in section, "wire 段未指向 wire schema 集成测试文件"
    for env_var in ("OPENCLAW_IMAGE", "OPENCLAW_TEMPLATE_DIR", "LLM_API_KEY"):
        assert env_var in section, f"wire 段未列出 wire 集成测试 env：{env_var}"
    assert "ghcr.io/openclaw" in section, "wire 段未说明 ghcr 官方镜像"


def test_wire_section_assertions_catch_env_table_deletion() -> None:
    """回归（codex #170 P2）：删 wire 段 env 表须被段内断言检出。

    旧实现搜全 README：容器 smoke 段（#94）已含三件套 env 名 → 删 wire env 表仍 green（假阴性）。
    新实现把断言限定在 wire 子段 → 段内不再含三件套 env → red。构造退化 README（wire 段截到
    env 表前，保留引子里的 path/ghcr）证明段内断言有牙：前置假阴性条件成立，段内断言仍检出。
    """
    real = _load()
    start = real.index(_WIRE_SECTION_HEADER)
    rest = real[start:]
    env_table = rest.find("**env 三件套**")
    assert env_table != -1, "wire 段缺少 env 三件套表锚点"
    degenerate = real[:start] + rest[:env_table]  # 截断 wire 段 env 表 + 本地跑说明
    # 前置：退化 README 仍含引子 path/ghcr + 容器 smoke 段的三件套 env —— 假阴性条件成立
    assert "chat/tests/test_integration_wire.py" in degenerate
    assert "ghcr.io/openclaw" in degenerate
    assert all(v in degenerate for v in ("OPENCLAW_IMAGE", "OPENCLAW_TEMPLATE_DIR", "LLM_API_KEY"))
    # 段内断言必须检出：wire 子段内不应再含三件套 env（env 表已被截掉）
    section = _extract_section(degenerate, _WIRE_SECTION_HEADER)
    assert not all(v in section for v in ("OPENCLAW_IMAGE", "OPENCLAW_TEMPLATE_DIR", "LLM_API_KEY")), (
        "wire 段内断言未检出 env 表被删"
    )


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


def test_readme_container_smoke_gate_matches_code() -> None:
    """回归（codex #170 P2）：README 容器 smoke 段门控描述须与代码现实一致。

    真值源：``containers/tests/test_integration.py`` 的 ``pytestmark = pytest.mark.integration``
    （无 skip、env 缺失直接 fail，issue #157 重构自旧 daemon 探测+skip）。README 不得再声称
    该测试用 ``DockerDaemonProbe`` daemon 探测门控或「无则 skip」——那是 #157 前的旧行为，
    与现实相反，会误导本地/CI 跑测者。``DockerDaemonProbe`` 类仍残留在 integration_helpers，
    但 ``containers/tests/test_integration.py`` 已不再引用它（仅 import ApprovalPairer 等 helper）。
    """
    text = _load()
    assert "DockerDaemonProbe" not in text, (
        "README 仍引用已弃用的 DockerDaemonProbe 门控（#94 smoke 实际用 integration marker）"
    )
    smoke_section = _extract_section(text, _SMOKE_SECTION_HEADER)
    assert "pytest.mark.integration" in smoke_section, (
        "容器 smoke 段未说明 integration marker 门控机制（与现实代码一致）"
    )
