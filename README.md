# 多 OpenClaw 容器管理面板

Vue3(TypeScript) 前端 + Django(DRF + Channels) 后端的**多 OpenClaw 容器管理面板**。
后端经 Docker SDK 直接增/删/查 OpenClaw 容器，每容器内跑一个 `main` agent，面板提供对话、
wiki 编辑、model 配置等管理能力。完整规格见 `docs/FULLSTACK-REFACTOR-SPEC.md`。

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

- **后端**：`backend/` —— Django 6 + DRF + Channels + drf-spectacular，Docker SDK 编排。详见 `backend/README.md`。
- **前端**：`frontend/` —— Vue 3 + Vite + TypeScript + Pinia + Router + Element Plus。详见 `frontend/README.md`。
- **编排契约**：`deploy/` —— 单容器 compose 模板 + `deploy/openclaw.json`（全面板共享的配置单一来源）。详见 `deploy/README.md`。

## 页面（五页）

| 页面 | 功能 |
|------|------|
| 登录 | 本地账号 + OIDC 骨架（provider 未配置时 501） |
| 容器管理 | OpenClaw 容器增 / 删 / 状态查看，端口池自动分配 |
| 对话 | 与容器内 main agent 流式对话：权限审批、斜杠命令补全、思考链折叠、工具执行只显标题 |
| wiki 编辑 | 每容器 `wiki/main` 文件树 + Typora 式实时渲染 md 编辑器 + obsidian 风格图谱 |
| Model 配置 | 每容器 OpenClaw model provider 的 CRUD（openai-compatible + anthropic） |

> 全局 token 拦截：除授权白名单接口外，所有 REST/WS 请求须带 JWT。

## 本地开发

### 前置

- Python 3.13+（`backend/`）、Node（`frontend/`）、Docker + compose plugin。
- Docker daemon：控制面经 `/var/run/docker.sock` 直连（⚠ 等价 root，本地/可信部署可接受）。
- researcher 模板：容器预填充源 `OPENCLAW_TEMPLATE_DIR`，需 `git clone https://github.com/ACautomata/researcher` 后指向它。

### 启动

```bash
# 后端（terminal 1）
cd backend
python3.13 -m venv .venv && . .venv/bin/activate
pip install -r requirements/dev.txt
python manage.py migrate
python manage.py runserver          # http://localhost:8000

# 前端（terminal 2）
cd frontend
npm install
npm run dev                          # Vite dev server
```

### 测试

```bash
cd backend  && . .venv/bin/activate && python -m pytest   # Django/pytest
cd frontend && npm run test                               # vitest
```

## 关键机制

- **容器编排**：每容器一个命名 home + 渲染后的 `openclaw.json` + 宿主端口；容器命名
  `openclaw-gw-<name>`，label `app=openclaw-fleet`；删除默认连数据一起删。
- **配置单一来源**：`deploy/openclaw.json` 是全面板共享模板，`ConfigRenderer` 渲染每容器配置并强制
  安全不变量（port/bind/token 占位）；`GATEWAY_TOKEN` 每容器独立生成、经 env 注入，真值不落盘。
- **端口池**：宿主侧池 `19000–19999`（容器内统一 18789，靠 Docker 网络命名空间隔离；池避开被单容器
  compose 占用的 18789），创建取最小空闲、删除回收。
- **设备配对**：chat/审批/补全/工具事件须先完成 Ed25519 设备配对（签名 challenge → 宿主 approve →
  deviceToken 持久化）；后端 `PairingService` 驱动状态机，幂等复用已配对连接。
- **docker.sock 安全**：Django 挂 `/var/run/docker.sock` 等价 root（spec §5.4 明示风险）；本地/可信
  部署可接受，生产应限制 Django 网络面或改用 rootless / 远程 TLS daemon。

## 配置

后端经环境变量覆盖（见 `backend/config/settings/base.py` 的 `OPENCLAW_FLEET`）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `OPENCLAW_FLEET_ROOT` | `<repo>/fleet` | `instances/<name>/` 落盘根 |
| `OPENCLAW_TEMPLATE_DIR` | `/srv/openclaw/template/researcher` | 共享只读 researcher 模板（预填充源） |
| `OPENCLAW_IMAGE` | `ghcr.io/openclaw/openclaw:2026.6.34-browser` | 镜像 tag（官方 browser 变体，ADR 0003；生产建议 pin digest） |
| `LLM_API_KEY` | — | 全面板共享 LLM key（env 注入容器，不落盘） |

网关部署侧环境变量见 `deploy/.env.example`（`GATEWAY_TOKEN` / `LLM_API_KEY` 等）。
