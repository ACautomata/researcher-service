# #553 研究：官方 SessionProjection/订阅能否覆盖 ChatView 全部帧型

> 权威来源（ADR 0007）：GitHub `openclaw/openclaw` 的 `packages/gateway-client/src/*.ts`，锁 `v2026.7.2-beta.6` tag。
> 实证文件：`session-projection.ts`（758 行，beta.6 含 `reduceSessionProjectionRunEvent`，main 才拆出 `session-projection-run-event.ts`）、`session-subscriptions.ts`（382 行）。
> 比对对象：`frontend/src/chat/eventTranslate.ts`（327 行）、`thinking.ts`、`timeline.ts`、`attachments.ts`、`useChatConnection.ts`（1139 行）。

> **计数口径说明（两次独立研究，实质一致）**：本票有两份研究，结论相同——「SessionProjection 是 transcript/run 投影、不解析 message.content、ChatView 渲染帧基本全自建、订阅协调器只做审批订阅/回放」。覆盖率数字差异只是**计数口径**：写「覆盖 0% / 自建 100%」是严格只数「官方直接产出该渲染帧」；写「覆盖 10-15% / 自建 85-90%」是把「run 状态机可推 done」「media 展示性信号」「审批订阅/回放」算作部分覆盖。**实质无冲突：ChatView 7 种渲染帧型官方一帧都不直接产出。**

## 官方导出面（beta.6 实证）

`@openclaw/gateway-client/browser`（`browser.ts` 第 8–9 行）与 `./index` **均直接导出** `session-projection.js` 与 `session-subscriptions.js`——浏览器可**直接经 npm `./browser` 导入 `createSessionProjection`/`reduceSessionProjectionRunEvent`/`getGatewaySessionMessageSubscriptionCoordinator` 等，无需 fork**。本研究已实证这两个模块的实现零 Node 依赖（纯类型 + 纯函数 + 一个 WeakMap 协调器），browser-safe。

## 一句话结论

**不能覆盖。** 官方 SessionProjection 是「transcript/run **持久化 + identity/去重 + run 生命周期**」投影，**只到消息粒度、且把消息当不透明 `unknown`**；它不提供 ChatView 渲染所需的任何**内容层/连接级**帧型。订阅协调器只是 `sessions.messages.subscribe/unsubscribe` 的 wire 租约管理，**不产出任何渲染帧**。ChatView 帧型 ≈ **官方投影直接给 0% + 全部需自建翻译**；投影能替代的只是 `useChatConnection` 里一小部分「transcript 对账/重放去重/历史重建」，而那一块并非 `eventTranslate` 的职责。

## 1. 官方投影的输入与输出形状

### 输入（两套，互不重叠）

**(a) `SessionProjection`（session-projection.ts）** — 输入是 `SessionProjectionEvent` **抽象事件**（不是原始 wire EventFrame）：
- `snapshotLoaded{messages}` / `messagePersisted{message,envelope}` / `sendPending` / `sendAcknowledged` / `sendFailed` / `runDelta{runId,message}` / `runTerminal{runId,status,message,...}` / `sessionReset` / `transportGap` / `reconnected`。
- 网关侧原始事件先经 `reduceSessionProjectionRunEvent(event)` 归一——它只认 `event.state ∈ {delta, final, error, aborted}`，其余 state/无 runId 直接返回 `null`（丢弃）。

**(b) `GatewaySessionMessageSubscriptionCoordinator`（session-subscriptions.ts）** — 输入是 `acquire(key,{agentId,includeApprovals})` / `release(subscription)`；输出是 `GatewaySessionMessageSubscription{key, agentId?, includeApprovals?, approvalReplay?}`，即 **RPC 租约句柄**，不输出消息内容。

### 输出形状（SessionProjectionState）

