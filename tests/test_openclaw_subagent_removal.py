"""issue #20 删除子 agent 的接缝测试。

唯一可测接缝 = 路由是否仍暴露子 agent 端点 + 仓库内无残留引用 + 前端导航收敛。
- paper-review 路由、GET /openclaw/agents 应已删除（404）。
- 前端 3 个子 agent 页面文件与旧 openclaw.js 应删除；index.html 无其 script 引用。
- openclaw_shared.js 的 OC_AGENTS 仅含 main；core.js 导航无 oc-autoresearch/oc-review/oc-idea。
- 全仓 grep 无 autoresearch / paper-review / idea-generate（保留的 Claude agent.py 不受影响）。
"""
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.asyncio
async def test_paper_review_route_removed(openclaw_route):
    client, _, _ = openclaw_route
    r = await client.post("/api/v1/openclaw/paper-review", json={"message": "x"})
    # 路由已删 → 非 2xx（FastAPI 对已删路径返回 404，或对残留通配返回 405）
    assert r.status_code in (404, 405), f"paper-review 路由应删除，实际: {r.status_code}"


@pytest.mark.asyncio
async def test_paper_review_progress_route_removed(openclaw_route):
    client, _, _ = openclaw_route
    r = await client.get("/api/v1/openclaw/paper-review/tid-x/progress")
    assert r.status_code in (404, 405), f"paper-review 进度路由应删除，实际: {r.status_code}"


@pytest.mark.asyncio
async def test_agents_route_removed(openclaw_route):
    client, _, _ = openclaw_route
    r = await client.get("/api/v1/openclaw/agents")
    assert r.status_code == 404, f"GET /openclaw/agents 应删除，实际: {r.status_code}"


def test_subagent_page_files_deleted():
    pages = REPO_ROOT / "public" / "js" / "pages"
    for f in ("openclaw_autoresearch.js", "openclaw_review.js", "openclaw_idea.js", "openclaw.js"):
        assert not (pages / f).exists(), f"{f} 应删除"


def test_index_html_has_no_subagent_script_refs():
    html = (REPO_ROOT / "public" / "index.html").read_text(encoding="utf-8")
    for f in ("openclaw_autoresearch.js", "openclaw_review.js", "openclaw_idea.js", "openclaw.js"):
        assert f'pages/{f}' not in html, f"index.html 不应再引用 {f}"


def test_oc_agents_only_main():
    shared = (REPO_ROOT / "public" / "js" / "pages" / "openclaw_shared.js").read_text(encoding="utf-8")
    m = re.search(r"OC_AGENTS\s*=\s*\{(.*?)\n\};", shared, re.DOTALL)
    assert m, "未找到 OC_AGENTS 定义"
    body = m.group(1)
    assert "'main'" in body
    for removed in ("autoresearch", "paper-review", "idea-generate"):
        assert removed not in body, f"OC_AGENTS 不应再含 {removed}"


def test_core_nav_has_no_subagent_entries():
    core = (REPO_ROOT / "public" / "js" / "core.js").read_text(encoding="utf-8")
    for nav in ("oc-autoresearch", "oc-review", "oc-idea"):
        assert f"id: '{nav}'" not in core, f"core.js 导航不应再含 {nav}"


def test_no_residual_subagent_references_in_repo():
    """全仓 grep（代码与前端）无 autoresearch / paper-review / idea-generate 残留。

    保留的 Claude Agent SDK 本就 不含这些标识。`routes/idea.py` 的 `idea_generate`
    函数是 idea 模块（pipeline /idea/generate）自身功能，与 OpenClaw 的 idea-generate
    子 agent 无关，明确排除（issue #20：保留的 Claude agent.py 不受影响）。
    docs/ 与 .remember/ 为历史记录，不在收敛范围。
    """
    pattern = re.compile(r"autoresearch|paper-review|paper_review|idea-generate|idea_generate", re.IGNORECASE)
    # 文件级豁免：routes/idea.py 的 idea_generate 是 idea 模块（pipeline /idea/generate）
    # 自身功能，与 OpenClaw 的 idea-generate 子 agent 无关（issue #20：保留的 Claude
    # agent.py 不受影响）。其余文件（含 routes/openclaw.py、wiki.js）在 #20/#21/#22 后须零残留。
    exempt_files = {"routes/idea.py"}
    scan_roots = ["routes", "services", "public", "main.py", "config.py"]
    offenders = []
    for root in scan_roots:
        p = REPO_ROOT / root
        files = [p] if p.is_file() else [f for f in p.rglob("*") if f.suffix in (".py", ".js", ".html")]
        for f in files:
            rel = str(f.relative_to(REPO_ROOT))
            if rel in exempt_files:
                continue
            text = f.read_text(encoding="utf-8", errors="ignore")
            for i, line in enumerate(text.splitlines(), 1):
                if pattern.search(line):
                    offenders.append(f"{rel}:{i}: {line.strip()[:80]}")
    assert not offenders, "存在子 agent 残留引用:\n" + "\n".join(offenders)
