# R13 — OpenClaw WebSocket 协议接入设计（openclaw_service）

> 目标：把 `services/openclaw_service.py` 从 HTTP `POST {base}/v1/responses` + SSE 改造为 OpenClaw 网关的 **WebSocket RPC 协议**（protocol v4），同时保持 `routes/openclaw.py` 对前端输出的 SSE 事件（`text` / `done` / `error` / `raw`）**完全不变**。
>
> 事实来源标注：
> - **[上游源码]** = 浅克隆 `github.com/openclaw/openclaw`（main 分支）`src/gateway/**`、`packages/gateway-protocol/**`，逐文件 grep/阅读所得，最高置信。
> - **[官方文档]** = `docs.openclaw.ai/gateway*`、`/web/dashboard`、`/cli/gateway`，以及社区镜像 `clawdocs.org`、`openclaw-openclaw.mintlify.app`。
> - **「未文档化，需起容器实测」** = 文档与源码均未给出确定答案处。

---

## 1. WS 端点确切 URL / path

**结论（高置信）：`ws://<host>:18789/`，根路径直接 upgrade，无子路径。**

| 判断项 | 值 | 依据 |
|---|---|---|
| 端口 | `18789` | 本仓库 probe `openclaw.json` `gateway.port: 18789`；[官方文档] `/gateway` 解析顺序 `--port → OPENCLAW_GATEWAY_PORT → gateway.port → 18789` |
| 协议 | `ws://`（本地 loopback）；`wss://`（`gateway.tls.enabled: true` 时） | [官方文档] `/web/dashboard` |
| **path** | **`/`（根路径）** | 三个独立来源一致：mintlify 文档明示 `ws://localhost:18789/`；clawdocs 示例 `new WebSocket('ws://localhost:18789')`（无 path）；dashboard 文档 `wss://127.0.0.1:18789`（无 path）。`openclaw gateway health --url ws://127.0.0.1:18789` 同样无 path |
| 多路复用 | **WS、HTTP API、Control UI 共用同一端口 18789** | [官方文档] `/gateway`：「单个多路复用端口」承载 WebSocket 控制/RPC + HTTP API + 插件路由 + Control UI |

**候选 path 排除**：`/ws`、`/gateway`、`/socket` 均无任何来源支持；文档明确 **唯一带 path 的 WS 是 `ws://localhost:18789/canvas/ws`**（Canvas host 通信，与聊天无关）。聊天 RPC 走根路径。

**认证携带**：token 既可放 `connect` 帧 `params.auth.token`（见 §6），也可放 URL query `?token=<GATEWAY_TOKEN>`（clawdocs 示例 `new WebSocket('ws://localhost:18789?token=your-auth-token')`）。本设计用 `connect` 帧方式（更贴合 §0 握手）。

**置信度**：高。三个独立文档来源 + CLI 示例互证，且无 competing path。仍建议起容器后 `websocat ws://127.0.0.1:18789/` 实测一次确认（成本低）。

---

## 2. `chat.send` / `sessions.send` 字段级 schema

均来自 **[上游源码]** TypeBox schema，逐字段摘录。

### 2.1 `chat.send`（`ChatSendParamsSchema`，`packages/gateway-protocol/src/schema/logs-chat.ts`）

