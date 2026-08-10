# 增强 P1：outbox 离线待发队列持久化（sessionStorage 最小版）实现规格（#564 / 子 ticket of #551）

> **研究问题**：为面板 chat/ 补齐官方独占、我们完全没有的「离线/重连待发持久化」——断网或重连期间用户已输入但尚未送达的消息不丢，重连后恢复重发。定**最小版**实现规格（官方 713 行 + 依赖 7 态 queue 状态机，对面板单容器/单会话过重，#558 判「思路档自写」）。
>
> **判定依据**：
> - **官方**：`ui/src/lib/chat/outbox-store.ts`(713 行）+ `outbox-store-codec.ts`——sessionStorage 按 `gatewayOwner` scope 存 `StoredComposerSession{draft, queue: ChatQueueItem[], updatedAt}`；queue 项含 `id/text/createdAt/sendAttempts/sendState(7态)`；依赖其 `chatQueue` + `sendState` 7 态发送状态机（`chat-types.ts:35-66`）。
> - **我们**：完全没有——断线时用户消息只在内存，刷新/重连即丢（`useChatConnection.ts` 仅 `pendingSend` 单标志 `:62` + 首帧乐观 echo `:772-783`）。
> - **既有事实（本仓实证）**：`gatewayChat.send` 已内置 `idempotencyKey`（`createRequestId().replace(/[^a-z0-9]/g,'')`，`gatewayChat.ts:590-596`)——网关幂等去重的基础设施**已存在**，只是当前每次 `send()` 调用都重新生成（重发会拿新 key 而失效）。
>
> **advisor 三处修正（已并入）**：①范围收紧到「ack 未回才落盘」在线路径，不做离线排队；②刷新恢复落点在 `syncSessions` 之后、且必须先 `loadHistory` 再重发（防排序反转 + 双跑）;③「catch 不 remove」的保守取值反致双发，须按 activeRunId 细分。

---

## 一、最小版形态与范围（先框死，避免 scope creep)

**官方 713 行复杂在哪、我们为何不抄**：多 `gatewayOwner` 分桶 + `agentId`/`mainAlias` scope 解析 + `draftRevision` 跨标签同步 + legacy v1→v2 迁移 + `subscribeStoredChatOutboxChanges` 监听。面板是**单容器单会话单标签**场景，这些全砍。

**范围再收紧一档**：outbox **只在「在线但 ack 未回」的窄窗落盘**，捕获「已发出但未确认」的并发断线。断开后（`disconnected=true`）输入的消息**不**排队——现状 `onClose` 已 `disconnected.value=true` 禁发（`useChatConnection.ts:588`)，它们从未离开输入框，本就「不丢」（只是没发）。这样：

- **不动现状发送门**（`send()` `:769` 的 `disconnected` 检查原样保留，不引入「断线可排队」新 UX)。
- **绕开 ack 超时窗**：网关慢、ack 8s 才回时，在线路径的 `addPending` 已在 ack 到达时 remove（§三.1 先 add 后 ack 完成即删），重发钩子又只在恢复路径跑——不打扰正常慢网关。
- 确认点（ack）与「真发出去」的界天然重合，无逻辑扭曲。

**纳入范围（最小闭环）**:
1. 在线发送时把「待确认」消息写入 sessionStorage(scope = 容器+会话）。
2. ack 确认送达 → 从 outbox 删除。
3. 刷新/重连后 → 若该 scope 有残留待发项（说明上次 ack 未回即断）,**先 loadHistory 再重发**。

**显式排除（最小版不做）**:
- **不引入 7 态 sendState / steer / queue 状态机**——#558/地图已判过重。只「待确认/已确认」二元。
- **不持久化附件**（`Attachment` 含 File/dataUrl，序列化体积大且 File 引用跨刷新失效）——只持久化**纯文本**；带附件消息断线仍丢（已知限制，ticket 本就写「只存待发文本」)。
- **不持久化输入框草稿**（官方 `draft` 是另一功能）——不在「已输入但尚未送达」语义内。
- **不做跨标签 storage 监听**——面板单标签。
- **不动现状 resume 逻辑**(`resumeRun`/B5/:601-612)——#564 只管「用户那条没确认的」，不管「assistant 在途流恢复」（那是 #560/B5 范畴）。

