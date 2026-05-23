#!/usr/bin/env python3
"""Validate idea card JSON for the paper demo."""

from __future__ import annotations

import json
import sys
from pathlib import Path


REQUIRED_FIELDS = [
    "idea_id",
    "title",
    "one_sentence_hypothesis",
    "target_problem",
    "mechanism",
    "paper_insight_or_limitation",
    "evidence_chain",
    "minimum_experiment",
    "expected_metric_change",
    "implementation_scope",
    "risks",
    "confidence",
    "recommendation_reason",
]


def is_empty(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, dict)):
        return len(value) == 0
    return False


def validate(ideas: list[dict]) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    for idx, idea in enumerate(ideas, 1):
        label = idea.get("idea_id") or f"idea[{idx}]"
        for field in REQUIRED_FIELDS:
            if field not in idea or is_empty(idea.get(field)):
                errors.append(f"{label}: missing required field `{field}`")
        evidence = idea.get("evidence_chain")
        confidence = str(idea.get("confidence", "")).lower()
        if is_empty(evidence) and "low" not in confidence:
            errors.append(f"{label}: missing evidence must be marked low-confidence")
        metric = idea.get("expected_metric_change")
        if is_empty(metric):
            errors.append(f"{label}: expected_metric_change must name at least one metric")
        if len(str(idea.get("minimum_experiment", ""))) < 20:
            warnings.append(f"{label}: minimum_experiment looks too short")
    return {
        "valid": not errors,
        "idea_count": len(ideas),
        "errors": errors,
        "warnings": warnings,
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: validate_idea_cards.py <ideas.json> <validation.json>", file=sys.stderr)
        return 2
    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    ideas = json.loads(input_path.read_text(encoding="utf-8-sig"))
    if not isinstance(ideas, list):
        print("Input must be a JSON array.", file=sys.stderr)
        return 2
    report = validate([idea for idea in ideas if isinstance(idea, dict)])
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("valid" if report["valid"] else "invalid")
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
