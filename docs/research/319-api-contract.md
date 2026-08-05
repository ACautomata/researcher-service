# 全量 REST + WS API 契约（TS/Express 重写 · 对齐基准）

> Wayfinder ticket **#319** 产出物 · Part of map **#308**。
>
> 本文档把新后端对外暴露的所有端点汇编成一份对齐基准，供**前端适配（#317）**与**执行汇编（#320）**引用。
>
> **本票是汇总（task），零新决策**：所有端点形状均已被上游票据锁定，本文只做核实与汇编。
> 凡与上游决议冲突处，**以上游决议原文为准**；本文推导的码号/形状在表中标注「转译」，与决议原文直接给出的「锁码」区分。

**依据票（上游锁定来源）**：
- **#311** 认证/账号生命周期（管理员制 · 双角色 · 配额 · bootstrap · bcrypt · JWT 平移 · refresh 旋转撤销 · OAuth2 O1 骨架）
- **#312** 容器隔离边界 + **全局错误信封契约**（最终准据）+ `Container.name` 全局唯一
- **#313** 创建/删除并发模型（进程内互斥 + BullMQ + 异步 delete + 端口入队前分配）
- **#315** WIKI 接口逐字节迁移清单（5 路由 7 方法）
- **#318** 对话桥接面（REST 代理面全保留 + 概念拆分）+ Redis 易失态
- **#321** 浏览器↔面板 WS 承载（自建 `ws` + subprotocol JWT + 4401 + 查库验签）

---

## 0. 迁移标签图例

| 标签 | 含义 |
|------|------|
| **不变** | 路由 + 成功载荷形状与现状逐字节一致，前端对该端点几乎零改动（仅信封解析统一） |
| **隔离/认证调整** | 路由不变，但归属/角色/认证语义按 #311/#312 调整（响应经同一归属前置，错误改信封） |
| **重设计** | 形状随新模型改变（如异步 delete、概念拆分、新增账号管理端点） |
| **新增** | 现状不存在、随新模型新增的端点 |
| **移除** | 现状存在、新模型下核销的端点 |

---

## 1. 全局错误信封（#312 最终准据，适用全部 REST 端点）

**所有 REST 端点一律返回 HTTP 200**，错误信号全部搬进响应体信封。

```jsonc
// 成功
{ "code": 0, "message": "ok", "data": <业务载荷> }        // code 恒为 int；data 恒在、可空 null
// 失败
{ "code": <5位分层码>, "message": "<人类可读总述>", "data": null | {field:[errors]} }
```

- `data` **恒在、可空 `null`**（成功无业务体 / 失败均带）。
- **参数校验** `code=90002`，字段明细进 `data`（`{field:[errors]}`，平移 DRF ValidationError 形状），`message` 给人类可读总述。
- **「不存在 vs 越权」同码、同文案、同空 `data`，对客户端逐字节一致** = 防探测；区分仅进服务端日志/审计（内部记 `owner_mismatch` vs `not_found`），**绝不进响应**。

### 1.1 五位分层码表

| 段 | 域 |
|----|-----|
| `0` | 成功 |
| `1xxxx` | 通用 · 鉴权 |
| `2xxxx` | 容器 |
| `3xxxx` | wiki |
| `4xxxx` | models |
| `5xxxx` | chat · pairing |
| `9xxxx` | 系统 · 校验 |

### 1.2 已锁码（决议原文给出）

| 码 | 语义 | 来源 |
|----|------|------|
| `0` | 成功 | #312 |
| `20040` | 容器不存在 / 越权（**同码**） | #312 |
| `20041` | 容器名冲突（`name` 全局唯一，不分占用者） | #312/#310 |
| `20042` | 配额超限（`User.maxContainers`） | #312/#311 |
| `90001` | OAuth provider 未配置（原 HTTP 501） | #312（修 #311 O1） |
| `90002` | 参数校验失败（字段明细进 `data`） | #312 |

### 1.3 转译码（本契约按信封规则推导，执行期可微调，但语义与分层已锁）

> 现状各视图抛 DRF/HTTP 语义码（400/404/409/503/502…），新后端全部并入信封。下表把每个旧语义映射到对应 5 位码。**「锁码」行来自决议原文；「转译」行是本契约推导。**