---

## 二、Scope 键（ticket 待决点 1)

官方 scope = `(gatewayOwner, sessionKey, agentId)`。我们没有 gatewayUrl（隧道直连）与 agentId。**最小 scope = 容器 + 会话**：
- 同一浏览器跑多容器，必须按容器分桶，否则 A 容器待发被 B 读走重发。
- 同容器多会话（`selectedSession`)，按会话分桶重发才回到正确会话。

**存储 key**：单 JSON blob,`openclaw.panel.outbox.v1:<container>` →
```ts
{ version: 1, sessions: Record<sessionKey, OutboxItem[]> }

interface OutboxItem {
  id: string            // createRequestId() 32-hex,兼作幂等 key(§四)
  text: string
  createdAt: number
}
```

**容量**：单会话上限对齐官方 `MAX_STORED_QUEUE_ITEMS=50`；超限**丢最旧**（宁丢一条不爆 quota)。会话数天然受 `sessions` 键数约束。另：单 blob 跨会话读写是非原子 read-modify-write，并发 `addPending`(A 会话）与重发后 `removePending`(B 会话）可互相丢更新——最小版接受（单会话内单发+ack 快，竞争窗窄），文档标注。

---

## 三、恢复重发语义（ticket 待决点 2——核心决策）

### 三.1 待确认窗口与入/出时机

现状发送（`send()` `:765-818`)：乐观 echo user → `pendingSend=true` → `gateway.send()` → ack 返回 runId。**「待确认」= `chat.send` RPC 发起到 ack 返回 runId 之间**。

- **入**：`gateway.send()` 调用**前**，把 `{id, text, createdAt}` 写入该 scope（与 `pendingSend=true` 同步点）。
- **出（确认）**:ack **resolve** 拿 runId → `removePending`。ack = 网关已受理（`status:"started"`)，已送达，无需再持久化。

> 以 **ack** 为确认点而非首帧：ack 是网关权威「已受理」、早于流式首帧；以首帧为界会让「ack 已回但首帧慢」的窗口白白持久化。

### 三.2 catch 路径的 remove 决策（advisor 修正③)

「catch 一律不 remove」的保守取值**反而致双发**：网关实际已受理（建了 run）但 ack 丢失/超时，outbox 残留 → 重发经幂等去重（**不双跑**，幂等 key 兜住）——但 loadHistory 会先渲染网关建的那条用户消息，重发的乐观 echo 又渲染一条 → **UI 双条**。故必须细分：

- **catch 且 `activeRunId` 非空**（`:810` 现有 return，网关已受理在续流）→ `removePending`（已送达，ack 慢而已）。
- **catch 且 `activeRunId` 空**（首帧未到，run 未起来，`:810-815` finalize 支）→ **不 remove**，下次重连重发。

> 「确认已受理」的判别**沿用在途 run 信号**(`activeRunId`)，不为 catch 路径新建「已受理但 ack 丢」追踪——那会重新长出被砍掉的复杂度。残留项的 UI 双条风险由 §三.4 的「先 loadHistory 去重」兜住（见下）。

### 三.3 重发时机 = 会话选定且连接就绪，且必须先 loadHistory（advisor 修正②)

**刷新场景**：全新首连，`selectedSession` 由 `syncSessions` 拉列表后选定。重发**不能**挂在 `onReady` 重连支（那是 tab 存活、内存有 selectedSession 的路径）；刷新是**新首连**，落点在 `syncSessions` 完成选定**之后**。
**且必须先 `loadHistory` 再重发**，两个原因：
1. **排序**：重发的乐观 echo `pushMessage` 追加到 `messages` **末尾**；而「已受理但 ack 丢」的消息在网关在更早位置。不先 loadHistory 就 push，用户消息跑到较新 assistant 回复**之后** → 排序反转。loadHistory 先把网关权威历史（含那条已受理消息）铺底，再 push 重发，顺序才对。
2. **UI 双条去重**：loadHistory 拿回网关侧那条（已受理 ack 丢的）消息。若其 text/createdAt 与 outbox 项匹配（content-level)，**丢弃该 outbox 项不再重发**（它已在历史里）——这兜住 §三.2 catch 空 activeRunId 但网关已受理的残留。

