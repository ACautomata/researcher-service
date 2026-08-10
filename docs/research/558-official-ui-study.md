# 官方 control-ui 连接与渲染对照研究（#558 / 子 ticket of #551)

> **研究问题**：官方 control-ui(`github.com/openclaw/openclaw` 的 `ui/`,Lit + Vite）在**连接编排**与**渲染翻译**上，有哪些比我们 `frontend/src/chat/`(Vue3）更强/更对的点，值得移植/对齐？
>
> **对照对象**：
> - 官方：`ui/src/api/gateway.ts`(693 行）+ `gateway-browser-socket.ts` + `gateway-browser-auth.ts`;`ui/src/lib/chat/*`(message-extract/message-normalizer/thinking/tool-call-view/tool-cards/tool-call-grouping/session-diff/tool-display/outbox-store）+ `ui/src/pages/chat/chat-gateway.ts`(515 行）+ `history-merge.ts`
> - 我们：`frontend/src/chat/gatewayChat.ts`(653 行）+ `deviceAuth.ts`/`deviceTokenStore.ts`;`eventTranslate.ts`/`thinking.ts`/`timeline.ts`/`useChatConnection.ts`(1139 行）+ `components/chat/ToolLine.vue`(59 行）
>
> **关键前提（SDK 版本差）**：双方都用裸 `GatewayProtocolClient`。但官方 `ui/` 跟踪主仓 `main`，其 `gateway.ts` 用到的一组 helper(`isRetryableGatewayStartupUnavailableError`/`resolveGatewayStartupRetryAfterMs`/`GatewayRecoveryScopeTracker`/`storedDeviceTokenScopesAllowRead`)**不在**我们钉的 `@openclaw/gateway-client@2026.7.2-beta.6` 里；而**另一批官方能力（连接 helper + 完整 `SessionProjection` 套件）我们 SDK 已导出却一直没用**。证据：`frontend/node_modules/@openclaw/gateway-client/dist/browser.d.mts:20`（导出清单）、`session-subscriptions-DrhzqL6v.d.mts:237-246`。

---

## 总览判定表

| 维度 | 谁强 | 一句话结论 | 最值得移植 |
|------|------|-----------|-----------|
| 1. 连接编排 | **互有胜负** | 架构同款（裸协议机+薄编排）。官方更会把决策委托给 SDK helper + 用网关 advertised tick 做看门狗；我们的配对编排/双预算/后台看门狗更贴合面板场景 | tick 看门狗对齐 + 复用 SDK 的 token 自愈 helper |
| 2. 渲染翻译 | **官方全面更强（最大差距）** | 工具渲染体系、history 归一化、结构化 thinking 块、流式走 SDK SessionProjection——我们都更简/更缺 | 工具渲染体系（纯 TS 可直接抄）+ 结构化 thinking 块 + history 归一化 |
| 3. runId 归属/乐观发送 | **打平，官方多两块独占** | 双方都为同一 bug（我 #53 / 官方 #1909）手写复杂状态机；官方**并非**全交 SDK。官方独占：outbox 离线待发队列持久化 + steer/queue 7 态发送状态机 | outbox 离线待发持久化（断线 UX 硬伤） |
| 4. 可移植性 | — | SDK 包内可直接 import 的最值钱；纯 TS 0 依赖的可直接抄；依赖 `../../../../src/` 共享层的只能抄思路；官方核心逻辑几乎不碰 Lit，Vue3 可复用 | 见文末清单 |

---

## 维度 1：连接编排（官方 `gateway.ts` vs 我们 `gatewayChat.ts`)

双方架构**同款**：裸 `GatewayProtocolClient` + 自写 socket 工厂（官方 `createBrowserGatewaySocket`，我们 `createPanelTunnelSocket` 走隧道）+ 自写配对/token 生命周期接线。差异在「决策放哪」。

| 子项 | 官方做法（证据） | 我们做法（证据） | 谁强 | 是否值得移植 |
|------|----------------|----------------|------|-------------|
| **token 自愈决策** | 委托 SDK `shouldRetryGatewayWithDeviceToken({retryBudgetUsed, currentDeviceToken, explicitToken, storedToken, trustedEndpoint, errorDetails})`(`gateway.ts:579-590`)，配 `pendingDeviceTokenRetry`/`deviceTokenRetryBudgetUsed` 单次预算 | 手写 `recoverTokenMismatch`：MISMATCH → `clearStoredToken` → `client.start()` 重连回 bootstrap 重配对，复用配对预算防死循环（`gatewayChat.ts:462-472`、`368-376`) | **官方更简**（决策收进 SDK，UI 只管预算标志）；我们更显式但更啰嗦 | **值得**：SDK `2026.7.2-beta.6` 已导出 `shouldRetryGatewayWithDeviceToken`/`selectGatewayConnectAuth`，可直接 `import` 替换手写分支 |
| **凭证选择** | `selectGatewayConnectAuth` + `resolveGatewayConnectScopes`(`gateway.ts:630-639`、`456-465`)，stored scopes 经 `storedDeviceTokenScopesAllowRead` 过滤 | `hasStoredDeviceTokenFor` 判断后传/不传 `token`，交官方 lifecycle 选（`gatewayChat.ts:265-274`) | 打平（都落到官方 lifecycle) | 否（已用官方 lifecycle) |
| **看门狗（黑洞检测）** | `startTickWatch` 用**网关 hello 下发的 `policy.tickIntervalMs`** 作基准，`> tickIntervalMs*2` 无帧 → `forceReconnect`;`resolveSafeTimeoutDelayMs` 钳制恶意超大 interval(`gateway.ts:531-553`) | 固定 `SILENCE_TIMEOUT_MS=60s` / `WATCHDOG_INTERVAL_MS=15s`，假定「网关 tick≤30s」(`gatewayChat.ts:154-155`、`501-505`) | **官方更对**（跟着网关承诺走，不硬编码假设） | **值得**：读 hello 的 `policy.tickIntervalMs` 替换 60s 硬编码（`tickIntervalMs*2` 阈值 + `resolveSafeTimeoutDelayMs` 钳制，SDK 已导出） |
| **看门狗后台误杀** | 无特殊处理（依赖真实网关心跳） | `#493`:`document.hidden` 期间跳过判定 + `wasHidden` resume 重置基准（`gatewayChat.ts:487-499`) | **我们更强**（修过生产 bug) | 否（官方没有，已是我们的优势） |
| **startup-unavailable 区分** | 网关启动中：`isRetryableGatewayStartupUnavailableError` → close 4013 + `resolveGatewayStartupRetryAfterMs` 退避（`gateway.ts:606-613`、`206`) | 统一走 4402 网关不可达预算（`gatewayChat.ts:325-327`) | 官方更细（区分「网关正在启动」与「不可达」) | **不可直接移植**:`isRetryableGatewayStartupUnavailableError`/`resolveGatewayStartupRetryAfterMs` 不在我们 SDK 版本（`browser.d.mts:20` 无）。可抄思路，等 SDK 升级 |
| **重连退避** | `reconnect:{initialMs:800, multiplier:1.7, maxMs:15000}` 交协议机（`gateway.ts:367`) | `reconnect:{initialMs:1000, multiplier:2, maxMs:30000}` 交协议机（`gatewayChat.ts:289`) | 打平（参数差异，无对错） | 否 |
| **连续失败 give-up** | 未见独立 give-up 预算（交协议机 RetrySupervisor) | 手写 `consecutiveFailures`/`gatewayUnavailableCount` 双预算 + `STABLE_CONNECTION_MS` crash-loop 判定（`gatewayChat.ts:209-332`) | **我们更强**（协议机 `maxAttempts` 恒 Infinity，官方裸协议机层没补这个洞，我们补了） | 否 |
| **配对编排** | Control UI 场景：浏览器**直连**网关，配对在网关侧自洽（bootstrap → hello 下发 deviceToken → `storeDeviceAuthToken`),UI 不做带外 approve(`gateway.ts:508-529`) | 面板场景：approve 须由**控制面在容器内 `openclaw devices approve`** 编排（ADR 0006)，手写 `runAutoPairing`/`pairingState` 状态机 + 预算（`gatewayChat.ts:441-456`、`230-232`) | **我们更强且必要**（架构约束不同：我们走隧道、approve 在控制面；官方直连不需要） | 否（场景不同，不可照搬） |

