# Implementation Spec — TS/Express 控制面重写 + 前端拆分适配

> Wayfinder map **#308** 的交接规格 · 收尾 task **#320** 的产出物。
>
> 本文档把 map 下 13 个已 resolve 决策票（#309–#328）的决议汇编成一份**可直接交接给执行 effort** 的实现规格。
> 本规格**零新决策**：所有形状均以上游票决议原文为最终准据；凡冲突处，以上游票为准。
>
> **依据票（最终准据来源）**：
> - **#308** charting 骨架（Express+ws 同进程 / SQLite+Prisma / Redis 扩容 / 双角色认证 / 前端聚焦拆分）
> - **#309** 网关桥接复用官方包 + 包接管/自建分界 · 笔记 `docs/research/openclaw-gateway-client.md`
> - **#310** Prisma+SQLite 数据模型 · schema `docs/research/310-prisma-schema-draft.prisma`
> - **#311** 认证/账号生命周期 + OAuth2 预留
> - **#312** 容器按用户隔离边界 + 全局错误信封契约
> - **#313** 容器创建/删除并发模型
> - **#314** Node `ws` 握手 JWT 认证 · 笔记 `docs/research/node-ws-handshake.md`
> - **#315** WIKI 接口逐字节迁移清单 · 清单 `docs/research/315-wiki-express-migration.md`
> - **#316** ChatView 组件拆分 + slot 组合 · 桩 `docs/prototypes/316-chatview-{split,stubs}.vue`
> - **#317** 前端适配新认证/隔离/配对模型
> - **#318** 对话桥接面 + 自动配对触发点 + Redis 易失态
> - **#319** 全量 REST+WS API 契约 · 契约 `docs/research/319-api-contract.md`
> - **#321** 浏览器↔面板 WS 承载
> - **#328** admin 账号管理界面形状 + 路由骨架
>
> **ADRs**：本规格的配对/对话桥接形态已被 [ADR 0006](adr/0006-browser-direct-gateway-via-panel-tunnel.md)（B-直连）重写——面板从「后端胖桥接中介」退为「认证隧道 + approve 编排 + bootstrap 发放」三件薄事，配对单位从「每容器一次」改为「每浏览器设备」；协议版本/镜像以 [ADR 0007](adr/0007-gateway-ts-source-authority.md) 为准。文中配对/对话桥接章节（故事 52–72、§G、§J pairing 行、§K）已按 ADR 0006 改写；`docs/research/319-api-contract.md` 的旧契约（§2.4 pairing / §2.5 chat REST 代理）留档标注，以本文档为最新准据。

---

## Problem Statement

当前控制面是 **Django 6 + DRF + Channels** 单体后端，前端是 **Vue3 + TS**。痛点：

1. **后端技术栈负担**：Django/Channels 的异步模型、DRF 的认证/序列化与 OpenClaw 官方 Node SDK（`@openclaw/gateway-client`）之间存在语言鸿沟。对话桥接、Ed25519 设备配对、WS protocol v4 协议机全部是**手写 Python 防腐层**，维护成本高、与官方包语义对齐需反复互证。
2. **无多用户隔离**：现状容器是「全面板共享基础设施」，`Instance` 无 `owner` 字段，任何登录用户可见/可操作全部容器——无法支撑多租户使用。
3. **认证能力薄弱**：现状是 simplejwt 无状态 access+refresh（无服务端撤销/旋转）、无角色概念、无配额、公开自助注册。无法做管理员制的账号管理。
4. **前端 ChatView 大单体**：`ChatView.vue` 1092 行，连接生命周期、runId 路由、消息投影混在一起，难以测试与演进。

从用户视角：管理员想要一个**能按用户隔离容器、能管理账号（建/禁用/重置密码/改配额）、后端易维护（复用官方 SDK 而非手写协议）** 的控制面板；普通用户想要**只管自己的容器、自己的对话与 wiki**，且不感知后端重写。

## Solution

**废弃 Django 后端，以 TypeScript + Express 从零重写控制面；前端聚焦拆分 ChatView 并适配新后端模型。**

核心方案（全部 charting 阶段锁定）：

- **后端形态** = Express + `ws` **同进程单端口**（REST 走 Express，对话桥接 WebSocket 共存同一 Node 进程，JWT 握手迁移）。
- **数据库** = SQLite + Prisma（沿用零运维；Prisma 提供事务/迁移/类型安全）。**扩容**：新引入 **Redis** 承载短 TTL 易失态（配对进行中快照、每会话连接登记）；持久/审计态仍落 Prisma/SQLite。
- **认证** = 管理员 + 普通用户**双角色**（密码 bcrypt、OAuth2 预留端口、首个管理员密码明文仅首启 log 输出一次）。
- **对话桥接** = **浏览器直连网关（ADR 0006 B-直连）**：浏览器跑官方 `@openclaw/gateway-client` 的 `./browser` 协议机，经面板隧道（后端仅「认证隧道 + approve 编排 + bootstrap 发放」三件薄事）直连容器网关；**不自行实现** WS protocol v4 / 网关客户端 / Ed25519 配对。自建的是包之上的编排（面板隧道 socket、设备身份/tokenStore 持久化、自动 approve、4402 有限重连）。
- **前端** = 聚焦拆分 ChatView（8 组件 slot 组合）+ 适配新认证/隔离/配对模型，其余视图保持。

**本期范围**：仅后端从零重写 + 前端拆分/适配。OpenClaw 容器内部、`deploy/` 编排契约不变。**执行（实际编码）另起 effort，不在本规格内。**

## User Stories

### 认证与账号（#311 / #312 / #328）

