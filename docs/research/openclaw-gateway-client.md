# OpenClaw 网关客户端协议与对话桥接 / 自动配对调研

> 研究 ticket：issue #309（wayfinder 地图 #308 的子任务）。
> 目的：为一手来源驱动的「TS/Express 后端重写对话接口 + 容器创建后自动配对」决策提供事实依据。
> 日期：2026-08-01。本文件只做事实记录与结论，不改业务代码。

一手来源：
- 官方文档 `https://docs.openclaw.ai/gateway/clients`（WebFetch 拉取，2026-08-01）。
- npm registry API（非 web 页面，页面 403）`@openclaw/gateway-client` / `@openclaw/gateway-protocol`，解包 `2026.7.2-beta.6` tarball 读 `dist/*.d.mts` 类型定义（API/事件/schema 的权威来源）。
- 本仓库现状实现：`backend/chat/`（pairing / pairing_ws / device_crypto / pool / consumers / event_translate / models）+ 防腐层 `backend/integration/openclaw/`（wire 子包 / wire_client）。

---

## 1. 两个 npm 包:版本与 API 面

### 1.1 版本与发布形态(关键事实)

- 两个包在 npm 的 `dist-tags.latest` 都指向 **`0.0.0`**，description 是「Reserved package name」——**占位版本**。
- 真实代码在日历版本号的 beta：**`2026.7.2-beta.4 / .5 / .6`**。要拿到真实实现须显式锁版本（`npm i @openclaw/gateway-client@2026.7.2-beta.6`），裸 `npm install` 装到的是空壳 `0.0.0`。
- 两个包都**无 README**（registry `readme` 字段为空）；文档全靠官方站 + 包内 `.d.mts` 类型。
- 运行依赖：
  - `@openclaw/gateway-client` → `ws@8.21.1`、`ipaddr.js@2.4.0`、`@openclaw/gateway-protocol@2026.7.2-beta.6`。
  - `@openclaw/gateway-protocol` → `typebox@1.3.6`（schema/运行时校验）。

### 1.2 `@openclaw/gateway-protocol`(纯类型/schema 层)

description:「Typed schemas and runtime validators for the OpenClaw Gateway WebSocket protocol」。
subpath exports（`dist/*.mjs` + `.d.mts`）：`.`、`./schema`、`./version`、`./client-info`、`./frame-guards`、`./startup-unavailable`、`./connect-error-details`、`./gateway-error-details`。

权威常量（`version.d.mts`）：

| 常量 | 值 | 含义 |
|---|---|---|
| `PROTOCOL_VERSION` | `4` | 当前 wire 版本 |
| `MIN_CLIENT_PROTOCOL_VERSION` | `4` | 网关接受的最低普通客户端协议 |
| `MIN_NODE_PROTOCOL_VERSION` | `3` | 认证 node 的最低协议 |
| `MIN_PROBE_PROTOCOL_VERSION` | `3` | 轻量 probe 的最低协议 |

`client-info.d.mts`：
- `GATEWAY_CLIENT_IDS`：17 个受信 client id（`gateway-client` / `webchat-ui` / `openclaw-control-ui` / `node-host` / `openclaw-worker` / `openclaw-probe` / `test` / …）。本仓库用 `gateway-client`。
- `GATEWAY_CLIENT_MODES`：`webchat | cli | ui | backend | node | worker | probe | test`。本仓库用 `backend`。
- `GATEWAY_CLIENT_CAPS`：`agent-kind / approvals / exec-approvals / inline-widgets / run-tool-bindings / session-scoped-events / plugin-approvals / task-suggestions / terminal-offset-seq / tool-events / ui-commands`。本仓库只声明 **`tool-events`**（实时工具执行流由它门控）。
- `GatewayClientInfo`（hello/connect 上报）：`{id, displayName?, version, platform, deviceFamily?, modelIdentifier?, mode, instanceId?}`。

