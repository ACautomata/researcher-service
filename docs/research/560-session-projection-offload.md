# #560 规格：SDK SessionProjection 接管 run 归约/终态（P0，连接/状态层减负）

> 判定依据：`#553`（SessionProjection 只到 transcript/run 投影、不解析 content）+ `#558`（官方 `chat-gateway.ts` 同款用法）。
> 权威语义来源：`@openclaw/gateway-client@2026.7.2-beta.6` 运行时实证（`dist/session-subscriptions-BV7MxYiL.mjs`）。
> 目标：把 SDK 已导出却一直没用上的 `SessionProjection` 套件，接管 `eventTranslate`/`useChatConnection` 里**手写的 run 终态归一化 + 终态消息归一化 + 重放去重**——是「减负」不是「全替换」。产出交 `#556` 收口。

---

## 0. 最终边界（先定调，全文围绕它）

**我们手写的是「增量投影 + 归属守卫」，SDK 管的是「run 终态归一化 + 终态消息归一化 + 重放去重」。**
`SessionProjection` 只到 run/转录本层，把 message 当不透明 `unknown`、从不打开 `content[]` 拼增量文本——所以
**delta 文本/thinking/工具/审批/附件的渲染翻译仍 100% 自建**（`#553` 结论，本规格不改）。它接管的是
`eventTranslate`/`useChatConnection` 里**散落的终态分类、message 多态归一化、跨事件 dedup** 这三类判定。

**与官方的差异（两处，都有架构理由，已锁不随官方）：**
1. 官方流式 `chatStream` 是**每 delta 覆盖整段**（`resolveDeltaChatStreamText` 求整段快照）；我们是**增量 append**
   `last.raw += delta`（`useChatConnection.ts:229`）。这是契约差异，本规格保持现状。
2. 官方本地乐观消息进 projection（`sendPending`）；我们 `newMsg` 本地消息**从不进 projection**——
   它们缺网关 `__openclaw` 元数据，喂入会被 `isLocallyOptimisticSessionMessage` 误判、把 `reconcile` 的
   「只保留 live/pending」语义搅浑。**projection 不跨连接，连接边界整体作废重建（下详）。**

---

## 1. 架构：挂一层薄归约器（官方同款姿势）

```
裸 GatewayProtocolClient onEvent
        │
        ▼
┌─ SessionProjection 归约器（新增，薄，同宿 gatewayChat 连接闭包）─┐
│  projection = reduceSessionProjectionRunEvent(projection, payload, scope)  │
│  → SessionProjectionRunTransition { projection, previousRun, currentRun }  │
│  终态时：currentRun.status / currentRun.message / currentRun.errorMessage   │
│  重放时：hasSessionProjectionAcceptedFinal(previousRun, currentRun.message) │
└──────────────────────────────────────────────────────────┘
        │ 用归约结果构造终态/去重判定；delta 原文直透
        ▼
  ChatEventTranslator.translate → ChatFrame（渲染契约不变）
        ▼
  useChatConnection.handle*（claimRun 归属守卫 + 增量 raw 累积，不变）
```

- **放置**：projection 状态放 `gatewayChat`（与 `translator` 并列，`gatewayChat.ts:203`），生命周期 = 连接闭包。
  官方也挂在连接编排层（`chat-gateway.ts`），不放 `eventTranslate` 纯函数模块。
- **payload 直喂**：`reduceSessionProjectionRunEvent` 的入参 `SessionProjectionGatewayRunEvent` 形状
  `{state, runId, message, stopReason, errorKind, errorMessage, yielded}` 与我们 chat 事件 payload 同构，
  **无需消息映射层，payload 直接喂**。`scope` 省略（`scopesMatch` 对 `undefined` 宽容）。