| 现状 HTTP 语义 | 含义 | → 信封码 | 锁/转 |
|----------------|------|----------|-------|
| **401** 未认证（无/坏 access token） | JWT 缺失或无效 | `10001` | 转译 |
| **401** 登录失败（用户名/密码错） | authenticate 失败 | `10002` | 转译 |
| **401** refresh 缺失/无效/已撤销 | 刷新凭证无效 | `10003` | 转译 |
| **403** 角色不足（user 调 admin-only） | 越权调账号管理/跨用户 | `10004` | 转译 |
| **404** 容器不存在 / 越权 | 同码防探测 | `20040` | **锁** |
| **409** 容器名冲突 | name 全局唯一撞名 | `20041` | **锁** |
| **409** 配额超限 | 建容器超额 | `20042` | **锁** |
| **400** name 非法（路径段） | 容器名 DNS-label 校验失败 | `90002` | 转译（入 `data.name`） |
| **409-busy** 目标在 provisioning（delete/models 写） | `creating` 态拒写 | `20043` | 转译 |
| **409** 残留 orphan 目录 | create 撞残留目录 | `20044` | 转译 |
| **503** LLM key 未配置 | `ConfigurationError` | `90003` | 转译 |
| **503** 端口池耗尽 / 分配冲突 | `PortPoolExhausted/PortAllocationError` | `90004` | 转译 |
| **409** home 清理失败（delete） | `InstanceCleanupError`，行标 REMOVING 可重试 | `20045` | 转译 |
| **404** wiki 页不存在 / 越权 | 同码防探测（页 + 归属） | `30040` | 转译 |
| **400** wiki path 非法（穿越/非 .md） | `InvalidPath` / `RelPathField` | `90002` | 转译（入 `data.path`） |
| **409** wiki 页已存在（POST） | `PageExists` | `30041` | 转译 |
| **404** model provider 不存在 / 越权 | provider 行缺失或归属 | `40040` | 转译 |
| **409** provider_id 冲突（POST/PUT） | unique(instance,provider_id) | `40041` | 转译 |
| **400** provider 入参非法 | serializer 校验失败 | `90002` | 转译 |
| **503** provider 写盘失败 | `ConfigWriteError`（DB 回滚） | `90003` | 转译（复用系统域） |
| **404** chat 容器不存在 / 越权 | 同码防探测 | `20040` | **锁**（复用容器域） |
| **409** 未配对 | `NotPaired` | `50041` | 转译 |
| **502** 网关离线/握手失败/RPC 失败 | pool acquire / RPC 异常（固定文案不外泄） | `50042` | 转译 |
| **502** 配对握手失败 | `PairingError` | `50043` | 转译 |
| **400** chat 入参非法（label/approval/sessions body） | serializer 校验失败 | `90002` | 转译 |
| **202 配对进行中**（PAIRING_REQUIRED） | 待宿主 approve | `0` + `data.status:"pending"` | 转译（**成功态，非错误**） |

> **HTTP 语义移交代价（#312 已确认）**：nginx/BaoTa 层、监控告警、`fetch` 原生错误分支、OpenAPI 文档均读不到错误，错误分类唯靠自定义码；前端全域适配信封解析。本契约据此**只给信封码，不保留 HTTP 状态语义**——HTTP 200 是唯一成功/失败的传输层状态。

---

## 2. 端点总表（按域）

> 「现状 HTTP 状态」列是 Django 现状，供前端对照找差异；「新契约」列是信封后的统一形状。

### 2.1 系统 / 探针

| 路由 × 方法 | 标签 | 请求 | 成功 `data` 载荷 | 错误码 | 备注 / 依据 |
|-------------|------|------|------------------|--------|-------------|
| `GET /api/health` | **不变** | — | `{ "status": "ok" }`（形状沿用现状） | — | 公开，无鉴权。健康探针，BaoTa/compose healthcheck 用 |
| `GET /api/protected` | **移除** | — | — | — | 现状 T02 契约探针，重写后无存在必要（诊断用 `me`） |
| `GET /api/schema[…]` | **重设计** | — | OpenAPI JSON / Swagger UI | — | drf-spectacular → Express 侧等价（执行期选型；非运行时契约，不阻塞前端） |

### 2.2 认证 `auth`（挂 `/api/v1/auth/`）