`connect-error-details.d.mts`（结构化 connect 错误码，权威）：
- `ConnectErrorDetailCodes` 含 `PAIRING_REQUIRED`，以及一族 `AUTH_*` / `DEVICE_AUTH_*`（`DEVICE_AUTH_NONCE_MISMATCH` / `DEVICE_AUTH_SIGNATURE_INVALID` / `DEVICE_AUTH_SIGNATURE_EXPIRED` …）/ `PROTOCOL_MISMATCH` / `CLIENT_VERSION_MISMATCH`。
- `ConnectPairingRequiredReasons`：`not-paired / role-upgrade / scope-upgrade / metadata-upgrade`——**scope/role 升级会触发新的 pending 配对请求**。
- `PairingConnectErrorDetails`：`{code:'PAIRING_REQUIRED', reason?, requestId?, remediationHint?, recommendedNextStep?, retryable?, pauseReconnect?, deviceId?, requestedRole?, requestedScopes?, approvedRoles?, approvedScopes?}`。
- `recommendedNextStep ∈ {retry_with_device_token, update_auth_configuration, update_auth_credentials, wait_then_retry, review_auth_configuration}`。

`frames-BPnee-QV.d.mts`（typebox schema，wire 帧契约）：
- 顶层帧：`RequestFrame {type:'req',id,method,params?,traceparent?}`、`ResponseFrame {type:'res',id,ok,payload?,error?}`、`EventFrame {type:'event',event,payload?,seq?,stateVersion?}`。
- `ConnectParamsSchema`：`{minProtocol,maxProtocol,client{…},caps?,commands?,permissions?,role?,scopes?, device?{id,publicKey,signature,signedAt,nonce}, auth?{token?,bootstrapToken?,deviceToken?,password?,approvalRuntimeToken?,agentRuntimeIdentityToken?}, locale?,userAgent?}`。
- `HelloOkSchema.auth`：`{deviceToken?, role, scopes[], issuedAtMs?, deviceTokens?[]}`——**deviceToken 在 hello-ok.auth 下发**。
- `HelloOkSchema.policy`：`{maxPayload, maxBufferedBytes, tickIntervalMs, allowedSessionVisibilities?, …}`（与本仓库 `GatewayPolicy` 对应）。
- `ErrorShapeSchema`：`{code,message,details?,retryable?,retryAfterMs?}`。

### 1.3 `@openclaw/gateway-client`(Node 参考客户端)

description:「Reference WebSocket client for the OpenClaw Gateway protocol」。
subpath exports：`.`、`./browser`（浏览器安全版）、`./timeouts`、`./readiness`。

核心导出（`index.d.mts` re-export 集线，实现分散在 `readiness-*` / `protocol-client-*` / `session-subscriptions-*`）：

- **`GatewayClient`** 类：构造吃 `GatewayClientOptions`，方法是 `request<T>(method, params?, opts?) => Promise<T>` + 生命周期 `start()/stop()/stopAndWait()`。**高层语义（chat.send/chat.history/sessions.subscribe）不在类上封装成命名方法，而是走通用 `request(method,…)` + `onEvent` 回调**。
- `GatewayClientOptions`（瘦身列出对话桥接相关字段）：
  - 连接/握手：`url, origin, minProtocol, maxProtocol, connectChallengeTimeoutMs, preauthHandshakeTimeoutMs, tickWatchTimeoutMs, requestTimeoutMs, tlsFingerprint`。
  - 认证：`token, bootstrapToken, deviceToken, password, approvalRuntimeToken, agentRuntimeIdentityToken`。
  - 身份/角色：`clientName, clientDisplayName, clientVersion, platform, deviceFamily, mode, role, scopes, caps, commands, permissions, instanceId, deviceIdentity`。
  - 设备身份托管回调 `hostDeps`：`loadOrCreateDeviceIdentity / signDevicePayload / publicKeyRawBase64UrlFromPem / loadDeviceAuthToken / storeDeviceAuthToken / clearDeviceAuthToken`（**Ed25519 签名与 deviceToken 持久化由宿主注入**，与本仓库 `device_crypto.py` + `Pairing` 模型同构）。
  - 事件回调：`onEvent(evt), onHelloOk(hello), onConnectError(err), onReconnectPaused(info), onClose(code,reason,info), onGap({expected,received})`。