**本维度小结**：官方并没有在连接编排上「碾压」我们——它的 Control UI 场景更简单（浏览器直连网关、配对自洽），很多我们手写的复杂（双预算、后台看门狗、带外 approve）是面板隧道架构的真实需求，官方没有也不需要。官方真正比我们**干净**的两点都值得对齐：**①把 token 自愈/凭证决策委托给 SDK helper（我们 SDK 已导出却手写了一份）;②看门狗跟着网关 advertised tickIntervalMs 走而非硬编码 60s**。startup-unavailable 区分是好思路，但 helper 不在我们 SDK 版本，暂不可移植。

---

## 维度 2：渲染翻译（官方 `lib/chat` vs 我们 `eventTranslate/thinking/timeline`)

**这是差距最大的维度。** 官方把渲染拆成一组职责单一的纯函数模块，且流式渲染委托给 SDK SessionProjection；我们集中在 `eventTranslate.ts` 手写 `_sent` 求差 + `useChatConnection` 内联 history 翻译，工具/思考/历史丰富度全面落后。

| 子项 | 官方做法（证据） | 我们做法（证据） | 谁强 | 是否值得移植 |
|------|----------------|----------------|------|-------------|
| **流式 delta 累积** | 委托 SDK `reduceSessionProjectionRunEvent` 做 run 归约 + `hasSessionProjectionAcceptedFinal` 重放去重（`chat-gateway.ts:258-303`);delta 文本求差 `resolveDeltaChatStreamText`（前缀校验，快照不一致回退整段）(`chat-gateway.ts:72-96`) | 手写 `ChatEventTranslator._sent: Map<runId,已发文本>`,delta 追加/final 尾补/非前缀 replace 纠正（`eventTranslate.ts:141-254`) | **官方更对**（归约/去重收进 SDK，跨浏览器+终端共用） | **值得（核心）**:SDK 已导出 `reduceSessionProjectionRunEvent`/`hasSessionProjectionAcceptedFinal`（我们一行没用，`grep` 无命中）。但注意官方**仍保留**手写 `chatStream` 文本累积，projection 主管「run 状态/终态/去重」，不是全替换 |
| **结构化 thinking 块** | `extractThinking` 从 `content[]` 取 `type==="thinking"` 块（`message-extract.ts:61-80`);**同时** `stripThinkingTags` 委托共享层剥内联 `<thinking>` 标签（`message-extract.ts:8,25`)——双路 | 仅内联 `<thinking>` XML 标签拆分 `splitThinking`(`thinking.ts:29-63`);**不识别结构化 thinking 块**(`grep "type==='thinking'" frontend/src/chat` 无命中） | **官方更全**（新版网关可能下发结构化块，我们漏渲染） | **值得**：补 `extractThinking` 式的结构化块提取（不依赖共享层，纯解析可自写）；内联标签剥离我们已有且更精（残片/terminal 处理） |
| **history 归一化** | `message-normalizer.ts`(663 行）:role 归一、**附件**(image/audio/video/document + sizeBytes/durationMs/尺寸）、**canvas 预览**、**语音便签**、**reply 目标**、**sender 身份**、工具 call/result 块、相邻 text 合并、元数据剥离（`message-normalizer.ts:443-663`) | `useChatConnection.translateHistoryMessage`(~30 行）：仅 text + media(image/audio/video)+ toolCall 块（`useChatConnection.ts:894-913`);`thinking` 恒 `''`（注释「暂不剥离」`:889,907`) | **官方全面更强** | **部分值得**：优先级排序——结构化 thinking 块 > sender 标签 > 附件元数据（duration/size/尺寸）> reply/canvas。注意官方 `message-normalizer` 依赖共享层（`../../../../src/`×4）不可直接 npm 移植，**只能抄思路自写** |
| **工具渲染** | 完整体系：`tool-call-view.ts` 分类（command/read/edit/write/search/fetch/generic)+ 多 harness(Claude/Codex）参数拼写兼容 + 路径 basename(`tool-call-view.ts:23-58,64-86`);`tool-call-diff.ts` edit/write 内联 diff(`:1-23`);`tool-cards.ts` 工具卡提取；`tool-display.ts` 工具图标/动词表（`tool-display.json`);`tool-call-grouping.ts` 连续调用聚合摘要「Ran 13 commands, read 6 files」(`:1-51`) | `ToolLine.vue`(59 行）：图标+名称+前两个参数+状态+输入输出原文（`ToolLine.vue:12-44`);`eventTranslate.translateTool` 只产 name/state/input/result(`eventTranslate.ts:305-326`) | **官方全面更强（渲染丰富度差距之最）** | **最值得**:`tool-call-view.ts`/`tool-call-diff.ts`/`tool-call-grouping.ts` **0 共享层依赖**(`grep` 命中 0)，是纯 TS 可直接抄；`tool-display.ts` 依赖共享 JSON 只能抄思路 |
| **附件提取** | `message-normalizer` 内联（kind/mimeType/label/sizeBytes/durationMs/width/height/artifactId/playback/isVoiceNote)(`:526-555`) | `extractMessageAttachments`：仅 type/mimeType/src/fileName(`eventTranslate.ts:87-110`) | 官方更全（元数据更丰富） | 值得（跟随 history 归一化一起） |
| **timeline 合并** | （在 `chat-gateway`/`stream-reconciliation` 内联，处理 steer chip/sub-agent 等） | `timeline.ts`(72 行）：消息+审批双列表纯函数合并 + 流式占位沉底 + SyntheticAnchor(`timeline.ts:54-72`) | **我们更聚焦简洁**（官方处理场景更多但更杂） | 否（我们的已够用且清晰） |

**本维度小结**：渲染是官方「碾压」我们的唯一维度。最值钱的不是某个单点，而是两个**架构性事实**:
1. **流式渲染的官方做法是「SDK SessionProjection 管 run 归约/去重 + UI 管文本累积」**，我们却把这两件事都手写进了 `eventTranslate._sent` 和 `useChatConnection`。SDK 套件我们版本就有，零新增依赖。
2. **工具渲染官方是一整套「分类→diff→图标→聚合摘要」的纯函数流水线，且其中三个文件 0 共享层依赖、可直接抄**；我们只有一行摘要。这是投入产出比最高的移植项。

---

## 维度 3:runId 归属 / 乐观发送 / 外来 run

**推翻预设的发现**：官方**并没有**把 run 归属/乐观发送全交给 SDK。`chat-gateway.ts`(515 行）自己维护 `state.chatRunId`/`chatQueue`/`lastLocalTerminalReconcile`，只把「终态分类、timeout 归类、重放去重」委托给 projection。它和我们一样，为「外来 run 劫持 activeRunId 吞回复」这个 bug 手写了复杂守卫——我们引用 `#53`，官方引用 [`#1909`](`chat-gateway.ts:316-317`)。

| 子项 | 官方做法（证据） | 我们做法（证据） | 谁强 | 是否值得移植 |
|------|----------------|----------------|------|-------------|
| **activeRun 归属** | `state.chatRunId` + `isEventForDifferentActiveRun` + `authoritativeTerminalMatches`(`chat-gateway.ts:65-70,214-236`) | `activeRunId`/`abandonedRunIds`/`foreignRunIds` + `claimRun`(`useChatConnection.ts:57-66,158-217`) | **打平**（同款状态机，同等复杂） | 否（各自贴合场景） |
| **外来/旧 run 首帧判别** | pendingSend 期间 ack runId 比对（`chat-gateway.ts:57-59,304-313`) | `myRunId`(ack 返回）比对 + `graceExpired` 宽限（`useChatConnection.ts:63-66,187-207`) | 打平（同机制） | 否 |
| **外来 run 的 final 处理** | 外来 run 的 final 若可见 → 刷新 history 显示新消息（sub-agent announce,#1909)(`chat-gateway.ts:318-328`) | 外来 run 终态清理记录即弃（`useChatConnection.ts:255-258`) | **官方更对**(sub-agent/并行 run 的 final 不丢） | **值得**：外来可见 final 刷新 history，而非简单丢弃 |
| **乐观发送** | `chatQueue` + `ChatQueueItem.sendState` **7 态**(`waiting-model/waiting-idle/executing-command/steering/sending/waiting-reconnect/unconfirmed/failed`)+ steer/queue + replyTo + attachments(`chat-types.ts:35-66`) | `pendingSend` 单标志 + 首帧乐观 echo(`useChatConnection.ts:62`) | **官方更强**（但场景更复杂：多 agent steer) | 部分（7 态对面板过重；`waiting-reconnect`/`unconfirmed` 两态值得借鉴） |
| **离线/重连待发持久化** | `outbox-store.ts`(681 行）:sessionStorage 按 (sessionKey,agentId) scope 持久化待发队列，重连恢复（`outbox-store.ts:1-66`) | **完全没有**——断线时用户消息只在内存，刷新/重连即丢 | **官方独占强项** | **值得（高价值）**：断线/重连期间用户已输入消息持久化恢复，是面板断网 UX 硬伤；但依赖其 queue 状态机，移植成本高 |
| **重放去重** | `hasSessionProjectionAcceptedFinal`(SDK)(`chat-gateway.ts:299`) | `_sent` 累积 + final 前缀比对（`eventTranslate.ts:236-246`) | 官方更稳（SDK 有界 canonical 终态历史） | 值得（随 SessionProjection 一起） |

