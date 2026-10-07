# AGENTS.md

This file provides guidance to Qoder (qoder.com) / Claude Code when working with code in this repository.

## Project overview

**天津大学科研智能体平台**——多 OpenClaw 容器管理面板（产品显示名 #758 Q13 / #760；内部标识 researcher-service 系不动）。Vue3(TypeScript) 前端 + TS/Express 控制面，前后端分离。
控制面经 Docker SDK 直接增/删/查 OpenClaw 容器，每容器内跑一个 `main` agent；面板提供对话、
wiki 编辑、model 配置等管理能力。交接规格见 `docs/research/320`（wayfinder #308 汇编）。

> 旧 Django(DRF + Channels) 后端已退役（#341 M9 收尾），当前为 Express + ws 同进程控制面。

## 领域词汇（glossary）

本项目特有领域术语的定义 + **同义词禁令**（tunnel / wiki 容器 / 软删存档 / approval funnel / 镜像谱系 / …）
见 `GLOSSARY.md`。写代码、命名、开 issue、写规格时用其词汇，不要自造同义词；拿不准就查它。

## Layout

```
server/     TS/Express 控制面（Express 5 + ws + Prisma 7 + SQLite + BullMQ/Redis + dockerode）
frontend/   Vue 3 + Vite + TypeScript + Pinia + Router + Element Plus
deploy/     编排契约：单容器 compose 模板 + openclaw.json（配置单一来源）+ 生产 compose
docs/       research/（issue 规格）+ adr/ + agents/（triage 指引）
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
npm test                                       # vitest 全量（containers-smoke 需真 docker daemon）
npm run build                                  # tsc + prisma generate 产物拷贝

# ---- frontend（Vue3 + Vite）----
cd frontend
npm install
npm run dev                                    # Vite dev server（proxy /api、/ws → :8001，指向容器化 server）
npm run test                                   # vitest
npm run build                                  # vue-tsc 类型检查 + vite build

# ---- dev 控制面（容器化，与 prod 同形态；issue #594 / ADR 0013）----
# 起服务 / 真编排 OpenClaw 容器（named volume 拓扑）一律走此；纯逻辑迭代仍用上方宿主 npm test/typecheck。
docker compose -f deploy/docker-compose.dev.yml up -d --build   # server+redis，挂 docker.sock，server:8001
# 前置：researcher 克隆到仓库根（build context template=../researcher，或设 RESEARCHER_DIR）；
#       真编排另需派生镜像（构建须打成 Dockerfile FROM 基线版本 tag，命令见 deploy/README.md）
#       + export LLM_API_KEY。
```

## 架构总览

```
浏览器 (Vue3 + TS)
    │ HTTP/REST (JWT Bearer)        │ WebSocket (JWT subprotocol)
    ▼                               ▼
Express 控制面 (server/, localhost:8001)
    │ auth / users / containers / wiki / models / chat  (路由按域)
    │ 全局 #312 信封（HTTP 200 + {code,message,data}）+ jose HS256 认证
    ▼
Docker SDK 控制面 (containers)          网关隧道 (chat，浏览器直连网关)
    │ dockerode 挂 docker.sock             │ 隧道只做握手 4401 + 原始帧透传
    ▼                                     ▼
OpenClaw 容器 fleet (openclaw-gw-<name>，每容器独立 home/openclaw.json/宿主端口)
```

## server 模块边界（`server/src/`）

每格一句职责概述——实现细节读代码，设计决策与「为什么」读 `docs/adr/` 和 `docs/research/<issue>-*.md`。
issue 号（#xxx）即规格寻址键，对应 `docs/research/` 下的规格文档。