- **`GatewayProtocolClient<TPlan>`**（`./browser` 侧）：浏览器安全的单 socket/握手/重连/帧状态机——「environment adapters 拥有 transport 与 auth 策略，本类拥有 socket/handshake/reconnect/frame 状态机」。`request/addEventListener/closeSocket/resetReconnectBackoff`。
- **Session 投影协调器**（`session-subscriptions-*`）：`createSessionProjection / reduceSessionProjection / reconcileSessionProjectionSnapshot / projectLiveSessionMessage / GatewaySessionMessageSubscriptionCoordinator` 等——这是 npm 客户端内置的「会话/消息/in-flight run 投影 + 序号 reconcile + 重连恢复」机制，对应本仓库手写的 `RecoveryCoordinator` + `RunEventRouter`。
- 辅助：`waitForEventLoopReady` / `startGatewayClientWhenEventLoopReady`（事件循环就绪探测，Node 侧启动前对齐 IO 就绪）；`timeouts`（challenge/握手超时钳制）。

> 体量判断：npm 的 `GatewayClient` 是**通用、重量级**参考客户端（重连监督、事件循环就绪、TLS 指纹、设备 token 托管、session 投影协调器、readiness 探测全内置）。本仓库现状是**手写、精简的 Python 客户端**，只实现对话桥接所需子集。TS/Express 重写若用 npm 包，会话投影/重连/设备身份托管可大量复用，但要接受其 beta 版本与较重的内置策略。

---

## 2. WS protocol v4 握手 + deviceToken + 事件语义

### 2.1 握手流程(operator/WebChat 客户端,官方文档 + 本仓库实现互证)

1. 客户端持久化一个 **Ed25519 设备身份**（本仓库 `DeviceCrypto.generate_identity()`：私钥 PKCS8 PEM / 公钥 SPKI PEM；`deviceId = sha256(raw 公钥 32B).hex`；线上公钥 = raw 32B 的 base64url 无 padding）。
2. 连 `ws://host:port/`，**等 `connect.challenge` event**，取其 `nonce`（官方文档另说用其 `ts` 作 `signedAt`；本仓库 `signedAt = time.time()*1000`，`nonce` 取自 challenge.payload.nonce）。无 `nonce`（或非负整数 `ts`）的 challenge 视为非法。
3. 发 `connect` req：`minProtocol=4,maxProtocol=4` + `client{id,mode,platform,version}` + `role:'operator'` + `scopes` + `caps:['tool-events']` + `device{id,publicKey,signature,signedAt,nonce}` 签名块 + `auth.token`（bootstrap 用 `GATEWAY_TOKEN`）。
   - 签名串 = `buildDeviceAuthPayloadV3`：**11 段 `|` 连接**（`v3|deviceId|clientId|clientMode|role|逗号scopes|signedAtMs|token|nonce|platform(小写)|deviceFamily(小写)`），上游逐字节比对，metadata 先 trim+转小写。Ed25519 签名输出 base64url。
4. 成功 → **`hello-ok`**（connect 的 res ok），`payload.auth.deviceToken` + `auth.scopes`（协商结果）+ `policy`。**持久化 deviceToken，后续连接用它**（token rotation 不能扩大已批准的 pairing contract）。
5. 未配对 → res not ok，`error` 外层 `code='NOT_PAIRED'`、内层 `details.code='PAIRING_REQUIRED'`、`details.requestId`（官方 ghcr 2026.6.34 镜像为两段嵌套码；旧实现/fork 可能外层直接 `PAIRING_REQUIRED`）。
   - 宿主侧恢复：`openclaw devices list` → `openclaw devices approve <requestId>`，再按 `details.recommendedNextStep` 重试。