| 路由 × 方法 | 标签 | 请求 body | 成功 `data` | 错误码 | 备注 / 依据 |
|-------------|------|-----------|-------------|--------|-------------|
| `POST /login` | **隔离/认证调整** | `{username, password}` | `{access, mustChangePassword}` | `10002` 凭证错 · `90002` | refresh 走 `Set-Cookie: refresh_token=…; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`。`mustChangePassword` 供前端拦截至改密页（#311 C1）。仅 JSON parser（防跨站 form CSRF） |
| `POST /token/refresh` | **隔离/认证调整** | —（refresh 走 cookie） | `{access}` | `10003` refresh 无效/已撤销/重放 | **R1 旋转**：旧 refresh 撤销、`replacedByTokenId` 链、重放检测（#311）。无 body |
| `POST /logout` | **隔离/认证调整** | — | `null` | `10001` | **R1 服务端撤销**：删 `refresh_token` cookie（Path=/api/v1/auth）+ RefreshToken 行 `revokedAt` 置位。需 access |
| `GET /me` | **隔离/认证调整** | — | `{id, username, email, role, mustChangePassword, maxContainers}` | `10001` | 出参扩 `role/mustChangePassword/maxContainers`（#310/#311 新增字段）。需 access |
| `POST /register` | **重设计**（公开 → admin-only） | `{username, password(临时), email?, maxContainers?}` | `{id, username, email, role}` | `10004` 非 admin · `90002` · `20041` 用户名冲突 | **#311 管理员制**：关公开自助注册，现状 `AllowAny` 作废，变 admin 账号管理操作；新建账号 `mustChangePassword=true`（C1 强制改密） |
| `POST /password/change` | **新增** | `{oldPassword, newPassword}` | `null`（或撤销全部 refresh） | `10001` · `10002` 旧密错 · `90002` | **#311 C1**：user 改自己密码；落地 `mustChangePassword=false`。bcrypt(12) |
| `GET /oauth/<provider>/login` | **隔离/认证调整** | — | —（骨架） | `90001` provider 未配置 | **#311 O1 + #312 修**：裸 501 → 信封 `90001`。不接真 IdP、无 service 抽象 |
| `GET /oauth/<provider>/callback` | **隔离/认证调整** | — | —（骨架） | `90001` | 同上。`User.oidcIssuer/oidcSubject` 可空预留，本期无关联逻辑 |

> **账号管理（admin 建/禁用/重置密码/改配额）**：#311 锁定能力（admin 全能力 + 账号管理 + 配额 `User.maxContainers`），但**具体路由形状未在上游票定义**。`POST /register`（建账号）已列；禁用/重置/配额端点属执行期新增（如 `PATCH /users/<id>`、`POST /users/<id>/reset-password`），**不在本契约锁码范围**，由 #320 执行顺序票补全。标 **新增（骨架待定）**。

### 2.3 容器 `containers`（挂 `/api/v1/containers/`）

| 路由 × 方法 | 标签 | 请求 body | 成功 `data` | 错误码 | 备注 / 依据 |
|-------------|------|-----------|-------------|--------|-------------|
| `GET /` | **隔离/认证调整** | — | `[ContainerSummary]` 数组 | `10001` | **#312 隔离**：user 仅见自己、admin 跨用户全部。`ContainerSummary = {name, port, status, health, image, container_id, created_at, pairing}`，`pairing` 批量预取（形状见 §2.4） |
| `POST /` | **隔离/认证调整** | `{name}` | `ContainerSummary`（**creating 态快照**，同步返回） | `20041` 撞名 · `20042` 配额 · `20044` 残留目录 · `90003` LLM key · `90004` 端口耗尽 · `90002` | **#313**：端口入队前分配、入队串行；同步阶段返 creating 快照，客户端 list 轮询 seeing `creating→running`。配额 `User.maxContainers` 计数校验 |
| `DELETE /<name>` | **重设计**（同步 204 → 异步信封） | — | `null`（已入队）或 `{status:"removing"}` | `20040` 不存在/越权 · `20043` 在飞 create（**#313 改为置取消标志**，不再拒） · `20045` 清理失败可重试 | **#313 异步化**：delete 按 name 入队串行、变异步返信封、list 轮询；遇在飞 create 置取消标志统一回滚；chat pool 逐出改由 worker delete 完成后触发。现状「409-busy 拒删」语义**废弃**（改取消标志），保留码 `20043` 仅作在飞冲突的备用 |

> **状态机（#313，5 态不变）**：`creating → running ⇄ stopped → removing(终)` + `error`。`GET /` 的 `status` 字段值域 = 此 5 态。

### 2.4 配对 `pairing`（挂 `/api/v1/containers/<name>/pairing/`）