主聊天方法。`additionalProperties: false` —— 多传字段会被拒。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sessionKey` | string(1..512) | **是** | 会话键。决定会话归属与 agent 路由。普通主会话可用 `"main"` 或自定义逻辑键；子 agent 会话键形如 `agent:<agentId>:<name>` |
| `message` | string | **是** | 用户消息文本。空串且无 attachment 会被拒（`"message or attachment required"`） |
| `idempotencyKey` | NonEmptyString | **是** | 幂等键，客户端安全重试用。**注意：这是必填项**（区别于 `sessions.send` 里它是可选） |
| `agentId` | string | 否 | 指定目标 agent。缺省走会话/默认 agent（本部署 = `main`）。**这替代了 HTTP 的 `model: "openclaw/<agent>"`** |
| `sessionId` | string | 否 | 精确指定 transcript generation；一般省略 |
| `thinking` | string | 否 | 思考级别覆盖（如 `"low"/"high"`），一次性 |
| `attachments` | array<object> | 否 | 附件（图片/文件），见 §2.3 |
| `timeoutMs` | int ≥0 | 否 | 单次请求超时 |
| `deliver` | bool | 否 | 是否把结果经 channel 投递（本场景不需要） |
| `fastMode` / `fastAutoOnSeconds` | bool\|"auto" / int | 否 | 快速模式，与本场景无关 |
| `originatingChannel/To/AccountId/ThreadId` | string | 否 | **需 admin scope**，本场景不用 |
| `systemInputProvenance` / `systemProvenanceReceipt` / `suppressCommandInterpretation` | — | 否 | **需 admin scope**。`suppressCommandInterpretation: true` 可阻止把消息当斜杠命令解析——对论文评审这类含 `/` 的文本有用，但需 admin scope |

**关键映射（相对现 HTTP 实现）**：
- 现 `chat()` 的 `history` 逐条构造 `input_items` → **WS 不需要**。会话历史由网关侧按 `sessionKey` 维护；只要复用同一 `sessionKey`，网关自动带历史。若每次新建会话则无需传历史。
- 现 `system_prompt` → `payload.instructions` → **WS `chat.send` 无对等的非 admin 字段**（`systemInputProvenance` 需 admin scope）。替代方案见 §7。
- 现 `temperature`/`max_tokens` → **WS `chat.send` 无此参数**。模型/采样由网关 `openclaw.json` 的 agent 配置决定（`agents.defaults.model`）。这符合 WS 协议定位：网关托管 agent 运行时，调用方不控采样参数。**「未文档化，需起容器实测」** 是否 `sessions.create` 的 `model`/`thinkingLevel` 能部分替代。

### 2.2 `sessions.create`（`SessionsCreateParamsSchema`，`src/gateway/protocol/schema/sessions.ts`）

建会话入口。全部可选。

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 会话键；省略则网关生成 |
| `agentId` | string | 绑定 agent |
| `label` | string | 显示标签 |
| `model` | string | **初始模型覆盖**（如 `minimax/MiniMax-M3`），原子写入会话 |
| `parentSessionKey` | string | 父会话（spawn 场景） |
| `task` / `message` | string | 建会话同时注入的首条任务/消息 |

> 注：`thinkingLevel` 在官方文档叙述中提及可持久化，但当前 schema 字段为 `model`；`thinkingLevel` 持久化走 `sessions.patch`（`SessionsPatchParamsSchema.thinkingLevel`）。**「未文档化，需起容器实测」** `sessions.create` 是否接受 `thinkingLevel`（schema 未列）。

### 2.3 `sessions.send`（`SessionsSendParamsSchema`）

向已存在会话发消息。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key` | NonEmptyString | **是** | 目标会话键 |
| `message` | string | **是** | 消息文本 |
| `thinking` | string | 否 | 思考级别 |
| `attachments` | array | 否 | 附件 |
| `timeoutMs` | int ≥0 | 否 | 超时 |
| `idempotencyKey` | NonEmptyString | 否 | 幂等键（此处可选） |

> **`chat.send` vs `sessions.send` 选型**：`chat.send` 是 WebChat/原生 WS 客户端的主路径，事件协议（`chat` 事件族 + `deltaText`）围绕它设计，且支持 `agentId` 指定。本设计**用 `chat.send`**。`sessions.send` 更偏会话间互发/工具调用。

### 2.4 附件（图片 base64）编码（`attachment-normalize.ts`）

`attachments[]` 每项字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 附件类型（图片可省或按客户端约定） |
| `mimeType` | string | 如 `image/png`。网关以此分流 image vs 文件 |
| `fileName` | string | 文件名 |
| `content` | **base64 string** | 原始字节的 base64。也接受 `source:{type:"base64", media_type, data}` 形式（`normalizeAttachmentContent` 会把 ArrayBuffer/typed-array 转 base64，字符串原样透传） |

**对前端**：现有 `files: [{name, data, type}]` 里 `data` 若是 data URL（`data:image/png;base64,....`），**需剥掉 `data:...;base64,` 前缀**只留纯 base64，映射为 `{ mimeType: f.type, fileName: f.name, content: <pure_base64> }`。

---

## 3. 流式事件 → 现有 SSE 映射表

### 3.1 WS 帧与事件（[上游源码]）

- 帧外壳：`{"type":"event","event":"chat","payload":{...},"seq":N}`（`server-broadcast.ts:263`）。
- 聊天事件名 = 字面量 **`"chat"`**（`server-chat.ts:1042 broadcast("chat", payload, ...)`）。
- 事件 payload 基座 `ChatEventBaseSchema`：`runId`、`sessionKey`、`agentId?`、`spawnedBy?`、`seq`。
- 事件联合体 `ChatEventSchema`（`logs-chat.ts`）按 `state` 区分：