| 域 | 职责 | 关键模块 |
|-----|------|----------|
| `auth/` | 双角色账号 + JWT 签发/刷新（R1 旋转）+ bootstrap B1 + C1 强制改密 | `tokens.ts` `authenticate.ts` `bootstrap.ts` `userService.ts` |
| `containers/` | Docker SDK 编排（增/删/查、端口池、config 渲染、5 态机）；容器 kind 三值分派（#784，`kind.ts`） | `orchestrator.ts` `dockerRuntime.ts` `ports.ts` `configRenderer.ts` `fleetAssembly.ts` |
| `wiki/` | wiki 树 CRUD + graph（`WikiFileSystem` Port + 纯逻辑）。#784 存储换轨 = 每用户 wiki 容器树根 `/wiki`、每操作前置 ensure（归属校验先于 ensure）；#789 OKF 适配 = SKIP 集扩充 + markdown 相对链接边 + claims 旁车只读 API + okf 徽章入页数据；#790 = `POST /wiki/update` 三通道③独立 run 触发面（updateEvents 纯映射 wiki_run 五类事件） | `service.ts` `logic.ts` `nodeFs.ts` `compile.ts` `routes.ts` |
| `models/` | model provider CRUD（#775：行挂 ownerId；事务 = mutation + config_meta version bump 热生效；白名单第一层 origin 精确匹配 + DNS 私网拒绝 → 90002 字段级）+ 端点白名单 admin REST；写盘链已退役不再接线，物理删除留待 T0 #801 | `service.ts` `routes.ts` `endpoints.ts` `values.ts` |
| `chat/` | 网关隧道（JWT 握手 4401 + 原始帧透传，ADR 0006 浏览器直连） | `tunnelAssembly.ts` `subprotocol.ts` `values.ts` |
| `files/` | 统一文件 CRUD（#776 root 契约：wiki 读写面暂留 / workspace legacy 只读 / lab 沙箱只读 GET；写面收敛 wiki；经 Docker getArchive/putArchive/exec rm，ADR 0012） | `fsPort.ts` `dockerArchive.ts` `paths.ts` `tar.ts` `routes.ts` |
| `events/` | SSE 事件流（#773，替代 WS 的传输面）：StreamHub per-user 扇出 + 连续单调 serverSeq + 事件桥薄投影（LangChain streamEvents → 自有目录，不透传） | `hub.ts` `logic.ts` `routes.ts` `bridge.ts` `values.ts` |
| `sandboxes/` | 会话沙箱生命周期（#776：1 session:1 `researcher-sandbox-<sessionId>`，对容器列表隐身）：惰性 ensure / 闲置 30min 自动 stop（文件保留）/ 级联删（容器+独立 bridge 网络）；4GB·4 核·PidsLimit 512·禁 swap（OOM 杀进程不杀容器）；非 root(1000) + CapDrop ALL + no-new-privileges + RestartPolicy no；消费方 = runner ensure/touch + #778 删 session 级联 + #781 fork 字面复制（`forkSandbox`：export→import 整 FS，源已删空起步兜底） | `values.ts` `runtime.ts` `dockerRuntime.ts` `lifecycle.ts` `service.ts` `assembly.ts` |
| `wikiContainers/` | wiki 容器生命周期（#784：每用户一台 `researcher-wiki-<userId>`、永久、零初始化零骨架、NetworkMode none 零出网、256MB/128 pids、非 root 全套加固、无具名卷——备份 = docker export 全树 tar，还原 = docker import 重建；活性 = inspect Running；对 fleet 隐身 kind=wiki + owner 标签） | `values.ts` `runtime.ts` `dockerRuntime.ts` `lifecycle.ts` `assembly.ts` |
| `runner/` | LangGraph 运行时域（#747 换轨）。`backend/` = DockerArchiveBackend（deepagents BackendProtocolV2 本地镜像 → /wiki + /lab 双根 Docker 原语映射，Port 注入可 fake）；`persistence/` = #774 持久化双件（PrismaCheckpointSaver + PrismaMemoryStore，继承 langgraph 基类零侵入）；根五件 = ProviderRegistry（#775：config 热生效 + 白名单第二层 40042 + fetch 验最终 origin）/ allowlist / concurrency（40043 per-user+全局信号量 + wouldReject 预检）/ usage（usage_metadata 全量采数落 llm_usage_records）/ providerDefaults / llmToolPort（#792 多模态回退链）；`runtime/` = RunService 内核（per-thread 串行链、run 状态机 queued→running⇄interrupted→终态+suspended、resume 互斥 50001、normalizeReplay 重放归一 #779、沙箱 ensure/touch 接线、recordTurn 落行）+ projector / checkpointTurn / errorKind / graphFactory / abortGuard / bullmqRunQueue（attempts:1，崩溃重放由 normalizeReplay 拦截转 recover）；wikisearch = #789 三通道①常驻检索（openwiki deep-import，Result 永不 throw）；`wikigen/` = #790 三通道②（teammates.kind='wiki-update' run，跳缓存装配）+ ③（wiki/updateRun 独立 run 全流程占全局串行锁）双路径；`approval/` = #783 审批三层漏斗（rules → judge → 升级，全量落 tool_approval_logs）；`writelock/` = #785 per-path 写锁 + write-after-write 覆盖审计 | `backend/` `persistence/` `providerRegistry.ts` `allowlist.ts` `concurrency.ts` `usage.ts` `llmToolPort.ts` `runtime/runService.ts` `runtime/projector.ts` `runtime/checkpointTurn.ts` `bullmqRunQueue.ts` `wikisearch.ts` `approval/` `writelock/` `wikigen/` `auditRoutes.ts` `assembly.ts` |
| `sessions/` | 会话 REST 域（#778 · #747 C 节：扁平挂用户，容器维度退役）：创建/列表/改标题（首轮自动生成）；发消息 32-hex Idempotency-Key 幂等（同 key 异 content → 50007）；abort（仅 running 在飞，否则 50006）/ resume（50001 先到先得双层）；多端门禁（queued/running 禁输入 50005、非终态拒删；幂等查先于门禁）；历史投影 GET 回放零差异（TurnReducer 双入口同构）+ inFlight 投影（#779）；删会话级联删沙箱；#781 rewind（换 activeCheckpointId 指针 + 被放弃路线软删 + session.invalidated 事件）/ fork（新 Session 行溯源 + checkpoint 祖先链复制 + 消息行截断复制 + 沙箱字面复制 + file_journal 截断继承），rewind scope 三态 #782（all/chat/files）+ rewind/preview；#787 sendMessage 入口截斜杠命令（幂等/落行全作用于原始输入，官方命令展开在构造点），系统命令 /new /compact /model（结果经 command 聚合面挂行） | `values.ts` `reducer.ts` `rewind.ts` `service.ts` `routes.ts` |
| `figures/` | AutoFigure 核心域（#744 v2 + #791 数据模型 + #792 工具收口）：读面 = list/detail/png/svg 单点归属门 70040 同码防探测（admin 跨用户可见）；`createFigure` 终态一次性 create（Figure 无状态列）；figure_run 事件族（progress 六 stage 落 SSE + created/completed/failed 等五类落 text_trace_logs，fail-soft）；读/下载面 svg `<img>` blob 渲染；生成执行面唯一入口 = 插件 `plugins/autofigure`（AutoFigureView/REST 创建端点已退役） | `service.ts` `toolPort.ts` `figureAudit.ts` `dataUri.ts` `routes.ts` |
| `plugins/`（骨架）+ 根 `plugins/`（插件包） | 插件系统（#788 骨架 + #792 ctx 四件校准）：definePlugin 契约（PluginToolContext 最小面 + ctx 可选面 run/figures/llm/audit）+ 注册期 fail-fast 强校验 + 启动期 env 全目录校验；run 粒度启用集静态过滤（目录版本入图缓存键）；LangChain 适配（tool_call_id 与 ctx 四件均经 ALS 解析）；目录 GET + per-user 启用 PUT（8xxxx 段）；`RunService.executePluginToolRun` = {execute} outcome 直达执行面（zod 预校验 + REST 经 handler 80001 即时反馈）；插件包 = manifest（工具+category+configSchema）+ server.ts + web.ts（现含 autofigure：figure_generate 工具不进三层漏斗 + /figure 命令直达同一执行面）；**plugins/ 树禁裸包名 import**（依赖经 `autofigureDeps.ts` re-export 桥，前端对称面 `deps.ts`） | `api.ts` `registry.ts` `surface.ts` `tools.ts` `runContext.ts` `commandResolution.ts` `routes.ts` + `plugins/autofigure/` |
| `officialContent/` | 官方内容目录（#787，always-on：无启用位/无 DB 表/无 REST 域）：源 = 仓库根 `official/`，`scripts/build-official-content.mjs` 编译期产 `generated.ts`（提交入库）；commands = markdown 模板 + `$ARGUMENTS` 插值 → user message 注入；skills = 目录行注入 system prompt（≤4KB）+ `read_official_skill` 渐进披露（≤64KB）；系统命令 /new /compact /model 为保留名（官方目录禁占用）；teammate 默认全继承目录提示 | `catalog.ts` `runtime.ts` `generated.ts` |