> 触发点统一：**「某容器某会话选定且连接就绪」时**，先 `loadHistory`，再对 loadHistory 后的会话跑 `resendOutbox`。落点 = `syncSessions` 选定会话后（刷新）+ `onReady` 重连支的 syncSessions 路径（断线重连）。**避开** `onReady` 的 `resumeRun` 支（`:540-543` 在途 run 恢复，非用户待发语义）。

### 三.4 刷新 vs 断线重连

| 场景 | 现状 | outbox 恢复 |
|------|------|------------|
| **断线重连**(tab 存活，内存有 selectedSession) | `onReady` 重连支 → syncSessions | syncSessions 内选定后 loadHistory → resendOutbox |
| **整页刷新**(tab 重建，selectedSession 空） | 首连 → syncSessions 选定 | 同上，同一触发点 |

两路收敛到**同一触发点**(syncSessions 选定 + loadHistory 后），无需为首连/重连分两套。

### 三.5 自动重发（非回填确认）

重连/刷新后**自动重发**，不做「回填待用户确认」：官方语义即自动补发；「不丢」的修复就是自动补，回填仍把负担甩给用户。重发复用乐观 echo(`pushMessage(user)` + `pushMessage(assistant)`)，无特殊中间态，与「不引 7 态」一致。

---

## 四、重复发送去重（ticket 待决点）

**复用现有 `idempotencyKey`，不新造身份。**
- `OutboxItem.id` 即幂等 key：写入时用 `createRequestId().replace(/[^a-z0-9]/g,'')` 生成，并把同一 `id` 传给 `gateway.send` 的 `idempotencyKey`。
- 要求 `gatewayChat.send` 从「内部自动生成」改为「**外部传入优先，缺省内部生成**」（改造点）。
- **去重语义**：断线时「网关已收但 ack 丢」→ 重发同 `idempotencyKey`，网关幂等去重**不重复执行**（schema 必填 idempotency 即为此设，`:583`)。这是官方「`unconfirmed` 态靠 idempotency 防重」的同款——我们不需显式 `unconfirmed` 态，幂等 key 本身兜住 ack 丢失重发。

> **不引入 `hasSessionProjectionAcceptedFinal` 做用户消息去重**——那是 #560 管「重放 final」（assistant 侧）的网；用户消息去重的正确工具是 `chat.send` 的 `idempotencyKey`（网关侧幂等）。#560 也明确「本地乐观消息不入投影」。

---

## 五、改造点 / 新增文件（精确到文件/函数）

### 新增 `frontend/src/chat/outboxStore.ts`（类比 `localStorage.ts`，纯逻辑可测）

走 **sessionStorage**（官方同款；语义=「本标签本次会话的待发」，比 localStorage 的「跨会话持久」更贴待发，且不占长期存储）。需先在 `localStorage.ts` 补 `getSafeSessionStorage`（同款 try/catch 降级，对齐官方 `local-storage.ts` 双导出）。纯函数 0 信任读回（逐字段 normalize，坏行丢弃）:

```
loadOutbox(container): Record<sessionKey, OutboxItem[]>   // 读回 normalize,坏 blob → {}
addPending(container, sessionKey, item): void              // 入队,+50/会话 cap 丢最旧
removePending(container, sessionKey, id): void             // ack/已受理确认删除
takePending(container, sessionKey): OutboxItem[]           // 读走待发(重发用)
```

### 改造 `frontend/src/chat/gatewayChat.ts`（幂等 key 外注）

`send(sessionKey, message, attachments?, idempotencyKey?)`:key 改「外部传入优先，缺省内部生成」。~3 行（`:590-596`)。

### 改造 `frontend/src/chat/useChatConnection.ts`