1. As an admin, I want to log in with username + password, so that I receive an access token + a rotating refresh token (HttpOnly cookie) and can stay signed in securely.
2. As an admin, I want the very first admin account to be created lazily on first boot with its plaintext password printed to the log exactly once, so that I can bootstrap a fresh deployment without seeding credentials.
3. As any user, I want to be forced to change my password on first login (when `mustChangePassword=true`), so that bootstrap/issued temporary passwords don't linger.
4. As any user, I want to change my own password (old + new), so that I can rotate my credentials; on success all my refresh tokens are revoked and `mustChangePassword` clears.
5. As an admin, I want public self-registration to be closed, so that only I can create accounts.
6. As an admin, I want to create a new user (username + temporary password + optional email + optional maxContainers), so that the account is born with `mustChangePassword=true`.
7. As an admin, I want a dedicated top-level "账号管理" page (`/admin/users`) reachable from a conditional nav item (only rendered when `me.role==='admin'`), so that account management is clearly separated.
8. As an admin, I want the users table to show username / role / isActive / quota **used/limit** (via `GET /users` returning `containerCount`) / mustChangePassword / createdAt with row-inline actions, so that I can see account state at a glance.
9. As an admin, I want to disable/enable a user via a toggle with a second confirmation, so that a disabled user immediately loses access (REST + WS both reject on next verify).
10. As an admin, I want to be prevented from disabling myself, so that I can't lock out the last admin.
11. As an admin, I want to reset a user's password and see the new plaintext exactly once in a one-time modal (not retrievable after close), so that I can hand it over out-of-band; reset also revokes all that user's refresh tokens and sets `mustChangePassword=true`.
12. As an admin, I want to edit a user's maxContainers quota inline (number input), so that I can control per-user capacity.
13. As any client, I want non-admin / cross-user / nonexistent-user access to all return the **same** code (`10041`) with identical body, so that account names can't be probed.
14. As any user, I want OAuth2 login/callback endpoints to return a structured `90001` (provider not configured) skeleton instead of a bare 501, so that the port is reserved for future IdP integration without a service abstraction.

### 会话与 token（#311 / #317）

15. As any user, I want my refresh token to rotate on every refresh (old one revoked, `replacedByTokenId` chain) with replay detection, so that a stolen refresh token is detectable and unusable.
16. As any user, I want logout to server-side revoke my refresh token and clear the cookie, so that I'm actually signed out.
17. As a frontend, I want the API client's response interceptor to judge 401 by envelope code (not HTTP status), rotate both tokens (R1), and queue concurrent refreshes, so that session handling is robust against races.
18. As any user, I want my access token to be short-lived and carried in the request body/Authorization header while the refresh token lives only in an HttpOnly+Secure+SameSite=Lax cookie (Path=/api/v1/auth), so that tokens never touch disk or logs.

### 容器生命周期（#313 / #312）

19. As a user, I want to see only my own containers in the list, so that I can't see or touch other users' containers.
20. As an admin, I want to see all users' containers, so that I can operate the whole fleet.
21. As a user, I want container names to be globally unique (collision → `20041` regardless of who owns the name), so that naming is unambiguous panel-wide.
22. As a user, I want container creation to return a `creating`-state snapshot synchronously and to poll the list to see `creating→running`, so that the UI stays responsive during slow provisioning.
23. As a user, I want creation requests with the same name to be serialized through a per-name queue, so that concurrent creates/deletes can't race.
24. As a user, I want delete to be asynchronous (returns an envelope immediately, list polling observes `removing`), so that I'm not blocked on teardown.
25. As a user, I want deleting a container whose create is still in-flight to set a cancellation flag that rolls back provisioning at the next checkpoint, so that "delete immediately" doesn't wait for a half-built container.
26. As a user, I want failed cleanup to mark the row REMOVING and be retryable, so that transient teardown failures aren't permanent.
27. As a user, I want port allocation to happen before enqueue (arbitrated by a SQLite unique constraint, drawing from the four-source used-set), so that port conflicts are decided synchronously and predictably.
28. As a user, I want bind-port conflicts during provisioning to be retried in-place with a fresh port (budget = pool size), so that transient host port contention self-heals.
29. As a user, I want to be rejected with `20042` when I exceed my maxContainers quota, so that capacity is enforced.
30. As the panel, I want provisioning to run as BullMQ background jobs (Redis-backed, worker concurrency configurable, default 2) with stalled-job recovery, so that a crashed worker's job is re-run.
31. As the panel, I want an in-process `Map<name, lease>` mutex guarding create/delete per name (independent of Redis), so that double-create/double-delete within one process is fenced even if Redis is down.
32. As a user, I want the container state machine to remain 5 states (`creating→running⇄stopped→removing(terminal)` + `error`), so that status semantics are unchanged.

### 按用户隔离（#312）

33. As any client, I want every REST endpoint to return HTTP 200 with a standard envelope (`code:0`+`data` on success; 5-digit layered code on failure), so that error handling is uniform.
34. As any client, I want "doesn't exist" and "not yours" to return byte-identical `20040` (same code, same message, same empty `data`), so that ownership can't be probed; the distinction lives only in server logs.
35. As any client, I want parameter validation failures to return `90002` with per-field detail in `data` (`{field:[errors]}`), so that form errors are actionable.
36. As the panel, I want containers/wiki/models/chat to all flow through a single shared ownership gate (`_get_instance` + owner check: admin passes all, user only their own), so that isolation is enforced at one point.

### WIKI（#315）

37. As a user, I want the wiki file tree (`GET tree`) for my container, so that I can browse pages grouped by directory (open vocabulary, no hardcoded categories, top-level scattered pages excluded).
38. As a user, I want to read a page (`GET page?path=`) with its full original content, so that I can view/edit it.
39. As a user, I want to overwrite an existing page (`PUT page`) with byte-exact content preserved, so that the editor round-trips whitespace exactly; PUT must not trigger recompile.
40. As a user, I want to create a new page (`POST page`) and have it trigger a debounced (5s) recompile into the search index, so that new content becomes searchable without a compile storm.
41. As a user, I want to delete a page (`DELETE page`) and have it trigger the same debounced recompile to clear index residue.
42. As a user, I want the full graph (`GET graph`) with nodes + edges (from `[[wikilink]]` + `related_pages`), edges NOT deduplicated, ghost nodes for unresolvable links, so that the obsidian-style graph renders faithfully.
43. As a user, I want pages aggregated by `category:` marker (`GET categories`, open vocabulary keys, top-level scattered pages included), so that I can browse by topic.
44. As a user, I want wiki path traversal / symlink escape / managed-file access (`_SKIP_DIRS`/`_SKIP_FILES`) to be rejected at two layers, so that the filesystem can't be escaped.
45. As a user, I want a single corrupt file/symlink/unreadable entry to degrade gracefully (skip/fallback) rather than 500 the whole tree/aggregate.
46. As the panel, I want the wiki REST contract to remain byte-identical to the Django version (routes + success payloads), with only errors moving into the envelope, so that the frontend wiki code barely changes.

### Model provider 配置（现状 models app，随重写平移）

