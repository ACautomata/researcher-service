# #565 实现规格：结构化 thinking 块提取（extractThinking 式）

> 归属：wayfinder 地图 [#551](https://github.com/ACautomata/researcher-service/issues/551)「chat/ 对齐官方增强」P1 增强项。
> 判定依据（官方 vs 我们）：见 [`558-official-ui-study.md`](./558-official-ui-study.md) 维度2「结构化 thinking 块」行。
> 与 #560 的关系：见 §5。本规格只产出**决策与改造点**，不承载写代码（地图 Destination 锁定「只做规划与决策」）。

## 0. 一句话

补齐官方有、我们缺的「结构化 thinking 块」渲染：新版网关在 `message.content[]` 下发 `type==="thinking"` 块时，提取其 `thinking` 字段文本进 `Msg.thinking`（折叠卡渲染）。**只补「结构化块」这一路**；内联 `<thinking>` XML 标签剥离（`splitThinking`）保留不动。history 路全量覆盖，流式路最小覆盖（replace 快照 / final 消息）。

## 1. 官方做法（一手证据，`message-extract.ts`）

官方 `extractThinking`（`ui/src/lib/chat/message-extract.ts:61-80`）原文语义：

```ts
function extractThinking(message: unknown): string | null {
  // message.content 为数组时遍历每个块：
  //   if (item.type === "thinking" && typeof item.thinking === "string")
  //     取 item.thinking.trim()，非空才 push
  // 多块用 "\n" join；全空返回 null
}
```

关键事实（决定我们实现的三点）：

1. **字段名是 `item.thinking`，不是 `item.text`**。官方只读 `thinking` 字段，无 `text` 兜底。
2. **逐块 `.trim()` + 丢弃空串 + 多块 `\n` join**；全空返回 `null`（区别于 `extractMessageText` 返 `''`）。
3. **与内联标签剥离是两个独立函数**：`stripThinkingTags`（`strip-thinking-tags.ts`，C 档委托共享层）剥内联 `<thinking>`，`extractThinking` 取结构化块——官方在 content 层**双路并存、各司其职**，不在一个函数里合并。这印证我们的分工（§3）。

## 2. 我们的现状（缺口定位）

| 位置 | 现状 | 缺口 |
|------|------|------|
| `eventTranslate.ts` `extractMessageText`（:55-67） | 只拼 `content[]` 里 `type==='text'` 块的 `text` | `type==='thinking'` 块被**静默丢弃** |
| `thinking.ts` `splitThinking`（:29-63） | 只处理**内联 `<thinking>` XML 标签**（残片/terminal 处理很精） | 不识别结构化块（`grep "type==='thinking'"` 无命中） |
| `useChatConnection.ts` `translateHistoryMessage`（:894-913） | `thinking: ''` 恒空（注释「暂不剥离」:889,907） | history 里 assistant 的 thinking 块完全丢失 |
| `useChatConnection.ts` `handleText`（:219-235） | 只对 `raw` 跑 `splitThinking` | 结构化块文本永不进 `Msg.thinking` |

**结论**：内联标签剥离我们已有且更精；要补的是「结构化块提取」这一路。这与 #558 的判定一致。

## 3. 与 `splitThinking` 的分工（核心待决项）

两条路**互不干扰、产物合并**，理由：二者作用在**不同的数据载体**上。

- **`splitThinking`** 作用在 `raw`（累积**内联标签**文本串）上：拆 `text`/`thinking`/`inThinking`，处理流式残片与 terminal 兜底。
- **`extractThinking`** 作用在 `message.content[]`（**结构化块**数组）上：取 `type==='thinking'` 块的 `thinking` 字段。

**合并规则（流式 `handleText` 内）**：

```
last.raw += delta                        // 文本增量照旧累积（不变）
const parts = splitThinking(last.raw)    // 内联标签路：照旧（不变）
last.text = parts.text                   // 正文只受内联路影响（不变）
last.thinking = structThinking !== null
  ? structThinking                       // 结构化块权威：覆盖内联剥离结果
  : parts.thinking                       // 无结构化块：回退内联路（现状）
last.thinkingOpen = parts.inThinking     // 「思考中」态仍由内联路供给（不变）
```

- **`structThinking` 覆盖（非拼接）**：结构化块是该消息思考的**权威来源**；当网关同时下发结构化块与内联标签时，二者大概率同源，拼接会翻倍。覆盖语义与官方 `extractThinking` 返 `string | null`（`null` = 无结构化块）天然对齐。
- **`null` 哨兵**：`structThinking === null` 表示「本条消息无结构化 thinking 块」，此时**完全不碰** `splitThinking` 的产物——保留内联路现状行为。只有非 `null` 才覆盖。这保证：旧版网关（只发内联标签）行为**逐字节不变**。
- **`thinkingOpen` 不动**：结构化块在 `replace` 快照 / `final` 出现时是完整块（无「未闭合」概念），「思考中」流式态继续由内联路的 `inThinking` 供给。

## 4. 两路改造点（精确到函数）

### 4.1 新增纯函数 `extractThinking`（`eventTranslate.ts`）

与 `extractMessageText`/`extractMessageAttachments` 并列的同款「0 信任内容块提取」纯函数。**与官方语义逐点对齐**：

```ts
// eventTranslate.ts（与 extractMessageText 同文件，紧随其后）
// #565 结构化 thinking 块提取（对齐官方 message-extract.ts extractThinking）：
// 取 message.content[] 里 type==='thinking' 块的 thinking 字段（string 才取），逐块 trim、
// 丢空串、多块 '\n' join；全空/无块/content 非数组 → null（区别于 extractMessageText 的 ''）。
// 0 信任：非对象 message / 块非对象 / thinking 非 string 一律跳过。
export function extractThinking(message: unknown): string | null {
  if (!message || typeof message === 'string') return null
  const obj = asRecord(message)
  const content = obj.content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = asRecord(block)
    if (b.type !== 'thinking') continue
    if (typeof b.thinking !== 'string') continue
    const cleaned = b.thinking.trim()
    if (cleaned) parts.push(cleaned)
  }
  return parts.length > 0 ? parts.join('\n') : null
}
```

- **不读 `text` 字段**：与官方对齐（官方只读 `thinking`）。若实测发现某些网关变体把思考放在 `type==='thinking'` 块的 `text` 字段，再以实证为准加 `?? b.text` 兜底——**当前不预设**（0 信任 + 对齐官方优先，避免无证据的「灵活性」）。
- 纯函数、无跨帧态，符合 `eventTranslate.ts` 既有风格（`extractMessageText`/`extractMessageAttachments` 同款）。

### 4.2 history 路：`translateHistoryMessage`（`useChatConnection.ts:894-913`）

**改造最小、覆盖最全**——网关 history 下发的是完整消息，`content[]` 里 thinking 块是完整块。

```ts
// useChatConnection.ts:894-913 translateHistoryMessage
const text = extractMessageText(m) || (typeof m.text === 'string' ? m.text : '')
const structThinking = extractThinking(m)          // #565 新增
// …
return {
  role: historyRole(m.role),
  raw: text,
  text,
  thinking: structThinking ?? '',                  // ← 由恒 '' 改为真实提取；null 回退 ''
  thinkingOpen: false,                             // 历史为终态，无「思考中」
  streaming: false,
  tools,
  media,
}
```

- `thinking: ''`（注释「暂不剥离」:889,907）→ `structThinking ?? ''`。
- 同时**删掉「thinking 暂不剥离」注释**（:889,907），改为指向本规格的语义说明。
- history 是终态，`thinkingOpen` 恒 `false` 不变。
- 与既有 `extractToolRows`（:917-935，仅当 `text===''` 时调用）无冲突：thinking 块提取独立于 toolCall 块提取。一条 `[thinking, toolCall×N]` 的 abort assistant 消息（E1b 实测场景）现在既能有工具行、也能有思考卡。

### 4.3 流式路：`handleText`（`useChatConnection.ts:219-235`）—— 最小覆盖

**现状契约决定的最小落点**：结构化 thinking 块只可能出现在 `message.content[]` 里，而流式 `content[]` 只在 **`replace` 快照** 与 **`final` 消息** 出现；`deltaText` 增量字段只含文本（内联标签走 `splitThinking` 已覆盖）。

```ts
// useChatConnection.ts handleText（在 splitThinking 之后合并结构化块）
function handleText(runId: string, delta: string, replace?: boolean) {
  if (!claimRun(runId)) return
  const last = chat.messages[chat.messages.length - 1]
  if (last && last.role === 'assistant' && (last.streaming || activeRunId === runId)) {
    if (!last.streaming) last.streaming = true
    clearResumeWait()
    last.raw = replace ? delta : last.raw + delta
    const parts = splitThinking(last.raw)
    last.text = parts.text
    last.thinkingOpen = parts.inThinking
    // #565：结构化 thinking 块（replace 快照 / final 消息的 content[]）权威覆盖内联剥离结果；
    // 无结构化块（null）时不碰内联路产物（旧网关行为不变）。
    const structThinking = extractThinking(/* 当前帧的 message，见下 */)
    last.thinking = structThinking ?? parts.thinking
  }
}
```

**关键问题：`handleText` 当前签名拿不到 `message`**。`translateDelta`/`translateFinal` 在 `eventTranslate.ts` 里把 `message` 提取成 `delta`/`replace` 文本后才发 `text` 帧，`handleText` 只见文本不见原始 `message`。两个落点方案：

- **方案 A（推荐）：在翻译层提取、随帧携带。** `translateDelta`（`eventTranslate.ts:203-229`）与 `translateFinal`（:231-254）在已有 `payload.message` 上顺手 `extractThinking(payload.message)`，把结果挂到 `text` 帧（`ChatFrame.text` 增一个可选 `thinking?: string | null` 字段），`handleText` 直接消费。**优点**：`extractThinking` 的调用与 `extractMessageText`/`extractMessageAttachments` 同层（0 信任解析集中在翻译层），`useChatConnection` 只做投影不碰 payload；`final` 路（`translateFinal` 的 tail/replace 帧）也自然覆盖。
- **方案 B：`handleText` 多收一个 message 参数。** 把 `payload.message` 透传进 `handleText`。缺点：把 0 信任 payload 解析泄漏进连接层，破坏「翻译层集中解析」的现有分层。

**采方案 A**。`ChatFrame` 的 `text` 变体加 `thinking?: string | null`（仅在 `replace`/`final` 帧可能非 `undefined`；`delta` 增量帧恒 `undefined`，`handleText` 对 `undefined` 跳过覆盖、仅 `??` 内联结果）。

> 说明：`deltaText` 增量帧**不**走 `extractThinking`——增量字段是字符串，无 `content[]`。内联标签在增量里由 `splitThinking` 处理。结构化块只在快照/final 出现，故增量帧无需改。

## 5. 与 #560 的关系（边界清晰、零冲突）

#560（SessionProjection 减负）的规格明确（[`560-session-projection-offload.md`](./560-session-projection-offload.md) `:12-13,120-123`）：

> `SessionProjection` 只到 run/转录本层，把 message 当**不透明 `unknown`**、从不打开 `content[]` 拼增量文本——所以 **delta 文本/thinking/工具/审批/附件的渲染翻译仍 100% 自建**（#553 结论，本规格不改）。

- **SDK 不产 thinking**：projection 不解析 `content[]`，故结构化 thinking 提取**永远是我们自建一侧**的活，#560 接管 run 终态/归一化/重放去重后仍如此。
- **「减负后谁来产 thinking」的答案**：仍由 `eventTranslate.ts` 翻译层（本规格 §4.1/4.3 方案 A）。#560 把 `translateFinal` 的 `message` 来源从 `payload.message` 换成 SDK `currentRun.message` 归约结果，但**该 message 仍是带 `content[]` 的同构形状**，`extractThinking` 照常可用——本规格与 #560 的改造点**函数不重叠**（#560 动 projection 接线/终态/归一化，本项动 `extractThinking` 新增 + 两处消费）。
- **文件交集**：`eventTranslate.ts` 与 `useChatConnection.ts` 均与 #560 共触，但按地图 #556 已标注的函数粒度合并即可（#560 动 `translateFinal` 的 message 来源/终态清理，本项动 `translateDelta`/`translateFinal` 内新增 `extractThinking` 调用 + `handleText`/`translateHistoryMessage` 消费）。

## 6. 触及文件与验收

### 触及文件（与 ticket 一致）

| 文件 | 改动 |
|------|------|
| `frontend/src/chat/eventTranslate.ts` | 新增 `extractThinking` 纯函数；`translateDelta`/`translateFinal` 在 `replace`/`final` 帧顺手提取并挂 `text` 帧；`ChatFrame.text` 增 `thinking?: string \| null` |
| `frontend/src/chat/useChatConnection.ts` | `translateHistoryMessage` 用 `extractThinking` 填 `Msg.thinking`（删「暂不剥离」注释）；`handleText` 合并结构化块（`??` 覆盖内联结果） |
| `frontend/src/chat/thinking.ts` | **不动**（内联标签路保留，与结构化块路并列） |

### 验收（ticket 的「含结构化 thinking 块的 history/流式消息，ThinkingCard 正确渲染」细化）

`eventTranslate` 层（纯函数，vitest）：

1. `extractThinking`：`content=[{type:'thinking',thinking:'  想A  '},{type:'text',text:'正文'},{type:'thinking',thinking:'想B'}]` → `'想A\n想B'`（trim + `\n` join）。
2. 全空/无 thinking 块/`content` 非数组/`message` 为 string 或 null → `null`。
3. `thinking` 字段非 string（如 `null`/number）的块 → 跳过。
4. `translateDelta`（`replace` 快照含 thinking 块）→ `text` 帧带 `thinking` 字段；`translateFinal`（final 消息含 thinking 块）→ tail/replace 帧带 `thinking`。
5. `delta` 增量帧 → 不挂 `thinking`（`undefined`）。

`useChatConnection` 层（vitest）：

6. **history 路**：`translateHistoryMessage` 收到 `content=[{type:'thinking',thinking:'...'},{type:'text',text:'...'}]` → `thinking` 为提取值、`text` 为正文、`thinkingOpen:false`；无 thinking 块 → `thinking:''`（现状）。
7. **history 回归**：`content=[{type:'thinking',...},{type:'toolCall',...}]`（无 text 块，E1b abort 场景）→ 工具行照常 + 思考卡有内容。
8. **流式路**：`handleText` 收到带 `thinking` 的 replace/final 帧 → `last.thinking` 被覆盖为结构化值；收到 `delta` 增量帧（无 `thinking`）→ `last.thinking` 走 `splitThinking` 内联结果（现状不变）。
9. **回归**：纯内联标签流式（无结构化块）行为与现状**逐字节一致**（`thinking` 来自 `splitThinking`）。

类型/端到端：

10. `vue-tsc` 零错；`ChatFrame` 新字段不破坏既有帧消费者。
11. 含结构化 thinking 块的 history/流式消息，`ThinkingCard` 正确渲染（`Msg.thinking` 非空即渲染，现有折叠卡逻辑无需改）。

## 7. 明确不做（范围锁定）

- **不动 `splitThinking`**：内联 `<thinking>` 标签剥离保留全部现状（残片/terminal），与结构化块路并列双路——对齐官方 `stripThinkingTags` + `extractThinking` 双函数分工。
- **不读 `text` 字段兜底**：官方只读 `thinking` 字段；无实测证据不预设变体（0 信任 + 对齐官方）。
- **不动 `Msg` 接口 / `newMsg` / `ThinkingCard`**：字段已就位，只改数据来源。
- **不动 `delta` 增量帧的 thinking**：增量字段无 `content[]`，内联标签由 `splitThinking` 覆盖。
- **history 归一化的其它维度**（附件元数据 duration/size/尺寸、sender 标签、reply 目标、canvas）——属 **#568**，本项只补 thinking。
- **不引入共享层**：`extractThinking` 纯解析自写（C 档），不依赖官方 `../../../../src/`。
