#!/usr/bin/env python3
"""Deduplicate draft idea cards."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def norm(value: object) -> str:
    return " ".join(str(value or "").lower().split())


def key_for(idea: dict) -> tuple[str, str, str]:
    return (
        norm(idea.get("title")),
        norm(idea.get("mechanism")),
        norm(idea.get("minimum_experiment")),
    )


def evidence_len(idea: dict) -> int:
    evidence = idea.get("evidence_chain", [])
    if isinstance(evidence, list):
        return sum(len(str(x)) for x in evidence)
    return len(str(evidence or ""))


def dedup(ideas: list[dict]) -> list[dict]:
    by_key: dict[tuple[str, str, str], dict] = {}
    for idea in ideas:
        key = key_for(idea)
        if key not in by_key or evidence_len(idea) > evidence_len(by_key[key]):
            by_key[key] = idea
    return list(by_key.values())


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: idea_dedup.py <draft-ideas.json> <ideas.dedup.json>", file=sys.stderr)
        return 2
    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    ideas = json.loads(input_path.read_text(encoding="utf-8-sig"))
    if not isinstance(ideas, list):
        print("Input must be a JSON array.", file=sys.stderr)
        return 2
    result = dedup([idea for idea in ideas if isinstance(idea, dict)])
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(result)} deduplicated ideas to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
