# 全栈重构 spec —— Vue3(TS) + Django 多 OpenClaw 容器管理面板

> 目的：把本仓库（FastAPI + 单文件 vanilla-JS、单容器 OpenClaw 面板）重写为标准前后端分离项目，
> **Vue3(TypeScript) + Django**，最终形态是一个**多 OpenClaw 容器管理面板**。本文档交付给一个
> 「go do it」执行 agent 直接开工。
>
> 出处：Wayfinder map [#25](https://github.com/ACautomata/researcher-service/issues/25)，
> 决策来自 tickets #26–#36（研究 + grilling + 起容器实测），详见各 `docs/research/r*.md`。
>
> 标注：**[已证]** = 起容器实测确认（#36）；**[决策]** = 用户拍板；**[待实测]** = 文档未覆盖，开工后验证。

---

## 0. 范围与删除清单

### 0.1 做什么

一个管理多个 OpenClaw 容器的面板，六页：

| 页 | 功能 |
|---|---|
| 容器管理 | OpenClaw 容器的增 / 删 / 状态查看 |
| 对话 | 与容器内 main agent 对话：流式、权限审批、斜杠命令补全、思考链折叠、工具执行只显标题 |
| Model 配置 | 每容器 OpenClaw model provider 的 CRUD（openai-compatible + anthropic 接口） |
| wiki 编辑 | 每容器 `wiki/main` 的文件树 + Typora 式实时渲染 md 编辑器 + obsidian 风格图谱 |
| 登录 | OAuth 登录骨架（OIDC 通用形态） |
| （网关） | 全局 token 拦截：除授权接口外，所有请求须带 token |

### 0.2 删除清单（其余功能全部移除）

- **后端**：现有全部 FastAPI `routes/` + `services/` + `main.py` + `database.py` + `config.py` + `models.py`。
  含旧 pipeline（kb/lit/idea/algo/dashboard/chat/obs/tasks/param/discover）、obsidian 后端、独立
  Claude Agent SDK（`routes/agent.py` + `services/agent_service.py`）、旧 auth（auth_crypto/user_settings/
  request_context/data_filter/user_credentials）。**仅作行为参照保留阅读，代码不迁移。**
- **前端**：`public/` 整个 vanilla-JS 前端（16 文件）全部删除。
- **数据库**：旧 `pipeline.db` 全部表（papers/keywords/entries/problems/ideas/algorithms/tasks/domains/
  lit_analyses/users/sessions/user_settings）废弃，不迁移。
- **保留**：`deploy/`（compose + openclaw.json + README，作为编排契约与模板来源）、`docs/research/`、
  `docs/prototypes/`、`vault/`（示例）。

---

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────┐
│  frontend/  Vue3 + Vite + TS + Pinia + Router + ElementPlus │
│  ─ 容器管理 / 对话(WS) / Model配置 / wiki编辑(树+编辑器+图谱) / 登录 │
└───────────────▲───────────────────────────▲──────────────┘
       HTTP/REST │ (JWT Bearer)              │ WebSocket (JWT via query/subprotocol)
┌───────────────┴───────────────────────────┴──────────────┐
│  backend/   Django + DRF + Channels + drf-spectacular     │
│  ─ accounts / containers / wiki / models / chat (5 apps)  │
│  ─ 全局 IsAuthenticated + Channels JWT middleware          │
│  ─ Docker SDK 控制面 (containers)                          │
│  ─ OpenClaw WS 客户端连接池 (chat)：每容器一条已配对连接      │
└───────────────▲───────────────────────▲──────────────────┘
   Docker SDK   │                        │ WS (protocol v4, 已配对 deviceToken)
┌───────────────┴────────┐  ┌───────────┴─────────────┐
│  Docker daemon          │  │  openclaw-gw-<name> 容器  │ ×N
│  openclaw-home-<name> 卷 │  │  127.0.0.1:<port>:18789  │
│  instances/<name>/...    │  │  wiki/main · openclaw.json│
└─────────────────────────┘  └─────────────────────────┘
```

**[决策] 后端**：Django + DRF（REST）+ Channels（WebSocket）。**[决策] 前端**：Vue3 + Vite + TS +
Pinia + Vue Router + Element Plus。**[决策] 容器控制面**：docker-py（Docker SDK）直接增删查容器。
**[决策] 与 OpenClaw 对话**：WS protocol v4（`connect.challenge→connect→hello-ok`，`chat.send` + runId 路由）。

---

## 2. 项目目录布局（官方风格）

**[决策]** `backend/`（标准 Django project 布局，app 平铺于 project 根，**不套 src/**）+ `frontend/`
（Vite `src/`）+ `deploy/`（沿用）。**[决策]** settings 分 `base/dev/prod` 三分。

```
repo-root/
├── backend/
│   ├── manage.py
│   ├── config/                  # Django project 配置包
│   │   ├── settings/{base,dev,prod}.py
│   │   ├── urls.py
│   │   ├── asgi.py              # Channels + DRF 路由挂载
│   │   └── wsgi.py
│   ├── accounts/                # app: 本地账号 + OIDC 登录 + JWT 签发/刷新
│   │   ├── models.py  serializers.py  views.py  urls.py  services.py  tests/
│   ├── containers/              # app: Docker SDK 编排
│   ├── wiki/                    # app: 每容器 wiki/main CRUD + 文件树 + graph
│   ├── models/                  # app: 每容器 model 配置 CRUD
│   ├── chat/                    # app: OpenClaw WS 对话桥接 + 连接池 + 事件翻译
│   └── requirements/{base,dev}.txt
├── frontend/
│   ├── index.html  vite.config.ts  package.json  tsconfig.json
│   └── src/
│       ├── main.ts  App.vue
│       ├── router/index.ts
│       ├── stores/             # Pinia: auth / containers / chat / wiki
│       ├── api/                # REST client（axios/fetch 封装，带 JWT 拦截器）
│       ├── ws/                 # Channels WS client（@vueuse/core useWebSocket）
│       ├── views/              # ContainersView/ChatView/ModelsView/WikiView/LoginView
│       └── components/         # ChatStream/ToolLine/ApprovalCard/SlashMenu/FileTree/MdEditor/WikiGraph
└── deploy/                      # compose + openclaw.json 模板来源（沿用）
```

---

## 3. 后端 —— auth（accounts）

**[决策]**（#31）

- **OAuth 形态**：通用 **OIDC / 自研 IdP**。骨架按 OIDC 授权码形态预留，`issuer/client_id/scope` 走
  `settings.OAUTH_PROVIDERS` 注册表配置，不绑死厂商；后续接具体 IdP 只加配置。
  端点：`GET /api/v1/auth/oauth/<provider>/login`（302 重定向到 IdP）+ `GET /api/v1/auth/oauth/<provider>/callback`
  （换 token），骨架期 provider 未配置时返回 **501**。
- **token 形态**：后端签发**短期 JWT access token**（前端 `Authorization: Bearer` 头携带）+
  **httpOnly cookie 刷新 token**。推荐 `djangorestframework-simplejwt`。
- **拦截落点**：DRF 全局 `DEFAULT_PERMISSION_CLASSES=[IsAuthenticated]`；授权白名单
  （`POST /auth/register`、`POST /auth/login`、`GET /auth/oauth/<p>/login|callback`、`POST /auth/token/refresh`）
  单独 `permission_classes=[AllowAny]`；WebSocket 用**自定义 Channels JWT middleware** 在握手时验同一 JWT。
- **最小登录态**：骨架同时提供**本地账号注册/登录**（走同一套 JWT 签发）+ OAuth 端点占位，
  未配 IdP 也能端到端联调。

---

## 4. 后端 —— 输入 0 信任

**[决策]**（#32）

- 所有写操作（POST/PUT/PATCH）必经 DRF Serializer `is_valid()`，**禁止视图裸读 `request.data`**；
  路径/查询参数也走 Serializer 或 `django-filter`。
- 挂 **drf-spectacular** 自动生成 OpenAPI schema（`/api/schema/` + Swagger UI），作为前端/执行 agent
  的权威契约。
- settings 层收紧默认 parser/permission。

---

## 5. 后端 —— containers（Docker SDK 编排）

**[决策]**（#27，详见 `docs/research/r27-multi-container-orchestration.md`；wiki 存储按 §5.6 定为 bind-mount，
对 r27 的命名卷表述有修正）

### 5.1 供给方式

- 每容器一个独立 home（`~/.openclaw` = 容器内 `/home/node/.openclaw`），用 **bind-mount 宿主目录**
  `instances/<name>/home`（见 §5.6）。
- **共享只读模板** `/srv/openclaw/template/researcher`（git clone ACautomata/researcher，周期 git pull）
  提供 workspace/wiki/skills 骨架；新 home 由控制面**直接在宿主 `cp -a` 预填充**（bind-mount 宿主路径可达，
  无需 init 容器）。
- 不选「每容器独立 git clone」（N 份 git 树/N 倍磁盘/N 次 clone）；不选命名卷（§5.6）。

### 5.2 openclaw.json 模板化（配置单一来源 = Django DB）

- `openclaw.json` 由 Django 侧 **Jinja 模板渲染**（`deploy/openclaw.json` 为底），每容器唯一，落到
  `OPENCLAW_FLEET_ROOT/instances/<name>/openclaw.json`，bind-mount（**ro**）覆盖进容器。
- 模板占位：`gateway_token`、`model_provider/base_url/model_id/...`、`llm_api_key_env_id`。
  `gateway.port` 容器内固定 18789，`wiki_path` 用 `~/.openclaw/wiki/main`。
- **token 策略**：每容器独立 `GATEWAY_TOKEN`（`secrets.token_urlsafe` 生成，存 DB），**env 注入 +
  `${GATEWAY_TOKEN}` 占位**，token 不落盘进 JSON。
- **LLM key 粒度 [决策]**：**全面板共享一个 `LLM_API_KEY`**（env 注入所有容器），最简；后续按需升级为
  每容器独立（SecretRef env id 参数化）。

### 5.3 端口分配

- **容器内统一 18789**（Docker 网络命名空间天然隔离，规避 browser 派生端口冲突），仅**宿主侧**分配。
- 控制面维护宿主端口池 **[决策] 19000–19999**（避开已被单容器 compose 占用的 18789），创建取最小空闲、
  记账、删除回收；bind 统一 `127.0.0.1`。
- 面板容器命名 `openclaw-gw-<name>`，打 label `app=openclaw-fleet` 与原 compose 栈（`openclaw-gateway`）隔离。

### 5.4 生命周期（docker-py）

- 连接：`docker.from_env()`。**[决策]** Django **挂 `/var/run/docker.sock`**（等价 root；本地/可信部署
  可接受，spec 标注安全风险：sock 暴露 = 宿主 root，生产应限制 Django 网络面或改用 rootless/远程 TLS daemon）。
- 创建：`containers.run(image=pin-digest, name=openclaw-gw-<name>, user="0:0",
  cap_add=[CHOWN,SETUID,SETGID,DAC_OVERRIDE], environment={4 sync flag 全关, LLM_API_KEY, GATEWAY_TOKEN,
  OPENCLAW_GATEWAY_BIND=lan, ...}, volumes={instances/<name>/home→/home/node/.openclaw(rw),
  instances/<name>/openclaw.json→…/openclaw.json(ro)}, ports={"18789/tcp":("127.0.0.1",host_port)},
  restart_policy=unless-stopped, labels={app=openclaw-fleet,...})`。创建前先 `cp -a` 预填充 home。
- 状态：`containers.list(filters={"label":["app=openclaw-fleet"]})` + 外部 HTTP `GET /health`。
- 删除：`stop() → remove(v=True,force=True)` + `rmtree(instances/<name>)`。**[决策] 默认连数据一起删**，
  不提供 keep_volume 选项（符合「面板临时增删容器」语义）。

### 5.5 状态机

`creating(cp -a 预填充 home→渲染配置→run) → running(healthy) → stopped(目录保留) → removing(终态)`，
失败回滚目录。`Instance` model 存 `name/port/token/home_dir/container_id/status/created_at`，
崩溃后按 label 扫 daemon 对账。

### 5.6 wiki 存储形态（**已定：bind-mount**）

**[决策]** wiki home 用 **bind-mount 宿主目录** `OPENCLAW_FLEET_ROOT/instances/<name>/home`
（其中 `home/wiki/main` 即 wiki），**不用 Docker 命名卷**。Django 直读/直写宿主路径，与 #29「直读
文件系统」、#34「编辑器实时编辑/自动保存/图谱」完全一致，实现最简、图谱/编辑器直接落地。
`openclaw.json` 仍单独 ro 覆盖（`instances/<name>/openclaw.json`）。命名卷方案（r27 原推荐）因宿主
路径在 Docker Desktop/VM 不可直达、迫使 wiki 读取改经容器 API，**已否决**。

> 对 §5.1/§5.4 的修正：凡「命名卷 `openclaw-home-<name>`」一律改为「bind-mount `instances/<name>/home`
> → `/home/node/.openclaw`(rw)」。预填充 = 控制面直接 `cp -a template/researcher/. instances/<name>/home/`
> （宿主路径可达，**无需 init 容器**，§5.1 的 init 机制作废）；删除 = `rmtree(instances/<name>)`。

---

## 6. 后端 —— wiki（每容器 wiki/main CRUD + graph）

**[决策]**（#29，详见 `docs/research/r29-wiki-crud-path.md`）

- **读取**：Django **直读宿主文件系统**（方案 B 下 = `instances/<name>/home/wiki/main`），不经容器
  gateway。决定性事实：官方 `wiki_apply` 只支持 narrow 修改、无法整页编辑；gateway 停了直读仍可用。
- **结构**：五核心分类 `concepts/entities/sources/syntheses/reports` + `domains/<d>/papers/` 子树并存；
  frontmatter 双 schema；遍历时跳过 `.openclaw-wiki/`。
- **写入生效**：memory-wiki **无文件监听**——直写后浏览页即时一致，但搜索索引/digest 滞后到下次
  compile。新建/删除后**异步去抖触发一次 `wiki compile`**（CLI / wiki_apply / ingest，受
  `ingest.autoCompile=true` 门控）同步机器视图。**[待实测]** compile 触发用容器 exec 是否即时生效。
- **graph**：节点 = 后端遍历文件树（跳过 `.openclaw-wiki`/index）；边 = 解析 `[[wikilink]]`
  （+可选 frontmatter `related_pages`/`source_pages`）。提供后端全库预解析端点供全局图谱。
- **API**（每容器）：`GET /containers/<name>/wiki/tree`、`GET/PUT/POST/DELETE /containers/<name>/wiki/page?path=`、
  `GET /containers/<name>/wiki/graph`。全部 Serializer 校验 path（防目录穿越）。

---

## 7. 后端 —— models（每容器 model 配置 CRUD）

**[决策]**（#28，详见 `docs/research/r28-model-config-crud.md`）

- model provider = `openclaw.json` 的 `models.providers` map 条目（key = provider id），`api` 字段区分协议：
  openai 系 `openai-completions`、anthropic 系 `anthropic-messages`。
- provider 字段：`baseUrl` / `apiKey`(SecretRef) / `api` / `authHeader` / `models[]`（每模型 `id/name/
  reasoning/input/cost/contextWindow/maxTokens`）。
- **凭证**：apiKey 用 SecretRef `{source:"env",provider:"default",id:<ENV名>}`，**只存 marker 不落明文**
  **[已证]**（#36：引用缺失 env 即报 `Environment variable "X" is missing or empty`）。
- **生效**：OpenClaw **watch 配置文件热加载，无需重启 [已证]**（#36：`config change detected` →
  `config hot reload applied`；失败时 `runtime remained on last-known-good` 不崩，env 补齐自动恢复）。
  **去 Docker 化：不再 restart**。
- **无原生注册/测试自定义 provider 的 API/CLI**，只能改 openclaw.json（Django 改 `instances/<name>/openclaw.json`
  后经热加载生效）；最近似探活：`openclaw models status --probe`、拉 schema 的 `openclaw config schema`。
- **修正点**（相对旧代码）：不同接口类型分别写 `openai-completions`/`anthropic-messages`（旧
  `_infer_provider` 全写死 `anthropic-messages` 是 bug）；**删 provider 须级联清理** `agents.defaults.model.
  primary/fallbacks` 与 `agents.defaults.models` 别名，否则留悬空引用。
- **API**（每容器）：`GET/POST/PUT/DELETE /containers/<name>/models/providers[/<pid>]`，Serializer 校验
  baseUrl/apiKey env id/models，写操作改 DB 后重渲染 openclaw.json。

---

## 8. 后端 —— chat（OpenClaw WS 对话桥接 + 连接池）

**[决策 + 已证]**（#26 + #36，详见 `docs/research/r26-ws-advanced-events.md`）

### 8.1 ⚠ 接入前提：设备配对（关键修正）

OpenClaw operator scope **不在 connect 握手声明授予**，而来自**设备配对记录 [已证]**（#36：裸 token
connect 得 `scopes:[]`，`chat.send`/`commands.list`/`tools.catalog` 全报 `missing scope`）。后端每容器
WS 客户端必须先完成一次配对：

1. 持久化 **Ed25519 设备身份**（私钥存后端安全存储/DB）。
2. 连 `ws://127.0.0.1:<port>/`，等 `connect.challenge`（含 `payload.nonce`）。
3. 签名 challenge-bound payload，`connect` 带 `device:{publicKey,signature,signedAt,nonce}` + 共享
   `GATEWAY_TOKEN`（bootstrap）+ `role:"operator"` + `scopes:[operator.read,operator.write,
   operator.admin,operator.approvals]` + `caps:["tool-events"]`。
4. 得 `PAIRING_REQUIRED` → 一次性由宿主 `openclaw devices approve <requestId>` 批准（**部署/运维动作**）。
5. 重连，持久化 `hello-ok.auth.deviceToken`（含协商 scope），后续用它连接。

> 官方明示「**不要手改 openclaw.json 造 bearer token**」。**[待实测]** device_id 精确派生与签名串规范
> （字节级），按官方 protocol 文档/客户端库实现。配对后需补测：审批事件完整 payload、工具事件确切名、
> 是否存在独立 thinking 帧（见 §8.3 风险）。

### 8.2 对话与特性帧形态

- **对话**：`chat.send{sessionKey,message,agentId:"main",idempotencyKey}` → ack 带 `runId`；`chat` 事件
  按 runId 路由，`state:delta`(deltaText/replace/message) → `final/error/aborted`。会话历史由网关按
  sessionKey 维护。多容器：WS 连接池 `dict[(url,token)→client]`（扩自旧单例）。
- **权限审批**：`exec.approval.requested` 事件推送 → 后端翻译给前端卡片 → 前端回覆经
  `approval.resolve(id,kind,decision)`（需 `operator.approvals`）。**[已证]** 方法族存在；**[待实测]**
  事件完整 payload 与 decision 取值。
- **斜杠命令**：`commands.list` 拉清单 → 前端补全；命令经普通 `chat.send` 发 `/cmd`。**[已证]** 方法存在
  （需 scope）；**[待实测]** 响应外层键名、includeArgs 元数据。
- **工具执行**：连接声明 `caps:["tool-events"]` + `gateway.controlUi.toolTitles:true`，工具事件带标题，
  前端只显标题。**[待实测]** 工具 start/end 事件确切名、payload、是否带 runId。
- **思考链**：**protocol v4 无独立 thinking 帧 [已证]**（chat.delta 仅 deltaText/replace/message）。
  思考可能以纯文本泄漏进 deltaText，**协议层无法区分思考与正文**——见 §8.3 风险。

### 8.3 ⚠ 风险与回退（思考链折叠）

**[已证]** 无独立 thinking 帧 → 前端「思考链折叠」区块**可能拿不到可与正文分离的 reasoning 流**。
回退策略（spec 以此为准，待配对实测后敲定）：
- (a) 若实测存在独立 thinking 帧：照 #33 原型渲染折叠卡。
- (b) 若无：默认整段按 text 透传，思考链折叠区块降级为「不展示」或「全文可折叠」，并在 UI 标注。
  **执行 agent 须在配对实测后确认走 (a) 还是 (b)。**

### 8.4 对前端

- 前端经 **Channels WS**（JWT 握手）连后端 `chat` consumer；后端再经该容器的已配对 WS 连 OpenClaw，
  把 chat/tool/approval 事件翻译成前端契约（text/done/error/tool/approval/cot）。
- REST：`GET /containers/<name>/chat/commands`（代理 commands.list）、`POST .../chat/approval/resolve`。

---

## 9. 前端逐页规格

**[决策]**（#30 选型 + #33/#34 UX）

### 9.1 通用

- 选型：Milkdown（md 编辑器）+ vis-network/vue-vis-network2（图谱）+ @vueuse/core useWebSocket（WS）+
  markdown-it + el-collapse + highlight.js（流式渲染）。
- API client 封装 JWT 拦截器（401 刷新/跳登录）；Pinia store 分 auth/containers/chat/wiki。

### 9.2 登录页（骨架）

本地账号注册/登录表单 + 「OIDC 登录」按钮（占位，未配置置灰/501 提示）。登录后存 access token +
刷新 cookie，跳容器管理页。

### 9.3 容器管理页

容器卡片/表格列表（name、状态 running/stopped、health、端口、model、操作），「新建容器」（填 name/
image/端口池自动分配/LLM key）+「删除」（确认；默认连数据一起删，§5.4）+「进入对话/wiki/Model」。

### 9.4 对话页（五特性，照 #33 原型 `docs/prototypes/oc-chat-page.html`）

- 布局：左侧栏（容器列表 + ＋新建容器 / 会话列表 + ＋新会话）；顶栏（会话名 + 容器 tag + 模型 tag +
  operator 配对状态）。
- **流式**：逐字渲染 + 末尾闪烁光标。
- **思考链折叠**：气泡顶部虚线卡「▶ 思考过程 · N步·Xs」，点击展开（**受 §8.3 风险约束，可能降级**）。
- **工具执行**：一行一个——图标 + `工具名`(mono) + 关键参数 + 状态（✓完成·N结果 / ⟳运行中），不展开细节。
- **权限审批**：内联橙边卡「⚠️ 请求提升权限」+ 命令块 + [批准][拒绝][查看细节]，处理后变淡显示结果。
- **斜杠命令**：输 `/` 弹补全菜单（前缀过滤，cmd mono + 描述），点击填入；清单来自 commands.list。

### 9.5 Model 配置页

当前容器 selector + provider 列表 + 新增/编辑/删除表单（api 类型 openai-completions/anthropic-messages、
baseUrl、apiKey env id、models 子表）。保存提示「热加载即时生效，无需重启」。

### 9.6 wiki 编辑页（照 #34 决策）

- **版面**：左文件树（固定）+ 中 Milkdown 编辑器（主区）+ 右 vis-network 图谱（可折叠面板，可全屏）。
- **联动**：点树节点或图谱节点都进编辑器打开该文件；保存后树与图谱实时刷新；图谱高亮当前节点。
- **保存 + 多容器**：Typora 式**自动保存**（防抖 ~800ms 落盘）；**顶部容器切换器**整体切换，切前自动落盘。
- **图谱**：默认**局部 ego 图**（当前文件 1–2 跳 wikilink 邻居）；可切**全局**（Barnes-Hut + 拖拽隐边 +
  超阈值聚类）。点节点直接打开对应 md 进编辑器。

---

## 10. 数据模型（Django，全新，废弃旧表）

- `accounts.User`（Django auth 或自定义最小）+ OIDC 绑定占位。
- `containers.Instance`：`name(uniq)/port/token/volume/container_id/status/image/llm_api_key(SecretRef env id)/
  created_at`。
- `models.ModelProvider`（或并入 Instance 的 JSON 配置；单一来源在 DB，渲染到 openclaw.json）：
  `instance(FK)/provider_id/api/base_url/api_key_env_id/auth_header/models_json`。
- `chat.Pairing`：`instance(FK)/device_id/device_token/public_key/private_key_ref/scopes/status`。
- wiki 不落库（直读文件系统），graph 可缓存。
- 迁移：全新 `migrate`，无旧数据迁移。

---

## 11. 分阶段交付计划

**[决策]** P0 骨架 → P1 核心 → P2 体验，每阶段可独立验证。

- **P0 骨架**：backend（Django project + 5 app 骨架 + settings 三分 + drf-spectacular + JWT auth + token
  拦截 + Channels JWT middleware）+ frontend（Vite + Vue3 + Pinia + Router + Element Plus 骨架 + 登录页 +
  容器管理页 CRUD 打通 Docker SDK）。
  验证：本地注册登录 → JWT 拦截生效（无 token 401）→ 建/删一个 OpenClaw 容器 → 状态可见。
- **P1 核心**：chat 对话（设备配对 + WS 桥接 + 流式）+ wiki 编辑页（树 + Milkdown + 自动保存）+
  Model 配置 CRUD（热加载）。
  验证：配对后与容器对话出流式；wiki 树点击进编辑器、编辑落盘；改 model provider 热加载生效。
- **P2 体验**：审批卡、斜杠补全、思考链折叠（按 §8.3 定 (a)/(b)）、wiki 图谱（ego + 全局）。
  验证：审批卡批准/拒绝闭环；`/` 补全可用；图谱点节点开文件。

---

## 12. 待实测清单（待拍板已全部闭合）

**已拍板（本章前各节标注 [决策]）**：wiki 用 bind-mount home（§5.6）；删容器默认连数据删（§5.4）；
Django 挂 docker.sock（§5.4）；LLM key 全面板共享（§5.2）；端口池 19000–19999（§5.3）。

**待实测（执行 agent 开工后验证）**：

| 项 | 阶段 | 说明 |
|---|---|---|
| 设备配对 device_id/签名串规范 | P1 前置 | 配对后才能 chat/审批/补全/工具事件；按官方 protocol 文档/客户端库实现 |
| 审批事件 payload / 工具事件名 / 独立 thinking 帧 | P2 | 配对后抓帧；决定思考链走 §8.3(a)/(b) |
| wiki compile 触发（容器 exec）即时性 | P1 | 直写后 wiki_search/digest 何时一致 |
| 镜像内 curl（healthcheck） | P0 | 兜底用控制面外部 HTTP 探 `/health` |
| bind-mount home 直读/直写并发一致性 | P1 | 面板写 wiki 与 agent 写 wiki 的锁边界 |

---

## 13. 关键信源

- 编排契约：`docs/research/r27-multi-container-orchestration.md`、`deploy/`、`docs/research/r6`
- WS 协议：`docs/research/r26`、`r13`、https://docs.openclaw.ai/gateway/{protocol,clients,operator-scopes}
- model CRUD：`docs/research/r28`、`deploy/openclaw.json`
- wiki：`docs/research/r29`、`r7`
- 前端：`docs/research/r30`、原型 `docs/prototypes/oc-chat-page.html`
- 实测：ticket [#36](https://github.com/ACautomata/researcher-service/issues/36)
