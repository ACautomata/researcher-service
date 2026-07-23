# R26 — OpenClaw WS 高级对话事件（权限审批 / 斜杠命令 / 工具执行 / 思考链）

---
> **实测回填（#36, 2026-07-23, openclaw 2026.7.1）**：⚠️ **关键修正**——operator scope **不在 connect 握手声明授予**，而来自**设备配对记录**：Ed25519 设备身份签名 challenge-bound payload（`device:{publicKey,signature,signedAt,nonce}`）→ connect → `PAIRING_REQUIRED` → 宿主 `openclaw devices approve` → 重连拿 `hello-ok.auth.deviceToken`。实测裸 token connect 得 `scopes:[]`、`chat.send`/`commands.list`/`tools.catalog` 全报 `missing scope`。**后端每容器 WS 客户端须先完成配对**。思考链/工具事件确切帧仍待配对后实测。


> 对应 issue **#26**（多容器面板对话前端四特性补齐）。
>
> 本文在 R13（`docs/research/r13-ws-protocol.md`，握手 + chat.send + runId 路由）之上，补齐四个高级对话特性的 WS 帧形态。面向「多容器面板」的对话前端与后端翻译层（`services/openclaw_ws.py` / `services/openclaw_service.py`）。
>
> **事实来源标注**：
> - **[官方文档]** = `docs.openclaw.ai/gateway/protocol`（中英两版对照），一手协议文档。
> - **[二手来源]** = 公开搜索聚合（mintlify 镜像、社区文档、GitHub issue），与官方文档存在出入，仅作线索，**未经官方文档或源码证实处一律标「需实测」**。
> - **「需实测」** = 文档未给出字段级 schema，需起容器用真实网关验证。
>
> **与 R13 的一致性约束**：R13 从上游源码证实聊天事件名为字面量 `chat`（`server-chat.ts` 的 `broadcast("chat", ...)`），事件按 `state: delta/final/aborted/error` 区分。部分 [二手来源] 提到的 `agent.delta` / `agent.tool.start` / `agent.thinking` 等 `agent.*` 事件族**未获官方文档证实**，与 R13 的 `chat` 单事件 + `state` 联合体的模型冲突。本文以官方文档 + R13 为准，`agent.*` 事件族统一标注「二手来源，需实测」。

---

## 0. 通用帧外壳（四特性共用）

```jsonc
// 请求（client → gateway）
{ "type": "req",   "id": "<uuid>", "method": "<method>", "params": { } }
// 响应（gateway → client）
{ "type": "res",   "id": "<uuid>", "ok": true,  "payload": { } }
{ "type": "res",   "id": "<uuid>", "ok": false, "error": { } }
// 事件（gateway → client，广播）
{ "type": "event", "event": "<name>", "payload": { }, "seq": 12, "stateVersion": 34 }
```

握手仍走 R13 §0 的 `connect.challenge → connect → hello-ok`。本文件四特性中**有三项需要在 `connect` 帧声明额外 capability / scope 才会下发**，见各节。

---

## 1. 权限审批（elevated / permission request）

### 结论一句话
网关以 `exec.approval.requested`（及 `plugin.approval.requested`）**事件**广播待审批请求；operator 客户端用 `exec.approval.resolve` / `approval.resolve` **方法**回覆批准/拒绝，需 `operator.approvals` scope。

### 方法 / 事件清单（[官方文档]）