配置集中在 `src/config.ts`（env 唯一读取点 + 生产 fail-fast，即 GLOSSARY.md「配置边界」）。Prisma schema 在
`prisma/schema.prisma`（建表 SQL 由 `scripts/apply-schema.mjs` 落库，不经 prisma CLI——规避 Prisma 7 AI 守卫）。

## API / 路由

- `GET /api/health`（公开）。
- `/api/v1/auth/*` — 登录/refresh(R1 旋转)/logout/me/password/change + OIDC `oauth/<p>/login|callback`（未配 provider 时 90001）。
- `/api/v1/users` — admin 账号管理（GET 连带 containerCount / POST / PATCH / reset-password；码段 1xxxx）。
- `/api/v1/containers/*` — 容器列表/新建（同步返 creating 快照）/删除（异步信封）。
- `/api/v1/containers/<name>/pairing/` — 设备配对查询/触发/approve。
- `/api/v1/containers/<name>/wiki/{tree,page,graph,categories}` — wiki 文件树/读写/图谱（数据源 = 该容器行 owner 的 wiki 容器，每操作前置 ensure；归属校验先于 ensure——越权探测不建容器）。
- `/api/v1/containers/<name>/wiki/claims?path=` — 页 claims 旁车只读面（#789：论断 evidence + 页级漂移 fresh|drifted|null；页缺失 30040、旁车缺失 200+空 claims）。
- `/api/v1/containers/<name>/models/providers[/<pid>]` — model provider CRUD（事务 = mutation + config_meta version bump 热生效；白名单第一层未命中 → 90002 字段级 base_url）。
- `/api/v1/provider-endpoints[/<id>]` — 端点白名单 admin CRUD（#775 · 731 §3.1；非 admin → 10004）。
- `/api/v1/approval-logs` — 审批全量审计检索 admin REST（#783 · ADR 0015；judge 输入只露 hash）。
- `/api/v1/file-overwrite-logs` — 覆盖审计检索 admin REST（#785；一次 write-after-write 覆盖 = 一行）。
- `/api/v1/usage/aggregate` — LLM usage 核算聚合 admin REST（#800 · 时间窗半开 [from,to)；按 user × provider × model）。
- `/api/v1/containers/<name>/files?root=<wiki|workspace|lab>&path=&recursive=` — 统一文件 CRUD（#776：wiki = legacy 容器树读写面暂留；workspace = legacy 只读；lab = 沙箱只读 GET、`<name>` 为 sessionId；写面仅 wiki，lab/workspace → 90002）。
- `/api/v1/sessions[/<id>]` — 会话 REST 域（`messages` POST 幂等发消息 + GET 历史投影、abort、resume、rewind[scope 三态 + preview]、fork；50002 同码防探测）。
- `/api/v1/containers/<name>/chat/{sessions,approval/resolve,commands}` — chat REST 代理。
- 对话 WS 走 `/ws/chat/` 隧道（JWT subprotocol 握手；先 accept 再 close(4401) 拒未认证）。
- `GET /api/v1/events` — SSE 事件流（#773，panel_stream cookie 认证）。