47. As a user, I want to CRUD model providers for my container, so that I can configure LLM backends; provider list/create/read/update/delete per container.
48. As a user, I want `provider_id` collisions within a container rejected (`40041`), so that provider keys stay unique.
49. As a user, I want provider changes to re-render `openclaw.json` and hot-reload via OpenClaw watch (DB as single source of truth), so that config changes take effect without manual container restarts.
50. As the panel, I want provider API keys referenced by env marker (`apiKeyEnvId`, e.g. `LLM_API_KEY`) never stored as plaintext, so that credentials don't touch disk.
51. As the panel, I want a failed provider write to roll back the DB row (`90003`), so that DB and on-disk config never diverge.

### 对话桥接与配对（#318 / #321 / #309）

> **形态已被 ADR 0006 重写**（见头部 ADR 标注）：以下 52–72 的旧形态故事中，「面板连接池/事件翻译/自定义 wire/配对状态机/自动触发」均被取代；保留的用户可见行为（JWT 握手 4401、会话删除、配对可观察、凭证不落盘）在 B-直连下仍成立，改写如下。

52. As a user, I want to open a WebSocket tunnel to my container authenticated by a JWT carried in the `access_token` subprotocol, so that my token never appears in URLs/logs.
53. As a user, I want the WS handshake to accept-then-close(4401) on expired/invalid credentials, so that my frontend can force-refresh the token and reconnect immediately (distinct from ordinary backoff reconnect).
54. As the panel, I want WS credential verification to check the DB for user existence + active (same source as REST `get_user()`), so that disabling/deleting a user takes effect immediately on WS too.
55. ~~As a user, I want to `start` a bridge by naming a container (optionally resuming with a `sessionKey`), so that the panel establishes a per-session gateway connection.~~ **已由 ADR 0006 取代**：浏览器官方协议机经隧道直连，无面板连接池。
56. ~~As the panel, I want the connection-pool key to be `(user, container, socketSession)`…~~ **已删除**（池壳整块删除，见 ADR 0006 决定 6）。
57. ~~As a user, I want to `send` a chat message and receive streamed `text` deltas (append) and `replace` snapshots (set), keyed by `runId`, so that I see live assistant output.~~ **已由协议机透传取代**（隧道原样透传网关原始帧）。
58. ~~As a user, I want a `done` frame when a run reaches a terminal state, so that the UI can finalize that runId.~~ **同上**（会话投影归官方包）。
59. ~~As a user, I want application-level `ping`/`pong` heartbeat frames…~~ **已删除**（应用层心跳移交官方协议机/隧道承载，ADR 0006 决定 6）。
60. ~~As a user, I want approval cards (`approval`) as connection-level frames…~~ **已由协议机事件取代**（`exec.approval.resolve` 等经隧道透传，浏览器消费网关原始帧）。
61. ~~As a user, I want to `resolve` an approval with `{id, kind, decision}`…~~ **同上**。
62. ~~As a user, I want tool execution frames (`tool` with `{runId, name, state, title, input, result}`)…~~ **同上**。
63. ~~As the panel, I want gateway events delivered via the official client's `onEvent` and translated by a pure TS function…~~ **已删除**（事件翻译移交前端官方包，ADR 0006 决定 6）。
64. ~~As a user, I want chat sessions CRUD via REST proxy (`GET/POST sessions/`, `GET history`, `DELETE sessions/<key>`)…~~ **已删除**（chat REST 代理面 #339 整张作废，ADR 0006 决定 6）。
65. ~~As a user, I want `DELETE sessions/<key>` to be admin-elevated on the gateway…~~ **已删除**；会话管理经浏览器官方协议机 `sessions.delete`（不带 archivedOnly，ADR 0006 事实 4；真实网关对未归档会话的删除行为列为遗留实测项 ③）。
66. ~~As a user, I want to resolve approvals and list slash commands via REST proxy (`approval/resolve`, `GET commands`)…~~ **已删除**（同上，浏览器直连走协议）。
67. ~~As a user, I want container creation to auto-trigger device pairing after provisioning completes…~~ **已删除**（ADR 0006 决定 3/5：配对触发点改为「浏览器首连遇 PAIRING_REQUIRED 时按需配对」，不再有创建后自动配对的后端触发器）。
68. As the panel, I want pairing to follow the B-直连形态：**每浏览器设备 × 每容器**独立配对，浏览器官方协议机首连（bootstrap token）遇 `PAIRING_REQUIRED{requestId}` → 自动 `POST …/pairing/approve` → 后端容器内 `openclaw devices approve <requestId>` → 重连拿 deviceToken（localStorage 持久化），so that 开箱即聊、配对可观察可重试。
69. As the panel, I want the deviceToken lifecycle (store/load/invalidate/retry) driven by the official package's `GatewayBrowserDeviceAuthLifecycle`（前端 `tokenStore` 回调，localStorage 按 `(clientId, deviceId, role)` 键存），so that protocol truth stays in the package.
70. As the panel, I want the host-side approve (`openclaw devices approve <requestId>` inside the container) orchestrated by the backend (`POST …/pairing/approve`，docker exec；浏览器永不接触容器 exec 通道——ADR 事实 3 物理约束)，so that PAIRING_REQUIRED can be resolved automatically.
71. As a user, I want container list to carry a pairing snapshot (`pending`/`paired`/`unpaired`)，容器页能确认配对进度，so that I can observe pairing state at a glance.
72. As the panel, I want `device_token`/`private_key_pem` never exposed in any response（真值仅经协议机 hello-ok 下发浏览器、存浏览器 localStorage，服务端 Pairing 表恒存密文），so that device credentials stay secret.

### 前端拆分（#316 / #317）

73. As a frontend maintainer, I want ChatView decomposed into 8 components (orchestration shell `ChatView` + dumb `ChatSidebar`/`ChatHeader`/`ChatStream`/`ChatComposer` + leaf `ChatMessageItem`/`ThinkingCard`/`ToolLine`/`ApprovalCard`), all props-in/emits-out, so that each piece is independently testable.
74. As a frontend maintainer, I want slot composition at the current granularity (`msg-item`/`thinking`/`tool-line`/`approvals`/`empty`/`slash-menu`/`banner`), so that presentation is injected by the parent while logic stays in the host.
75. As a frontend maintainer, I want a `chatStore` (Pinia reactive projection + pure mutations, mirroring `useWikiStore`) holding message state, so that rendering state is decoupled from connection.
76. As a frontend maintainer, I want a `useChatConnection` composable owning the imperative connection lifecycle + runId cluster (closure-held ws/timers/runId set), translating ws frames into store mutations, so that the non-reactive connection×runId cluster shares one host.
77. As a user, I want the chat UI to behave identically after the split (same wire, same reconnect, same ping/pong), so that the refactor is invisible.

