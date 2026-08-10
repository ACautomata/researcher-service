# #569 规格：外来可见 final 局部插入 history（P3，对齐官方 #1909）

> 判定依据：`#558`（维度 3，官方 #1909「外来可见 final 不丢」）+ 官方一手源码 `ui/src/pages/chat/chat-gateway.ts:316-328` + `ui/src/pages/chat/chat-history.ts`。
> 权威语义来源：`openclaw/openclaw` 官方 control-ui 运行时实证（`chat-gateway.ts` 外来 final 分支、`publishVisibleFinal`、`shouldHideAssistantChatMessage`）。
> 目标：外来可见 run 的 `final` 到达时**局部插入**一条助手消息进当前 transcript（而非简单丢弃），对齐官方 #1909。产出交 `#556` 收口。
> 档位：思路档（抄思路自写）——官方 `publishVisibleFinal` 依赖其 projection `messagePersisted`/identity 体系，面板 projection 形态不同（`#560`），不可照抄，只抄「局部插入 + 可见判定 + 去重」的机制语义。

---

## 0. 最终边界（先定调，全文围绕它）

**官方 #1909 是「即时局部插入」，不是「整段 history 重拉」。** 先把 `#569` 体里「刷新 history」的歧义表述纠正为精确机制：

- 官方外来 final 分支（`chat-gateway.ts:318-328`）：`final` 可见 → `publishVisibleFinal(finalMessage, [...state.chatMessages, finalMessage], payload.runId)` —— 把归一化 final **追加到当前 messages 数组尾部**，并经 projection `messagePersisted` 持久化。**全程不触发 history 重拉。**
- 因此本规格的「刷新 history」= **局部插入一条助手消息**（`chat.messages.push`），**不调用 `loadHistory`**。
- 这与面板 `#560` 锁定的「本地消息不入 projection、projection 不跨连接」形态相容：面板不照抄官方 `messagePersisted` 持久化，只抄「局部插入」的 UI 语义；去重改用贴合面板的机制（§3）。

**两处与官方的差异（都有架构理由，已锁不随官方）：**

1. **去重不照抄 `messagePersisted` identity**：官方靠 projection `messagePersisted`（identity = runId+messageId+messageSeq）去重；面板本地消息无 `__openclaw` 元数据、projection 不跨连接（`#560 §0/§3`）。面板去重改走 §3 的双网。
2. **可见判定复用面板既有 foreign 语义，不强引官方 `NO_REPLY`/心跳判定**：官方 `shouldHideAssistantChatMessage` = 静默回复（`NO_REPLY`）/心跳确认才隐藏；面板当前把自主/心跳 run 靠「非本 run」判定进 `foreignRunIds`（F7），无显式 heartbeat/silent 处理。本规格的「可见」判定在面板 foreign 语境下重新收敛（§2.2），不引入官方 `chat-history.ts` 的 silent/heartbeat 判定函数。

---

## 1. 架构：在保留的 foreignRunIds 终态分支上「加插入行为」

```
裸 GatewayProtocolClient onEvent (gatewayChat.ts:392)
        │
        ▼
  ChatEventTranslator.translate → ChatFrame（七帧契约 + 本规格新增「外来 final 携带 message」）
        │
        ▼
  useChatConnection.handleDone（claimRun 归属守卫不变）
        │ foreignRunIds.has(runId) 分支（:255-258，#560 §2.7 保留）
        ▼
  【新增】final 可见？ ──否──→ 维持现状：foreignRunIds.delete + return（丢弃）
        │是
        ▼
  【新增】去重（§3 双网）──已收──→ 丢弃（重放 final）
        │未收
        ▼
  【新增】translateHistoryMessage(msg) → Msg → chat.messages.push（局部插入，不重拉 history）
        │
        ▼
  foreignRunIds.delete(runId)（终态清理，不变）
```

- **放置**：插入逻辑放 `useChatConnection.handleDone` 的外来分支（`:255-258`），**不新增模块**。这是 `#560 §2.7` 明确「全套保留、一行不动」的归属状态机——本规格**只在该分支内加行为**，不改 claimRun/守卫语义。
- **在途 activeRunId 不动**：外来 final 插入是**纯追加**一条消息，不触碰 `activeRunId`/`pendingSend`/`pendingAbandonCount`/`resumeRun`，不打断在途流式 turn。这契合官方语义（外来 final 与当前 active run 并存）。
- **不触发 `loadHistory`**：避免打断在途占位/滚动位置、避免 historyGen 竞争。

