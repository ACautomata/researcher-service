---
name: run-ai-research-pipeline
description: Build, launch, and stop the full-stack dev servers (TS/Express control plane + Vite frontend), check health, and interact via curl/chromium-cli.
---

Paths below are relative to the **repository root** (`ai-research-pipeline/`).

## Quick start (agent path)

```bash
# 后台启动控制面 + 前端（自动 npm install / prisma generate / 落表）
.claude/skills/run-ai-research-pipeline/driver.sh start

# 阻塞等待两端就绪（超时 30s）
.claude/skills/run-ai-research-pipeline/driver.sh wait
```

Now the stack is live:

| Layer | URL |
|---|---|
| Server (TS/Express 控制面) | `http://localhost:8001` |
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
curl -s http://localhost:8001/api/health

# 登录 → 提取 access token（#312 信封：成功在 data.access）
TOKEN=$(curl -s -X POST http://localhost:8001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<bootstrap-密码>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['access'])")

# 访问受保护端点
curl -s http://localhost:8001/api/v1/containers/ -H "Authorization: Bearer $TOKEN"
```

> 公开注册已关闭（admin-only，spec #331）：账号由 bootstrap（首启 log 输出 admin 临时密码一次）
> 或 admin users 页创建。bootstrap 临时密码在 `server/` 首启日志（`driver.sh start` 后
> `tail -f /tmp/ai-research-pipeline-server.log`）。

### Browser (chromium-cli)

```bash
chromium-cli --viewport=1280x900 \
  "http://localhost:5173" \
  'Snapshot' \
  'Screenshot /tmp/ai-research-pipeline-screenshot.png'
```

The Vite dev server proxies `/api` → `localhost:8001` and `/ws` → `localhost:8001` (WS upgrade), so `chromium-cli` against `:5173` exercises the full stack.

### WebSocket (chat)

```bash
TOKEN="<JWT-from-login>"
wscat -c "ws://localhost:5173/ws/chat/" -H "Sec-WebSocket-Protocol: access_token, $TOKEN"
```

## Run (human path)

```bash
# 终端 1: server（TS/Express 控制面）
cd server && npm install && npm run prisma:generate && npm run db:apply && npm run dev

# 终端 2: frontend
cd frontend && npx vite
```

The human path opens a Vite dev server that prints a local URL — open it in a desktop browser. Useless headless (no display).

## Test suite

```bash
# server（TS 控制面）
cd server && npm run typecheck && npm test && npm run build

# frontend
cd frontend && npm run test && npm run build
```

## Gotchas

- **DB 落表**: On first launch or after schema changes, the driver runs `prisma:generate` + `db:apply` automatically（`server/prisma/init.sql` 落到 `DATABASE_URL` 指向的 SQLite）。If you're running the server manually, run `npm run db:apply` first — otherwise bootstrap 报 `no such table: users`。
- **Worktree node_modules**: If you're inside a git worktree, `node_modules/` isn't shared — run `npm install` in the worktree's `server/` and `frontend/` before starting. The driver's `_ensure_node_modules` handles this.
- **Port conflicts**: The driver uses `--strictPort` for Vite and `npm run dev`（Express）bound to `localhost:8001`. If either port is taken, the start command fails. Check with `driver.sh status` or `lsof -i :8001 -i :5173`。
- **Redis / docker daemon**: 容器生命周期（POST /containers）依赖 Redis（BullMQ）与 docker daemon；不可达时 REST 认证/账号端点仍可用，仅容器创建不可用（driver 会警告）。
- **Vite proxy**: Requests to `http://localhost:5173/api/*` are proxied to the Express server. API-only testing should hit `:8001` directly — the proxy exists for the browser's same-origin convenience.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl :8001/api/health` 无响应 | 执行 `driver.sh status` 检查进程存活 |
| 登录报 `10005 强制改密` | bootstrap/新建账号首登须先 `POST /api/v1/auth/password/change`（C1 强制改密流程） |
| Vite 返回 500 | 检查 worktree `node_modules` 是否存在——软链主仓库的 `node_modules` 缺失依赖会导致 `main.ts` mount 失败 |
| `driver.sh start` 提示 server 已在运行 | 旧进程残留，用 `driver.sh stop` 强制清理，或手动 `pkill -f "tsx watch src/server.ts"` |