## Implementation Decisions

> 全部以下游票决议为最终准据；本节按执行模块组织。**不含具体文件路径/代码片段**（决策性 shape 除外，来自原型/调研并标注）。

### A. 技术选型（#308 charting 锁定）

- **运行时**：Node + TypeScript。
- **REST 框架**：Express。全局 JSON parser（防跨站 form CSRF），错误经统一信封中间件。
- **WS 库**：`ws`（裸 RFC 6455 事实标准，非 socket.io——现状是纯原生 `new WebSocket` + 应用层 JSON，socket.io 引入即破坏 wire 兼容）。`noServer:true` + `server.on('upgrade')` 手动 `handleUpgrade`。
- **JWT 库**：`jose`（HS256，强制显式 `algorithms:['HS256']` 防算法混淆，async 不阻塞事件循环）。密钥 = 现状 `SECRET_KEY`（HS256 对称，无 RS256/JWKS）。
- **同进程单端口**：`createServer(expressApp)` + `server.on('upgrade')` 分流——Express 管普通 HTTP、`ws`(noServer) 管 upgrade，共享同一端口与同一 `SECRET_KEY`（对齐现状 daphne 单端口分流）。
- **ORM/DB**：Prisma 7 + SQLite（`datasource` 不写 url，连接串迁 `prisma.config.ts` / PrismaClient adapter）。目标 Prisma 7。
- **队列**：BullMQ（Node 最成熟队列，自带并发上限/重试/stalled-job 崩溃重跑），Redis-backed。
- **易失态存储**：Redis（短 TTL：配对进行中快照、每会话连接登记）。
- **密码**：bcrypt(cost=12)。
- **网关桥接**：`@openclaw/gateway-client` + `@openclaw/gateway-protocol`。**⚠ 两包 `dist-tags.latest` 是占位空壳 `0.0.0`，真实代码在 `2026.7.2-beta.*`，安装须显式锁 beta 版本**（#309）。
- **OpenAPI**：drf-spectacular → Express 侧等价（执行期选型；非运行时契约，不阻塞前端）。

### B. 数据模型（#310，已过 `prisma validate`）

> 平移映射：`accounts auth_user→User`、`(无)→RefreshToken`（新增）、`containers.Instance→Container`(+ownerId)、`chat.Pairing→Pairing`(一对一 Cascade)、`models.ModelProvider→ModelProvider`(多对一)、`wiki→无表`（纯容器内文件树）。

6 实体。**关键取向**（来自 #310 schema 草案）：
- **Prisma 无 union check constraint** → `status`/`role`/`api` 一律 `enum`（`ProviderApi` 用 `@map` 落连字符真值）。
- **`EncryptedTextField` → 「字段 + `<x>Encrypted` 布尔」成对**，应用层加密、DB 存密文。
- 所有表/列 `@@map`/`@map` 显式命名，与 Django 现状对齐。
- 时间戳 `DateTime @default(now())` / `@updatedAt`（SQLite 下 Prisma 存 ISO-8601 文本）。

实体与关键约束：
- **`User`**：`id cuid`、`username @unique`、`email? @unique`、`passwordHash?`(bcrypt；纯 OIDC 可空→应用层禁空密码登录)、`role Role @default(user)`、`isActive @default(true)`、`oidcSubject?`/`oidcIssuer?`（`@@unique([oidcIssuer, oidcSubject])`，双可空 SQLite 视为 distinct）、`containers[]`/`refreshTokens[]`。
- **`RefreshToken`**（新增）：`userId FK Cascade`、`tokenHash @unique`(存散列不落明文)、`expiresAt`、`revokedAt?`(null=有效)、`replacedByTokenId?`（旋转链指针，reuse 检测）。
- **`Container`**：`name @unique`(DNS-label `^[a-z][a-z0-9-]{2,29}$` 应用层校验)、`port @unique`、`ownerId FK Cascade`、`token`+`tokenEncrypted`、`homeDir`、`containerId @default("")`(空串非 NULL)、`status ContainerStatus @default(creating)`、`image`、`leaseExpiresAt?`、`pairing?`/`modelProviders[]`。**`name` 全局唯一**（#312 定夺，非按用户）。
- **`Pairing`**（一对一 Cascade）：`containerId @unique`、`deviceId`/`publicKeyPem`/`privateKeyPem`+`*Encrypted`/`deviceToken`+`*Encrypted`/`scopesJson`/`pairingRequestId`/`status PairingStatus @default(unpaired)`/`attemptVersion`。**B-直连下（ADR 0006）**：设备配对行由后端 approve 端点 upsert（pending→paired + pairingRequestId 记账），`deviceToken`/`privateKeyPem` 真值不下发服务端、列恒为密文占位。
- **`ModelProvider`**：`containerId FK Cascade`、`providerId`、`api ProviderApi`、`baseUrl`、`apiKeyEnvId`(`^[A-Z][A-Z0-9_]{0,127}$` 应用层校验)、`authHeader @default(true)`、`modelsJson`、`@@unique([containerId, providerId])`。
- **`wiki`**：无表，纯容器内文件树直读直写。

### C. 认证与账号（#311 / #312 / #328）

- **账号制** = 管理员制（关公开注册）。矩阵：admin 全能力 + 账号管理 + 跨用户容器；user 自助建/删自己容器 + 改自己密码，不碰账号与他人。
- **配额** `User.maxContainers` per-user 必填、admin 可改、超额拒（`20042`）。
- **bootstrap** = **B1 惰性首启**（空表生成 admin、明文密码仅 log 一次）+ **C1 首登强制改密**（bootstrap 与新建账号同启，`mustChangePassword=true`）。
- **OAuth2** = **O1 骨架**：不接 IdP、无 service 抽象、与本地账号无关联；login/callback 端点返信封 `90001`（#312 修，原 501）。`User.oidcIssuer/oidcSubject` 可空预留。
- **密码** bcrypt(12)。
- **JWT** access/refresh 结构平移；**refresh = R1 旋转 + 服务端撤销**（启用 RefreshToken 表，旋转链 + 重放检测）。
- **refresh 承载**：`Set-Cookie: refresh_token=…; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`。login 仅 JSON parser。logout 删 cookie + `revokedAt` 置位。
- **`me` 出参**扩 `role`/`mustChangePassword`/`maxContainers`。
- **admin 账号管理**（#328）：独立一级页 `/admin/users`（admin-only nav 条件渲染 + 首例 `meta.requiresAdmin` 守卫，非 admin 重定向 `/`）；4 端点 `/api/v1/users`（`GET /users` 连带 `containerCount` / `POST /users` / `PATCH /users/<id>`(active+配额) / `POST /users/<id>/reset-password`）；**码段收进 `1xxxx`**：`10041` 用户不存在/越权（同码防探测）· `10042` 用户名校验 · `10043` 配额非法 · `10044` 不可禁用自己。reset 回显一次性明文 modal + reset 即 revoke 该 user 全部 refresh token 强制重登 + C1。