## 2. 替代清单 vs 保留清单

### 2.1 触发时机（问 1 答：外来可见 final 何时出现）

面板**当前为单 agent 精简场景**，外来可见 final 的真实触发点：

| 场景 | 是否产生外来可见 final | 说明 |
|---|---|---|
| 单容器单 main agent 对话 | 否（现状主体） | 用户 run 即 activeRunId，无外来 run |
| 断线重连 resume 重放 | 重放 final（去重网拦截） | 同一 run 的 final 二次到达，不重复插入 |
| **子代理/并行 run（sub-agent announce，官方 #1909 本意）** | **是** | 多 agent 场景出现时真正需要——P3 定位 |
| 多容器并联/共享会话 | 是（前瞻） | 另一连接在同一 sessionKey 上跑的 run |

**收敛**：本规格落地「机制就位」——局部插入 + 可见判定 + 去重完整实现，多 agent/子代理 announce 场景出现时自动生效；单 agent 现状经 §4 验收确保**不回归**（外来 final 仍不污染在途 turn）。

### 2.2 「可见」判定（问 2 答：外来 run final 归属当前会话的判别）

官方语义：`final` 可见 = 归一化 message 存在 **且非隐藏**（非静默回复/心跳确认）。面板语境下分两层：

- **归属当前会话**：外来 run 的 `runId` 已在 `foreignRunIds` 中 → 它本就是「本连接、本 sessionKey 上观察到的非本 run」，**天然归属当前会话**。无需额外 sessionKey 比对（连接级 sessionKey 已由 `selectSession`/`containerGen` 守卫保证）。
- **可见 = 有可归一化的助手消息体**：外来 final 帧需携带 message 本体（见 §2.3 数据流），经 `translateHistoryMessage` 提取后 `text !== '' || media.length > 0 || tools.length > 0` 才判可见；空 final（无内容）维持丢弃。
- **隐藏判定的取舍**：官方 `NO_REPLY`/心跳判定函数（`chat-history.ts`）**不引入**——面板 F7 已把自主/心跳 run 归入 foreign，其 final 若恰好是 `NO_REPLY` 之类，经 `translateHistoryMessage` 提取 `text` 后落入「空内容维持丢弃」分支即可，无需专门的 silent 判定。**这是思路档的取舍：只保「有实质内容才插入」，不抄官方的隐藏文案清单。**

### 2.3 数据流接缝（关键：done 帧当前不携带 message）

**现状缺口**：当前 `done` 帧契约是 `{ type:'done', runId }`（`eventTranslate.ts:9`），**不携带 message 本体**；外来 final 的 message 在 `translateFinal` 里被「tail 补发 + done」消费（`:231-254`），从未透出给 `handleDone`。

**接缝设计**（与 `#560 §2.2` 终态消息归一化天然咬合）：

- `#560` 已规定终态 message 来源从 `payload.message` 换成 **`currentRun.message`**（SDK `updateRun` 归一的终态权威 message）。外来 run 的 final 同样经 `reduceSessionProjectionRunEvent` 归约 → `currentRun.message` 即外来 run 的归一化 final。
- **新增 ChatFrame**：在终态路径透出一个「携带 message 的外来 final」帧。最小方案是扩展 done 帧为 `{ type:'done'; runId; message?: unknown }`（`message` 仅外来 run 的 final 填充，本 run final 沿用现有 tail 补发逻辑、不填）。`handleDone` 仅在 `foreignRunIds.has(runId)` 分支消费 `frame.message`。
- **复用 `translateHistoryMessage`**：插入的 message 走 `translateHistoryMessage(msg)` 转 `Msg`（`:894`，已处理 content 多态/text 回退/attachments/toolCall 提取），与历史消息翻译同一路径，**不新写 message 解析**。
  - 注意 `translateHistoryMessage` 入参是 `HistoryMessageDTO`；外来 final 的 `currentRun.message` 形状与其同构（网关 display-normalized 消息），`#560` 已确认 payload 直喂同构。若类型不匹配，加一个薄适配（foreign final message → HistoryMessageDTO），**不重写解析逻辑**。

### 2.4 保留：归属状态机与在途 turn（`#560 §2.7`，一行不动）

`claimRun`/`activeRunId`/`foreignRunIds`/`abandonedRunIds`/`pendingSend`/`myRunId`/grace 宽限**全套保留**。本规格只在 `handleDone` 外来分支**加插入**，不改任何守卫判定。`handleError` 外来分支（`:290-293`）**不动**（error 终态无 final message 可插入，维持清理丢弃）。