**本维度小结**:run 归属双方打平（同一个 bug、同样的手写状态机）。官方真正多出来的是**两块我们没有的能力**:**①outbox-store 离线待发队列持久化（断网用户消息不丢）;②steer/queue 的多态发送状态机**。前者是实打实的面板 UX 短板，值得移植；后者对面板的单 agent 场景过重，按需取 `waiting-reconnect`/`unconfirmed` 即可。

---

## 维度 4：可移植性（官方 Lit → 我们 Vue3)

官方这些核心逻辑**几乎不碰 Lit**——都是纯函数/class（依赖 `@openclaw/normalization-core` 等框架无关包）,Vue3 可直接复用。真正的可移植性分三档：

| 档位 | 内容 | 证据 | 移植方式 |
|------|------|------|---------|
| **A. SDK 包内，`import` 即用**（零新增依赖，我们版本已有） | 连接 helper:`shouldRetryGatewayWithDeviceToken`/`selectGatewayConnectAuth`/`resolveGatewayConnectScopes`/`resolveSafeTimeoutDelayMs`;SessionProjection 全套：`createSessionProjection`/`reduceSessionProjection`/`reduceSessionProjectionRunEvent`/`projectLiveSessionMessage`/`reconcileSessionProjectionSnapshot`/`hasSessionProjectionAcceptedFinal`/`readSessionMessageIdentity`/`normalizeSessionProjectionRunId` | `browser.d.mts:20`、`session-subscriptions-DrhzqL6v.d.mts:237-246` | 直接 `import { ... } from '@openclaw/gateway-client/browser'` |
| **B. 纯 TS 0 共享层依赖，可直接抄** | `tool-call-view.ts`（工具分类/diff 入口）、`tool-call-diff.ts`（行 diff)、`tool-call-grouping.ts`（聚合摘要） | `grep` 共享层依赖命中 0(`tool-call-view.ts:1-21` 仅引 `@openclaw/normalization-core`) | 抄文件，改 import 路径 + 接 Vue 组件 |
| **C. 依赖共享层（`../../../../src/`)，只能抄思路** | `message-normalizer.ts`(×4)、`message-extract.ts`(×4)、`tool-display.ts`(×4，`tool-display.json`)、`strip-thinking-tags.ts`（委托 `stripAssistantInternalScaffolding`)、`thinking.ts`（思考级别选择器，与文本剥离无关） | `grep` 命中 4/4/4/1；共享层在 openclaw 主仓 `src/`，不在 SDK npm 包 | 抄解析思路自写（如结构化 thinking 块提取、附件元数据），不引共享层 |
| **D. 不在我们 SDK 版本，暂不可移植** | `isRetryableGatewayStartupUnavailableError`/`resolveGatewayStartupRetryAfterMs`/`GatewayRecoveryScopeTracker`/`storedDeviceTokenScopesAllowRead` | `browser.d.mts:20` 导出清单无此四项 | 等 SDK 升级，或抄思路自写 |

