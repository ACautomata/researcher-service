# AGENTS.md

## Project overview

FastAPI backend + single-file vanilla-JS frontend. An "AI Research Pipeline" that automates academic research: upload papers → extract knowledge → discover problems → generate ideas → output algorithm code. All AI calls go through an OpenAI-compatible API.

## Commands

```powershell
# Install dependencies (no venv created by default)
pip install -r requirements.txt

# Run dev server (with auto-reload)
python main.py
```

The server starts at `http://localhost:8000` (configurable in `.env`). Interactive API docs at `http://localhost:8000/docs`.

There are **no tests, no linters, no typechecking, no CI** configured.

## Prerequisites

- **`.env` file is required.** Copy the template pattern—at minimum set `AI_API_KEY`. Without it, all AI-dependent features throw `RuntimeError("请先在 .env 文件中配置 AI_API_KEY")`.
- The API is OpenAI-compatible; defaults to Zhipu GLM (`https://open.bigmodel.cn/api/paas/v4`).

## Architecture

```
main.py              — FastAPI app, uvicorn runner, lifespan (init DB + uploads dir)
config.py            — dotenv loader, Config class, module-level exports
database.py          — aiosqlite: async init_db(), db_query(), db_execute(), update_task()
models.py            — Pydantic models (⚠ largely unused — routes define their own)
routes/kb.py          — /api/v1/kb/*  upload, parse, entries, keywords, clear-all
routes/lit.py         — /api/v1/lit/* auto-discover, search-external, validate, problems
routes/idea.py        — /api/v1/idea/* generate, list
routes/algo.py        — /api/v1/algo/* generate, test, optimize, list
services/ai_service.py    — chat(), chat_json(), prompt templates for each pipeline step
services/parser_service.py — extract_text() for PDF/DOCX/TXT/MD/TeX
services/external_service.py — arXiv + Semantic Scholar search
public/index.html     — entire frontend (inline CSS + JS), no bundler
uploads/              — uploaded paper files (gitignored implicitly)
pipeline.db           — SQLite database (auto-created, gitignored implicitly)
```

## Pipeline data flow

`kb (upload + parse)` → `lit (discover problems + validate)` → `idea (generate + score)` → `algo (code + mock test)`

Each step depends on data produced by the previous step. The frontend enforces this visually.

## API pattern

Long-running operations (parse, discover, validate, generate, test) are **async tasks**:
1. `POST /api/v1/{module}/{action}` returns `{task_id, status: "running"}`
2. Client polls `GET /api/v1/{module}/{action}/{task_id}/progress` (1200ms interval in frontend)
3. When `status === "completed"`, `result` contains the output

Task state is tracked in the `tasks` table in SQLite.

## Key constraints & gotchas

- **Algorithm testing and optimization are mocked.** `algo.py:_do_test` and `algo.py:algo_optimize` use `hash(algo_id)` to generate fake pass/fail counts and performance numbers. Real sandboxed code execution is not implemented.
- **`models.py` is largely unused.** Each route file defines its own Pydantic models inline. Do not assume models from `models.py` are the canonical request shapes—read the route file directly.
- **No `response_format` in AI calls.** `ai_service.py` avoids `response_format: "json_object"` to stay compatible with all OpenAI-compatible providers. Instead, it prepends a system message demanding JSON and strips markdown fences from responses.
- **AI concurrency:** 5 concurrent requests max (semaphore in `ai_service.py`), 120s timeout.
- **The frontend reloads everything on navigation.** After any task completes, `go(pageId)` re-fetches all data from the corresponding API endpoints. The `cache` object is fully rebuilt.
- **Database is auto-created** in `lifespan` on startup via `init_db()`. SQLite WAL mode is not explicitly enabled.
- **File encoding:** The plain-text parser tries `utf-8`, `gbk`, `gb2312`, `latin-1` in that order (relevant for Chinese-language papers).
- **Uploaded filenames** are prefixed with a UUID fragment (`uuid4().hex[:12]_`).

## Frontend notes

- Single HTML file, no framework, no npm.
- API base = `/api/v1` (hardcoded JS var).
- Drag-and-drop upload supported on the KB page.
- All pages share a `cache` object populated by `loadPapers()`, `loadKeywords()`, `loadProblems()`, `loadIdeas()`, `loadAlgos()`.
