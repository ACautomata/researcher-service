---
name: idea-generate
description: Generate structured research ideas from papers placed in a local paper/ folder, plus optional wiki, memory, experiment logs, and repository context. Use when the agent needs to summarize related papers, extract limitations or future-work signals, propose improvement ideas, and write recommended Idea Cards to a Markdown file. Do not use for full PRD writing or experiment execution.
---

# Idea Generate

## Overview

Generate candidate research ideas from evidence. The demo path assumes the user manually places related papers under a local `paper/` folder. The skill extracts paper context, summarizes limitations and future-work signals, proposes improvement ideas, and writes the most recommended ideas to Markdown.

Do not produce unconstrained brainstorming. Produce ideas that are grounded in paper evidence, comparable side by side, and ready for human review or downstream evaluation.

## OpenClaw Compatibility

This is an OpenClaw workspace skill. It should live at:

```text
skills/idea-generate/SKILL.md
```

The skill follows the OpenClaw / AgentSkills layout: one `SKILL.md` with YAML frontmatter, optional `references/`, optional `scripts/`, and no per-agent YAML config. Resolve referenced helper files relative to `{baseDir}` or this skill directory.

## Dependencies

The scripts use the Python standard library by default. Two extractors are optional:

- `pypdf` for PDF text extraction
- `python-docx` for DOCX text extraction

Install them with:

```bash
python -m pip install -r {baseDir}/requirements.txt
```

If an optional dependency is missing, the extractor records an unavailable-extraction note instead of failing the whole run.

## Demo Workflow

Use this workflow for the minimum runnable demo:

1. Locate the paper folder. Default to `<repo>/paper`.
2. Create a run directory under `idea-runs/YYYYMMDD-HHMMSS-<topic-slug>/`.
3. Run `scripts/build_paper_context_pack.py` to extract paper text and limitation/future-work snippets.
4. Read the generated `paper-context.md` and `paper-context.json`.
5. As the agent, write `paper-analysis.md` with:
   - paper-by-paper summary
   - cross-paper common findings
   - limitations, gaps, and future-work signals
   - transferable insights from one paper to another
6. As the agent, write `draft-ideas.json` with 5-10 candidate Idea Cards based on:
   - paper limitations
   - future work
   - contradictions or gaps across papers
   - transferable insights from one paper to another
   - simple, testable modifications
7. Run `scripts/idea_dedup.py`.
8. Run `scripts/validate_idea_cards.py`.
9. Fix any validation errors in the JSON.
10. Run `scripts/write_idea_markdown.py`.
11. Return the final `recommended-ideas.md` path and a short summary.

Example commands:

```bash
python <skill-root>/scripts/build_paper_context_pack.py --paper-dir paper --topic "<topic>" --out idea-runs/<run-name>
python <skill-root>/scripts/idea_dedup.py idea-runs/<run-name>/draft-ideas.json idea-runs/<run-name>/ideas.dedup.json
python <skill-root>/scripts/validate_idea_cards.py idea-runs/<run-name>/ideas.dedup.json idea-runs/<run-name>/validation.json
python <skill-root>/scripts/write_idea_markdown.py idea-runs/<run-name>/ideas.dedup.json idea-runs/<run-name>/recommended-ideas.md --context idea-runs/<run-name>/paper-context.json --analysis idea-runs/<run-name>/paper-analysis.md
```

## Required Inputs

Before generating ideas, build or normalize an `Idea Generation Brief`. Use `references/brief-template.md`.

Try to fill these fields:

- `research_topic`
- `target_task`
- `current_baseline`
- `available_data`
- `available_code`
- `available_compute`
- `preferred_metrics`
- `hard_constraints`
- `known_failures`
- `desired_risk_level`

If some fields are missing, infer conservatively from local context and mark them as assumptions.

For the demo, only `research_topic` is strictly required. If the user does not provide it, infer from filenames and paper snippets, then mark it as an assumption.

## Read Order

Read only the files needed for the current request, in this order:

1. `paper/` folder via `scripts/build_paper_context_pack.py`
2. Generated `paper-context.md`
3. Relevant `syntheses/` pages for the topic, if present
4. Relevant `sources/` pages for evidence, if present
5. Relevant `entities/` pages for methods, tasks, and metrics, if present
6. Relevant `memory/` or `MEMORY.md` entries for recent discussion and failures, if present
7. Repo files needed to understand the baseline or implementation scope, if needed

Do not bulk-load the entire wiki.

## Core Workflow

1. Build the `Idea Generation Brief`
2. Build paper context from `paper/`
3. Group evidence into candidate opportunity buckets:
   - literature gaps
   - contradictory findings
   - transferable methods
   - historical failures
   - metric weaknesses
   - engineering constraints
4. Write `paper-analysis.md`: summarize each paper's method, contribution, limitation, and possible insight
5. Generate candidate ideas using `references/generation-strategies.md`
6. Deduplicate and cluster similar ideas
7. Score ideas lightly for:
   - evidence strength
   - testability
   - feasibility
   - novelty
   - expected impact
8. Output recommended Idea Cards using `references/idea-card-template.md`

Use `references/paper-demo-output-spec.md` for the runnable demo output contract.

## Hard Rules

1. Ground every idea in evidence, not only model intuition
2. Include a minimum validation experiment for every idea
3. Name at least one metric the idea expects to change
4. Identify a likely risk or failure mode for every idea
5. Mark weakly supported ideas as `low-confidence`
6. Prefer 5-10 high-signal ideas over a long noisy list
7. Do not claim a paper says something unless it appears in `paper-context.md` or another cited source
8. Prepare ideas for human review or downstream evaluation; do not declare the final winner inside this skill

## Output Structure

For the final user reply, keep it short and include:

1. generated run directory
2. final `recommended-ideas.md` path
3. number of papers processed
4. number of recommended ideas

The main artifact is the Markdown file, not the chat response. Each Idea Card should follow `references/idea-card-template.md`. Overall output expectations are defined in `references/output-spec.md` and `references/paper-demo-output-spec.md`.

## Quality Bar

Good outputs are:

- structured
- evidence-backed
- tied to repo or task context
- easy to compare side by side
- concrete enough to pass into idea-evaluate or idea-to-prd

Bad outputs are:

- generic advice
- vague “try transformer / diffusion / rag” suggestions
- ideas without metrics
- ideas with no minimum experiment
- ideas detached from current data, code, or constraints