### D. 全局错误信封（#312 最终准据，适用全部 REST 端点）

**所有 REST 端点一律 HTTP 200**，错误信号搬进响应体信封。

```jsonc
// 成功
{ "code": 0, "message": "ok", "data": <业务载荷> }        // code 恒 int；data 恒在、可空 null
// 失败
{ "code": <5位分层码>, "message": "<人类可读总述>", "data": null | {field:[errors]} }
```

- `data` 恒在、可空 `null`。**参数校验** `code=90002`，字段明细进 `data`（`{field:[errors]}`，平移 DRF ValidationError 形状）。
- **「不存在 vs 越权」同码、同文案、同空 `data`** = 防探测；区分仅进服务端日志（`owner_mismatch` vs `not_found`），绝不进响应。

**五位分层码段**：`0` 成功 · `1xxxx` 通用/鉴权 · `2xxxx` 容器 · `3xxxx` wiki · `4xxxx` models · `5xxxx` chat/pairing · `9xxxx` 系统/校验。

**已锁码**（决议原文）：`0` / `20040` 容器不存在或越权（同码）/ `20041` 名冲突 / `20042` 配额 / `90001` OAuth 未配置 / `90002` 参数校验。

**转译码**（按信封规则推导，执行期可微调，语义与分层已锁；全表见 `319-api-contract.md` §1.3）：`10001` 未认证 · `10002` 登录失败 · `10003` refresh 无效 · `10004` 角色不足 · `20043` 目标在 provisioning · `20044` 残留 orphan 目录 · `20045` home 清理失败可重试 · `30040` wiki 页不存在/越权 · `30041` wiki 页已存在 · `40040` provider 不存在/越权 · `40041` provider_id 冲突 · `50041` 未配对 · `50042` 网关离线/握手/RPC 失败 · `50043` 配对握手失败 · `90003` LLM key 未配置/写盘失败 · `90004` 端口池耗尽。

**HTTP 语义移交代价（#312 已确认）**：nginx/监控/`fetch` 原生错误分支/OpenAPI 均读不到错误，错误分类唯靠自定义码；HTTP 200 是唯一传输层状态。

### E. 容器隔离与授权（#312）

- user 仅见自己容器、admin 跨用户全部、user 间互不可见。
- **授权语义 = 全部 REST HTTP 200 + 标准错误信封**。
- **「不存在 vs 越权」同码防探测**，区分仅进服务端日志。
- **`Container.name` 全局唯一**（撞名 `20041` 不分占用者）。
- chat/wiki/models 经 `_get_instance` 同一归属前置传导（admin 全放行 / user 仅本人）；越权 `20040` 同码。
- **现有数据不迁移**（开发阶段废弃）。

### F. 容器创建/删除并发模型（#313）

- **转向「进程内互斥 + BullMQ(Redis) 队列 + SQLite 持状态」**（弃 Python 线程池 + Redis 锁）。
- 双创建/delete 护栏 = 进程内 `Map<name,租约>`（锁不依赖 Redis）。
- 后台 provisioning = BullMQ，worker 并发**可配默认 2**。
- 状态机 5 态不变：`creating→running⇄stopped→removing(终)`+`error`。
- **create 与 delete 都按 name 入队串行**（消竞态，k8s Terminating 式）。
- **delete 变异步**（返信封、list 轮询）。
- **delete 遇在飞 create = 置取消标志**，provisioning 检查点检出即统一回滚后终止（用户立即删不干等）。
- 补偿全平移：ERROR 行保留 / bind 端口冲突就地换端口重试（预算=池大小）/ 清理失败标 REMOVING 可重试。
- **端口入队前分配**（SQLite 唯一约束仲裁，已用集四来源不变）。
- 背压 = `User.maxContainers` 配额 + 端口池耗尽。
- 衔接：chat pool 逐出改由 worker delete 完成后触发；`Pairing` 经 `onDelete: Cascade` 级联；错误全走信封 `2xxxx`。

### G. 对话桥接面（#318 / #321 / #309）

> **已被 ADR 0006（B-直连）重写**。旧「包接管 vs 自建」分界（后端持 `GatewayClient` 池壳 + 事件翻译 + 自定义 wire）作废；新形态：浏览器终结协议，后端退为「认证隧道 + approve 编排 + bootstrap 发放」三件薄事。

**包接管 vs 自建分界（B-直连下重划）**：
- **包接管（浏览器侧官方 `./browser` 协议机）** = connect 握手、单连接协议机、重连+看门狗、断线恢复+session 投影、deviceToken 生命周期（`GatewayBrowserDeviceAuthLifecycle` 的 `loadIdentity`/`tokenStore`/`buildPlan`/`acceptHello`/`clearStoredToken`）、`buildDeviceAuthPayloadV3` 签名串、协议常量/版本、事件 `onEvent` 投递。
- **须自建（包之上编排，非重造协议）** = 面板隧道 socket（`createSocket` 注入，JWT 握手 + 归属门）、设备身份/tokenStore 持久化（localStorage，Ed25519 身份多 tab 共享）、自动 approve 编排（`PAIRING_REQUIRED` → `POST …/pairing/approve`）、4402 有限重连预算、配对状态快照（容器列表 pairing 字段）。

**①隧道 = 原样透传**：浏览器↔后端一条 WS（JWT subprotocol 握手 + `authenticate()` 同源验签 + **归属门**：user 只能开到自己容器的隧道，越权 `4401`）；隧道建立后**原样透传网关原始协议帧**——不解析、不翻译、不注入凭证、不做 method 级授权（ADR 0006 决定 2）。