| 名称 | 类型 | 方向 | scope | 说明 |
|---|---|---|---|---|
| `exec.approval.requested` | event | gw→client | `operator.read`（收事件） | 有待审批的 exec 请求时广播 |
| `exec.approval.request` | method | client→gw | — | 主动发起一次 exec 审批（`host=node` 时须带 `systemRunPlan`） |
| `exec.approval.get` / `exec.approval.list` | method | client→gw | — | 查询单个/全部待审批 |
| `exec.approval.resolve` | method | client→gw | **`operator.approvals`** | 回覆批准/拒绝 |
| `exec.approval.waitDecision` | method | client→gw | — | 阻塞等一个待审批的决定，超时返回 `null` |
| `approval.get` / `approval.resolve` | method | client→gw | **`operator.approvals`** | **类型无关**的持久化审批（推荐用这个对） |
| `plugin.approval.requested` / `plugin.approval.resolved` | event | gw→client | `operator.approvals` | 插件自定义审批流 |
| `plugin.approval.request` / `.list` / `.waitDecision` / `.resolve` | method | client→gw | `operator.approvals` | 插件审批流对应方法 |

### 帧样例

**待审批事件（gateway → client）**：
```jsonc
{
  "type": "event",
  "event": "exec.approval.requested",
  "payload": {
    // ⚠ 字段级 payload 官方文档未给全。已知：
    //   - 有稳定的审批 id（供 resolve 引用）
    //   - host=node 时含 systemRunPlan: { argv, cwd, rawCommand, sessionKey, agentId, ... }
    // 「需实测」完整字段清单
  },
  "seq": 21
}
```

**批准 / 拒绝（client → gateway）—— 类型无关审批对（推荐）**：
```jsonc
// 请求
{ "type": "req", "id": "r1", "method": "approval.resolve",
  "params": { "id": "<approvalId>", "kind": "<kind>", "decision": "approve" } }
// 响应（first-answer-wins，总是返回已记录的权威结果）
{ "type": "res", "id": "r1", "ok": true, "payload": { /* canonical result */ } }
```
`approval.resolve` 三个字段官方已明示：`id`、`kind`、`decision`。`decision` 的取值集合（`"approve"/"deny"` 等）**「需实测」**。

**exec 专用回覆（client → gateway）**：
```jsonc
{ "type": "req", "id": "r2", "method": "exec.approval.resolve",
  "params": { /* 「需实测」字段清单，推测含 id + decision */ } }
```

### 与 runId 的关联
审批事件**不挂在某个 chat runId 下**——它是连接级 / 会话级的独立广播，前端需在对话流之外单独监听（不属于 `chat` 事件族，不能被 R13 的 runId 过滤器吞掉）。`systemRunPlan` 内含 `sessionKey`/`agentId`，可用于把审批归属到具体会话。**「需实测」** payload 是否直接携带 `runId`。

### scope / cap 需求
- 收 `exec.approval.requested`：`operator.read`（本仓库 `connect` 已声明）。
- 回覆 `*.resolve`：**`operator.approvals`** —— 当前 `openclaw_ws.py:60` 只声明了 `["operator.read","operator.write"]`，**需新增 `operator.approvals`**，否则 resolve 会被拒。
- [二手来源] 提及 `approvals` / `exec-approvals` / `plugin-approvals` 等 **capability**（`connect.params.caps`）门控审批事件下发——**需实测**是否除 scope 外还需在 `caps` 里声明。

### 后端翻译建议
- `openclaw_ws.py` 的 `_dispatch` 当前只路由 `event=="chat"`。需新增分支：`event=="exec.approval.requested"` / `plugin.approval.requested` → 投递到一个**连接级审批队列**（非 runId 队列）。
- 对前端 SSE 新增事件类型，如 `{"type":"approval","id","kind","summary","raw"}`；前端渲染「批准/拒绝」按钮，回调后端新端点（如 `POST /openclaw/approval/resolve`），后端调 `approval.resolve`。
- **先决改动**：`connect` 帧 `scopes` 加 `operator.approvals`。

---

## 2. 斜杠命令（slash commands）

### 结论一句话
网关用 `commands.list` 方法暴露可用命令清单（含 `textAliases` 斜杠别名），供前端 `/` 输入补全；命令本身**通过普通 `chat.send` 发送**（消息文本以 `/` 开头即被解析为命令）。

### 方法（[官方文档]）

