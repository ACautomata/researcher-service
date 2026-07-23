# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## Project overview

FastAPI backend + single-file vanilla-JS frontend. An "AI Research Pipeline" that automates academic research: upload papers → extract knowledge → discover problems → generate ideas → output algorithm code. All AI calls go through an OpenAI-compatible API.
 
## Commands

```powershell
# Clear stale bytecode before starting (prevents route registration issues)
Get-ChildItem -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force

# Install dependencies (no venv created by default)
pip install -r requirements.txt

# Run dev server (with auto-reload)
python main.py

# Run seam tests (pytest; fake OpenClaw WS server stands in for the gateway)
pytest tests/ -q
```

The server starts at `http://localhost:8000` (configurable in `.env`). Interactive API docs at `http://localhost:8000/docs`.

Tests use `pytest` (see `tests/`); there are no linters, no typechecking, no CI configured. To run the single-main-agent OpenClaw gateway locally: `git clone https://github.com/ACautomata/researcher ./researcher`, then `docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d` (see `deploy/README.md` and `README.md`).

## Prerequisites

- **`.env` file is required.** Copy the template from `.env.example`—at minimum set `AI_API_KEY`. Without it, all AI-dependent features throw `RuntimeError("请先在「个人配置」页面或 .env 中配置 API Key（SK）")`.
- The API is OpenAI-compatible; defaults to Zhipu GLM (`https://open.bigmodel.cn/api/paas/v4`).
- Claude Agent SDK (`claude-agent-sdk>=0.1.69`) is a dependency; the agent feature runs the SDK in a thread pool and streams results via SSE.

## Architecture

```
main.py                  — FastAPI app, uvicorn runner, lifespan (init DB + uploads dir), auth/context middleware
config.py                — dotenv loader, Config class, module-level exports
database.py              — aiosqlite: async init_db(), db_query(), db_execute(), update_task()
models.py                — Pydantic models (⚠ largely unused — routes define their own)
routes/kb.py             — /api/v1/kb/*    upload, parse, entries, keywords, clear-all
routes/lit.py            — /api/v1/lit/*   auto-discover, search-external, validate, problems, history CRUD
routes/idea.py           — /api/v1/idea/*  generate, list
routes/algo.py           — /api/v1/algo/*  generate, test, optimize, list
routes/agent.py          — /api/v1/agent/* Claude Agent chat (SSE streaming, not polling)
routes/chat.py            — /api/v1/chat/*  direct AI chat (stream and non-stream, unprotected)
routes/obsidian.py       — /api/v1/obsidian/* vault tree, file CRUD, graph, search, tags
routes/auth.py           — /api/v1/auth/* register, login, session, user-level API settings; /api/v1/auth/admin/* user management (admin only)
routes/user_settings.py  — /api/v1/user/*  per-user AI credentials (mirrors /auth/settings)
routes/dashboard.py       — /api/v1/dashboard/* task list, system stats (CPU/RAM/disk/GPU), unprotected
routes/openclaw.py        — /api/v1/openclaw/* single-main-agent OpenClaw bridge: chat (WS), upload, apply-config, status, wiki
services/ai_service.py        — chat(), chat_json(), prompt templates; uses per-user creds
services/parser_service.py    — extract_text() for PDF/DOCX/TXT/MD/TeX
services/external_service.py  — arXiv + Semantic Scholar search
services/agent_service.py     — Claude Agent SDK wrapper (thread pool → SSE)
services/openclaw_service.py  — OpenClaw SSE contract (text/done/error/raw) + WS event translation
services/openclaw_ws.py       — process-level OpenClaw WS client singleton (handshake, reconnect, runId routing)
services/obsidian_service.py  — vault file I/O, graph scanning, tag extraction
services/auth_crypto.py       — PBKDF2-SHA256 password hashing, session token generation
services/request_context.py   — ContextVar[int] for user_id, ContextVar[str] for user_role propagation
services/data_filter.py       — user_filter() helper: admin sees all, regular user sees own+legacy
services/user_credentials.py  — per-user credential resolution with fallback to global .env
public/index.html             — thin HTML shell, loads external CSS/JS
public/css/style.css          — all styles extracted from old monolithic index.html
public/js/core.js             — globals, auth, API client, nav, routing, bootstrap
public/js/pages/home.js       — home/welcome page
public/js/pages/profile.js    — user settings / personal config page
public/js/pages/kb.js         — knowledge base (upload, parse, entries, keywords)
public/js/pages/lit.js        — literature (auto-discover, search, validate, cross-analysis, history persistence)
public/js/pages/idea.js       — idea generation & scoring
public/js/pages/algo.js       — algorithm generation, test, optimize
public/js/pages/param.js      — parameter optimization/suggestion
public/js/pages/discover.js   — research motivation discovery (problem browser, severity filter)
public/js/pages/chat.js       — paper writing assistant (section selector, writing templates, AI chat)
public/js/pages/obs.js        — scientific chart generator (AI Smart Generate, Data Viz, Code Editor)
public/js/pages/dashboard.js  — scientific value analysis (Idea quality, problem validation, algo perf, pipeline funnel)
public/js/pages/tasks.js      — task management hub (3 tabs: Pipeline/Center/System, polling)
public/js/pages/doc.js        — API documentation page
public/js/pages/admin.js      — admin user management (list users, reset passwords, change roles, delete)
public/js/pages/openclaw_shared.js — OpenClaw shared module (multi-session, SSE streaming, render, upload); OC_AGENTS = main only
public/js/pages/openclaw_main.js   — oc-main page (single line: buildOcAgentPage('main'))
public/js/pages/wiki.js            — Wiki page (reads researcher wiki/main; five core categories + domains)
public/js/pages/ocstatus.js        — OpenClaw status panel (gateway + container + main)
public/js/app.js              — event listeners + bootstrap() call
deploy/                       — slim single-service compose stack + deploy/openclaw.json (config single source, overrides researcher's)
tests/                        — pytest seam tests (issue #16 infra; fake OpenClaw WS server for openclaw routes)
uploads/                      — uploaded paper files (gitignored)
pipeline.db                   — SQLite database (auto-created, gitignored)
vault/                        — example Obsidian vault
```

