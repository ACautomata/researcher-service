# AGENTS.md

This file provides guidance to Qoder (qoder.com) / Claude Code when working with code in this repository.

## Project overview

**天津大学科研智能体平台**（产品显示名 #758 Q13 / #760；内部标识 researcher-service 系不动）。
Vue3(TypeScript) 前端 + TS/Express 控制面，前后端分离。控制面经 Docker SDK 编排面板自管容器
（会话沙箱 + 每用户 wiki 容器）；面板提供对话、wiki 编辑、model 配置等能力。
**#858 OpenClaw 退役③：openclaw-gw fleet（容器 CRUD/管理页/容器行表）已整体退役**——用户视角
只有会话 / wiki / 模型配置。交接规格见 `docs/research/320`（wayfinder #308 汇编）。

> 旧 Django(DRF + Channels) 后端已退役（#341 M9 收尾），当前为 Express + ws 同进程控制面。

## Layout

```
server/     TS/Express 控制面（Express 5 + Prisma 7 + SQLite + BullMQ/Redis + dockerode）
frontend/   Vue 3 + Vite + TypeScript + Pinia + Router + Element Plus
deploy/     编排契约：生产 compose + dev 栈 + wiki 容器镜像构建
docs/       research/ + prototypes/ + adr/ + specs/ + agents/（架构参考 + triage 指引，见下表索引）
```

## Commands

```bash
# ---- server（TS/Express 控制面）----
cd server
npm install
npm run prisma:generate                        # 生成 Prisma client（fresh checkout 必须）
npm run db:apply                               # 落表（better-sqlite3 直连 prisma/init.sql）
npm run dev                                    # tsx watch 宿主直跑（仅纯逻辑调试——摸不到 named volume；起服务/真编排走下方容器化 dev 栈）
npm run typecheck                              # tsc --noEmit
npm test                                       # vitest 全量（沙箱/wiki 容器 smoke 需真 docker daemon）
npm run build                                  # tsc + prisma generate 产物拷贝

# ---- frontend（Vue3 + Vite）----
cd frontend
npm install
npm run dev                                    # Vite dev server（proxy /api → :8001，指向容器化 server）
npm run test                                   # vitest
npm run build                                  # vue-tsc 类型检查 + vite build

# ---- dev 控制面（容器化，与 prod 同形态；issue #594 / ADR 0013）----
# 起服务 / 真编排容器（沙箱 + wiki 容器）一律走此；纯逻辑迭代仍用上方宿主 npm test/typecheck。
docker compose -f deploy/docker-compose.dev.yml up -d --build   # server+redis，挂 docker.sock，server:8001
# 会话发消息需 export LLM_API_KEY（仅起控制面/登录可跳过）。
```

## 架构总览

```
浏览器 (Vue3 + TS)
    │ HTTP/REST (JWT Bearer) + SSE 事件流 (/api/v1/events)
    ▼
Express 控制面 (server/, localhost:8001)
    │ auth / users / files(files 路由) / wiki / models / sessions / events  (路由按域；#858 容器 CRUD 退役)
    │ 全局 #312 信封（HTTP 200 + {code,message,data}）+ jose HS256 认证
    ▼
Docker SDK 控制面 (sandboxes + wikiContainers)
    │ dockerode 挂 docker.sock
    ▼
面板自管容器 fleet（researcher-sandbox-<sessionId> 会话沙箱 + researcher-wiki-<userId> wiki 容器；
#858 起 openclaw-gw fleet 退役，kind 标签二值 wiki|sandbox）
```

## 全局红线

- **输入 0 信任**：所有写操作经 zod schema 强制校验（`validation/schemas.ts`），禁裸读 `req.body`。

## 领域参考（按触发场景查阅）

| 触发场景 | 文档 |
|---|---|
| 改 `server/src/` 某域实现 | `docs/agents/server-modules.md` — 各域职责 + 关键模块清单 |
| 动 REST 端点 / 错误码 / 信封例外 | `docs/agents/api-routes.md` — 路由全清单 + #312 信封细则 + 码段表 |
| 改 `frontend/src/` 任何模块 | `docs/agents/frontend-structure.md` — 目录结构 + 各模块职责 |
| 动容器编排 / 部署 / 凭证 / 测试接缝 | `docs/agents/constraints.md` — 退役清单、docker.sock 安全、生产部署、测试门控 |
| 输出涉及领域术语 / 与既有 ADR 冲突 | `GLOSSARY.md`（术语唯一来源）+ `docs/agents/domain.md`（消费指引） |
| 提 issue / triage 打标 | `docs/agents/issue-tracker.md` + `docs/agents/triage-labels.md` |

## Issue tracker / triage

Issues 跟踪在 GitHub `ACautomata/researcher-service`（`gh` CLI）。见 `docs/agents/issue-tracker.md`、
`docs/agents/triage-labels.md`（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。