- **惰性创建**：首个 chat run 事件时 `createSessionProjection()`（空），其后每 run 事件归约替换。
- **连接边界**：`onHello` 重建 projection（与现有 `resetTranslator()` 并列）。**不做 transportGap/reconnected
  增量喂入，不跨连接维护**——重连后 transcript 走全量 `loadHistory` 重建（见 §3），projection 只管「本连接内
  run 的归约/去重」。
- **ChatFrame 渲染契约不变**：`text/done/error/approval/approvalResolved/tool/attachment` 七帧原样。变的是
  「谁产出终态判定与终态 message」，不是产什么帧。

## 2. 替代清单（SDK 接管）vs 保留清单（手写）

### 2.1 替代：终态判定归一化 → `SessionProjectionRun.status`

`eventTranslate.translate` 的 `aborted/error` 分支（`eventTranslate.ts:182-199`）+ `useChatConnection` 的
`handleDone`/`handleError` 终态路由（`:250-330`）**改为读 `transition.currentRun`**：

| 现状（手写判 payload） | 改造后（读 `currentRun`） |
|---|---|
| `state==='aborted'` → `done` 帧 | `currentRun.status==='aborted'` → `done` 帧 |
| `state==='error'` → `error` 帧（`errorMessage ?? errorKind` 手写取舍） | `currentRun.status==='error'` → `error` 帧，`currentRun.errorMessage`（SDK 已 `readNonemptyString` 归一） |
| 无「timeout/yielded」概念 | `currentRun.status==='timeout'` → error 帧（message 带 timeout）；`'yielded'` → done 帧（SDK 语义：`yielded=true && stopReason==='end_turn'`） |

**净得**：errorMessage/errorKind 手写取舍删掉；新增 timeout/yielded 细分（`#558` 点名的 SDK 独占能力）；
`aborted/final/error` 三分支坍成「读 `currentRun.status` 一个 switch」。**归属路由不变**：done/error 帧仍挂 runId，
`handleDone`/`handleError` 的 abandoned/foreign/orphan/activeRunId 守卫原样消费。

### 2.2 替代：终态消息归一化 → `currentRun.message`

`translateFinal`（`eventTranslate.ts:231-254`）的 `extractMessageText(payload.message)` + tail 补发 + 非前缀
replace 纠正 + `extractMessageAttachments(payload.message)`，**message 来源从 `payload.message` 换成
`currentRun.message`**。SDK `updateRun` 已把「delta 期快照 → final 权威 message」归一成终态 `run.message`
（含「delta 给快照、final 无 message 时沿用 current.message」的保留逻辑，`.mjs:1164`），替代我们散在
delta-replace 快照（`eventTranslate.ts:204-209`）与 final 提取两处的 message 归一化。

> delta 路径不变（仍读 `payload.deltaText`/replace 原文增量直透）；仅 final 的 message 来源改走 `currentRun.message`。

### 2.3 替代：终态清理 → `acceptedFinalMessageIdentities`

`translateFinal` 末尾 `this.sent.delete(runId)`（`:252`）、`aborted` 分支 `this.sent.delete(runId)`（`:184`）、
error 分支 `this.sent.delete(runId)`（`:195`）——**这三个手动终态清理删掉**，改由 SDK 在 `runTerminal` 时把终态
identity 记入 `acceptedFinalMessageIdentities`（`.mjs:1163`）。`_sent` 在终态后**不再立即 delete**（条目转为
「冷条目」，配合 §2.4 dedup 与 §2.5 有界淘汰兜底）。

### 2.4 替代：重放去重 → `hasSessionProjectionAcceptedFinal`（新增的安全网，现状无对应）

新增：终态到达时若 `hasSessionProjectionAcceptedFinal(previousRun, currentRun.message)` 为真 → **跳过本次终态
渲染**（官方 `chat-gateway.ts:170-180` 同款用法，防 resume 重放/断线重发把同一 final 渲染两次）。
**这是官方有、我们缺的 dedup**——官方 `acceptedFinalMessageIdentities` 只记终态、有界 200 run（`.mjs:1113-1120`），
正好兜住「重放 final」。**它不替代 `_sent`**（见 §2.6 关键否定）。