**信封**：全局 #312——所有 REST 一律 HTTP 200，错误信号在 body `{code,message,data}`；「不存在 vs 越权」
同码防探测（20040/30040/40040/60040）。例外：figures 产物成功路径直发原生字节（png/svg 不包信封、
不 base64-in-JSON，错误面仍走信封）；SSE 流端点连接级认证失败走 **HTTP 401** + 信封体（#726 钉死，EventSource
看不见状态码，REST 刷新链死信号让路）。

**码段**：`0` 成功 · `1xxxx` 通用/鉴权 · `2xxxx` 容器 · `3xxxx` wiki · `4xxxx` models（40042 端点不在白名单[运行时第二层] · 40043 并发配额已满）· `5xxxx` 会话/run（50002 session_not_found · 50003 审批挂起 · 50004 approval_not_found · 50005 run 进行中禁输入/非终态拒删 · 50006 无在飞可中断 · 50007 幂等 key 同 key 异 content · 50008 文件状态重放中）· `6xxxx` files · `7xxxx` figures（70040 同码防探测 · 70043 产物不可用；70041/70042 退役保留防复用）· `9xxxx` 系统/校验。

## frontend 结构（`frontend/src/`）

- `router/index.ts` — 用户面板路由表 + 导航守卫（未登录重定向 `/login`；#800 起零 admin 残留）。
- `admin/` — admin 子应用（#800 双面板 MPA）：独立 `main.ts`/路由表（base `/admin/`，`decideAdminGuard`
  纯函数守卫）/运营 nav + 用户面板回链/`views/`（账号/端点白名单/审计/Usage/内容消息/API 文档）；
  vite 双入口产物级隔离（nginx try_files → admin.html；`verify-admin-split.mjs` 挂 build 验证用户 bundle
  不含 admin 代码）；登录角色落点 admin → `/admin/`。
