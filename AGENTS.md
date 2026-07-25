# AGENTS.md

This file provides guidance to Qoder (qoder.com) / Claude Code when working with code in this repository.

## Project overview

多 OpenClaw 容器管理面板。**Vue3(TypeScript) 前端 + Django(DRF + Channels) 后端**，
前后端分离。后端经 Docker SDK 直接增/删/查 OpenClaw 容器，每容器内跑一个 `main` agent；
面板提供对话、wiki 编辑、model 配置等管理能力。完整规格见 `docs/FULLSTACK-REFACTOR-SPEC.md`。

> 旧 FastAPI + vanilla-JS 单体已删除（issue #48 收尾），本仓库现为标准前后端分离布局。

## Layout

```
backend/    Django 6 + DRF + Channels + drf-spectacular  （manage.py 入口；requirements/{base,dev}.txt）
frontend/   Vue 3 + Vite + TypeScript + Pinia + Router + Element Plus
deploy/     编排契约：单容器 compose 模板 + openclaw.json（配置单一来源）
docs/       FULLSTACK-REFACTOR-SPEC.md + research/ + prototypes/ + adr/
```

## Commands

```bash
# ---- backend（Django）----
cd backend
python3.13 -m venv .venv && . .venv/bin/activate   # 或 uv venv .venv && uv pip install -r requirements/dev.txt
pip install -r requirements/dev.txt
python manage.py migrate
python manage.py runserver                          # http://localhost:8000（REST + WS）
python -m pytest                                    # 全部后端测试（pytest + pytest-django）

# ---- frontend（Vue3 + Vite）----
cd frontend
npm install
npm run dev                                         # Vite dev server
npm run test                                        # vitest
npm run build                                       # vue-tsc 类型检查 + vite build
```

OpenAPI / Swagger 文档在 `http://localhost:8000/api/schema/swagger/`。

## 架构总览

```
浏览器 (Vue3 + TS)
    │ HTTP/REST (JWT Bearer)        │ WebSocket (JWT)
    ▼                               ▼
Django 控制面 (DRF + Channels, localhost:8000)
    │ accounts / containers / wiki / models / chat  (5 apps)
    │ 全局 IsAuthenticated + Channels JWT middleware
    ▼
Docker SDK 控制面 (containers)          OpenClaw WS 客户端连接池 (chat)
    │ docker.from_env() 挂 docker.sock     │ WS protocol v4 (已配对 deviceToken)
    ▼                                     ▼
OpenClaw 容器 fleet (openclaw-gw-<name>，每容器独立 home/openclaw.json/宿主端口)
```

## backend app 边界（5 app 按域）

| app | 职责 | 关键模块 |
|-----|------|----------|
| `accounts` | 本地账号 + OIDC 骨架 + JWT 签发/刷新 | `views.py` `serializers.py` `middleware.py`（Channels JWT） |
| `containers` | Docker SDK 编排（增/删/查容器、端口池、config 渲染） | `orchestrator.py` `provisioner.py` `ports.py` `config_renderer.py` `docker_runtime.py` |
| `wiki` | 每容器 `wiki/main` 文件树 + CRUD + graph | `service.py` `compile.py` `views.py` |
| `models` | 每容器 model provider CRUD + 热加载 + 级联清理 | `config_builder.py` `serializers.py` `views.py` |
| `chat` | OpenClaw WS 对话桥接 + 连接池 + 设备配对 + 事件翻译 | `pairing.py` `pairing_ws.py` `pool.py` `consumers.py` `event_translate.py` `device_crypto.py` |

settings 分 `config/settings/{base,dev,prod}.py` 三分。ASGI 入口 `config/asgi.py`（Channels
`ProtocolTypeRouter` + `accounts.middleware.JwtAuthMiddleware`）。

## API / 路由（`config/urls.py`）

- `GET /api/health`（公开）、`GET /api/schema[…]`（drf-spectacular）。
- `/api/v1/auth/*` — 注册/登录/refresh/logout/me + OIDC `oauth/<p>/login|callback`（未配 provider 时 501）。
- `/api/v1/containers/*` — 容器列表/新建/删除。
- `/api/v1/containers/<name>/pairing/` — 设备配对查询/触发。
- `/api/v1/containers/<name>/wiki/{tree,page,graph}` — wiki 文件树/读写/图谱。
- `/api/v1/containers/<name>/models/providers[/<pid>]` — model provider CRUD。
- 对话走 Channels WS（`chat` consumer），JWT 握手。

全局 `DEFAULT_PERMISSION_CLASSES=[IsAuthenticated]`；授权白名单（register/login/refresh/oauth）显式 `AllowAny`。

## frontend 结构（`frontend/src/`）

- `router/index.ts` — 路由表 + 导航守卫（未登录重定向 `/login`，`auth.hydrate()` 恢复登录态）。
- `stores/` — Pinia：`auth.ts`（JWT access token）、`wiki.ts`。
- `api/` — REST client 封装（`client.ts` 带 JWT 拦截器；`chat/containers/wiki/models.ts` 按域）。
- `views/` — 五页：`LoginView` / `ContainersView` / `ChatView` / `WikiView` / `ModelView`。
- `components/` — `FileTree` / `MdEditor`（Typora 式实时渲染）/ `WikiGraph`（obsidian 风格图谱）。

## 关键机制与约束

- **配置单一来源**：`deploy/openclaw.json` 是全面板共享模板；`ConfigRenderer` 渲染每容器配置并强制
  安全不变量（port/bind/token 占位）。`GATEWAY_TOKEN` 每容器独立生成、经 env 注入，真值不落盘（spec §5.2）。
- **端口池**：宿主侧池 `19000–19999`（容器内统一 18789，靠 Docker 网络命名空间隔离；池避开单容器
  compose 占用的 18789），创建取最小空闲、删除回收（`containers/ports.py`）。
- **设备配对**：chat/审批/补全/工具事件须先完成 Ed25519 设备配对（签名 challenge → 宿主 approve →
  deviceToken 持久化，spec §8.1 / issue #36）。`PairingService` 驱动状态机，幂等复用已配对连接。
- **docker.sock 安全**：控制面挂 `/var/run/docker.sock` = 等价 root（spec §5.4 明示风险）。本地/可信
  部署可接受；生产应限制 Django 网络面或改用 rootless / 远程 TLS daemon。
- **输入 0 信任**：所有写操作经 DRF Serializer 强制校验，禁裸读 `request.data`；drf-spectacular 出 OpenAPI 契约。
- **凭证**：LLM key 全面板共享（`LLM_API_KEY` env 注入容器，不落盘）。
- **测试**：
  - backend：`cd backend && python -m pytest`（pytest + pytest-django + pytest-asyncio；`asyncio_mode=auto`）。
    容器编排集成 smoke 默认 skip，需真 daemon + `RUN_INTEGRATION=1`（见 `backend/README.md`）。
  - frontend：`cd frontend && npm run test`（vitest）；`npm run build` 跑 vue-tsc 类型检查。

## Issue tracker / triage

Issues 跟踪在 GitHub `ACautomata/researcher-service`（`gh` CLI）。见 `docs/agents/issue-tracker.md`、
`docs/agents/triage-labels.md`（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。