| 名称 | scope | 说明 |
|---|---|---|
| `commands.list` | `operator.read` | 列出某 agent 工作区的可用命令 |

**`commands.list` 请求参数**（官方已明示）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `agentId` | string | 缺省 = 默认 agent 工作区 | 目标 agent |
| `scope` | `"text"` \| `"native"` \| `"both"` | `"both"` | `text` = 不带 `/` 的斜杠命令；`native` = provider 原生命令 |
| `provider` | string | — | 影响 native 命令名的可用性 |
| `includeArgs` | bool | `false` | 为 `false` 时省略序列化的参数元数据 |

**响应项字段**（官方已明示）：`name`、`description`、`textAliases`（精确斜杠别名，如 `/model`、`/m`）、`nativeName`（provider 感知的原生命令名）。`includeArgs=true` 时另含参数元数据（字段名 **「需实测」**）。

### 帧样例
```jsonc
// 请求
{ "type": "req", "id": "c1", "method": "commands.list",
  "params": { "agentId": "main", "scope": "both", "includeArgs": true } }
// 响应
{ "type": "res", "id": "c1", "ok": true, "payload": {
    "commands": [
      { "name": "model", "description": "切换模型",
        "textAliases": ["/model", "/m"], "nativeName": "model" /*, "args": [...] */ }
      // ...
    ]
} }
```
> 响应外层键名（`commands` 还是别的）官方文档未逐字给出，**「需实测」**。

### 命令如何发送与执行
- **发送**：走 R13 的普通 `chat.send`，`message` 以 `/` 开头（如 `"message": "/model gpt-4"`）。网关侧解析为命令并执行。
- **抑制解析**：`chat.send` 的 `suppressCommandInterpretation: true` 可阻止把消息当命令解析——但**需 admin scope**（R13 §2.1）。论文文本若含 `/`，普通 scope 下无法抑制，前端需注意。
- **写配置类命令**：持久化的 `/config set`、`/config unset` 即使已有 operator scope 也需 **`operator.admin`**。

### 与 runId 的关联
命令经 `chat.send` 发出后即占用一个 `runId`，其输出（命令结果）作为普通 `chat` 事件的 `delta`/`final` 回流，走 R13 既有 runId 路由，**无需特殊处理**。

### 后端翻译建议
- 新增后端端点（如 `GET /openclaw/commands?agentId=main`），内部调 `commands.list` 并缓存（清单低频变化），前端 `/` 输入时拉一次做补全。
- 命令执行**复用现有 `chat_stream()`**，不新增 WS 路径。
- 若多容器面板各容器 agent 不同，按 `agentId` 分别缓存清单。

---

## 3. 工具执行（tool call 开始 / 进行 / 结束）

### 结论一句话
客户端须在 `connect.params.caps` 声明 **`tool-events`** capability，网关才下发「结构化工具生命周期事件」；工具标题用 `chat.toolTitles` 方法批量换取（需网关在 `openclaw.json` 开启 `gateway.controlUi.toolTitles`）。**工具事件的精确事件名官方文档未给出，需实测。**

### capability 与开关（[官方文档]）

| 项 | 值 | 说明 |
|---|---|---|
| capability | **`tool-events`**（`connect.params.caps`） | 声明后网关才把本连接注册为工具事件接收方；不声明则收不到，但握手不失败 |
| 工具事件事件名 | **「需实测」** | 官方文档只说「structured tool lifecycle events」，未给 start/progress/end 的具体事件名与 payload |
| `chat.toolTitles` | method，需 `operator.read` + 网关开 `gateway.controlUi.toolTitles` | 批量生成工具「用途短标题」，供折叠展示 |

**[二手来源] 线索（未证实，需实测）**：工具生命周期事件可能是 `agent.tool.start` / `agent.tool.result`（或 `agent.tool_call` / `agent.tool_result`），payload 含工具名 + 输入 + 结果。与 R13 的 `chat` 单事件模型冲突，**必须以实测为准**。