- `stores/` — Pinia：`auth.ts` / `wiki.ts` / `chat.ts`（对话页投影纯 mutation，视图模型类型经
  `chat/projection.ts` 再导出）/ `fileTabs.ts`（#793 起 root=lab、切会话即换树）。
- `api/` — REST client 封装（`client.ts` 信封解析 + 401 刷新链 + 并发去抖；按域分文件）。
- `plugins/` — 插件 web 面基建（#788 + #799）：definePluginWeb 契约（props 六件 + stage 可选件）+
  `pluginComponentFor` 渲染注册表（未注册走默认工具行渲染；挂点 = ToolLine 展开区）；web 组件本体在仓库根
  `plugins/<id>/`（vite/tsconfig 双端 include 分工）。
- `chat/` — chat 核心（REST+SSE 换轨 #793）：`projection.ts`（投影归约器纯函数，applyEvent/fromProjection
  双入口同形状，零差异由 projection.test.ts 锁死；figure_run.progress 进行态装饰；#796 teammate 分区归约）/
  `useChatSession.ts`（发送幂等/门控/断线补偿/审批/slash 系统命令；SSE 按 teammateId 分流折叠区）/
  `useEventStream.ts`（SSE 薄封装：原生重连 + seq gap 检测 + 401 关流）/ `restOutbox.ts`（断线排队落盘
  50 上限丢最旧）/ `attachments.ts`（采集校验纯函数，multipart 上传换 attachmentIds）。
- `views/` — 用户面板视图：`LoginView` / `ContainersView` / `ChatView` / `WikiView` / `CategoriesView` /
  `ModelView` / `PluginsView`（#799 插件目录页）/ `FigureEditorView` / `LegalDocumentView` / `NotFoundView`。
- `components/` — `FileTree` / `MdEditor` / `WikiGraph` / ChatView 哑组件族（props-in/emits-out 零协议
  import：`ChatSidebar`/`ChatHeader`/`ChatStream`/`ChatComposer`/`ChatMessageItem`/`ThinkingCard`/`ToolLine`
  [展开区接插件渲染注册表]/`ApprovalCard`/`ApprovalDock` #796 具名徽标/`TeamFolds` #796 teammate 折叠区）。

## 关键机制与约束

- **配置单一来源**：`deploy/openclaw.json` 是全面板共享模板；`ConfigRenderer` 渲染每容器配置并强制
  安全不变量（port/bind/token 占位）。`GATEWAY_TOKEN` 每容器独立生成、经 env 注入，真值落盘为 AES 密文。
- **端口池**：宿主侧池 `19000–19999`（容器内统一 18789，靠 Docker 网络命名空间隔离），创建取最小空闲、删除回收（`containers/ports.ts`）。
- **设备配对**：chat/审批须先完成 Ed25519 设备配对（签名 challenge → 宿主 approve → deviceToken 持久化）。
  A3 双层状态机 `PAIRING_REQUIRED→APPROVING→PAIRED`（可重试无 FAILED 终态），宿主 approve 由控制面在容器内
  `openclaw devices approve` 编排（ADR 0006）。
- **docker.sock 安全**：控制面挂 `/var/run/docker.sock` = 等价 root（spec §5.4 明示风险）。本地/可信
  部署可接受；生产应限制控制面网络面或改用 rootless / 远程 TLS daemon。
- **输入 0 信任**：所有写操作经 zod schema 强制校验（`validation/schemas.ts`），禁裸读 `req.body`。
- **凭证**：LLM key 全面板共享（`LLM_API_KEY` env 注入容器，不落盘）；`CREDENTIAL_ENCRYPTION_KEYS`
  加密 gateway token 落盘密文。
- **生产部署**：`deploy/docker-compose.deploy.yml`（frontend nginx + server + redis 三服务），
  CD 经 GitHub Actions 构建 `server`/`frontend` 镜像推 GHCR 并部署宝塔宿主（见 `deploy/DEPLOY.md`）。
- **测试**：
  - server：`cd server && npm test`（vitest；接缝 1–5：wiki Port / 信封 REST / WS 桥 / hostDeps /
    编排器 Port）。容器编排集成 smoke 需真 docker daemon（自动探测门控）；BullMQ 用例需真 Redis（门控）。
  - frontend：`cd frontend && npm run test`（vitest）；`npm run build` 跑 vue-tsc 类型检查。

## Issue tracker / triage

Issues 跟踪在 GitHub `ACautomata/researcher-service`（`gh` CLI）。见 `docs/agents/issue-tracker.md`、
`docs/agents/triage-labels.md`（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。
