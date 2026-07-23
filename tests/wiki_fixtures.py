"""构造 researcher wiki/main 骨架的测试工具（issue #21）。

布局依据 docs/research/r7-wiki-read-mechanism.md：五核心目录（concepts/entities/
sources/syntheses/reports）+ domains/<domain>/papers/ 子树 + 顶层 index.md（含
openclaw:wiki:index 生成块）+ 插件私有 .openclaw-wiki/ 与 _attachments/_views。
"""
from pathlib import Path

INDEX_MD = """# Wiki Index

## Generated
<!-- openclaw:wiki:index:start -->
- Render mode: `obsidian`
- Total pages: 2
- Claims: 1
- Sources: 0 / Entities: 0 / Concepts: 1 / Syntheses: 0 / Reports: 0
<!-- openclaw:wiki:index:end -->
"""

EMPTY_INDEX_MD = """# Wiki Index

## Generated
<!-- openclaw:wiki:index:start -->
- Render mode: `obsidian`
- Total pages: 0
- Claims: 0
- Sources: 0 / Entities: 0 / Concepts: 0 / Syntheses: 0 / Reports: 0
<!-- openclaw:wiki:index:end -->
"""

CATEGORY_INDEX = """# {Title}

<!-- openclaw:wiki:{kind}:index:start -->
- No {kind} yet.
<!-- openclaw:wiki:{kind}:index:end -->
"""

# researcher 论文页（schema B：type/domain/paper.*/evidence_level，平铺点号键）
PAPER_MD = """---
title: Attention Survey
type: paper
domain: ml
status: active
created: 2024-01-01
updated: 2024-06-01
paper.title: Attention Survey
paper.authors: [Alice, Bob]
paper.year: 2024
paper.venue: NeurIPS
paper.arxiv: "2401.00001"
paper.doi: "10.0000/xyz"
evidence_level: full-paper
---

# Attention Survey

正文：Transformer 注意力机制综述。参见 [[concept.example-topic]]。
"""

# 插件官方 schema（schema A：pageType/id/title/status）
CONCEPT_MD = """---
pageType: concept
id: concept.example-topic
title: "Example Topic"
status: active
updatedAt: "2026-04-14T10:00:00.000Z"
---

# Example Topic

一个抽象概念页。
"""


def build_wiki_skeleton(root: Path, empty: bool = False) -> Path:
    """在 root 下构造 wiki/main 骨架，返回 wiki 根目录路径。

    empty=True 时只建空骨架（各分类仅 index.md 占位），用于 0-pages 容错测试。
    """
    wiki = root / "wiki" / "main"
    wiki.mkdir(parents=True, exist_ok=True)

    (wiki / "index.md").write_text(EMPTY_INDEX_MD if empty else INDEX_MD, encoding="utf-8")

    # 五核心目录各放 index.md 占位
    for kind in ("concepts", "entities", "sources", "syntheses", "reports"):
        d = wiki / kind
        d.mkdir(exist_ok=True)
        (d / "index.md").write_text(
            CATEGORY_INDEX.format(Title=kind.title(), kind=kind), encoding="utf-8"
        )

    # 插件私有目录 + 下划线目录（应被跳过）
    (wiki / ".openclaw-wiki").mkdir(exist_ok=True)
    (wiki / ".openclaw-wiki" / "state.json").write_text("{}", encoding="utf-8")
    (wiki / "_attachments").mkdir(exist_ok=True)
    (wiki / "_views").mkdir(exist_ok=True)

    if not empty:
        # 一个 concept 页面（插件官方 schema）
        (wiki / "concepts" / "concept.example-topic.md").write_text(CONCEPT_MD, encoding="utf-8")
        # 一个 domain 论文页（researcher schema）
        papers = wiki / "domains" / "ml" / "papers"
        papers.mkdir(parents=True, exist_ok=True)
        (papers / "attention-survey.md").write_text(PAPER_MD, encoding="utf-8")

    return wiki