### `chat.toolTitles`（官方已明示行为）
- 网关未开 `gateway.controlUi.toolTitles`（默认关）时响应 `{ "titles": {}, "disabled": true }`。
- 批量处理，**单次最多 24 条**，输入有界。
- 标题走 utility 模型路由：优先显式 `utilityModel`，否则会话 provider 的默认小模型；**绝不回退到主模型**。
- 按「agent + 工具名 + 输入」缓存。

### 帧样例
```jsonc
// 握手时声明 capability（对现有 connect 帧的增量）
{ "method": "connect", "params": { ..., "caps": ["tool-events"], ... } }

// 工具标题批量获取
{ "type": "req", "id": "t1", "method": "chat.toolTitles",
  "params": { "items": [ { "name": "bash", "input": {"cmd":"ls"} } /* ≤24 */ ] } }
{ "type": "res", "id": "t1", "ok": true, "payload": { "titles": { "<key>": "列出目录文件" } } }
// 「需实测」请求/响应的确切字段名（items/titles 的结构）
```

**工具生命周期事件（形态待实测，下为推测占位）**：
```jsonc
{ "type": "event", "event": "<tool-event-name>",  // 「需实测」确切名
  "payload": { "runId": "...", "tool": "bash", "state": "start|progress|end",
               "title": "...", "input": {}, "output": {} }, "seq": 33 }
```

### 与 runId 的关联
工具发生在某个 chat run 内部，工具事件 payload **预期携带 `runId`**（与所属 chat.run 关联），以便前端把工具卡片嵌进对应消息气泡。**「需实测」** 确认。后端 `_dispatch` 若按 runId 路由，需扩展以兼容工具事件（不能假设只有 `chat` 事件带 runId）。

### scope / cap 需求
- 收工具事件：`operator.read`（已有）+ `caps: ["tool-events"]`（**需新增**）。
- `chat.toolTitles`：`operator.read`（已有）+ 网关侧开 `gateway.controlUi.toolTitles`（`apply-config` 需写入）。

### 后端翻译建议
- `connect` 帧 `caps` 由 `[]` 改为 `["tool-events"]`。
- `_dispatch` 新增工具事件分支：按 payload 的 `runId` 投递到对应 run 队列，对前端 SSE 新增 `{"type":"tool","state":"start|end","title","name"}`。
- 「工具标题」折叠展示：优先用工具事件自带 `title`（若有）；否则收齐工具名+输入后调 `chat.toolTitles` 换标题（注意 ≤24 批量 + 网关须开开关，否则 `disabled:true` 降级为显示工具名）。
- **落地前必须先实测**：确认工具事件的确切事件名、是否携带 runId、payload 字段。

---

## 4. 思考链（reasoning / CoT）

### 结论一句话
**官方文档未定义独立的「思考链 / reasoning」帧或字段。** protocol v4 的 `chat` 增量事件只携带 `deltaText`（+ `replace` 标志 + 累积快照 `message`），**没有** `reasoning` / `thinking` 字段与 text delta 区分。[二手来源] 提到的 `agent.thinking` 事件**未获官方证实，需实测**。

### 官方文档已证
- `chat` 事件 `state="delta"` 时：增量载荷 = `deltaText`；`message` 仍为助手累积快照；非前缀替换置 `replace=true`、`deltaText` 为替换文本（与 R13 §3.1 完全一致）。
- **无** `reasoning` / `thinking` / CoT 专属字段、帧类型或 `state` 取值。
- 与「思考」相关的仅有请求侧的 `thinking` 级别覆盖（`chat.send.thinking`，如 `"low"/"high"`，R13 §2.1）和 `sessions.patch.thinkingLevel`——都是**设置思考强度**，不是**读取思考内容**。