1. **`send()`(`:765-818`)**:`gateway.send()` 前生成 `id` + `addPending`;ack `.then`(`:793-798`)`removePending`;catch 按 §三.2 细分（activeRunId 非空 remove，空不 remove）。传 `id` 作 `idempotencyKey`。
2. **新增 `resendOutbox(container, sessionKey)`**:`takePending` 读出，先经 loadHistory 内容去重（§三.3)，逐条走与 `send()` 相同的乐观 echo + `gateway.send(key, text, undefined, item.id)`，逐条 ack 后 remove。
3. **触发点**:`syncSessions` 选定会话 + loadHistory 后调 `resendOutbox`（刷新 + 断线重连同点，§三.3/三.4)。

> **宿主预览清理**:`ChatView.vue` `sendMessage`(onSend）管附件校验 + 清预览条。outbox 只接 composable 内 `send()` 的网关触点；预览清理只在宿主「决定发送」路径，重发路径（纯文本、无附件）不经宿主，天然不碰预览。

---

## 六、与 #560(SessionProjection 减负）的边界

- **#560 管**:run 终态归一化 / 终态消息归一化 / 重放 final 去重——**assistant 侧**。
- **#564 管**：用户待发消息持久化 + 重发 + 幂等去重——**user 侧**。方向正交，零逻辑交叠。
- **文件交集**:`useChatConnection.ts` 的 `send()`(#564 加队/删队）与恢复路径（#564 在 syncSessions/loadHistory 后插 resendOutbox,#560 改 resumeRun/reconcile)。函数粒度不重叠：#564 不动 `resumeRun`/`reconcile` 逻辑（显式排除，§一）。
- **不引入 `reconcileSessionProjectionSnapshot`**（与 #560 判定一致）。

---

## 七、验收（ticket 硬指标）

1. **断网输入 → 刷新/重连 → 消息不丢**：在线发出但 ack 未回即断的消息，重连/刷新后自动重发、出现在会话中正确位置（loadHistory 后）。
2. **不重发重复**:ack 已回的不留 outbox、不补发；ack 丢但网关已收的，重发经 `idempotencyKey` 幂等去重，转录无双跑；loadHistory 内容去重防 UI 双条。
3. **scope 隔离**:A 容器待发不被 B 读走。
4. **单测**(`outboxStore.test.ts` 新增 + `useChatConnection`/`gatewayChat` 改写）:normalize 坏行丢弃、cap 丢最旧、add/remove/take、send 入队/ack 删队/catch 细分、重发传原 id 复用幂等 key、loadHistory 去重。`vue-tsc` 零错。
5. **净行为约束**：正常在线路径零行为变化（ack 快时落盘即删，用户无感）；断线 UX 除「恢复后自动补发」外不变（仍禁发、不引入排队）。

---

## 八、与官方的最小版差异（已锁，不随官方）

① 不抄 713 行多 owner/agentId/draft/legacy/跨标签同步——单容器单会话单标签全砍；② 不引 7 态 sendState——只「待确认/已确认」二元（ack 为界）;③ 用 sessionStorage 而非 localStorage——贴「本标签待发」;④ 去重靠复用 `idempotencyKey` 而非显式 `unconfirmed` 态；⑤ 范围再收紧到「在线 ack 未回才落盘」,**不做离线排队**（现状已禁发，未发消息留在输入框本就不丢）。

## 九、已知限制（最小版显式取舍）

- **带附件消息断线仍丢**（File/dataUrl 不可持久化）——纯文本外暂不覆盖。
- **输入框草稿不持久化**（官方 draft 是另一功能）。
- **断开后输入的消息不排队**（现状禁发，留输入框）——若日后要「离线也能排队发」，是另一增强项，需先改发送门 UX。
- 重发是「新 run 语境」：断线前的在途 assistant 流不恢复（#560/B5 resumeRun 范畴）,outbox 只管「用户那条没确认的」。
- 单 blob 跨会话 read-modify-write 非原子，并发 add/remove 可互相丢更新——单会话单发场景窗窄，接受并标注。
