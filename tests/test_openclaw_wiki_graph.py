"""issue #46 wiki 图谱后端端点接缝测试。

接缝 = FastAPI 路由 GET /openclaw/wiki/graph。用临时 wiki/main 骨架
（wiki_fixtures.build_wiki_skeleton，含跨类型 wikilink、别名 wikilink、悬空链接、
frontmatter related/source_pages）。断言：
- 节点覆盖全库页面，id 用 kind/pageId 复合键（与前端 openWikiPaper 一致）。
- 正文 [[wikilink]] 出边（type=wikilink），别名 [[target|alias]] 归一到 target。
- frontmatter related / source_pages 出对应类型边。
- 解析不到目标的 wikilink 归为悬空（dangling），不产生幻觉节点。
- 空骨架返回空 nodes/edges，不报错。
"""
import pytest


def _graph(res):
    return {n["id"]: n for n in res["nodes"]}, res["edges"]


def _edge_set(edges):
    return {(e["from"], e["to"], e["type"]) for e in edges}


@pytest.mark.asyncio
async def test_graph_returns_all_pages_as_nodes(openclaw_wiki):
    """节点 = 全库页面，id 为 kind/pageId 复合键，带 kind/title/pageId 供渲染与点击开文件。"""
    client, _ = openclaw_wiki
    r = await client.get("/api/v1/openclaw/wiki/graph")
    assert r.status_code == 200, r.text
    res = r.json()
    assert "nodes" in res and "edges" in res

    nodes, _ = _graph(res)
    # 三篇真实页（concept + 两篇 domain 论文），占位 index.md 不当节点
    assert "concept/concept.example-topic" in nodes
    assert "domain/ml/attention-survey" in nodes
    assert "domain/ml/transformer-variants" in nodes
    assert not any(nid.endswith("/index") or nid == "index" for nid in nodes)

    # 节点带渲染/点击所需字段
    concept = nodes["concept/concept.example-topic"]
    assert concept["kind"] == "concept"
    assert concept["pageId"] == "concept.example-topic"
    assert concept["title"] == "Example Topic"


@pytest.mark.asyncio
async def test_graph_wikilink_edges(openclaw_wiki):
    """正文 [[wikilink]] 出 wikilink 边；别名 [[target|alias]] 归一到 target。"""
    client, _ = openclaw_wiki
    res = (await client.get("/api/v1/openclaw/wiki/graph")).json()
    _, edges = _graph(res)
    es = _edge_set(edges)

    # attention-survey 正文 [[concept.example-topic]]
    assert ("domain/ml/attention-survey", "concept/concept.example-topic", "wikilink") in es
    # transformer-variants 别名 [[concept.example-topic|示例概念]] 归一到 target
    assert ("domain/ml/transformer-variants", "concept/concept.example-topic", "wikilink") in es
    # transformer-variants 正文 [[attention-survey]] → domain 页
    assert ("domain/ml/transformer-variants", "domain/ml/attention-survey", "wikilink") in es


@pytest.mark.asyncio
async def test_graph_frontmatter_edges(openclaw_wiki):
    """frontmatter related / source_pages 出对应类型边。"""
    client, _ = openclaw_wiki
    res = (await client.get("/api/v1/openclaw/wiki/graph")).json()
    _, edges = _graph(res)
    es = _edge_set(edges)

    # attention-survey frontmatter related: [concept.example-topic]
    assert ("domain/ml/attention-survey", "concept/concept.example-topic", "related") in es
    # concept frontmatter source_pages: [attention-survey] → 解析到 domain 论文页
    assert ("concept/concept.example-topic", "domain/ml/attention-survey", "source_pages") in es


@pytest.mark.asyncio
async def test_graph_dangling_wikilink(openclaw_wiki):
    """解析不到目标的 wikilink 归为 dangling 节点（ghost），不产生幻觉页面节点。

    concept 正文含 [[不存在的页]] 与 [[Example Topic|自身别名]]（别名 target=自身 title → 自环）。
    """
    client, _ = openclaw_wiki
    res = (await client.get("/api/v1/openclaw/wiki/graph")).json()
    nodes, edges = _graph(res)
    es = _edge_set(edges)

    # 悬空节点以 dangling 标记存在，边连过去（前端可渲染为 ghost）
    dangling_ids = {nid for nid, n in nodes.items() if n.get("dangling")}
    assert any("不存在的页" in d for d in dangling_ids)
    assert ("concept/concept.example-topic", next(d for d in dangling_ids if "不存在的页" in d), "wikilink") in es

    # 别名 [[Example Topic|自身别名]]：target 是 title，归一到 concept 页自身（自环）
    assert ("concept/concept.example-topic", "concept/concept.example-topic", "wikilink") in es


@pytest.mark.asyncio
async def test_graph_edges_only_reference_known_or_dangling(openclaw_wiki):
    """所有边的两端都在 nodes 里（真实页或 dangling），无悬空 id 引用。"""
    client, _ = openclaw_wiki
    res = (await client.get("/api/v1/openclaw/wiki/graph")).json()
    nodes, edges = _graph(res)
    for e in edges:
        assert e["from"] in nodes, f"边 from 无对应节点: {e}"
        assert e["to"] in nodes, f"边 to 无对应节点: {e}"


@pytest.mark.asyncio
async def test_graph_empty_skeleton(openclaw_wiki_empty):
    """0-pages 空骨架返回空 nodes/edges，不报错。"""
    client, _ = openclaw_wiki_empty
    r = await client.get("/api/v1/openclaw/wiki/graph")
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["nodes"] == []
    assert res["edges"] == []


def test_frontmatter_block_list_parsed():
    """块式 YAML 列表（ingest 对 source_pages/related_pages 的真实写法）能被解析为 list。"""
    import routes.openclaw as rc
    md = "---\ntitle: T\nsource_pages:\n  - wiki/domains/ml/papers/a.md\n  - wiki/domains/ml/papers/b.md\nrelated_pages:\n  - wiki/concepts/c.md\n---\n\n正文\n"
    fm, body = rc._parse_frontmatter(md)
    assert fm["source_pages"] == ["wiki/domains/ml/papers/a.md", "wiki/domains/ml/papers/b.md"]
    assert fm["related_pages"] == ["wiki/concepts/c.md"]
    assert body == "正文"


def test_graph_normalize_ref_strips_vault_path():
    """source_pages/related_pages 的 vault 全路径归一化为 slug 末段。"""
    import routes.openclaw as rc
    assert rc._graph_normalize_ref("wiki/domains/ml/papers/attention-survey.md") == "attention-survey"
    assert rc._graph_normalize_ref("wiki/concepts/concept.example-topic.md") == "concept.example-topic"
    assert rc._graph_normalize_ref("attention-survey") == "attention-survey"
    assert rc._graph_normalize_ref('"ml/attention-survey"') == "attention-survey"