```ts
SessionProjectionState = {
  scope,                                    // sessionKey/sessionId/agentId/...
  entries: readonly SessionProjectionEntry[], // {message, identity, live, pending, pendingRunId}
  messages: readonly unknown[],             // entries 派生的 message 视图
  runs: Record<runId, SessionProjectionRun>,  // {runId,status,message,acceptedFinalMessageIdentities,stopReason,errorKind,errorMessage}
  hasTransportGap: boolean,
}
SessionProjectionRun.status = "streaming"|"completed"|"error"|"aborted"|"timeout"|"yielded"
```

**投影出什么**：transcript 顺序（按 `__openclaw.seq`/envelope.messageSeq 插入排序）、消息 identity（role/id/sequence/idempotencyKey/runId/isImported/externalSource）、pending（乐观本地 user 消息）与 live/persisted 对账去重（`entryMatches`/`sameTranscriptIdentity`/`reconcileSessionProjectionSnapshot`）、run 生命周期状态机 + run 终态消息 + 重放去重（`acceptedFinalMessageIdentities`）、`hasTransportGap` 重连裂缝标记、run 集合有界保留（`MAX_TRACKED_SESSION_RUNS=200`）。

**不投影什么**（grep 实证，命中数为 0）：`thinking` / `reasoning` / `tool` / `deltaText` / `approval` 全不在投影逻辑里；`media` 仅出现 1 次——`hasDisplayableSessionMessage` 把 `__openclaw.media` 数组非空当「消息可展示」信号 + `readSessionProjectionFinalMessageIdentity` 把它并入内容指纹，**均不产出 MediaBlock 渲染数据**。`message` 字段始终是**不透明 `unknown`**，投影从不打开 `content[]` 拆块、不拼增量文本。

## 2. 逐帧型判定（官方投影 vs 自建翻译）

| ChatView 帧型 | 我方实现 | 官方投影直接给？ | 判定 |
|---|---|---|---|
| **文本增量 delta** | `translateDelta`：`payload.deltaText` 累积 `_sent`，产 `{type:text,delta}` | ❌ 投影把 delta 当 `runDelta{message}` 存整段，**不读 `deltaText`、不产增量** | **自建**。协议根本不在 wire 传 message 级增量——增量在 `deltaText`，投影不碰。 |
| **终态 final** | `translateFinal`：尾部补发（`message.slice(sent.length)`）→ text + `done` | ⚠️ 投影产 `runs[runId].message` + `status:completed`，**但无 tail-补发逻辑、无 `done` 帧** | **自建**（tail 补发 + done 帧是渲染契约）。投影的 final message 可当**输入**复用。 |
| **replace 快照** | `delta{replace:true}` → 整段 set；`final` 非前缀 → replace 纠正 | ❌ 投影对 replace 无概念，只 upsert `message` | **自建**。replace 是「流式投影与权威文本不一致」的 UI 纠正，投影不做。 |
| **thinking 拆分** | `splitThinking`：对 `<thinking>...</thinking>` XML 标签做**内容层字符串扫描** | ❌ 协议无 thinking 概念（T08：thinking 内联在 text 增量里），投影从不解析 content 字符串 | **自建**。纯 UI 内容层解析，与投影正交。 |
| **工具事件帧** | `translateTool`：`event:'agent'`+`stream:'tool'`+`data.phase` → `{type:tool,state:running/done/error,...}` | ❌ 投影只认 chat run 事件；`reduceSessionProjectionRunEvent` 对 agent/tool 事件返回 `null`（丢弃） | **自建**。工具事件在投影输入层就被丢弃。 |
| **审批卡 requested** | `approvalCard`：`exec/plugin.approval.requested`（连接级广播）→ `{type:approval,id,kind,command,sessionKey,agentId}` | ❌ 投影不碰 approval；订阅协调器的 `includeApprovals`/`approvalReplay` 只是「让网关把审批事件随订阅一并下发」的**传输升级**，**不翻译帧** | **自建**。协调器替代的是「连接级审批订阅 fan-out」的**订阅动作**（对应我方 gatewayChat 的订阅），不是 `approvalCard` 翻译。 |
| **审批卡 resolved** | `approvalResolved`：`exec/plugin.approval.resolved` → `{type:approvalResolved,id,decision}` | ❌ 同上，无 resolved 帧翻译 | **自建**。 |
| **附件媒体块** | `extractMessageAttachments`（历史/流式 message.content[]→MediaBlock）+ `attachmentToMediaBlock`（发送 echo） | ❌ 投影不产 MediaBlock（仅把 `__openclaw.media` 当展示性/指纹信号） | **自建**。 |
| **runId 归属/外来 run 丢弃** | `useChatConnection`：`activeRunId`/`abandonedRunIds`/`claimRun`/`foreignRunIds` 状态机 | ❌ 投影无「活跃 run 认领/外来 run 丢弃」——它按 scope+runId 全量记录，不做「哪条 run 该进当前气泡」的 UI 决策 | **自建**。这是防「外来 run 劫持用户气泡」的 UI 策略，投影无对应物。 |