### 2.2 事件/方法语义(对话桥接相关子集)

请求方法（req → res）：

| 方法 | 用途 | 需要 scope |
|---|---|---|
| `connect` | 握手（见上） | — |
| `chat.send` | 发消息（ack 回 runId；带 `idempotencyKey` 幂等去重） | `operator.write` |
| `chat.history` | 取 transcript（`messages[].content` 多态：user=字符串 / assistant=`[{type:text,text}]`） | `operator.read` |
| `sessions.list` | 会话目录 | `operator.read` |
| `sessions.create` / `sessions.delete` | 建/删会话（delete 为 admin 提升） | `operator.write` / admin |
| `sessions.subscribe` / `sessions.messages.subscribe` | 订阅会话/会话消息流（重连恢复用） | `operator.read` |
| `exec.approval.list` | 补拉待审批（断线恢复） | `operator.approvals` |
| `exec.approval.request` / `{exec,plugin}.approval.resolve` | 审批请求 / 回覆（resolve 带 `id+kind+decision`） | `operator.approvals` |
| `commands.list` | 拉斜杠命令清单 | — |
| `artifacts.download` / `usage.cost` / `sessions.usage` / `config.patch`(admin) | 产物下载 / 用量 / 管理 | 视 scope |

事件（`type:'event'`，对话桥接实测校准过）：

- **`chat`**（挂 runId）：`payload.state ∈ {delta, final, aborted, error}`。
  - `delta`：`deltaText` 增量；`replace:true + message 快照` → 整段替换（前端 set 非 append）。
  - `final`：`message`（dict `{role,content:[{type:text,text}]}`）可能含未发尾部 → 先补 text 再 done。
  - `aborted` → done；`error` → `errorMessage`(退 `errorKind`)。
- **`agent`**（工具执行流，需 `tool-events` cap）：`payload.stream:'tool'` + `data.phase:'start'/'update'/'result'`，字段在 `data` 子对象（`name/toolCallId/args` start；`partialResult` update；`result/isError/meta` result）。**实测无独立 `agent.tool.start/result` 事件**。
- **审批**：`exec.approval.requested` / `plugin.approval.requested`（**连接级**，不挂 runId）→ 出审批卡 `{id,kind,command,sessionKey}`（实测 `command/sessionKey` 在 `payload.request` 下）；`exec.approval.resolved` / `plugin.approval.resolved`（他端 resolve 后广播，权威 decision）。
- 思考链：protocol v4 **无独立 thinking 帧**，整段按 text 透传（前端降级折叠卡）。
- 会话/用量：`sessions.changed`（按 sessionKey，含 `inputTokens/outputTokens/totalTokens/contextTokens/estimatedCostUsd`）；`sessionInfo.hasActiveRun / activeRunIds`；`inFlightRun{runId, text, plan?}`（重连恢复采用）。

重连恢复（官方 + 本仓库 `RecoveryCoordinator` 一致）：重建 `sessions.subscribe` + 选中会话的 `sessions.messages.subscribe` → `chat.history` 覆盖本地 → 若有 `inFlightRun` 采用其 `runId/text/plan` → 后续 `agent` 事件按 `payload.runId/seq` reconcile（每 run 独立维护最高已收序号，前向 gap → 重载权威历史）。

---

## 3. 现状对话桥接面(backend/chat + integration/openclaw)

数据面结构：浏览器(Vue) ⇄(Channels WS, JWT) `ChatConsumer` ⇄ 池化 `OpenClawWireClient` ⇄ 容器网关。

### 3.1 各模块职责