> ⚠️ **已由 ADR 0006（B-直连）取代**：本节为旧形态（A3 双层状态机 + Redis 快照 + `GET|POST /pairing/`）留档。B-直连下配对在浏览器侧（官方协议机），后端仅两个薄端点：`POST /<name>/bootstrap-token`（D1 发放）与 `POST /<name>/pairing/approve/<requestId>`（B2 docker exec approve，`Pairing` 表 pending→paired 记账）；配对快照随容器列表 `GET /containers/` 携带（形状仍为下方 `PairingStatus`，`error` 为 schema 枚举预留值、当前无写入方）。最新准据见 `docs/research/320-implementation-spec.md` §G。

| 路由 × 方法 | 标签 | 请求 | 成功 `data` | 错误码 | 备注 / 依据 |
|-------------|------|------|-------------|--------|-------------|
| `GET /` | **隔离/认证调整** | — | `PairingStatus` | `20040` 容器不存在/越权 · `90002` name 非法 | **#318**：查 Redis 进度快照 + Prisma 最终态 |
| `POST /` | **隔离/认证调整** | — | `PairingStatus`（已配对）；**进行中** `data.status:"pending" + pairing_request_id + detail` | `20040` · `50043` 握手失败 · `90002` | **#318 A3 双层**：`PAIRING_REQUIRED→APPROVING→PAIRED`，失败可重试无 FAILED 终态；deviceToken 真值归官方包。`detail` 含 `openclaw devices approve <request_id>` 提示 |

`PairingStatus = { status, device_id, scopes[], pairing_request_id, detail? }`
- `status ∈ {unpaired, pending, paired, error}`（#318 状态机 + 现状默认）。
- `scopes[]`：网关授权的 operator scope 列表（read/write/admin/approvals…）。
- **绝不外泄** `private_key_pem` / `device_token`（现状安全约束平移）。

### 2.5 对话 `chat` REST 代理面（挂 `/api/v1/containers/<name>/chat/`，**#318 全保留 + 概念拆分**）

> ⚠️ **已由 ADR 0006 作废**：本节为旧形态留档。chat REST 代理面（#339）整张删除——浏览器经隧道直连网关走官方协议机（会话 CRUD/审批/命令全部浏览器侧），后端无 chat 路由。最新准据见 `docs/research/320-implementation-spec.md` §G/§K。

> **概念拆分（#318）**：REST「对话 session」（对话线程 CRUD）≠「连接 session」`socketSession`（连接池 key 第三维，WS 侧）。两者无关，命名拆开。

| 路由 × 方法 | 标签 | 请求 | 成功 `data` | 错误码 | 备注 / 依据 |
|-------------|------|------|-------------|--------|-------------|
| `GET /sessions/` | **隔离/认证调整** | — | `{sessions:[{session_key, title, updated_at}]}` | `20040` · `50041` 未配对 · `50042` 网关失败 · `90002` | 代理网关 `sessions.list`（agentId=main + includeDerivedTitles），派生标题替代手填 title |
| `POST /sessions/` | **隔离/认证调整** | `{label?}` | `{session_key}` | `20040` · `50041` · `50042` · `90002` | 代理 `sessions.create`；key 面板生成 uuid4.hex，label 可空（网关派生标题） |
| `GET /sessions/<key>/history` | **隔离/认证调整** | query `limit?` `messageId?` | `{messages[], hasMore, nextOffset}` | `20040` · `50041` · `50042` · `90002` | 代理 `chat.history`；messages 透传（网关已 display-normalized），需 operator.read |
| `DELETE /sessions/<key>/` | **隔离/认证调整** | — | `null` | `20040` · `50041` · `50042` · `90002` | 代理 `sessions.delete`（**admin 级**，网关先归档 `.jsonl.deleted.<ts>.zst` 再删可恢复），需 operator.admin |
| `POST /approval/resolve` | **隔离/认证调整** | `{id, kind, decision}` | `{ok:true, id}` | `20040` · `50041` · `50042` · `90002` | 代理 `{kind}.approval.resolve`。`kind ∈ {exec, plugin}`，`decision ∈ {allow-once, allow-always, deny}`。**不回送权威 decision**（由网关 `*.approval.resolved` 事件广播，first-answer-wins） |
| `GET /commands` | **隔离/认证调整** | — | `[{name, description, aliases[]}]` | `20040` · `50041` · `50042` · `90002` | 代理 `commands.list`，`aliases` = textAliases（如 `/model`、`/m`），缺省回退 `/{name}`；includeArgs 元数据不透传 |