**②配对 = 每浏览器设备 × 每容器**：浏览器首连（bootstrap token）遇 `PAIRING_REQUIRED{requestId}` → 自动 approve → 重连拿 deviceToken（localStorage）。**无 Redis 快照、无 A3 状态机**——配对记账落 Prisma `Pairing` 表（status/deviceToken+`*Encrypted`/pairingRequestId），容器列表预取展示；deviceToken 真值仍归官方包。

**③REST 薄端点**：`POST /containers/<name>/bootstrap-token`（D1，所有权门控下发 bootstrap token）+ `POST /containers/<name>/pairing/approve/<requestId>`（B2，docker exec approve）。**chat REST 代理面（#339）整张作废**。

**④浏览器↔面板承载（#321）**：**隧道建立语义保留**——JWT subprotocol 握手、`authenticate()` 同源验签 + 归属门、拒绝 = accept-then-close(4401)。**应用层 ping/pong / 看门狗 / 退避重连移交官方协议机**（协议机内置重连；面板不再有自定义 wire 帧）。

**配对触发点（ADR 0006 决定 3/5）**：不再有「创建后自动配对」的后端触发器——配对在**浏览器首连遇 `PAIRING_REQUIRED` 时按需触发**；后端 approve 编排 = 容器内 `openclaw devices approve <requestId>`（复用 `ExecPairingApprover` exec 语义 + `_REQUEST_ID_RE` 白名单防注入）。

**关键 wire 事实（#309，供执行校准）**：握手 = 等 `connect.challenge` 取 nonce → connect req(minProtocol=4,maxProtocol=4 + role operator + scopes + caps `['tool-events']` + device 签名块 + `auth.token`=bootstrap GATEWAY_TOKEN) → 成功 `hello-ok`(下发 deviceToken+scopes+policy) / 未配对 `PAIRING_REQUIRED`(嵌套 `details.requestId`)。签名串 `buildDeviceAuthPayloadV3` = 11 段 `|` 连接，包已导出直接复用。**（真网关实测已由 #378 `pairingSmoke.test.ts` 门控 smoke 覆盖，含 #378 发现：2026.7.1 网关首连 `auth` 须用 `token` 字段，官方 lifecycle 的 `bootstrapToken` 字段被当 setup code 拒。）**

### H. WIKI 迁移（#315）

- 5 路由 7 方法接口**逐字节不变**；仅错误改信封（#315 amendment → #312）。
- 错误映射（现状 HTTP 语义 → 信封）：InvalidPath→`90002`(入 `data.path`)/页不存在→`30040`/PageExists→`30041`/name 非法→`90002`(入 `data.name`)/容器或越权→`20040`。**顺序陷阱**：name 格式非法≠name 合法但无此容器，两个码不可混。
- **分层平移**：`WikiService` 纯逻辑（`FrontmatterParser`/`CategoryMarkerExtractor`/`_WikilinkResolver`/`build_graph`/`list_categories`）与 `WikiFileSystem` Port 分层。
- **行为契约**：graph 边**不 dedup**、tree 不收顶层散落页而 categories 收、两者 title 语义不同（tree frontmatter→stem 无 H1 回落；categories frontmatter→H1→stem）、wikilink 三级解析（整串 id→stem→title→ghost，先见者优先）。
- **FS 安全防护复刻 codex #125**：symlink 不跟随 / 只收 regular file / SKIP 集合（`_SKIP_DIRS={.openclaw-wiki,_attachments,_views}`、`_SKIP_FILES={index.md,AGENTS.md,WIKI.md,inbox.md}`）读写全拦 / 单文件降级不 500 / 迭代 DFS 不递归 / root 与 root 直接父 symlink 检查。
- **path 双保险**：①请求校验（拒绝对/反斜杠/`..` 穿越、须 `.md`、归一化）→ `90002`；②FS realpath 校验（`_assert_not_managed` + `realpath` 落 root 内）→ InvalidPath。
- **compile 去抖 5s**：POST/DELETE 触发、**PUT 不触发**；`Map<name,Timeout>` + `clearTimeout` 重设 + `.unref()`；docker exec `openclaw wiki compile` best-effort 吞错，**不经 gateway WS**（容器内 exec 通道）。
- **按用户隔离结合点**：归属校验挂公共前置（`_get_instance`），越权=信封 `20040` 同码（对外不区分），一处改动覆盖全端点。
- **路由层不加 name 正则**（校验在 handler 内做，保「非法→`90002`」而非 Express 默认 404）。

### I. 前端拆分与适配（#316 / #317 / #328）

**ChatView 拆分（#316，HITL prototype 评审定案）**：
- **8 组件边界**：`ChatView` 编排壳 + 哑 `ChatSidebar`/`ChatHeader`/`ChatStream`/`ChatComposer` + 叶子 `ChatMessageItem`/`ThinkingCard`/`ToolLine`/`ApprovalCard`，全零逻辑 props-in/emits-out（贴 `FileTree` 风格）。
- **slot 组合**（当前粒度）：`msg-item`/`thinking`/`tool-line`/`approvals`/`empty`/`slash-menu`/`banner` 全开——表现父注入、逻辑留宿主。
- **状态宿主 = 候选 B**：`chatStore`(Pinia 响应式投影 + 纯 mutation，贴 `useWikiStore`) + `useChatConnection` composable（命令式连接生命周期 + runId 簇，闭包持 ws/定时器/runId 集，ws 帧→store mutation；引入首个 composable 先例）。
- **关键约束**：连接生命周期×runId 路由×消息投影共享的非响应式簇必须同宿主。
- **移交执行**：store↔composable 精确分工（containerGen/historyGen/loadHistory 归属）执行时落地。

**前端适配（#317，五点）**：
- **A 会话流** = 重写 `api/client.ts` 拦截器（信封码判 401 + R1 双 token 旋转 + 并发刷新队列，消费 `me` 新字段）。
- **B 隔离** = user 同列表 + admin 复用（仅消费后端过滤，无 admin 专属容器视图）。
- **C 配对** = 详情页只读徽标 + 失败重试按钮（成功绿/失败黄+重试，无独立配对页）。
- **D 契约** = 手写 TS interface 按 `319-api-contract.md` 对齐、vue-tsc 拦截，`auth.ts` 扩 role/R1、router 用 `me.role`。

**admin 账号管理（#328）**：`AdminUsersView.vue` + `api/users.ts` + 顶层路由（无 `/admin` 嵌套壳），state 用局部 `ref` 不开 store；复用 #317 信封解析 + `me.role`。

### J. REST 端点总表（#319，按域；迁移标签：不变/隔离认证调整/重设计/新增/移除）