- **`integration/openclaw/wire/`（防腐层，wire 域单一来源）**
  - `__init__.py`：常量族——`PROTOCOL=4`、`CLIENT_ID='gateway-client'`、`CLIENT_MODE='backend'`、`ROLE='operator'`、`AGENT_ID='main'`、`SCOPES`(read/write/admin/approvals)、`CAPS=['tool-events']`、`REQUIRED_SCOPES={read,write,approvals}`、审批/工具事件名族；`GatewayPolicy`（hello-ok policy 值对象）；`ConnectFrameBuilder.pairing()/session()`（两种 connect 帧）；wire 异常族（`ChatClientError`/`ChatConnectError`/`ChatSendError`/`ChatSendTransmittedError`/`ChatPayloadTooLargeError`）。
  - `wire_client.py` `OpenClawWireClient`（**Facade**，对单容器一条已配对长连接）：组合 5 协作者——
    - `ConnectionCore`：ws 连接生命周期（握手/challenge/看门狗/dead/4000/aclose），唯一 I/O 独占；
    - `RequestRouter`：req→res 回执路由（双表 + ack_timeout + transmitted 判定）；
    - `RunEventRouter`：runId 事件路由 + 翻译 + 终态清理 + 缓冲过滤；
    - `RecoveryCoordinator`：断线重连恢复（record/resume/unregister_active_session）；
    - `ApprovalFanout`：连接级审批订阅 fan-out。
  - RPC：`send_message`(chat.send) / `get_history` / `list_sessions` / `create_session` / `delete_session` / `resolve_approval` / `list_pending_approvals` / `request_approval` / `list_commands`。
  - 注：`chat/chat_client.py` 与 `integration/openclaw/wire_client.py` 都是 **identity re-export 薄壳**，唯一实现在 `wire/wire_client.py`（strangler 收敛 #231/#271）。
- **`chat/event_translate.py` `ChatEventTranslator`**：网关事件 → 前端契约帧（text/done/error/approval/approvalResolved/tool），按 runId 累积 `_sent` 支持 replace/final 补尾。
- **`chat/pool.py` `ChatConnectionPool`**：`dict[(url,device_token)→client]`，per-key 锁（TOCTOU 防重复 orphan）、`ReconnectPolicy` 指数退避(1s→30s)主动重连、`reacquire` 原子自愈（比较→采纳/驱逐→重建）、`_migrate_subscribers`/`_propagate_recovery` 换 client 迁移订阅者与记住会话、`evict_url/evict_instance`（force-repair/删除后清旧凭证）。`NotPaired` 在未配对/材料不全时抛出。`ChatFleet` 为 service locator。
- **`chat/consumers.py` `ChatConsumer`**：前端 WS 适配。`start{container,sessionKey?}`→取/建池化 client + 注册审批订阅 + 补拉待审批→`ready`；`send{sessionKey,message}`→`send_message`（同 idempotencyKey 有界重试一次；`ChatSendTransmittedError` 不重发只重取连接）；`resolve{id,kind,decision}`→`resolve_approval`；`ping`→`pong`（应用层活性）。`_reacquire_client` 自愈 + 迁移全部订阅者。
- **`chat/pairing*.py`**（见 §4）。
- **`chat/models.py` `Pairing`**：每容器配对记账行（`device_id` / 公私钥 PEM（私钥加密）/ `device_token`（加密）/ `scopes_json` / `pairing_request_id` / `status` 状态机 / `attempt_version`）。

### 3.2 新后端要复刻的最小对话桥接面

按「前端能用」的最小闭环，新 TS/Express 后端需要：

