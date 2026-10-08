# 天津大学科研智能体平台

Vue3(TypeScript) 前端 + TS/Express 控制面的科研智能体平台（产品显示名「天津大学科研智能体平台」，
#758 Q13 / #760；内部标识 researcher-service 系不动）。控制面经 Docker SDK 编排面板自管容器
（会话沙箱 + 每用户 wiki 容器）；面板提供对话、wiki 编辑、model 配置等能力。交接规格见
`docs/research/320`（wayfinder #308 汇编）。

> **#858 OpenClaw 退役③**：openclaw-gw fleet（容器 CRUD/管理页/容器行表）已整体退役——用户视角
> 只有会话 / wiki / 模型配置。历史 OpenClaw 机制见 `docs/adr/` 与 `docs/research/`（决策历史）。

## 架构总览

```
浏览器 (Vue3 + TS)
    │ HTTP/REST (JWT Bearer) + SSE 事件流 (/api/v1/events)
    ▼
Express 控制面 (server/, localhost:8001)
    │ auth / users / files(files 路由) / wiki / models / sessions / events  (路由按域)
    │ 全局 #312 信封（HTTP 200 + {code,message,data}）+ jose HS256 认证
    ▼
Docker SDK 控制面 (sandboxes + wikiContainers)
    │ dockerode 挂 docker.sock
    ▼
面板自管容器（researcher-sandbox-<sessionId> 会话沙箱 + researcher-wiki-<userId> wiki 容器；
#858 起 openclaw-gw fleet 退役，kind 标签二值 wiki|sandbox）
```

- **控制面**：`server/` —— TS/Express（Express 5 + Prisma 7 + SQLite + BullMQ/Redis + dockerode；
  SSE 事件流同进程，WS 隧道已随 T0 #801 退役）。详见 `server/README.md`。
- **前端**：`frontend/` —— Vue 3 + Vite + TypeScript + Pinia + Router + Element Plus。详见 `frontend/README.md`。
- **编排契约**：`deploy/` —— 生产 compose + dev 栈（server+redis）+ wiki 容器镜像构建。详见 `deploy/README.md`。

## 页面

| 页面 | 功能 |
|------|------|
| 登录 | 本地账号 + R1 refresh 旋转（HttpOnly cookie）+ C1 首登强制改密 + OIDC 骨架（未配置时 90001） |
| 对话 | 会话内 agent 流式对话（REST+SSE）：权限审批、斜杠命令、思考链折叠、工具执行只显标题、teammate 折叠区 |
| wiki 编辑 | 每用户 `researcher-wiki-<userId>` 容器 `/wiki` 文件树 + Typora 式实时渲染 md 编辑器 + obsidian 风格图谱 |
| Categories 栏目 | wiki 页按 category 分组浏览（chip + 只读正文） |
| Model 配置 | 本人 model provider 的 CRUD（openai-compatible + anthropic；owner 级，#857） |
| 插件目录 | 能力可见性唯一入口 + per-user 启用位开关（#799，V1 仅 AutoFigure） |
| Figure 编辑器 | researcher-service 内置图片/图表编辑模块（编辑器工作台占位壳，F2/F3 引入） |
| 账号管理（admin 子应用） | admin 面板（`/admin/` MPA）：账号管理 / 端点白名单 / 审计检索 / Usage 核算 / 内容消息 / API 文档 |

> 全局 token 拦截：除授权白名单接口外，所有 REST 请求须带 JWT；所有 REST 一律 HTTP 200 +
> 标准信封（`{code,message,data}`）。

## 本地开发

### 前置

- Node（`server/` + `frontend/`）、Docker daemon + compose plugin。
- Docker daemon：控制面经 `/var/run/docker.sock` 编排面板自管容器（⚠ 等价 root，本地/可信部署可接受）。
- Redis（可选，runner BullMQ run 队列需要；REST 认证/账号端点不依赖）。

### 启动