### [二手来源] 线索（未证实，需实测）
- `agent.thinking` 事件：扩展思考输出流。
- 辅助函数 `isReasoningStream()`：判断某条流是否为思考轨迹。
- **已知问题——思考泄漏**：内部 reasoning 可能泄漏进公开 channel（WebChat 等），泄漏签名是正文里出现 `"The user is…"`、`"Reasoning:…"`、工具叙述等**纯文本**（即混在 `deltaText` 里，而非独立帧）。这意味着：**若网关不发独立 thinking 事件，思考内容只能以纯文本形式混在 `deltaText` 中，无法从协议层可靠区分。**

### 与 runId 的关联
若存在独立 thinking 事件，预期与所属 chat run 共享 `runId`（**需实测**）。若思考混在 `deltaText`，则与正文同一 runId、同一事件流，协议层无法区分。

### scope / cap 需求
- **「需实测」** 是否需声明某 capability（如 `reasoning` / `thinking` cap）才下发 thinking 事件。官方文档 capability 清单未列。

### 后端翻译建议（分两种实测结果）
- **若实测存在独立 thinking 帧**：`_dispatch` 新增 thinking 事件分支，按 runId 路由，SSE 新增 `{"type":"thinking","text":...}`，前端折叠渲染（区别于正文 `text`）。
- **若实测思考混在 `deltaText`**（更可能，对照官方文档）：协议层**无法**可靠区分思考与正文。可选启发式（按 `"Reasoning:"` 等前缀正则切分）但脆弱、有漏判——**建议默认不区分，整段按 `text` 透传**；如产品确需折叠思考，先实测确认网关是否真有独立 thinking 通道再实现。
- **落地前必须先实测**：起容器跑一次带思考的会话，`websocat` 抓帧，确认是否存在独立于 `chat.delta` 的 thinking 帧及其事件名/字段。

---

## 附：四特性「文档已证 / 需实测」速查

| 特性 | 关键名 | 状态 | 落地前还需 |
|---|---|---|---|
| **权限审批** | `exec.approval.requested` / `approval.resolve`(`id,kind,decision`) / `operator.approvals` | **文档已证**（方法名 + scope + resolve 三字段） | `connect` 加 `operator.approvals` scope；「需实测」审批事件完整 payload、`decision` 取值、是否需 `caps` 声明、`exec.approval.resolve` 字段 |
| **斜杠命令** | `commands.list`(`agentId/scope/provider/includeArgs`) / 经 `chat.send` 发 `/cmd` | **文档已证**（方法 + 参数 + 响应字段 + 发送路径） | 「需实测」响应外层键名、`includeArgs=true` 时参数元数据字段 |
| **工具执行** | `caps:["tool-events"]` / `chat.toolTitles` / `gateway.controlUi.toolTitles` | **部分已证**（capability、toolTitles 行为已证；**工具事件名未证**） | `connect` 加 `tool-events` cap；`apply-config` 开 `toolTitles`；**「需实测」工具 start/end 事件名、payload、是否带 runId** |
| **思考链** | （无独立帧）/ `chat.delta.deltaText` | **文档已证无独立 reasoning 帧**；`agent.thinking` 仅二手来源 | **「需实测」是否存在独立 thinking 帧**；若无则协议层无法区分思考与正文 |

### 对现有代码的最小改动清单（与特性无关的通用前置）
1. `services/openclaw_ws.py:60` `connect` 帧 `scopes`：`["operator.read","operator.write"]` → 追加 `operator.approvals`（特性 1）。
2. 同处 `caps`：`[]` → `["tool-events"]`（特性 3）。
3. `_dispatch`（`openclaw_ws.py:161`）当前仅路由 `event=="chat"` → 需扩展以分发 `exec.approval.requested`（连接级）与工具/思考事件（runId 级）。
4. `apply-config`（`routes/openclaw.py`）→ 写入 `gateway.controlUi.toolTitles: true`（特性 3 工具标题）。