1. **设备身份 + 配对握手**（一次）：Ed25519 生成/持久化、`buildDeviceAuthPayloadV3` 签名、等 `connect.challenge` 取 nonce、发 `connect`（bootstrap `auth.token=GATEWAY_TOKEN`）、收 `hello-ok.auth.deviceToken`；`PAIRING_REQUIRED` 三分支落库 + 宿主 approve + 重握手。（npm 包：`GatewayClient` + `hostDeps.{loadOrCreateDeviceIdentity,signDevicePayload,storeDeviceAuthToken}` 可复用。）
2. **每容器一条已配对长连接**：`auth.token=deviceToken` 直连 + 每容器 device 签名块（`ConnectFrameBuilder.session`）。连接池 `(url,deviceToken)→client` + 复用 + 断线重连。
3. **chat 收发 + runId 路由**：`chat.send`(idempotencyKey) → ack(runId) → `chat` 事件按 runId 路由 → 翻译成前端帧（delta/final/aborted/error + replace 语义）。
4. **审批**：连接级 `exec/plugin.approval.requested/resolved` 订阅 + fan-out + `{kind}.approval.resolve` + `exec.approval.list` 断线补拉。
5. **会话/历史**：`sessions.list/create/delete` + `chat.history`（content 多态处理）。
6. **断线恢复**：`sessions.messages.subscribe` + `chat.history` + `inFlightRun` 采用 + `agent` 事件按 runId/seq reconcile。（npm 包 session 投影协调器可直接承担。）
7. **看门狗/背压**：hello-ok `policy.tickIntervalMs` 驱动静默看门狗（2×tick）；`policy.maxPayload` 发送侧预检。

非目标（现状有但重写首版可不迁）：wiki 编辑、model provider 热加载、斜杠命令补全 UI、`artifacts.download`、用量/成本聚合。

---

## 4. 自动配对:现状机制与触发点

### 4.1 Ed25519 配对状态机如何驱动(chat/pairing.py)

`PairingService.ensure_paired(instance, force_repair=False)`：
1. 每实例应用锁 + `select_for_update` 事务内读/建 `Pairing` 行；已 `paired` 且有 `device_token` → **幂等返回**（不重握手）。
2. `_load_or_create_identity`：复用持久化身份（deviceId 稳定）否则生成落库；`attempt_version += 1` 落库（并发复用同一 deviceId）。
3. 事务外 `_run_handshake`：**独立线程** `asyncio.run(PairingHandshake.pair(...))`（规避 ASGI/Daphne 下 sync/async view 两种上下文的事件循环冲突）。`PairingHandshake`：等 challenge 取 nonce → 发 connect → 三分支。
   - 冷启动瞬态（`gateway starting; retry shortly`，`retryable:true, retryAfterMs`）有界重试（默认 5 次）。
4. `PAIRING_REQUIRED(requestId)` → **自动 approve（面板默认开启）**：注入的 `ExecPairingApprover` 经 `containers.Fleet.exec_sync` 在容器内跑 `openclaw devices approve <requestId>`（exec_sync 等命令真正落库，非 fire-and-forget），再用同一 deviceId **重握手一次**拿 deviceToken。
   - approve 的 `requestId` 先经 `_REQUEST_ID_RE` 白名单校验（防注入宿主 shell）。
   - approve 抛 `PairingError`（CLI 退出码非零：token 不匹配/requestId 过期/网关断连）→ 落 `STATUS_ERROR`（避免「生成新 requestId 替换 actionable 请求」的配对 churn 死循环）；其它 transient 异常 → 落 `STATUS_PENDING` + raise `PairingRequired` 给上层重试。
5. 成功 → `_apply_result` 条件落库（`attempt_version` 乐观锁 + `F()` 原子更新，防并发覆盖）：`status=paired + device_token + scopes_json`。

`PairingFleet` 为 service locator；`_default_approver()` lazy 引用 `containers.Fleet` 构造 `ExecPairingApprover`（daemon 不可达时退 None → 保守退回人工 pending）。

### 4.2 「容器创建后自动配对」现状:不可迁移,需新建

**结论：现状没有「容器创建后自动配对」的自动化，需新建。**

- `ensure_paired` 全仓库**唯一**触发点是 `backend/chat/views.py` 的 `PairingView`（手动 `POST /api/v1/containers/<name>/pairing/`，`force_repair=True`）——即前端用户点「配对」按钮才驱动。
- 容器创建路径（`containers/views.py` POST → `Fleet.create_reserve` 预占 → **202** → `Fleet.submit_create` 注入 executor **后台**跑模板拷贝 + docker run；#297 异步化）**从不调用** `ensure_paired`（grep 编排器/provisioner/views 无任何配对调用）。
- 配对本身已是「一键自动 approve」（§4.1 的 `ExecPairingApprover`），缺的是**把它接到容器生命周期的触发器**。