```bash
# 控制面（terminal 1）
cd server
npm install
npm run prisma:generate && npm run db:apply
npm run dev                              # tsx watch，http://localhost:8001（REST + SSE 同端口）

# 前端（terminal 2）
cd frontend
npm install
npm run dev                              # Vite dev server（proxy /api → :8001）
```

> 起服务 / 真编排容器（沙箱 + wiki 容器）一律走容器化 dev 栈：
> `docker compose -f deploy/docker-compose.dev.yml up -d --build`（server:8001，与 prod 同形态，
> issue #594 / ADR 0013；纯逻辑迭代仍用上方宿主 npm test/typecheck）。

### 测试

```bash
cd server    && npm run typecheck && npm test && npm run build   # tsc + vitest + 构建
cd frontend  && npm run test && npm run build                    # vitest + vue-tsc
```

## 关键机制

- **容器编排**：面板自管容器两 kind——会话沙箱 `researcher-sandbox-<sessionId>`（1 session:1，
  惰性创建、闲置 30min 自动 stop、删 session 级联删）与 wiki 容器 `researcher-wiki-<userId>`
  （每用户一台、永久、NetworkMode none 零出网）；kind 标签二值 `researcher.kind=wiki|sandbox`
  （#858 收敛，识别准据 `server/src/containers/kind.ts`）。
- **T0 legacy 清退（#801）**：chat 隧道/设备配对/端口池/config 渲染/openclaw.json 模板/升级编排已整链
  退役；files API 只读化（root=lab 唯一读面）。
- **OpenClaw 退役③（#858）**：容器 CRUD REST/管理页/Prisma `containers` 表整链退役；
  `OPENCLAW_TEMPLATE_DIR`/`OPENCLAW_FLEET_ROOT`/`OPENCLAW_IMAGE`/`OPENCLAW_NAMED_VOLUMES`/
  `CREDENTIAL_ENCRYPTION_KEYS`/`LIFECYCLE_WORKER_CONCURRENCY` env 随 fleet 退役（落盘根改
  `DATA_ROOT`，现役消费方 = 附件上传临时区）；凭证加密链（crypto.ts）随 GATEWAY_TOKEN 落盘面退役。
- **docker.sock 安全**：控制面挂 `/var/run/docker.sock` 等价 root（spec §5.4 明示风险）；本地/可信
  部署可接受，生产应限制控制面网络面或改用 rootless / 远程 TLS daemon。

## 配置

控制面经环境变量读取（见 `server/.env.example` 与 `server/src/config.ts`；生产 fail-fast 校验）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `JWT_SECRET` | dev 不安全默认 | HS256 签名密钥；**生产必填** ≥32 字符（`NODE_ENV=production` 时 fail-fast） |
| `DATABASE_URL` | `file:./prisma/panel.db` | SQLite 连接串（Prisma driver adapter） |
| `PORT` | `8001` | 控制面监听端口（REST + SSE 同端口） |
| `DATA_ROOT` | `<cwd>/data` | 控制面落盘根（#858 前身 fleet 落盘根；现役唯一消费方 = 附件上传临时区）；生产显式 pin 绝对路径（fail-fast） |
| `SANDBOX_IMAGE` | busybox 级钉版（#776） | 会话沙箱镜像；**生产禁浮动 tag**：无 tag / `:latest` 启动即 fail-fast |
| `WIKI_IMAGE` | `ghcr.io/acautomata/researcher-service/wiki:<基线 tag>`（#784） | wiki 容器镜像（版本源 = `deploy/wiki-image/Dockerfile` FROM 基线行，wikiImage.test.ts 交叉断言）；生产禁浮动 tag 同上 |
| `LLM_API_KEY` | — | 全面板共享 LLM key（runner 侧 provider 凭证解析消费，#731 §1.3） |
| `REDIS_URL` | `redis://localhost:6379/0` | BullMQ run 队列 |

运行时部署侧环境变量见 `deploy/.env.example`（`LLM_API_KEY` / `JWT_SECRET` / AutoFigure 键等；
`cd.yml` 渲染落盘宿主，不进 git）。