| `state` | 关键字段 | 语义 |
|---|---|---|
| `"delta"` | `deltaText: string`（增量）、`message?`（**累积**快照）、`replace?: bool`、`usage?` | 增量输出。`replace=true` 表 `deltaText` 是非前缀的整段替换（非追加） |
| `"final"` | `message?`、`usage?`、`stopReason?` | 成功终态 |
| `"aborted"` | `message?`、`stopReason?` | 取消终态（用户/协调方 abort） |
| `"error"` | `errorMessage?`、`errorKind?`（`refusal/timeout/rate_limit/context_length/unknown`）、`usage?`、`stopReason?` | 失败终态 |

### 3.2 映射到现有 SSE（保持前端不变）

现有 `routes/openclaw.py` 输出给前端的事件类型为 `text` / `done` / `error` / `raw`。映射：

| WS `chat` 事件 | 条件 | → 现有 SSE 输出 |
|---|---|---|
| `state="delta"` | `replace` 非 true | `data: {"type":"text","text": deltaText}` |
| `state="delta"` | `replace=true` | 需特殊处理：前端是「追加式」渲染，非前缀替换无法直接追加。**建议**：累积快照 `message` 与已发文本做差集后发增量；若无 `message`，发 `{"type":"text","text": deltaText}` 并标注（**「未文档化，需起容器实测」** `replace` 实际触发频率，多数 agent 文本流不会触发） |
| `state="final"` | 正常 | `data: {"type":"done","usage": usage}` |
| `state="final"` | `message` 含此前未发的尾部文本（少见） | 先补 `text` 再 `done`（对齐现 `response.output_text.done` 分支的兜底逻辑） |
| `state="error"` | — | `data: {"type":"error","text": errorMessage \|\| errorKind}`，随后 `done`（对齐现 HTTP `response.completed status=failed` 后发 error+done 的顺序） |
| `state="aborted"` | — | `data: {"type":"error","text":"已中止: "+(stopReason\|\|"aborted")}` 或直接 `done`。**建议发 `done`**（中止非错误，前端正常收尾），并附 `stopReason` |
| 非 JSON / 无法解析帧 | — | `data: {"type":"raw","text": <原始文本>}`（对齐现 `except json.JSONDecodeError` 分支） |
| 收到终态（final/error/aborted）任一 | — | 之后**必须再发** `data: {"type":"done"}`，保证前端 `__DONE__` 收尾逻辑触发（现 `chat_stream()` 末尾无条件 `yield done`） |

**过滤**：只处理 `event=="chat"` 且 `payload.runId == 本次 chat.send 返回的 runId` 的帧。同连接上可能有其它会话/会话标题等 `chat` 事件，必须用 `runId` 精确匹配。

---

## 4. openclaw.json 是否需为 WS 开开关 / R8 重估

**结论：WS 无需任何额外开关。** WS 是网关的**主 RPC 协议**，与 Control UI 同源，默认随网关进程在 `gateway.port` 上监听，无独立 `enabled` 配置项。[官方文档] `/gateway` 与 [上游源码] 均无「WS endpoint enabled」开关。

**R8 重估（`gateway.http.endpoints.responses.enabled`）**：
- 现 `routes/openclaw.py:364` 的 `apply-config` 强制写入 `gw_ep["responses"] = {"enabled": True}` —— 这是为 **HTTP `POST /v1/responses`** 路径开的。
- **改走 WS 后，`/v1/responses` HTTP 端点不再被调用**，因此该开关对 WS 路径**不再必要**。
- **但建议保留写入**：(a) 无害，文档显示 HTTP 端点是同端口多路复用的一部分；(b) 若未来回退 HTTP 或前端有其它 `/v1/responses` 调用仍可用。**「未文档化，需起容器实测」** 该开关缺省值（是否默认开启）。若默认已开，`apply-config` 里这段可删。

---

## 5. 连接生命周期 / 库选型

### 5.1 库选型

当前后端用 `httpx`（**无 WS 客户端**）。候选：

| 库 | 评估 | 结论 |
|---|---|---|
| **`websockets`** | 纯 asyncio、成熟、与 FastAPI 同事件循环、API 简洁（`connect()` + `async for msg`）。已在大量 Python 项目验证 | **推荐** |
| `httpx-ws` | 与 httpx 生态集成，但成熟度/社区不及 `websockets`，且本场景无需复用 httpx transport | 备选 |
| `aiohttp` | 引入整个 HTTP 栈，过重 | 不推荐 |

**推荐 `websockets`**（`pip install websockets`）。注意 `requirements.txt` 需新增依赖。

### 5.2 连接复用策略

**推荐：单条持久连接 + 连接池管理器（按网关 URL+token 复用），多路复用多个并发会话。**