## 3. 结论：覆盖度比例

**ChatView 渲染帧型 = 官方投影覆盖 0% + 自建翻译 100%。**

- `eventTranslate.ts`（327 行，7 种 ChatFrame）**全部保留为 UI 专属薄翻译**——官方投影一帧都不替它产。
- `thinking.ts` / `extractMessageAttachments` / `attachmentToMediaBlock` 同理，与投影正交。
- `useChatConnection` 的 `activeRunId`/`abandonedRunIds` 归属机也保留（投影无对应决策）。

**官方投影真正能吸收的（不是 eventTranslate 的活）**：
1. **历史/快照对账**：`reconcileSessionProjectionSnapshot` + `entryMatches` 可替代我方 `loadHistory` 重建 + 重连补拉时的「持久化 vs 乐观/外来」去重（目前散在 useChatConnection 的历史路径）。
2. **run 生命周期 + 重放去重**：`runs[runId].status`（含 `timeout`/`yielded` 细分）+ `acceptedFinalMessageIdentities` 可替代我方 `_sent` 累积器的部分终态清理、断线 resume 重放去重；`hasTransportGap` 给出比「无看门狗」更明确的传输裂缝信号。
3. **transcript 排序**：按 `__openclaw.seq` 的 `insertEntry` 排序，比我方「按到达序 append」更贴合断线重连/历史 prepend 场景。

**订阅协调器真正能吸收的**：`includeApprovals` 的「单 observer 升级带审批 + `approvalReplay` 重放」可替代我方 gatewayChat 里手写的「连接级审批 fan-out 订阅」；`reset()` 的「重连退役旧租约不碰新连接」对应我方重连重建订阅。**它不替 eventTranslate 出帧。**

## 对 fork 的含义（喂给 map #551 的「事件翻译去向」）

- **fork 出来也要保留 `eventTranslate` 全套**：SessionProjection 与 ChatEventTranslator 解决的是**不同层**问题（transcript 持久化对账 vs 渲染帧翻译），不是替代关系。
- **可选叠加**：在把原始事件喂给我方 `ChatEventTranslator` **之前**，可并行喂 `reduceSessionProjectionRunEvent` 维护一份 transcript 投影，用于历史重建/重放去重/外来消息归并——替代 `useChatConnection` 里对账相关的散逻辑（约几十行，非 327 行翻译主体）。**复用路径**：`session-projection` 可直接经官方 `@openclaw/gateway-client/browser` npm 导入（见上「官方导出面」），**不必 fork**；订阅协调器同理。
- **订阅侧**：fork 的 `client.ts` 内部若引用 `session-subscriptions.js`（`./browser` 已导出，browser-safe），fork 会自然带出 `GatewaySessionMessageSubscriptionCoordinator`，替代我方手写审批订阅 fan-out；审批/工具/文本/thinking/附件的**帧翻译仍走 eventTranslate**。