### 2.5 保留：`_sent` 增量累积器（不可被 SDK 替代）

`_sent: Map<runId, 已发文本>`（`eventTranslate.ts:141`）是**增量渲染投影的必然产物**：我们 delta 是「append 增量」
而 final 需要「全文 vs 已累积」求 tail / 判前缀漂移，这个增量态 SDK 不提供（官方对应物是 `chatStream` 全量覆盖投影，
概念等价但契约相反）。**保留 `_sent` 及其全部既有行为**：
- delta 累积（`:218,226`）、replace 快照纠正（`:208,244-245`）、F9 非前缀 replace（`:240-246`）原样。
- `MAX_SENT_ENTRIES=500` 有界防御（`:223`）**保留**——终态不再 delete（§2.3），靠容量上限 + `onHello` `reset()`
  兜底清理。这与 SDK「终态不delete、靠 200 run 淘汰」语义同构，不算泄漏（500 是防御值，正常对话远不及）。

### 2.6 保留：`_sent` 的前缀 dedup 角色（关键否定——`hasSessionProjectionAcceptedFinal` 替代不了它）

`_sent` 的「同连接内 final-vs-已发文本求差」**顺带**承担了 dedup，但 `hasSessionProjectionAcceptedFinal`
**不能**接管这一角色：`readSessionProjectionFinalMessageIdentity` 对无 id/seq 的消息退化为
**内容指纹**（`content:JSON.stringify([role, content, media, …])`，`.mjs:1093-1103`）。重复内容的不同消息 →
同指纹 → 误判重放被吞。`_sent` 的文本求差对重复内容安全（重复 delta 照常 append）。故：**同连接内 dedup 仍靠
`_sent` 前缀求差；`hasSessionProjectionAcceptedFinal` 只做跨事件「重放 final」的额外网，不碰 `_sent`。**

### 2.7 保留：`activeRunId`/`foreignRunIds`/`abandonedRunIds` 归属状态机（官方也手写）

`claimRun`（`useChatConnection.ts:158-216`）+ `handleDone`/`handleError` 的归属守卫**全套保留、一行不动**。
`#558` 维度 3 判定「打平」：官方同为「外来 run 劫持 activeRunId 吞回复」这个 bug 手写状态机（其 `#1909`），
projection 无「哪条 run 该进当前气泡」的 UI 决策对应物。pendingSend/myRunId/grace 宽限同理保留。

### 2.8 保留：delta/thinking/工具/审批/附件渲染翻译（`#553`：85-90% 自建）

`translateDelta` 增量路径、`splitThinking`、`translateTool`、`approvalCard`/`approvalResolved`、
`extractMessageText`/`extractMessageAttachments`/`attachmentToMediaBlock` **全部保留**。SessionProjection 对这些
一帧都不产（`#553` 逐帧判定）。

## 3. 断线恢复 reconcile：不引入 `reconcileSessionProjectionSnapshot`（本规格判定不可行）

**#560 问 3 问「断线恢复 reconcile 是否可用 `reconcileSessionProjectionSnapshot`」——答：否（当前形态不可行）。**

- 官方能用它，因为官方本地乐观消息**进 projection**（`sendPending`/`messagePersisted`），reconcile 才能
  「只保留 live/pending 条目，其余以快照为准」（`.mjs:1061-1063`）。我们本地 `newMsg` 消息缺 `__openclaw`
  元数据、从不进 projection，reconcile 的 entry 匹配对它们失效。
- `insertEntry` 排序靠 `identity.sequence`（`__openclaw.seq`），我们历史/本地消息拿不到可靠 seq（`.mjs:1018-1034`）。
- 我们现有恢复路径已正确且经测试：**`resumeRun`（`:88,612`）保留在途 run 占位等续帧；`loadHistory` 的
  `inFlight` 保留（`:873-876`）把 `await` 期间的 user+流式 assistant 占位接在历史快照后**。这是「全量快照 +
  在途保留」，语义等价 reconcile 但贴合我们「本地消息不入投影」的现状。