## Pipeline data flow

`kb (upload + parse)` → `lit (discover problems + validate)` → `idea (generate + score)` → `algo (code + mock test)`

Each step depends on data produced by the previous step. The frontend enforces this visually.

Lit analysis supports 3 depths: **quick** (single-KB scan), **deep** (thorough single-KB), **cross** (dual-KB cross-reference, requires 2 domain selections). Analysis history is persisted to the `lit_analyses` table and survives page refresh.

Chat (论文辅助写作), Obs (科研绘图), Dashboard (科技价值分析), and Tasks (任务管理) are supplementary tools outside the main pipeline.

## API pattern

Long-running operations (parse, discover, validate, generate, test) are **async tasks**:
1. `POST /api/v1/{module}/{action}` returns `{task_id, status: "running"}`
2. Client polls `GET /api/v1/{module}/{action}/{task_id}/progress` (1200ms interval in frontend)
3. When `status === "completed"`, `result` contains the output

Exception: Agent chat (`/api/v1/agent/chat`) uses **SSE streaming**—POST starts the session, GET `/api/v1/agent/chat/{task_id}/stream` delivers `text/event-stream`.

Task state is tracked in the `tasks` table in SQLite.

## Database schema (SQLite via aiosqlite)

Core pipeline tables (auto-created in `init_db()`):
- `papers` — uploaded files (filename, original_name, ext, domain_id, markdown_content, user_id)
- `keywords` — extracted keywords with weight, category, source_paper_id, user_id
- `entries` — KB entries from parsed papers (title, category, keywords_json, paper_id, user_id)
- `problems` — research problems discovered from entries (severity, validated, validation_score, user_id)
- `ideas` — generated ideas referencing problems (novelty, feasibility, impact, overall_score, user_id)
- `algorithms` — generated code (language, from_idea, test metrics, perf timings, user_id)
- `tasks` — async task tracking (type, status, progress, step, result_json, error, user_id)
- `domains` — research domain grouping for papers, user_id
- `lit_analyses` — literature analysis history (kb_id, kb_id2, depth, status, progress, count, user_id)

Auth tables (only populated if AUTH_ENABLED or PIPELINE_REQUIRES_LOGIN):
- `users` — username + PBKDF2-SHA256 password hash + role (TEXT, default "user")
- `sessions` — session tokens with expiry, FK→users
- `user_settings` — per-user AI credentials (ai_api_base, ai_api_key, ai_model, anthropic_*, theme_color)

Migrations run as ALTER TABLE in `init_db()` — failing gracefully if column already exists. Current migrations: `user_settings.theme_color`, `papers.domain_id`, `papers.markdown_content`, `users.role`, and `user_id` on all core pipeline tables.

## Auth, role-based access & credential resolution

