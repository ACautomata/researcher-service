---
name: run-ai-research-pipeline
description: Build, launch, and stop the full-stack dev servers (Django backend + Vite frontend), check health, and interact via curl/chromium-cli.
---

Paths below are relative to the **repository root** (`ai-research-pipeline/`).

## Quick start (agent path)

```bash
# 后台启动前后端（自动 venv / npm install / migrate）
.claude/skills/run-ai-research-pipeline/driver.sh start

# 阻塞等待两端就绪（超时 30s）
.claude/skills/run-ai-research-pipeline/driver.sh wait
```

Now the stack is live:

| Layer | URL |
|---|---|
| Backend (Django DRF) | `http://localhost:8000` |
| Frontend (Vite dev)   | `http://localhost:5173` |

## Commands

```bash
driver.sh start       # 启动（幂等——已在运行则跳过）
driver.sh stop        # 停止 + 清理 PID 文件 + 强杀残留子进程
driver.sh restart     # stop → 等 1s → start → wait
driver.sh status      # 进程存活 + HTTP 健康检查
driver.sh wait        # 轮询直到两端 200（30s 超时）
```

## Interacting with the running app

### API (curl)

```bash
# 健康检查（无需认证）
curl -s http://localhost:8000/api/health

# 注册/登录
curl -s -X POST http://localhost:8000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"Pass1234!@","confirm_password":"Pass1234!@"}'

# 登录 → 提取 JWT
TOKEN=$(curl -s -X POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"Pass1234!@"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access'])")

# 访问受保护端点
curl -s http://localhost:8000/api/v1/containers/ -H "Authorization: Bearer $TOKEN"
```

### Browser (chromium-cli)

```bash
chromium-cli --viewport=1280x900 \
  "http://localhost:5173" \
  'Snapshot' \
  'Screenshot /tmp/ai-research-pipeline-screenshot.png'
```

The Vite dev server proxies `/api` → `localhost:8000` and `/ws` → `localhost:8000` (WS upgrade), so `chromium-cli` against `:5173` exercises the full stack.

### WebSocket (chat)

```bash
TOKEN="<JWT-from-login>"
wscat -c "ws://localhost:5173/ws/chat/?token=$TOKEN"
```

## Run (human path)

```bash
# 终端 1: backend
cd backend && DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py runserver localhost:8000

# 终端 2: frontend
cd frontend && npx vite
```

The human path opens a Vite dev server that prints a local URL — open it in a desktop browser. Useless headless (no display).

## Test suite

```bash
# backend
cd backend && DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python -m pytest

# frontend
cd frontend && npm run test
```

## Gotchas

- **DB migration**: On first launch or after schema changes, the driver runs `migrate --noinput` automatically. If you're running the backend manually, run `python manage.py migrate` first — otherwise `/api/v1/auth/register` 500s with `no such table: auth_user`.
- **Worktree node_modules**: If you're inside a git worktree, `node_modules/` isn't shared — run `npm install` in the worktree's `frontend/` before starting. The driver's `_ensure_node_modules` handles this.
- **Port conflicts**: The driver uses `--strictPort` for Vite and `manage.py runserver` bound to `localhost:8000`. If either port is taken, the start command fails. Check with `driver.sh status` or `lsof -i :8000 -i :5173`.
- **SQLite path**: `dev.py` derives the DB from `BASE_DIR` (= `backend/`). Running `manage.py` from the wrong directory creates a different `db.sqlite3`.
- **Vite proxy**: Requests to `http://localhost:5173/api/*` are proxied to the Django backend. API-only testing should hit `:8000` directly — the proxy exists for the browser's same-origin convenience.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl :8000/api/health` 无响应 | 执行 `driver.sh status` 检查进程存活 |
| `register` 返回 500, `auth_user` 表不存在 | 运行 migrate：`cd backend && DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py migrate` |
| Vite 返回 500 | 检查 worktree `node_modules` 是否存在——软链主仓库的 `node_modules` 缺失依赖会导致 `main.ts` mount 失败 |
| `driver.sh start` 提示 backend 已在运行 | 旧进程残留，用 `driver.sh stop` 强制清理，或手动 `pkill -f "manage.py runserver"` |