理由：
- WS 协议本身是多路复用的——一条连接上可同时跑多个 `chat.send` run，靠 `runId`/`sessionKey` 区分事件。
- 握手（challenge→connect→hello-ok）有成本，每会话新建连接浪费。
- 现 `chat_stream()` 是「一次调用 = 一个异步生成器」，改造后变为「向共享连接注册一个 runId 回调队列」。

**架构要点**：
- 一个进程级 `OpenClawWsClient` 单例（懒连接、自动重连）。
- 内部维护 `run_id → asyncio.Queue` 路由表；后台 reader 协程持续 `async for frame in ws`，把 `chat` 事件按 `runId` 投递到对应队列。
- `chat_stream()` 改为：获取连接 → `chat.send` → 拿 `runId` → 注册队列 → 从队列读事件翻译成 SSE 字符串 yield → 终态后注销队列。

### 5.3 断线重连与 challenge 重握手

- **挑战重握手**：每次新连接都必须重走完整 `connect.challenge → connect → hello-ok`（§0）。无会话恢复机制（`connect` 帧有 device 字段但属配对场景，本场景不用）。
- **重连策略**：reader 协程捕获 `ConnectionClosed` → 标记连接失效 → 指数退避重连（如 1s/2s/4s，封顶 30s）→ 重握手。**重连期间进行中的 run 无法恢复**（runId 是连接级的），应对其队列发 `error` + `done`。
- **心跳**：协议有 `tickIntervalMs`（hello-ok 的 `policy.tickIntervalMs`，文档示例 15000）。应用层可依赖 WS 协议层 ping/pong（`websockets` 默认开启 `ping_interval=20`）。**「未文档化，需起容器实测」** 网关是否要求应用层定时发 `tick`/保活 req。

### 5.4 最小客户端伪代码

```python
import json, asyncio, uuid
import websockets

class OpenClawWsClient:
    def __init__(self, url, token):
        self.url, self.token = url, token
        self.ws = None
        self._pending = {}   # req id -> Future
        self._runs = {}      # runId -> asyncio.Queue
        self._reader = None

    async def connect(self):
        self.ws = await websockets.connect(self.url, ping_interval=20)
        # 1. 等 challenge
        ch = json.loads(await self.ws.recv())          # event: connect.challenge
        # 2. 回 connect
        await self._send_req("connect", {
            "minProtocol": 4, "maxProtocol": 4,
            "client": {"id": "gateway-client", "version": "1.0",
                       "platform": "linux", "mode": "backend"},
            "role": "operator",
            "scopes": ["operator.read", "operator.write"],
            "caps": [], "commands": [], "permissions": {},
            "auth": {"token": self.token},
            "locale": "zh-CN", "userAgent": "ai-research-pipeline/1.0",
        })
        # hello-ok 由 _send_req 的 res 返回
        self._reader = asyncio.create_task(self._read_loop())

    async def _send_req(self, method, params):
        rid = uuid.uuid4().hex
        fut = asyncio.get_event_loop().create_future()
        self._pending[rid] = fut
        await self.ws.send(json.dumps(
            {"type": "req", "id": rid, "method": method, "params": params}))
        return await fut          # res 帧: ok -> payload

    async def _read_loop(self):
        async for raw in self.ws:
            f = json.loads(raw)
            if f.get("type") == "res":
                fut = self._pending.pop(f["id"], None)
                if fut and not fut.done():
                    fut.set_result(f if f.get("ok") else {"error": f.get("error")})
            elif f.get("type") == "event" and f.get("event") == "chat":
                p = f["payload"]
                q = self._runs.get(p.get("runId"))
                if q: await q.put(p)

    async def chat_stream(self, session_key, message, agent_id=None, attachments=None):
        params = {"sessionKey": session_key, "message": message,
                  "idempotencyKey": uuid.uuid4().hex}
        if agent_id: params["agentId"] = agent_id
        if attachments: params["attachments"] = attachments
        res = await self._send_req("chat.send", params)
        run_id = res["payload"]["runId"]               # ack: {runId, status:"started"}
        q = asyncio.Queue()
        self._runs[run_id] = q
        try:
            while True:
                p = await q.get()
                yield p                                # 由上层翻译成 SSE
                if p.get("state") in ("final", "error", "aborted"):
                    break
        finally:
            self._runs.pop(run_id, None)
```

> 注：`connect` 的 `client.id` 建议用 `"gateway-client"`（`GATEWAY_CLIENT_IDS.GATEWAY_CLIENT`，后端语义）或 `"cli"`；`mode` 用 `"backend"`。**「未文档化，需起容器实测」** 网关对 `client.id`/`mode` 组合是否有校验白名单（schema 层是 enum，建议起容器先跑一次 handshake 确认接受值）。

