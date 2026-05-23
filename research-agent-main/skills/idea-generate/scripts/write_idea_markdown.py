#!/usr/bin/env python3
"""Render recommended idea cards to Markdown."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def as_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    return [str(value)]


def sort_ideas(ideas: list[dict]) -> list[dict]:
    def score(idea: dict) -> float:
        for key in ("overall_score", "score", "priority"):
            try:
                return float(idea.get(key))
            except Exception:
                continue
        return 0.0

    return sorted(ideas, key=score, reverse=True)


def paper_list(context: dict | None) -> list[str]:
    if not context:
        return []
    papers = context.get("papers", [])
    if not isinstance(papers, list):
        return []
    return [f"- {p.get('paper_id', '?')}: {p.get('title', 'Untitled')} (`{p.get('path', '')}`)" for p in papers]


def collect_open_questions(ideas: list[dict], context: dict | None) -> list[str]:
    questions: list[str] = []
    if context:
        questions.extend(as_list(context.get("open_questions")))
        questions.extend(as_list(context.get("assumptions")))
    for idea in ideas:
        questions.extend(as_list(idea.get("open_questions")))
        assumptions = idea.get("assumptions")
        for assumption in as_list(assumptions):
            questions.append(f"Assumption to verify for {idea.get('idea_id', 'idea')}: {assumption}")
    seen: set[str] = set()
    deduped: list[str] = []
    for question in questions:
        normalized = " ".join(question.split()).lower()
        if normalized and normalized not in seen:
            seen.add(normalized)
            deduped.append(question)
    return deduped


def render(ideas: list[dict], context: dict | None, analysis: str, top_n: int) -> str:
    topic = context.get("topic", "") if context else ""
    selected = sort_ideas(ideas)[:top_n]
    lines = ["# Recommended Research Ideas", ""]
    if topic:
        lines.extend(["## Topic", "", topic, ""])
    if analysis.strip():
        lines.extend(["## Paper Analysis Summary", "", analysis.strip(), ""])
    papers = paper_list(context)
    if papers:
        lines.extend(["## Processed Papers", "", *papers, ""])
    if not analysis.strip():
        lines.extend(["## Paper Analysis Summary", "", "The recommended ideas below are grounded in the extracted paper snippets, especially limitations, future-work signals, method descriptions, and evaluation notes.", ""])
    lines.extend(["## Recommended Ideas", ""])
    for idx, idea in enumerate(selected, 1):
        lines.extend(
            [
                f"### {idx}. {idea.get('title', 'Untitled Idea')}",
                "",
                f"**Hypothesis:** {idea.get('one_sentence_hypothesis', '')}",
                "",
                f"**Paper insight / limitation addressed:** {idea.get('paper_insight_or_limitation', '')}",
                "",
                f"**Proposed improvement:** {idea.get('mechanism', '')}",
                "",
                "**Evidence chain:**",
                "",
            ]
        )
        evidence = as_list(idea.get("evidence_chain"))
        lines.extend([f"- {item}" for item in evidence] or ["- low-confidence: evidence not specified"])
        lines.extend(
            [
                "",
                f"**Minimum validation experiment:** {idea.get('minimum_experiment', '')}",
                "",
                f"**Expected metric change:** {idea.get('expected_metric_change', '')}",
                "",
                f"**Implementation scope:** {idea.get('implementation_scope', '')}",
                "",
                f"**Risks:** {idea.get('risks', '')}",
                "",
                f"**Confidence:** {idea.get('confidence', '')}",
                "",
                f"**Recommendation reason:** {idea.get('recommendation_reason', '')}",
                "",
            ]
        )
    open_questions = collect_open_questions(selected, context)
    if open_questions:
        lines.extend(["## Open Questions", "", *[f"- {item}" for item in open_questions], ""])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Write recommended ideas Markdown.")
    parser.add_argument("ideas_json")
    parser.add_argument("output_md")
    parser.add_argument("--context", default="")
    parser.add_argument("--analysis", default="")
    parser.add_argument("--top-n", type=int, default=5)
    args = parser.parse_args()

    ideas = load_json(Path(args.ideas_json))
    if not isinstance(ideas, list):
        raise SystemExit("ideas_json must contain a JSON array")
    context = load_json(Path(args.context)) if args.context else None
    if context is not None and not isinstance(context, dict):
        raise SystemExit("context must contain a JSON object")
    analysis = Path(args.analysis).read_text(encoding="utf-8-sig") if args.analysis else ""
    output = render([idea for idea in ideas if isinstance(idea, dict)], context, analysis, args.top_n)
    Path(args.output_md).write_text(output, encoding="utf-8")
    print(f"Wrote {args.output_md}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