**结论**：reconcile 维持 `loadHistory` + `inFlight` 保留现状，`reconcileSessionProjectionSnapshot` 本规格不引入。
（若未来把本地乐观消息也接入 projection 元数据，可另票再议——届时 `#560` 的 projection 接线是天然落点。）

## 4. 验收标准

1. **行为等价**：`cd frontend && npm run test` 全绿；`npm run build`（vue-tsc）零错。改造后
   `eventTranslate.test.ts` / `gatewayChat.test.ts` 断言的渲染结果与现状逐帧等价（同一事件序列产同一 ChatFrame 序列）。
2. **手写代码净减少**：`eventTranslate.ts` + `useChatConnection.ts` 手写状态判定**净删**——量化目标：删
   `aborted/error` 分支的手写 message/清理逻辑（`:182-199`）、`translateFinal` 的手动 `sent.delete`（3 处）、
   errorMessage/errorKind 手写取舍，**净减 ≥ 30 行**；新增 projection 归约接线 ≤ 25 行（薄）。
3. **归一化接管实证**：新增测试证明终态判定/终态 message 来自 `currentRun` 而非手写 payload 判读
   （如：error 事件的 `errorMessage` 经 SDK `readNonemptyString` 归一、delta 期快照被 final 权威 message 覆盖）。
4. **重放去重实证**：新增测试——同一 run 的 final 重复到达（模拟 resume 重放）第二次被
   `hasSessionProjectionAcceptedFinal` 拦截，只渲染一次。
5. **timeout/yielded 细分实证**：`state:'error' + errorKind:'timeout'` → error 帧带 timeout；
   `final + yielded:true + stopReason:'end_turn'` → done 帧（此前我们无此区分，作为新增覆盖而非回归）。

## 5. 测试改写清单

- **`eventTranslate.test.ts`（491 行）**：终态相关用例（`aborted→done`、`error→error`、final tail/replace）改为
  断言「经 projection 归约后的等价 ChatFrame」；`F9` 非前缀/重复 delta/前缀漂移用例（`:41-56,140-146`）**原样保留**
  （`_sent` 行为不变，是等价性回归网）。
- **`gatewayChat.test.ts`（964 行）**：`onEvent → onFrame` 路由用例（`:229`）断言帧序列不变；新增 projection
  接线用例（onHello 重建 projection、终态 dedup、timeout/yielded）。
- **`useChatConnection` 归属/恢复测试**（`claimRun`/`foreignRunIds`/`resumeRun`/`loadHistory` inFlight）：
  **不动**——归属与 reconcile 路径未改，是天然回归网。
- 新增 **`sessionProjection` 接线单测**（可并入 `gatewayChat.test.ts`）：覆盖 §4.3/§4.4/§4.5。

## 6. 交 #556 收口的要点

- 本项是「减负」非「全替换」：SDK 接管**终态归一化 + 终态消息归一化 + 重放去重**；`_sent` 增量投影、归属守卫、
  渲染翻译全保留。
- 与 `#555`（工具渲染）**文件零冲突**：`#555` 改 `ToolLine.vue` + `eventTranslate.translateTool`（产 tool 帧字段），
  本项改 `gatewayChat` projection 接线 + `eventTranslate` 终态/`translateFinal` + `useChatConnection` 终态消费——
  仅 `eventTranslate.ts` 有交集但函数不重叠（tool vs final/terminal）。**实施顺序：建议本项先行**（动连接层地基），
  或两者并行后合并 `eventTranslate.ts` 时按函数粒度对齐。
- D 档提醒：`reconcileSessionProjectionSnapshot` 当前形态不适用（本地消息不入投影），未纳入——若 #556 定
  「本地乐观消息接入 projection 元数据」方向，本项是落点。
