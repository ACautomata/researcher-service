---
name: auto-research-project-generator
description: Generate an AutoResearch project from a brief, RTS, or reference archive. Do not commit generated source into this configuration repository.
---

# AutoResearch Project Generator

## Purpose

Use this skill to generate an AutoResearch project as a runtime artifact. The generated project should be written to a user-provided output directory or to a run directory under the agent workspace, not committed into this OpenClaw configuration repository.

This repository stores the agent capability. It should not store the generated AutoResearch project itself.

## When To Use

Use this skill when the user asks to:

- create or scaffold an AutoResearch project,
- turn a research idea into an executable research automation project,
- generate RTS, task card, HPO, recorder, adapter, evaluator, or project validation modules,
- adapt a provided reference archive such as `auto_research.zip`,
- produce tests and documentation for an AutoResearch project.

Do not use this skill for paper-review-only tasks, general literature synthesis, or committing generated project artifacts to this repository.

## Inputs

Collect or infer these fields before generation:

- `project_name`: default to `auto_research` when unspecified.
- `output_dir`: where the generated project should be written.
- `source_mode`: one of `from_brief`, `from_rts`, `from_reference_archive`, or `update_existing_project`.
- `research_goal`: what research automation problem the project should support.
- `experiment_type`: HPO, proxy objective evaluation, RTS-to-experiment generation, generated project validation, or another explicit workflow.
- `runtime_constraints`: Python version, allowed dependencies, GPU/CPU assumptions, network limits, and filesystem limits.
- `deliverables`: source package, tests, examples, docs, CLI, reports, or a subset.

If the user provides a zip archive, inspect its structure and use it as the reference contract. Do not blindly copy logs, secrets, caches, virtual environments, or generated runtime state unless the user explicitly asks for an export package outside this repository.

## Output Contract

A generated AutoResearch project should normally contain:

```text
<output_dir>/
  auto_research/
    adapters/
    core/
    evaluators/
    generation/
    objective/
    planning/
    readers/
    rts/
    search_space/
    task_cards/
    validation/
    workflows/
  docs/
  examples/
  tests/
  pyproject.toml
  README.md
  README_ch.md
```

Optional runtime outputs belong under the generated project's own ignored directories, for example:

```text
outputs/
generated_projects/
.pytest_tmp/
.pytest_cache/
```

## Required Generated Capabilities

When producing a full AutoResearch project, include these capabilities unless the user narrows the scope:

- RTS schema loading, saving, and validation.
- Requirement and implementation-plan generation from RTS.
- Task-card loading, validation, and adapter creation.
- Search-space validation and deterministic config hashing.
- Trial execution through a safe subprocess adapter.
- Trial metric parsing from JSON and logs.
- Trial recording to structured files.
- Proxy objective scoring for quick validation.
- Optional generated project scaffolding and project validation.
- CLI or module entry points for running studies.
- Focused tests for each public workflow.

## Full Project Completeness Contract

For a full project generation request, the agent should treat the following package areas as required. This is the checklist used to prove that the generated project is complete rather than a partial demo:

- `auto_research/adapters/`: base adapter plus subprocess, PyTorch YAML, and PyTorch argparse adapters.
- `auto_research/core/`: task card, objective, recorder, safety, study runner, base types, and shared type definitions.
- `auto_research/evaluators/`: metric normalization, JSON parser, and log parser.
- `auto_research/generation/`: config generator, project generator, task-card generator, and reusable code snippets.
- `auto_research/objective/`: proxy objective scoring.
- `auto_research/planning/`: idea-to-RTS, baseline selection, requirement generation, and implementation planning.
- `auto_research/readers/`: idea or brief reader.
- `auto_research/rts/`: RTS schema, IO, and validation.
- `auto_research/search_space/`: search-space validation, sampling helpers, and hashing.
- `auto_research/task_cards/`: task-card compatibility layer.
- `auto_research/validation/`: command runner and generated-project validator.
- `auto_research/workflows/`: RTS-to-experiment workflow.
- `auto_research/templates/`: reusable project templates when the requested scope includes project generation.
- `auto_research/templates_docs/`: requirement and implementation-plan templates.
- `docs/`, `examples/`, `tests/`, `pyproject.toml`, and bilingual README files when the user requests a complete distributable project.

The agent should report any omitted area explicitly, with the user's reason for narrowing scope.

## Generation Workflow

1. Read the user's brief, RTS, archive, or existing project.
2. Decide the project scope and output directory.
3. Create the directory structure.
4. Generate package modules in small, cohesive files.
5. Generate tests alongside the modules they cover.
6. Generate examples that exercise the intended workflow.
7. Generate project documentation with input/output expectations.
8. Add a project-local `.gitignore` that excludes:
   - `.env`, `.env.*`, credentials, keys, and tokens,
   - virtual environments,
   - Python caches,
   - test caches,
   - logs,
   - generated runtime outputs,
   - local experiment databases.
9. Run the available tests when dependencies are present.
10. Report:
    - output path,
    - generated files summary,
    - tests run,
    - failures or skipped checks,
    - next manual steps.

## Verification Workflow

After generating a full project, verify it with these checks:

1. Produce a file manifest grouped by top-level directory.
2. Compare the manifest against the `Full Project Completeness Contract`.
3. Confirm that no forbidden files are present:
   - `.env`, `.env.*`,
   - private keys or token files,
   - chat transcripts,
   - raw logs,
   - virtual environments,
   - Python or pytest caches.
4. Run import checks for the generated package.
5. Run unit tests when dependencies are available.
6. If tests fail because of a missing optional dependency such as PyTorch, report the exact dependency and the affected test group.
7. Return a concise validation summary with:
   - generated file count,
   - required areas present or missing,
   - test command,
   - pass/fail counts,
   - known environment caveats.

## Safety Rules

- Never commit generated AutoResearch source code into this OpenClaw configuration repository.
- Never include `.env`, tokens, SSH keys, API keys, cookies, chat transcripts, or logs.
- Keep generated project files in a user-selected destination or a clearly named runtime output directory.
- If a requested output path is inside this repository, confirm that the user wants a local generated artifact and keep it gitignored.
- Treat generated projects and experiment outputs as runtime artifacts unless a maintainer explicitly asks for a separate product repository commit.

## Review Checklist

Before reporting completion, verify:

- The generated project path is outside tracked OpenClaw config files or is ignored by git.
- No secrets or logs are present in generated deliverables.
- The project has a clear README and install/test commands.
- The test result is reported honestly.
- Any missing dependency, such as PyTorch, is called out as an environment limitation rather than hidden.