> **chat 域授权（#312 + #318）**：现状「容器为全面板共享基础设施、无 owner」经 **#312 修订**——`Container.ownerId` 已建模，chat/wiki/models 全部经同一归属前置（`_get_instance` + owner 判定，admin 全放行 / user 仅本人）传导；越权走 `20040` 同码防探测。网关侧 scope（read/write/admin/approvals）仍是第二道强制。

### 2.6 WIKI（挂 `/api/v1/containers/<name>/wiki/`，**#315 逐字节迁移**，5 路由 7 方法）

> 路由 + 成功载荷**逐字节不变**；仅错误改信封（#315 amendment → #312）。FS 安全防护复刻 codex #125（symlink 不跟随 / 只收 regular file / SKIP 集合 / 单文件降级不 500）。compile 去抖 5s，POST/DELETE 触发、PUT 不触发，docker exec 不经 gateway WS。

| 路由 × 方法 | 标签 | 请求 | 成功 `data` | 错误码 | 备注 |
|-------------|------|------|-------------|--------|------|
| `GET /tree` | **隔离/认证调整** | — | `{groups:[{kind, name, pages:[{path, title}]}]}` | `20040` · `90002` name 非法 | 五核心分类 + domains 子树；不收顶层散落页（categories 才收） |
| `GET /page?path=` | **隔离/认证调整** | query `path` | `{path, title, content}` | `20040` · `30040` 页不存在 · `90002` path 非法 | path 相对 wiki/main，须 .md、拒穿越/反斜杠 |
| `PUT /page` | **隔离/认证调整** | `{path, content}` | `{path}` | `20040` · `30040` · `90002` | 覆盖已存在页；**不触发 compile**（r29 §2.3） |
| `POST /page` | **隔离/认证调整** | `{path, content}` | `{path}` | `20040` · `30041` 页已存在 · `90002` | 新建页，**触发 compile**（去抖 5s）进搜索索引 |
| `DELETE /page?path=` | **隔离/认证调整** | query `path` | `null` | `20040` · `30040` · `90002` | 删页，**触发 compile** 清索引残留 |
| `GET /graph` | **隔离/认证调整** | — | `{nodes:[{id, title, ghost?}], edges:[{from, to}]}` | `20040` · `90002` | 节点=遍历树，边=`[[wikilink]]`+related_pages；**边不 dedup** |
| `GET /categories` | **隔离/认证调整** | — | `{<category>:[{path, title, category, excerpt}]}` | `20040` · `90002` | 按 `category:` 标记分组；键为开放词表（扫到什么返什么）；**收顶层散落页**（与 tree 不同），title 语义与 tree 不同 |

> **wiki title 语义差异（#315 锁定）**：tree 与 categories 的 `title` 取值链不同（tree 走文件树派生、categories 走标记扫描），两接口语义不同为既定，前端勿混用。

---

## 3. WebSocket `/ws/chat/`（**#321 锁定不变**）

> ⚠️ **形态已由 ADR 0006 重写**：本节旧契约（面板自建连接池壳 + 帧协议 + 事件翻译）留档。B-直连下 `/ws/chat/` 退为**隧道**——浏览器↔后端一条 WS（JWT subprotocol 握手 + 归属门，`4401` 拒绝语义保留），建立后**原样透传网关原始协议帧**（不解析/不翻译/不注入凭证）；浏览器侧官方协议机负责握手/重连/session 投影/事件消费，应用层 ping/pong 作废。最新准据见 `docs/research/320-implementation-spec.md` §K。

> 浏览器 ↔ 面板腿。面板↔网关腿由官方 `@openclaw/gateway-client` 包接管（不在本契约）。

### 3.1 握手（#321 + #314）

- **承载**：原生 `new WebSocket('/ws/chat/', ['access_token', <jwt>])`（两种 subprotocol wire format 兼容：`['access_token', jwt]` 或 `['access_token.<jwt>']`）。
- **Node 侧**：`noServer:true` + `server.on('upgrade')` 手动 `handleUpgrade`；subprotocol 须**原样回显**（`access_token` 或 `access_token.<jwt>`），否则浏览器拒握手（1006）。
- **验签**：jose `jwtVerify`(HS256) **+ Prisma 查 user 存在且 active**（与 REST `get_user()` 严格同源；禁用/删 user 立即拒）。
- **拒绝语义**：先 accept 再 `close(4401)`（4401 = 凭证过期 → 前端 `recoverUnauthorized` forceRefresh 换新 token 立即重连，不退避；区别于普通断线指数退避）。
- **握手即建连接（#318）**：面板该条 ws 一建立，即为 `(user, container, socketSession)` 向网关 `GatewayClient.start()`；**sessionId（socketSession）由面板握手成功时签发**（防前端伪造撞 key）；断连 30s grace 兜底。