## 3. 去重（问 3 答：与 #560 终态归一化的配合）

面板 projection 形态下，去重靠**双网**（贴合 `#560`，不照抄官方 identity）：

1. **重放去重网（`#560 §2.4` 已建）**：外来 final 插入前查 `hasSessionProjectionAcceptedFinal(previousRun, currentRun.message)`——同一 run 的 final 重放（断线重发/resume 重放）第二次被拦截，只插入一次。**这是现成的网，本规格直接复用，零新增。**
2. **同连接内文本去重（`#560 §2.5/§2.6`）**：`_sent` 的 final-vs-已发文本求差对重复内容安全。但外来 run 的 delta **从不进 `_sent`**（其续帧被 claimRun 丢弃，只 final 到达）——故外来 final **无 `_sent` 条目可比对**。此处**不加额外去重**：外来 run 在本连接内只插入一次（终态分支插入后即 `foreignRunIds.delete`，同一 runId 不会二次进入），重放由网 1 兜底。

**结论**：去重 = 复用 `hasSessionProjectionAcceptedFinal`（网 1）+ foreignRunIds 终态清理的天然一次性（网 2 兜底）。**不引入官方 `messagePersisted` identity，不给 `_sent` 加外来 run 条目。**

## 4. 验收标准

1. **外来可见 final 不丢**：构造外来 run（runId ∈ foreignRunIds）的可见 final（message 有实质内容）→ 当前 transcript 尾部新增一条助手消息，`activeRunId`/在途 turn 不变。**单 agent 现状不回归**：外来空 final / 不可见 final 维持丢弃。
2. **不重拉 history**：外来 final 插入**不调用 `loadHistory`**（断言 historyGen 不自增、无 history RPC），滚动位置/在途占位不受影响。
3. **重放去重实证**：同一外来 run 的 final 二次到达（模拟重放），第二次被 `hasSessionProjectionAcceptedFinal` 拦截，只插入一次。
4. **在途 turn 隔离**：外来可见 final 插入时，若有在途 `activeRunId`，其流式 turn 继续正常收尾（外来消息是独立一条，不抢占/不污染 active 气泡）。
5. **行为等价回归**：`cd frontend && npm run test` 全绿；`npm run build`（vue-tsc）零错。现有 `useChatConnection` 归属/恢复测试（claimRun/foreignRunIds/resumeRun/loadHistory inFlight）**不动**，作为天然回归网。

## 5. 测试改写清单

- **`useChatConnection` 测试（新增用例）**：覆盖 §4.1–§4.4——外来可见 final 插入 / 空 final 丢弃 / 重放只插一次 / 在途 turn 隔离。
- **`eventTranslate.test.ts`**：新增「外来 run final → done 帧携带 message」用例（`#560` 终态 message 走 `currentRun.message` 后，外来 run 的归约 message 透出到 done 帧）。
- **`gatewayChat.test.ts`**：若 projection 归约对外来 run 的终态归一化有接线差异，补一条接线用例（外来 run final 经 `reduceSessionProjectionRunEvent` 归约产出 `currentRun.message`）。
- **归属/恢复测试**：**不动**（claimRun/foreignRunIds/resumeRun/loadHistory inFlight），作回归网。

## 6. 交 #556 收口的要点

- **机制就位、P3 前瞻**：本规格落地完整「局部插入 + 可见判定 + 去重」机制；当前单 agent 场景无真实外来可见 final 触发点，多 agent/子代理 announce（官方 #1909 本意）出现时自动生效。**实施紧迫性低，建议排在 P0/P1/P2 之后。**
- **与 `#560` 强耦合（文件级）**：本规格的 done 帧扩展（携带 `currentRun.message`）**依赖 `#560` 的终态消息归一化接线**（`currentRun.message` 是外来 run final 的唯一权威来源）。**实施顺序：必须先于或随 `#560` 落地**，否则外来 final 无归一化 message 可透出。
- **文件冲突**：触 `useChatConnection.ts`（handleDone 外来分支 + 插入）+ `eventTranslate.ts`（done 帧扩展）。`useChatConnection.ts` 与 `#564/#565/#568` 共触，`eventTranslate.ts` 与 `#565/#568` 共触——`#556` 统一排序。
- **不引入官方 silent/heartbeat 判定**（`chat-history.ts`）：面板 F7 foreign 语义 + 「空内容维持丢弃」已覆盖，思路档取舍，不抄官方隐藏文案清单。