- **系统**：`GET /api/health`(不变，公开)；`GET /api/protected`(**移除**)；`GET /api/schema[…]`(重设计，Express 等价)。
- **auth** `/api/v1/auth/`：`POST /login`(隔离调整，返 `{access, mustChangePassword}`，refresh 走 cookie) · `POST /token/refresh`(R1 旋转，无 body，返 `{access}`) · `POST /logout`(R1 撤销) · `GET /me`(扩 role/mustChangePassword/maxContainers) · `POST /register`(重设计：公开→admin-only) · `POST /password/change`(新增) · `GET /oauth/<p>/login|callback`(O1 骨架，`90001`)。
- **containers** `/api/v1/containers/`：`GET /`(隔离调整，user 自己/admin 全部，`ContainerSummary`+`pairing` 预取) · `POST /`(隔离调整，同步返 creating 快照，端口入队前分配) · `DELETE /<name>`(重设计：同步 204→异步信封，置取消标志) · `POST /<name>/bootstrap-token`(新增，ADR 0006 D1：所有权门控下发 bootstrap token；非 running → `20046`；token 明文不进日志) · `POST /<name>/pairing/approve/<requestId>`(新增，ADR 0006 B2：容器内 docker exec approve；越权/不存在同码 `20040` 防探测、非法 requestId → `90002`、非 running → `20046`、同 requestId 重复 approve 幂等；响应仅 `{status}`，无 token 字段)。
- **pairing**（B-直连下无独立端点；快照随容器列表携带）`GET /containers/` 的 `pairing` 字段：`{status, device_id, scopes[], pairing_request_id}`，`status∈{unpaired,pending,paired,error}`（Prisma `Pairing` 表落库状态原样透传，approve 后 pending→paired；`error` 为 schema 枚举预留值，当前无写入方）；绝不外泄 `private_key_pem`/`device_token`。
- **chat REST 代理** `/api/v1/containers/<name>/chat/`(**作废**，#339 整张删除——浏览器直连走协议，ADR 0006 决定 6；旧表见 `docs/research/319-api-contract.md` §2.5，留档不执行)。
- **WIKI** `/api/v1/containers/<name>/wiki/`(逐字节不变)：`GET /tree` · `GET /page?path=` · `PUT /page` · `POST /page` · `DELETE /page?path=` · `GET /graph` · `GET /categories`。
- **users** `/api/v1/users/`(新增，#328)：`GET /users`(连带 containerCount) · `POST /users` · `PATCH /users/<id>` · `POST /users/<id>/reset-password`。

### K. WebSocket `/ws/chat/`（#321 / #318 / #314）

> **已被 ADR 0006 重写**：浏览器不再消费面板自定义帧，`/ws/chat/` 退为**隧道**（原始协议帧原样透传）。原「入站/出站自定义帧 + 事件翻译」作废。

- **隧道（tunnel）**：浏览器↔后端一条 WS（JWT subprotocol 握手 + `authenticate()` 同源验签 + **归属门**：user 只能开到自己容器的隧道，越权 `4401`/信封等价）。隧道建立后**原样透传网关原始协议帧**——不解析、不翻译、不注入凭证、不做 method 级授权。
- **握手**：原生 `new WebSocket('/ws/chat/', ['access_token', <jwt>])`（兼容 `['access_token.<jwt>']` 单值格式）。Node 侧 `noServer:true` + `server.on('upgrade')` 手动 `handleUpgrade`；subprotocol 须**原样回显**否则浏览器拒握手(1006)。验签 = jose `jwtVerify`(HS256) + Prisma 查 user 存在且 active。拒绝 = 先 accept 再 `close(4401)`。
- **帧**：隧道后不再有面板自定义 wire（`text/done/approval/tool/ping/pong` 全删）；浏览器消费网关原始帧（官方协议机负责握手/重连/session 投影/事件投递）。应用层心跳移交官方协议机/隧道承载。

## Testing Decisions

> **好测试的标准**：只测外部可观察行为，不测实现细节。对纯逻辑（事件翻译、wiki 纯函数、store 投影、状态机）而言，模块边界本身就是最高接缝，直接单测、不经 HTTP；HTTP/WS 只是壳。

**测试接缝（已与用户对齐，5 后端 + 1 前端，与 5 个后端域一一对应）**：

1. **`WikiFileSystem` Port** — 纯逻辑（`build_tree`/`build_graph`/`categories`/`FrontmatterParser`/`CategoryMarkerExtractor`/`WikilinkResolver`）对 **fake FS** 直测，注入 5 类坑（symlink / 非 regular file / 不可读 / SKIP 集合 / 降级）。**Prior art**：`backend/wiki/tests/`（含 `test_graph_api.py`/`test_categories*`）契约断言逐条对 Express 实现重跑（#315 §8 回归锚点）。
2. **Envelope REST 契约**（`app.inject` 风格）— 注入假身份（admin/user）打路由，断言 HTTP 200 + 信封码 + 归属前置。单点归属前置（#312 `_get_instance`）→ 一条接缝覆盖 containers/wiki/models/chat/pairing 全端点。**Prior art**：现状 DRF `APIClient` 视图测试。
3. **WS 桥**（`wss` 事件发射器）— 面板↔浏览器腿：拨 upgrade/JWT/4401/subprotocol 回显，注入假 `onEvent`，断言出站帧翻译（`text`/`done`/`approval`/`tool`/`pong`）。**Prior art**：`backend/chat/tests` consumer 测试。注入官方包 `onEvent` 即假网关事件源。
4. **`GatewayClient.hostDeps` / 配对编排** — B-直连下协议机归浏览器官方包：后端接缝 = 容器路由（注入假 runtime docker exec，断言 approve 端点归属门/requestId 传参/exec 调用/配对落库/响应无 token 明文——**Prior art**：`server/test/pairingApprove.test.ts`）；前端接缝 = `gatewayChat` 模块边界（注入假 `createSocket` + 假 tokenStore + fake 网关帧序列，断言 PAIRING_REQUIRED → approve → hello-ok 下发 deviceToken → tokenStore 收到 store → 下次连接用 deviceToken——**Prior art**：`frontend/src/chat/gatewayChat.test.ts`）。官方协议机本身不测（官方包职责，连同 v4 握手/重连/deviceToken 生命周期一起豁免）。**Prior art（旧形态）**：`backend/chat/tests` `pool.py`/`pairing.py` 测试。
5. **编排器 Port**（容器生命周期）— 注入假 docker + 假 BullMQ（内存 fake），断言 5 态机 + 取消标志 + 端口入队前分配 + 补偿（换端口重试 / REMOVING 可重试）。**Prior art**：`backend/containers/` 测试（现有 docker fake + 集成 smoke 门控）；集成 smoke 需真 docker daemon，默认 skip（自动探测门控，对齐 `backend/README.md`）。
6. **前端接缝**：`chatStore` + `useChatConnection` — 注入假 ws，测 store 投影纯 mutation + runId 路由 + 连接生命周期；组件 props/emits 哑测。**Prior art**：`useWikiStore`/`FileTree` 测试形态。

**贯穿原则**：
- 防探测不分裂 — 对「不存在 vs 越权」逐字节同码（`20040`/`30040`/`40040`）做断言，且测试**不得**试图区分两者。
- 归属前置单点 — 每个域至少一条「user 越权访问他人资源 → 同码」与「admin 跨用户 → 放行」对偶用例。
- 异步生命周期 — create 返 creating 快照、delete 变异步，测试用 list 轮询观察状态迁移（#313）。
- 凭证零落盘 — 断言 `private_key_pem`/`device_token`/refresh token 明文不出现在任何响应体。
- 集成 smoke 门控 — 真 docker daemon 才跑的编排集成测试默认 skip，自动探测（对齐现状）。**配对闭环 smoke**（`server/test/pairingSmoke.test.ts`，#378）在真容器验证 bootstrap 首连 → `PAIRING_REQUIRED` → approve → hello-ok → deviceToken 全流程（ADR 0006 遗留实测项 ①，默认 skip、真跑无 skip）。

## Out of Scope

- **OpenClaw 容器内部逻辑、`deploy/openclaw.json` 编排契约** —— 本期不动（map #308 明示）。**注**：ADR 0006 决定 7 修订了「凭证真值不落盘」的表述（bootstrap token/deviceToken 可下发给容器属主浏览器设备），属安全不变量语义更新，非编排契约变更；deploy 契约文档（`deploy/README.md`）已同步。
- **实际的代码编写/执行** —— 本规格只产决策与规格，执行另起 effort（#308 终点）。
- **现有数据迁移** —— 开发阶段废弃，不做 Django→Prisma 数据搬运（#312）。
- **OAuth2 真实 IdP 接入** —— 仅 O1 骨架 `90001`，不接 IdP、无 service 抽象（#311）。
- **admin 账号管理以外的 admin 专属容器视图** —— admin 复用 user 同列表，仅消费后端过滤（#317）。
- **HTTP 状态语义的保留** —— 全部归并信封码，HTTP 200 是唯一传输层状态（#312）。
- **OpenAPI 工具链选型** —— 执行期定，非运行时契约，不阻塞前端（#319）。

## Further Notes

### 交接规格仍留给执行 effort 的开放点（#320 要求标注）

1. **`store↔composable` 精确分工**（#316 移交）：`containerGen`/`historyGen`/`loadHistory` 在 `chatStore` 与 `useChatConnection` 之间的最终归属，执行时落地。
2. **admin 账号管理 4 端点的精确请求/响应形状**（#319 §2.2「骨架待定」已由 #328 补全路由骨架与码段，但 payload 字段级形状在执行期与 #319 契约对齐定稿）。
3. **`§1.3` 转译码的执行期微调**：转译码语义与分层已锁，具体码号执行期可微调（以 `319-api-contract.md` 为基准定稿）。
4. **OpenAPI/Swagger 的 Express 侧等价工具选型**（执行期）。
5. **ACL 校准逻辑**（`319` §2.5/§3.2 网关 payload 解析）单点集中于集成层，实测后单点改。
6. **BullMQ/Redis 的具体部署拓扑**（连接串、queue 名、worker 进程形态）执行期定。
7. **两种 subprotocol wire format 的 Node 实测**（#314 附）：起 Node 原型后用格式①②各实测一次。

### 建议的实现里程碑顺序（#320 要求定顺序）

> 主线后端先行，前端在认证/契约稳定后跟进；**采用「并行双跑、按域切换」而非 big-bang**：新 Express 服务与旧 Django 并存于过渡窗口，按域逐个切换前端指向，最后退役 Django。

1. **M0 骨架**：Express + `ws` 同进程 + 信封中间件 + jose `authenticate()`（REST/WS 共享）+ Prisma schema 落地 + 迁移。→ verify：`GET /api/health` + 信封单测 + `prisma validate`。
2. **M1 认证与账号**：login/refresh/logout/me/register(admin)/password/change + R1 旋转 + bootstrap B1 + C1 + OAuth2 骨架 + users 4 端点。→ verify：信封 REST 契约测试（接缝 2）+ R1 重放检测用例。
3. **M2 容器生命周期**：编排器 Port + BullMQ worker + 端口池 + 5 态机 + 异步 delete + 取消标志。→ verify：编排器 Port 测试（接缝 5）+ 集成 smoke（门控）。
4. **M3 WIKI**：`WikiFileSystem` Port + 纯逻辑平移 + 5 端点 + compile 去抖。→ verify：wiki 契约断言逐条重跑（接缝 1）。
5. **M4 对话桥接**：~~`GatewayClient` 集成 + 多租户池壳 + 配对状态机 + 自动配对触发器 + WS 桥 + 事件翻译 + chat REST 代理~~ **已由 ADR 0006 重写**——浏览器直连网关（官方 `./browser` 协议机）+ 隧道 + 每浏览器设备配对 + 4402 有限重连；后端仅 bootstrap 发放 / approve 编排两薄端点。→ verify：pairing approve 测试（`server/test/pairingApprove.test.ts`）+ `gatewayChat` 测试（`frontend/src/chat/gatewayChat.test.ts`）+ 真网关配对闭环 smoke（`server/test/pairingSmoke.test.ts`，门控）。
6. **M5 前端适配**（可与 M3/M4 部分并行）：`api/client.ts` 拦截器重写 + `me.role` 消费 + 异步 delete 轮询 + ChatView 拆分 + admin users 页。→ verify：vue-tsc + vitest（接缝 6）。
7. **M6 切换退役**：前端指向新后端、按域回归、退役 Django。

**过渡并存说明**：M0–M5 期间新 Express 服务独立于旧 Django 运行（不同端口/路径前缀），前端按域灰度切换；M6 完成切换后退役 Django。Redis 自 M2 起需要（BullMQ + 易失态）。