- Auth is **optional**: controlled by `AUTH_ENABLED` and `PIPELINE_REQUIRES_LOGIN` in `.env`.
- Middleware (`main.py:70`) always attempts to parse a Bearer token. If valid, `request.state.user` is set and `ctx_user_id` + `ctx_user_role` (ContextVars) are propagated for the request's duration.
- `_pipeline_api_path()` defines which routes require login when `PIPELINE_REQUIRES_LOGIN=true`: `/api/v1/kb`, `/lit`, `/idea`, `/algo`, `/agent`, `/obsidian`. Routes `/chat`, `/dashboard`, `/auth`, and `/user` are **always excluded** from pipeline auth enforcement.
- Agent SSE streams also accept token via `?access_token=` query param (for EventSource which doesn't support custom headers).
- **Per-user credential override**: `ai_service.py` calls `get_effective_llm()` which checks `ctx_user_id` → queries `user_settings` table → falls back to global `.env` values. Same pattern for agent credentials via `get_effective_agent()`.
- When modifying AI-calling code, always resolve credentials through `user_credentials.py`, never read `AI_API_KEY` directly from config.

### Admin role assignment

- All new registrations default to `role = "user"`. The only way to grant admin role is via the admin management panel (`PUT /auth/admin/users/{id}/role`).
- Register and login responses both include the `role` field in the user object.

### Multi-tenant data isolation

Every core pipeline table has a `user_id INTEGER DEFAULT NULL` column. The `services/data_filter.py::user_filter()` helper controls visibility:

| User state      | SQL filter applied                     | Visible data                              |
|-----------------|----------------------------------------|-------------------------------------------|
| admin           | None (empty WHERE)                     | All rows (legacy + all users)             |
| regular user    | `(user_id IS NULL OR user_id = ?)`     | Legacy data (NULL) + own data             |
| unauthenticated | None (empty WHERE)                     | All rows (backward compatible)            |

- **Legacy data** (rows with `user_id IS NULL`, created before the migration) is visible to everyone. This ensures backward compatibility when enabling auth on an existing deployment.
- Background tasks (`asyncio.create_task`) capture `user_id` at request time and pass it as a parameter — ContextVar does **not** propagate to task coroutines automatically.
- All INSERT operations in pipeline routes include `user_id` (set to the current user's ID). DELETE/UPDATE operations are also scoped by user_id.

## Key constraints & gotchas

- **Algorithm testing and optimization are mocked.** `algo.py:_do_test` and `algo.py:algo_optimize` use `hash(algo_id)` to generate fake pass/fail counts and performance numbers. Real sandboxed code execution is not implemented.
- **`models.py` is largely unused.** Each route file defines its own Pydantic models inline. Do not assume models from `models.py` are the canonical request shapes—read the route file directly.
- **No `response_format` in AI calls.** `ai_service.py` avoids `response_format: "json_object"` to stay compatible with all OpenAI-compatible providers. Instead, it prepends a system message demanding JSON and strips markdown fences from responses.
- **AI concurrency:** 5 concurrent requests max (semaphore in `ai_service.py`), 120s timeout.
- **The frontend reloads everything on navigation.** After any task completes, `go(pageId)` re-fetches all data from the corresponding API endpoints. The `cache` object is fully rebuilt.
- **Database is auto-created** in `lifespan` on startup via `init_db()`. SQLite WAL mode is not explicitly enabled.
- **File encoding:** The plain-text parser tries `utf-8`, `gbk`, `gb2312`, `latin-1` in that order (relevant for Chinese-language papers).
- **Uploaded filenames** are prefixed with a UUID fragment (`uuid4().hex[:12]_`).
- **Obsidian vault** requires `OBSIDIAN_VAULT_PATH` in `.env`; all vault endpoints return 400 if not configured. Obsidian backend routes are retained but the frontend page (科研绘图) no longer uses them.
- **Chart generation** uses the `/chat/send` AI endpoint to generate ECharts HTML. The AI response is parsed for code blocks and rendered in a sandboxed iframe.
- **Dashboard → Tasks migration** in progress: all task management, workflow visualization, and system resource monitoring moved from dashboard.js to tasks.js. Dashboard.js now serves as a scientific value analysis page.
- **Agent SDK** runs synchronously in a `threading.Thread` (Windows) or subprocess (Linux/macOS), feeding events into an `asyncio.Queue` for SSE streaming.
- **ContextVar does not propagate to background tasks.** `asyncio.create_task()` coroutines run outside the request context. Always capture `uid` from `current_user_id()` at request time and pass it as a function argument to background coroutines.
- **Windows process management:** `uvicorn.run(reload=True)` has known issues with stale bytecode on Windows. If the server doesn't reflect code changes, clear `__pycache__` and restart. Use `powershell "Get-Process python* | Stop-Process -Force"` to kill orphaned server processes that `git-bash kill` can't terminate.

## Frontend notes

- Frontend split across 16 files: thin `index.html` + `css/style.css` + `js/core.js` + 13 page JS files + `js/app.js`. No framework, no npm, no bundler.
- `main.py` mounts `StaticFiles` at `/` (root) to serve everything under `public/`. API routes take precedence.
- JS files share global scope — they are loaded in order: core → pages → app.
- API base = `/api/v1` (hardcoded JS var).
- Drag-and-drop upload supported on the KB page.
- All pages share a `cache` object populated by `loadPapers()`, `loadKeywords()`, `loadProblems()`, `loadIdeas()`, `loadAlgos()`.
- Nav pages (P_FULL): home, kb, lit, discover, idea, algo, param, dashboard, chat, obs, tasks, oc-main, wiki, ocstatus, profile, doc, admin. The OpenClaw sub-agent pages (oc-autoresearch/oc-review/oc-idea) were removed in the single-main-agent refactor; only oc-main/wiki/ocstatus remain under the OpenClaw nav group. discover.js is "研究动机发现", tasks.js task management hub replaces old dashboard task views.
- KB stats card "含文献" counts total papers across all domains (sum of paper_count), not domain count.
- Lit page fetches analysis history from `GET /lit/history` on each navigation; new tasks are POSTed and status updates PUT to the backend.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues on `ACautomata/researcher-service`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical labels, each named as itself: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