### 3.2 帧协议（入 = 浏览器→面板；出 = 面板→浏览器）

**入站（浏览器 → 面板）**：

| type | 载荷 | 说明 |
|------|------|------|
| `start` | `{container, sessionKey?}` | 选容器建立桥接；重连可带 `sessionKey` 恢复活跃会话投影 |
| `send` | `{sessionKey, message}` | 发送对话消息（面板生成 idempotencyKey 幂等） |
| `resolve` | `{id, kind, decision}` | 审批回覆（kind exec/plugin，decision allow-once/allow-always/deny） |
| `ping` | — | 应用层心跳（面板回 `pong`，防看门狗误判半开） |

**出站（面板 → 浏览器）**：

| type | 载荷 | 说明 |
|------|------|------|
| `ready` | `{container}` | 桥接建立完成；随后 best-effort 补拉断线期积累待审批 |
| `text` | `{runId, text, replace?}` | chat delta 增量（追加）；`replace:true` 整段替换（前端 set 非 append） |
| `done` | `{runId}` | run 终态（final/aborted），清理该 runId 累积 |
| `error` | `{message, runId?, retryable?, id?}` | 业务/连接错误（终态帧解锁前端；`retryable` 提示可重连；审批失败带 `id` 仅复位该卡） |
| `approval` | `{id, kind, command}` | 权限审批卡（连接级，无 runId）；command 取值链 systemRunPlan.rawCommand→command→'' |
| `approvalResolved` | `{id, decision}` | 审批落定（网关权威 decision 经 `*.approval.resolved` 广播，first-answer-wins） |
| `tool` | `{runId, name, state, title, input, result}` | 工具执行帧（state start/update/result，走所属 chat run 路由） |
| `pong` | — | 心跳回显 |

> **事件翻译（#318 E1）**：网关事件经官方包 `onEvent` 投递 → TS 纯函数直译（`event_translate` 移植，无 I/O 无状态）→ 发对应 `socketSession` 的浏览器。思考链无独立帧（protocol v4），整段按 `text` 透传（前端折叠卡降级）。

---

## 4. 跨切关注点（执行对齐）

1. **信封统一是唯一错误面**：所有端点 HTTP 200 + 信封码；前端**唯一**适配点是信封解析 + 码→UI 映射。`code===0` 判成功，`data` 恒可取（可空）。
2. **防探测不分裂**：容器/子资源「不存在 vs 越权」逐字节同码同文案同空 `data`（`20040`/`30040`/`40040`/`20040`），前端**不得**试图区分；区分仅服务端日志。
3. **归属前置单点**：chat/wiki/models/containers 全部经同一 `_get_instance`+owner 判定传导（#312⑤），admin 全放行、user 仅本人。
4. **异步生命周期**：create 返 creating 快照、delete 变异步，前端统一 **list 轮询** seeing 状态迁移（#313）。
5. **凭证零落盘**：access 短寿命走 body，refresh 走 HttpOnly+Secure+SameSite=Lax cookie（Path=/api/v1/auth），R1 旋转+撤销（#311）。
6. **deviceToken / LLM key 不归面板**：deviceToken 真值归官方包（#318），LLM key env 注入容器（spec §5.2），均不落盘、不进响应。

---

## 5. 下游衔接（本契约被谁消费）

- **#317「前端适配新认证/隔离/配对模型」（grilling）**：以本契约 §1 信封 + §2 端点表 + §3 WS 帧为前端改动对齐基准；前端唯一实质改动 = 信封解析全域替换 + `me` 出参新字段消费 + 异步 delete 轮询 + 账号管理 UI（admin）。
- **#320「汇编交接规格 + 定执行顺序」（task）**：本契约是规格书的「API 契约」章节直接来源；§1.3 转译码供执行期码表定稿。
- **执行 effort**：按本契约逐端点实现 Express 路由 + 信封中间件 + WS 桥；ACL 校准逻辑（§2.5/§3.2 的网关 payload 解析）单点集中于集成层，实测后单点改。

> **遗留（非本票范围）**：admin 账号管理的禁用/重置/配额具体路由形状（§2.2 标注「骨架待定」）→ 归 #320 执行顺序票补全。本契约锁定「能力存在 + 错误码」，不锁未定义路由的精确形状。