---

## 6. token 在 WS 握手的携带

**结论（高置信）：`connect.params.auth.token = <GATEWAY_TOKEN>`。**

- §0 握手第 2 步 `connect` 帧 `params.auth.token` 即放 token（protocol 文档示例 `auth:{"token":"…"}`）。
- 对应 probe `openclaw.json`：`gateway.auth.mode: "token"`、`gateway.auth.token: "${GATEWAY_TOKEN}"`。
- 替代/补充：URL query `?token=<token>`（clawdocs 示例）。`connect` 帧方式优先。
- scope 至少需 `operator.read`（收 `chat` 事件，`EVENT_SCOPE_GUARDS.chat = [READ_SCOPE]`）。`chat.send` 写操作需 `operator.write`。**建议 `scopes: ["operator.read","operator.write"]`**。

---

## 7. 对 `routes/openclaw.py` 保持前端不变的改造要点

**前端契约不变**：`/chat/stream` POST 仍返回 `{task_id}`，`/chat/{tid}/stream` GET 仍推 `text/done/error/raw` SSE。仅 `services/openclaw_service.py` 内部实现替换。改造点：

1. **`chat_stream()` 内部替换**：HTTP `c.stream(POST /v1/responses)` → WS `chat.send` + 按 §3.2 映射事件。对外仍 `yield` 同样格式的 SSE 字符串。**函数签名、yield 格式、终态后无条件 `done` 的行为全部保留**。
2. **`chat()`（非流式）**：可复用 `chat_stream()` 收集全部 `text` 增量拼接为 `{"text","raw"}`；或 `chat.send` 后等到 `final` 取 `message`。**建议复用流式路径**简单可靠。
3. **`history` 参数处理变更**：WS 下历史由 `sessionKey` 维护。两选一：
   - (a) **每次新会话**：忽略 `history`，让 `system_prompt` 与当前消息一起进新会话（历史靠调用方拼进 `message` 文本，或放弃跨轮记忆）。
   - (b) **复用 `session_key`**：把现有 `session_key` 参数（现 HTTP 用 `payload.user`）映射为 WS `sessionKey`，网关自动带历史。**推荐 (b)**，语义最贴近。
   - ⚠ 现 `chat_stream()` 未接收/传递 `session_key`（`chat()` 有但 `chat_stream()` 调用未传），需在路由层补传。**这是行为差异点，需在实现时与 team-lead 确认记忆语义。**
4. **`system_prompt` 无处安放**：WS `chat.send` 无 `instructions` 对等字段（除非 admin scope 的 `systemInputProvenance`）。方案：
   - 把 `system_prompt` 拼到 `message` 前缀（最简，论文评审的 5 阶段指令就这么进）。
   - 或 `sessions.create(model=...)` + 系统提示经 agent 配置预设。**短期建议拼接**，并标注行为差异。
5. **`temperature`/`max_tokens` 失效**：WS 不暴露。改由网关 `openclaw.json` agent 配置控制。`apply-config` 已有能力写 agent model，无需调用方传。**在代码注释与 commit message 中明确此行为变化。**
6. **`health()`**：现 `GET /health` HTTP。WS 下可改为「尝试建连 + hello-ok 成功即健康」，或保留 HTTP `GET /health`（多路复用端口上 HTTP 仍可用）。**建议保留 HTTP `/health`**，改动最小。
7. **依赖**：`requirements.txt` 加 `websockets`。`httpx` 仍被 `health()` 等用，保留。
8. **连接单例生命周期**：在 FastAPI `lifespan` 启动时建 `OpenClawWsClient`（按 `get_effective_openclaw()` 的 url/token），关闭时 `close()`。注意 per-user 凭据：若多用户各有 gateway，需按 `(url,token)` 缓存多个连接。**当前部署多为单网关，先做单连接，多网关场景标注为后续扩展。**

---

## 附：仍需起容器实测确认项汇总

| 项 | 说明 |
|---|---|
| WS path | 根路径 `/`（三来源互证，高置信，仍建议 `websocat` 实测） |
| `client.id`/`mode` 白名单 | handshake 是否接受 `gateway-client`/`backend` 组合 |
| `sessions.create` 的 `thinkingLevel` | schema 未列，文档叙述提及 |
| `replace=true` 触发频率 | 决定 §3.2 替换分支是否需复杂实现 |
| 应用层保活 | 是否需在 `tickIntervalMs` 内发保活帧 |
| `responses.enabled` 缺省值 | 决定 `apply-config` 那段写入能否删 |
| 记忆语义 | 复用 `sessionKey` 时网关带历史的行为是否符合前端预期 |