**框架耦合结论**：官方是 Lit 但我们看中的逻辑（SessionProjection 归约、工具 view-model、diff、归一化）全在框架无关的 `.ts` 文件，没有一个 `LitElement`/`@customElement` 依赖。**Vue3 移植的摩擦只在「接组件渲染」一层，逻辑层可直接平移。**

---

## 建议从官方 ui 抄/对齐的清单（按价值排序）

| 优先级 | 项 | 价值 | 成本 | 档位 | 说明 |
|--------|----|------|------|------|------|
| **P0** | **工具渲染体系**:`tool-call-view.ts` + `tool-call-diff.ts` + `tool-call-grouping.ts` | ★★★★★ | 低 | B | 渲染丰富度差距最大、且 0 共享层依赖可直接抄。把 `ToolLine.vue` 从「一行摘要」升级为「分类+路径+内联 diff+聚合摘要」。投入产出比最高 |
| **P0** | **SDK SessionProjection 接管 run 归约/终态/重放去重** | ★★★★☆ | 中 | A | SDK 已导出、官方同款用法（`chat-gateway.ts:258-303`)。替换 `eventTranslate._sent` 求差 + `useChatConnection` 部分终态守卫。注意是「减负」不是「全替换」——官方也保留手写文本累积/activeRun |
| **P1** | **outbox-store 离线待发队列持久化** | ★★★★☆ | 高 | 思路 | 官方独占、我们完全没有。断网/重连时用户已输入消息不丢，面板断网 UX 硬伤。依赖 queue 状态机，建议先做最小版（sessionStorage 存待发文本，重连重发） |
| **P1** | **结构化 thinking 块提取**（`extractThinking` 式） | ★★★☆☆ | 低 | C | 新版网关可能下发 `type==="thinking"` 结构化块，我们目前漏渲染。纯解析可自写，history + 流式都补 |
| **P2** | **tick 看门狗对齐网关 advertised `tickIntervalMs`** | ★★★☆☆ | 低 | A | 读 hello 的 `policy.tickIntervalMs`,`> tickIntervalMs*2` 阈值 + `resolveSafeTimeoutDelayMs` 钳制，替换 60s 硬编码。跟着网关承诺走更稳 |
| **P2** | **token 自愈/凭证决策复用 SDK helper** | ★★★☆☆ | 低 | A | `shouldRetryGatewayWithDeviceToken`/`selectGatewayConnectAuth` 替换 `gatewayChat.ts` 手写分支，收敛与官方一致 |
| **P2** | **history 归一化增强**（附件元数据/sender 标签/相邻 text 合并） | ★★★☆☆ | 中 | C | 抄 `message-normalizer` 思路自写。优先级：附件 duration/size/尺寸 > sender 标签 > reply |
| **P3** | **外来可见 final 刷新 history**(sub-agent/并行 run 的 final 不丢，#1909) | ★★☆☆☆ | 低 | 思路 | 面板多 agent/子代理场景出现时再做 |
| **P3** | **startup-unavailable 区分**(4013+retryAfterMs) | ★★☆☆☆ | — | D | helper 不在我们 SDK 版本，等升级 |
| **不做** | steer/queue 7 态发送状态机、思考级别选择器、session-diff 面板、canvas 预览 | — | — | — | 面板单 agent/精简场景用不上，官方为多 agent/全功能 control-ui 设计 |

---

## 附：关键证据索引

**官方（openclaw/openclaw `main`,`ui/`）**
- `ui/src/api/gateway.ts:531-553`(tick 看门狗，advertised tickIntervalMs)、`:579-590`(`shouldRetryGatewayWithDeviceToken`)、`:606-613`(startup 4013+retryAfterMs)、`:630-639`(`selectGatewayConnectAuth`)
- `ui/src/pages/chat/chat-gateway.ts:258-303`(SessionProjection 归约 + 重放去重）、`:316-317`(#1909 外来 run final)、`:318-328`（外来 final 刷新 history)
- `ui/src/pages/chat/history-merge.ts:59-206`(`getChatSessionProjection`/`reduceChatSessionProjection`,scope 绑定 + 快照 reconcile)
- `ui/src/lib/chat/message-normalizer.ts:443-663`(history 归一化全量）、`message-extract.ts:61-80`（结构化 thinking 块）
- `ui/src/lib/chat/tool-call-view.ts:23-58`（工具分类）、`tool-call-grouping.ts:1-51`（聚合摘要）、`outbox-store.ts:1-66`（离线待发持久化）、`chat-types.ts:35-66`(sendState 7 态）

**我们（`frontend/`)**
- `frontend/src/chat/gatewayChat.ts:154-155`(60s 硬编码看门狗）、`:487-499`(#493 后台跳过）、`:462-472`(recoverTokenMismatch 手写）、`:325-327`(4402 预算）
- `frontend/src/chat/eventTranslate.ts:141-254`(`_sent` 手写求差/final 尾补/replace 纠正）
- `frontend/src/chat/useChatConnection.ts:57-217`(claimRun/activeRunId/foreignRunIds 状态机）、`:894-913`(history 翻译，thinking 恒 `''`)
- `frontend/src/components/chat/ToolLine.vue:12-44`（工具一行摘要）
- `frontend/node_modules/@openclaw/gateway-client/dist/browser.d.mts:20`(SDK 导出清单）、`session-subscriptions-DrhzqL6v.d.mts:237-246`(SessionProjection 签名）
