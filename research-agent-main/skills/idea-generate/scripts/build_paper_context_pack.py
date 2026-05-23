#!/usr/bin/env python3
"""Build a paper context pack from a local paper/ directory."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


SUPPORTED_EXTS = {".pdf", ".txt", ".md", ".markdown", ".docx"}
KEYWORD_GROUPS = {
    "abstract": ["abstract"],
    "limitation": ["limitation", "limitations", "limited", "weakness", "drawback", "challenge"],
    "future_work": ["future work", "future direction", "future research", "remain", "open problem"],
    "conclusion": ["conclusion", "conclusions"],
    "method": ["method", "methods", "approach", "framework", "model"],
    "experiment": ["experiment", "experiments", "evaluation", "metric", "results"],
}


@dataclass
class Snippet:
    kind: str
    keyword: str
    text: str


def read_text_file(path: Path) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "latin-1"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return path.read_text(errors="replace")


def read_pdf(path: Path, max_pages: int) -> str:
    try:
        from pypdf import PdfReader
    except Exception as exc:  # pragma: no cover - depends on env
        return f"[PDF extraction unavailable: {exc}]"

    reader = PdfReader(str(path))
    pages = []
    for page in reader.pages[:max_pages]:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            pages.append("")
    return "\n".join(pages)


def read_docx(path: Path) -> str:
    try:
        from docx import Document
    except Exception as exc:  # pragma: no cover - depends on env
        return f"[DOCX extraction unavailable: {exc}]"

    doc = Document(str(path))
    return "\n".join(p.text for p in doc.paragraphs if p.text.strip())


def extract_text(path: Path, max_pages: int) -> str:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return read_pdf(path, max_pages)
    if ext == ".docx":
        return read_docx(path)
    return read_text_file(path)


def normalize_space(text: str) -> str:
    text = text.replace("\x00", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def window_around(text: str, start: int, window: int) -> str:
    left = max(0, start - window)
    right = min(len(text), start + window)
    snippet = text[left:right]
    return normalize_space(snippet)


def find_snippets(text: str, per_kind: int, window: int) -> list[Snippet]:
    lower = text.lower()
    snippets: list[Snippet] = []
    seen: set[tuple[str, int]] = set()
    for kind, keywords in KEYWORD_GROUPS.items():
        found = 0
        for keyword in keywords:
            if found >= per_kind:
                break
            for match in re.finditer(re.escape(keyword.lower()), lower):
                bucket = match.start() // max(window, 1)
                key = (kind, bucket)
                if key in seen:
                    continue
                seen.add(key)
                snippets.append(Snippet(kind, keyword, window_around(text, match.start(), window)))
                found += 1
                if found >= per_kind:
                    break
    if not snippets and text:
        snippets.append(Snippet("overview", "head", normalize_space(text[: window * 2])))
    return snippets


def short_title(path: Path, text: str) -> str:
    for line in text.splitlines()[:20]:
        stripped = line.strip(" #\t")
        if 12 <= len(stripped) <= 180 and not stripped.lower().startswith(("abstract", "introduction")):
            return stripped
    return path.stem.replace("_", " ").replace("-", " ")


def collect_papers(paper_dir: Path, max_papers: int) -> list[Path]:
    files = [
        p
        for p in paper_dir.rglob("*")
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS and not p.name.startswith("~$")
    ]
    files.sort(key=lambda p: str(p).lower())
    return files[:max_papers]


def write_markdown(context: dict, out_path: Path) -> None:
    lines = [
        "# Paper Context Pack",
        "",
        f"Topic: {context['topic']}",
        f"Generated at: {context['generated_at']}",
        f"Paper count: {len(context['papers'])}",
        "",
        "## Papers",
        "",
    ]
    for paper in context["papers"]:
        lines.extend(
            [
                f"### {paper['paper_id']}: {paper['title']}",
                "",
                f"- Path: `{paper['path']}`",
                f"- Characters extracted: {paper['char_count']}",
                "",
                "Key snippets:",
                "",
            ]
        )
        for snippet in paper["snippets"]:
            lines.extend(
                [
                    f"- Kind: `{snippet['kind']}`; keyword: `{snippet['keyword']}`",
                    "",
                    f"  {snippet['text']}",
                    "",
                ]
            )
    out_path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build context pack from paper folder.")
    parser.add_argument("--paper-dir", default="paper", help="Folder containing papers.")
    parser.add_argument("--topic", default="", help="Research topic for the run.")
    parser.add_argument("--out", required=True, help="Output run directory.")
    parser.add_argument("--max-papers", type=int, default=20)
    parser.add_argument("--max-pages", type=int, default=20)
    parser.add_argument("--max-chars-per-paper", type=int, default=60000)
    parser.add_argument("--snippets-per-kind", type=int, default=2)
    parser.add_argument("--snippet-window", type=int, default=900)
    args = parser.parse_args()

    paper_dir = Path(args.paper_dir)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not paper_dir.exists():
        raise SystemExit(f"Paper folder not found: {paper_dir}")

    papers = []
    for index, path in enumerate(collect_papers(paper_dir, args.max_papers), 1):
        text = normalize_space(extract_text(path, args.max_pages))[: args.max_chars_per_paper]
        snippets = find_snippets(text, args.snippets_per_kind, args.snippet_window)
        papers.append(
            {
                "paper_id": f"P{index:02d}",
                "path": str(path),
                "title": short_title(path, text),
                "char_count": len(text),
                "snippets": [s.__dict__ for s in snippets],
            }
        )

    context = {
        "topic": args.topic or "ASSUMPTION: infer topic from papers",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "paper_dir": str(paper_dir),
        "papers": papers,
    }

    (out_dir / "paper-context.json").write_text(
        json.dumps(context, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_markdown(context, out_dir / "paper-context.md")
    print(f"Wrote context for {len(papers)} papers to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