### 4.3 触发点应挂在容器生命周期哪一步

容器生命周期（#297 异步创建）：`create_reserve`(预占 creating 行) → 202 → 后台 `submit_create`(模板拷贝 + docker run) → 容器 `creating → running`（客户端轮询 list 观察）。

最自然且最稳的触发点是：**后台 provisioning 完成、容器进入 running/healthy 之后**，由控制面异步调 `ensure_paired(instance)`。理由：

- 配对握手需要容器网关已在监听端口且 `GATEWAY_TOKEN` 已注入 env（`Instance.token` 即 GATEWAY_TOKEN，env 注入容器、DB 存值供后端握手）；creating 早期网关未就绪，握手必失败。
- `PairingHandshake` 已有冷启动 `retryable` 有界重试（`gateway starting; retry shortly`），正好覆盖「容器刚起、/health 绿早于主循环就绪」的窗口——自动配对触发器接在 provisioning 末尾即可复用这套容错。
- 不能在 `create_reserve` 同步阶段触发（容器尚不存在）；202 已返回，触发必须在后台 executor 或一个 provisioning 完成钩子里。
- 失败语义可复用：自动配对失败落 `pending/error` 行，前端 list 已批量注入 `pairing` 快照（`containers/views.py` GET），用户仍可在容器页手动重试（现有 `PairingView` 路径不变）。

---

## 5. 给后续决策 ticket 的事实结论

1. **npm 包是真实现但须锁 beta 版本**：`@openclaw/gateway-client` / `@openclaw/gateway-protocol` 的 `latest` 是占位 `0.0.0`，真实代码在 `2026.7.2-beta.6`；裸 `npm install` 拿到空壳。两包无 README，文档=官方站+`.d.mts`。protocol 包是 typebox schema/校验层；client 包是带重连/session 投影/设备身份托管的重量级参考客户端。
2. **握手与事件语义已被一手来源 + 本仓库实测互证**：v4 握手 = 持久化 Ed25519 身份 → `connect.challenge` 取 nonce → `connect`(min=maxProtocol=4, role=operator, device 签名块, `auth.token=GATEWAY_TOKEN` bootstrap) → `hello-ok.auth.deviceToken`；未配对返回嵌套 `NOT_PAIRED`/`PAIRING_REQUIRED`+`requestId`，宿主 `openclaw devices approve` 恢复。本仓库 `build_auth_payload_v3` / `ConnectFrameBuilder` / `ChatEventTranslator` 与官方 `ConnectParamsSchema`/`HelloOkSchema`/`ConnectErrorDetailCodes` 完全对得上。
3. **TS/Express 重写最小对话桥接面 = §3.2 七件事**：设备身份+配对握手、每容器已配对长连接+连接池+重连、chat 收发+runId 路由+翻译、审批(请求/resolve/补拉)、会话+历史、断线恢复、看门狗/背压。npm `GatewayClient` + session 投影协调器可直接承担 #1/#2/#6 的大头，但引入 beta 依赖与较重内置策略；手写精简客户端则须复刻 `wire` 子包已硬化的 dead/transmitted/恢复语义。
4. **「容器创建后自动配对」现状不存在，需新建触发器**：配对状态机（`PairingService.ensure_paired` + `ExecPairingApprover` 自动 `openclaw devices approve` + 重握手）已就绪且一键化，但全仓库唯一触发点是手动 `POST …/pairing/`。容器创建路径（#297 异步 202，后台 provisioning）从不调它。
5. **触发点应挂在后台 provisioning 完成、容器 running/healthy 之后**：握手依赖网关已监听端口 + `GATEWAY_TOKEN` env 已注入（`Instance.token`）；`PairingHandshake` 内置冷启动 `retryable` 重试正好覆盖启动窗口。失败落 pending/error，前端 list 批量注入的 `pairing` 快照让用户可手动重试，与现有手动路径兼容。
