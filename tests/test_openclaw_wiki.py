"""issue #21 Wiki 页适配 researcher wiki/main 的接缝测试。

接缝 = FastAPI 路由 GET/PUT /openclaw/wiki*。用临时目录构造 wiki/main 骨架
（index.md 含 openclaw:wiki:index 生成块 + 五核心分类 + domains 子树 + 双 schema frontmatter）。
断言：
- GET /openclaw/wiki 按分类列出页面（五核心分类 + domains），跳过 .openclaw-wiki/_attachments/_views。
- 容忍 0-pages 空骨架。
- GET 单页解析双 schema frontmatter（插件官方 pageType + researcher paper.*）。
- PUT 只覆盖已存在页面，不新建；不动 index.md 生成块。
"""
import pytest

from tests.wiki_fixtures import build_wiki_skeleton


def _groups_by_kind(res):
    return {g["kind"]: g for g in res["groups"]}


@pytest.mark.asyncio
async def test_wiki_list_groups_five_core_categories(openclaw_wiki):
    client, wiki_root = openclaw_wiki
    r = await client.get("/api/v1/openclaw/wiki")
    assert r.status_code == 200, r.text
    res = r.json()

    groups = _groups_by_kind(res)
    # 五核心分类都在（有页面才出分组；空分类可缺）
    assert "concept" in groups
    concept_pages = groups["concept"]["pages"]
    assert any(p["id"] == "concept.example-topic" for p in concept_pages)


@pytest.mark.asyncio
async def test_wiki_list_includes_domain_papers(openclaw_wiki):
    """researcher 论文页落 domains/<domain>/papers/，按 domain 分组列出。"""
    client, _ = openclaw_wiki
    res = (await client.get("/api/v1/openclaw/wiki")).json()
    groups = _groups_by_kind(res)
    assert "domain" in groups
    names = {p["id"] for p in groups["domain"]["pages"]}
    assert any("attention-survey" in n for n in names)


@pytest.mark.asyncio
async def test_wiki_list_skips_plugin_private_and_underscore_dirs(openclaw_wiki):
    """跳过 .openclaw-wiki/（插件私有）、_attachments/、_views/、各目录 index.md 占位。"""
    client, _ = openclaw_wiki
    res = (await client.get("/api/v1/openclaw/wiki")).json()
    all_ids = [p["id"] for g in res["groups"] for p in g["pages"]]
    for pid in all_ids:
        assert ".openclaw-wiki" not in pid
        assert "_attachments" not in pid and "_views" not in pid
        assert pid != "index", "index.md 占位不应当作普通页"


@pytest.mark.asyncio
async def test_wiki_list_tolerates_empty_skeleton(openclaw_wiki_empty):
    """0-pages 空骨架（index 块为 - No concepts yet.）不报错，groups 为空。"""
    client, _ = openclaw_wiki_empty
    r = await client.get("/api/v1/openclaw/wiki")
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["groups"] == []
    assert "index" in res  # index.md 仍单独返回


@pytest.mark.asyncio
async def test_wiki_get_paper_parses_dual_schema_frontmatter(openclaw_wiki):
    """单页 frontmatter 兼容双 schema：researcher paper.* 与插件官方 pageType/title。"""
    client, _ = openclaw_wiki
    r = await client.get("/api/v1/openclaw/wiki/domain/ml/attention-survey")
    assert r.status_code == 200, r.text
    fm = r.json()["frontmatter"]
    # researcher 论文页 schema（与 wiki.js 渲染同名字段）
    assert fm.get("paper.title") == "Attention Survey"
    assert fm.get("paper.year") == "2024"
    assert fm.get("evidence_level") == "full-paper"


@pytest.mark.asyncio
async def test_wiki_get_concept_parses_plugin_schema(openclaw_wiki):
    """插件官方 schema（pageType/id/title/status）也能解析。"""
    client, _ = openclaw_wiki
    r = await client.get("/api/v1/openclaw/wiki/concept/_/concept.example-topic")
    assert r.status_code == 200, r.text
    fm = r.json()["frontmatter"]
    assert fm.get("pageType") == "concept"
    assert fm.get("title") == "Example Topic"


@pytest.mark.asyncio
async def test_wiki_get_missing_page_404(openclaw_wiki):
    client, _ = openclaw_wiki
    r = await client.get("/api/v1/openclaw/wiki/domain/ml/nonexistent")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_wiki_put_overwrites_existing_only(openclaw_wiki):
    """PUT 只覆盖已存在页面；对新页面返回 404（不新建，避免破坏插件索引约定）。"""
    client, wiki_root = openclaw_wiki
    target = wiki_root / "domains" / "ml" / "papers" / "attention-survey.md"
    new_content = "---\ntitle: Attention Survey\n---\n\n已编辑正文\n"

    r = await client.put(
        "/api/v1/openclaw/wiki/domain/ml/attention-survey",
        json={"content": new_content},
    )
    assert r.status_code == 200, r.text
    assert target.read_text(encoding="utf-8") == new_content

    # 不存在的页面 → 404，不新建
    r2 = await client.put(
        "/api/v1/openclaw/wiki/domain/ml/brand-new-page",
        json={"content": "x"},
    )
    assert r2.status_code == 404
    assert not (wiki_root / "domains" / "ml" / "papers" / "brand-new-page.md").exists()


@pytest.mark.asyncio
async def test_wiki_put_does_not_touch_index_generated_block(openclaw_wiki):
    """PUT 不针对 index.md 的 openclaw:wiki:* 生成块（拒绝写 index，保护插件 managed 区）。"""
    client, wiki_root = openclaw_wiki
    index_path = wiki_root / "index.md"
    before = index_path.read_text(encoding="utf-8")

    # 尝试写 index（任何一种 kind/name 指向 index）应被拒绝或不影响生成块
    r = await client.put("/api/v1/openclaw/wiki/concept/_/index", json={"content": " hacked "})
    assert r.status_code in (400, 404), "不应允许覆写 index.md"
    assert index_path.read_text(encoding="utf-8") == before
    assert "<!-- openclaw:wiki:index:start -->" in before
