# #556 总规格：chat/ 对齐官方增强 —— 实施顺序 + 验收标准 + SDK 纪律 + 交接清单

> **归属**：wayfinder 地图 [#551](https://github.com/ACautomata/researcher-service/issues/551)「chat/ 对齐官方增强」的**最终收口票**，本图交付物。
> **前置**：八份增强项实现规格已全部产出并结票（#555/#560/#564/#565/#566/#567/#568/#569），本文把它们**收口为一份可交接总规格**，不重述各项细节（细节一律指向各票证据文档），只定全局的**实施顺序、验收标准、SDK 升级纪律、交接清单**。
> **决策来源**：#556 grilling 收口（2026-08-10）+ 各票证据文档的依赖标注。本规格只规划与决策，不承载写代码。

---

## 0. 决策总览（六条，已锁定）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | **实施顺序** | **3 波**：波1 = `#560` 先行独占 → 波2 = 六项（#555/#564/#565/#566/#567/#568）并行 → 波3 = `#569` 殿后 |
| 2 | **实施粒度** | **每项一 PR**：八个增强项各自独立 PR 落地、独立 review/验收/可回滚 |
| 3 | **验收标准** | **以现有 3139 行 vitest 单测为基线**（改写+新增）；渲染项（#555/#568）**额外附人工核对清单**，不引入截图测试基建 |
| 4 | **总规格形态** | **一份总交接规格**（本文），汇总顺序/验收/纪律/清单，逐项详情索引到各票证据文档 |
| 5 | **落点** | `docs/research/556-align-implementation-spec.md`（与八份证据文档同列） |
| 6 | **SDK 纪律** | **锁 `@openclaw/gateway-client@2026.7.2-beta.6`**；D 档项等升级；**触发式重估**，不立定期回看任务 |

> **范围**：只 `frontend/src/chat/`（含 `components/chat/` 渲染呈现）。`api/` 控制面 REST、`server/` 隧道与端点**不在射程**（map Out of scope）。架构接缝（裸 `GatewayProtocolClient` + `createPanelTunnelSocket`）经 #552/#558 锁定，**不变**。

---

## 1. 实施顺序（3 波）

### 1.1 顺序结论

```
波1  #560 SDK SessionProjection 减负        (useChatConnection + eventTranslate 语义地基)
      │
      ▼ 先行、独占 —— 它是波2 多项的语义前提
波2  ├ #555 工具渲染体系   (新增抄入 4 文件 + ChatMessageItem/ToolLine)
      ├ #564 outbox 离线待发 (新增 outboxStore + 浅触 useChatConnection/gatewayChat)
      ├ #565 结构化 thinking (eventTranslate + useChatConnection)
      ├ #566 tick 看门狗      (gatewayChat 阈值)
      ├ #567 token 自愈       (gatewayChat onConnectFailure)
      └ #568 history 附件元数据(eventTranslate + ChatMessageItem)
      ▼ 全并行 —— 跨文件、无函数级冲突，各自独立 PR
波3  #569 外来可见 final 局部插入           (依赖 #560 的 currentRun.message)
```

### 1.2 为什么是 3 波（依赖证据）

- **波1 = #560 先行且独占**：`#560` 改 `eventTranslate`/`useChatConnection` 的 run 终态归一化、终态 message 归一化（`payload.message` → `currentRun.message`）、重放去重（`hasSessionProjectionAcceptedFinal`）。这是 **#565**（thinking 经翻译层挂帧）、**#569**（done 帧扩展依赖 `currentRun.message`，#569 §6 明示「必须先于或随 #560 落地」）的语义前提。`#560 §6` 亦自标「建议本项先行」。故 #560 最先、单独一个 PR，不与任何项并行。
- **波2 六项并行**：逐项核对（下表 §1.3），六项**跨文件、函数粒度不重叠**，可并行推进、各自独立 PR，互不阻塞。
- **波3 = #569 殿后**：`#569` 的 done 帧扩展（携带外来 run 的归一化 final）**唯一权威来源是 `#560` 的 `currentRun.message`**；且 P3 前瞻（当前单 agent 无真实触发点，官方 #1909 本意是多 agent/sub-agent announce），实施紧迫性低。

### 1.3 文件冲突矩阵与合并策略（波2 内部）

**共触文件**（行数为 2026-08-10 实测）：

| 文件 | 波2 触及项 | 函数级冲突 |
|------|-----------|-----------|
| `eventTranslate.ts` (327) | #555（数据适配浅触）/ #565（`extractThinking`+`translateDelta/Final` 挂帧）/ #568（`MediaBlock`/`extractMessageAttachments`/`attachmentToMediaBlock`） | **无** —— #555 只产 `{name,args,details}` 三元组；#565 动 text/thinking 块；#568 动附件块。**块类型正交** |
| `useChatConnection.ts` (1139) | #564（`send()` 加/删队 + 恢复路径插 `resendOutbox`）/ #565（`translateHistoryMessage` 填 thinking + `handleText` 合并） | **无** —— #564 动 `send()`/`syncSessions` 后；#565 动 `translateHistoryMessage`/`handleText`。**函数不重叠** |
| `gatewayChat.ts` (653) | #566（`onConnectHello` 读 tick + 看门狗阈值）/ #567（新增 `onConnectFailure` + `resolveClose`/`onClose`/`buildConnectPlan`）/ #564（`send()` 幂等 key 外注 `:590-596`） | **无** —— #566 动 hello/看门狗；#567 动 connectFailure/close/plan；#564 动 send 幂等。**函数不重叠** |
| `ChatMessageItem.vue` | #555（聚合摘要落位 tools 循环层 `:53`）/ #568（`document` 渲染分支 + `mediaSrc` url 分支） | **无** —— #555 升级 ToolLine 注入；#568 新增附件分支。**区块不重叠** |
| `ToolLine.vue` | #555（升级为分类+路径+内联 diff） | 独占 |
| **新增文件** | #555 抄入 4 文件（`tool-call-view/diff/patch/grouping.ts`）/ #564 新增 `outboxStore.ts` | 各自独立 |

**合并策略**：六项无函数级冲突，故**波2 内不需要再排先后**。唯一要注意的是 `eventTranslate.ts`（#555/#565/#568 三触）与 `useChatConnection.ts`（#564/#565 双触）——若多 PR 并行，合并时**按函数粒度对齐**即可（各项改动点在不同函数/不同块类型，机械合并）。这与「每项一 PR」相容：各 PR 独立 review，冲突在 rebase 时按函数解决。

---

## 2. 逐项改造点 / 删除清单 / 验收索引

> 每项的**完整改造点、删除清单、验收用例、证据行号**在各票文档；此处只给一句话定位 + 触及文件 + 关键验收锚点 + 链接。**实施以各票文档为准。**

| 项 | 波 | 一句话定位 | 触及文件 | 关键验收锚点 | 证据文档 |
|----|----|-----------|---------|-------------|---------|
| **#560** P0 | 1 | SDK SessionProjection 接管 run 终态归一化/终态 message 归一化/重放去重（**减负非全替换**，`_sent`/归属守卫/渲染翻译全保留） | `gatewayChat.ts`（projection 接线）+ `eventTranslate.ts`（终态/`translateFinal`）+ `useChatConnection.ts`（终态消费） | 行为等价全绿；手写净减 ≥30 行；归一化/重放/timeout-yielded 三实证 | [560](./560-session-projection-offload.md) |
| **#555** P0 | 2 | 抄入官方 4 文件（view/diff/patch/grouping）把 `ToolLine` 升级为「分类+路径+内联 diff+聚合摘要」 | 新增 4 文件 + `ToolLine.vue` + `ChatMessageItem.vue`（tools 循环层 `:53`）+ 浅触 `eventTranslate.ts` | record-coerce 内联 / i18n shim / 删 WeakMap 缓存；数据适配 `args←ToolRow.input`/`details←ToolRow.result` | [555](./555-official-tool-call-files.md) |
| **#564** P1 | 2 | outbox 离线待发最小版（**窄窗落盘**：在线但 ack 未回才存，不做离线排队；先 loadHistory 再重发，复用 `idempotencyKey` 去重） | 新增 `outboxStore.ts` + `useChatConnection.ts`（send/resendOutbox）+ `gatewayChat.ts`（幂等 key 外注 `:590`）+ `localStorage.ts`（补 `getSafeSessionStorage`） | 断网刷新不丢 / 不双发（幂等+loadHistory 内容去重）/ scope 隔离 | [564](./564-outbox-min-spec.md) |
| **#565** P1 | 2 | 结构化 thinking 块提取（新增 `extractThinking` 纯函数；history 全量 + 流式最小覆盖；`splitThinking` 内联路保留，双路覆盖式合并） | `eventTranslate.ts`（新增 `extractThinking` + 挂帧）+ `useChatConnection.ts`（`translateHistoryMessage`/`handleText`） | trim/`\n` join/全空返 null；history 填 thinking；旧网关行为逐字节不变 | [565](./565-structured-thinking-extract.md) |
| **#566** P2 | 2 | tick 看门狗对齐 hello `policy.tickIntervalMs`（阈值 = clamp 后 `tick*2`，替换 60s 硬编码；#493 后台看门狗全保留） | `gatewayChat.ts` 唯一（import + 2 常量 + `onConnectHello` + 阈值；删 `SILENCE_TIMEOUT_MS`） | 基准随 advertised 变化 / 超小钳地板 1s / 缺失回退 30s / #493 不回归 | [566](./566-tick-watchdog-advertised-tick.md) |
| **#567** P2 | 2 | token 自愈**分码处理**（`AUTH_TOKEN_MISMATCH` 对齐官方单次重试；`AUTH_DEVICE_TOKEN_MISMATCH` 不能用 `shouldRetry`，保留 `recoverTokenMismatch` 收窄；预算用尽 R2 兜底收敛同一自愈闭环） | `gatewayChat.ts` 唯一（新增 `onConnectFailure` + 2 预算标志 + `resolveClose`/`onClose`/`buildConnectPlan`） | V1–V6 分码用例；防死循环 `pairingAttempts` 不回归 | [567](./567-token-self-heal-sdk-helper.md) |
| **#568** P2 | 2 | history 附件元数据增强（**四块只附件元数据是真增强**：把发送侧已在 wire 的 `sizeBytes/durationMs/width/height` 接进 `MediaBlock`；history 路 0 信任条件透传兜底；补 `document` 型 + url 形态渲染） | `eventTranslate.ts`（`MediaBlock`/两个提取函数）+ `ChatMessageItem.vue`（`document` 分支 + `mediaSrc` url 分支） | 条件透传（有才带、缺则现状）/ 发送 echo 上屏 / 不回归 | [568](./568-history-normalization.md) |
| **#569** P3 | 3 | 外来可见 final **局部插入**（非重拉 history）：外来 run final 可见且未重放 → `translateHistoryMessage` 转 Msg 尾部 push；去重复用 #560 重放网 | `useChatConnection.ts`（`handleDone` 外来分支）+ `eventTranslate.ts`（done 帧扩展携带 `message`） | 外来 final 不丢 / 不重拉 history / 重放只插一次 / 在途 turn 隔离 | [569](./569-foreign-final-insert.md) |

---

## 3. 验收标准（全局）

### 3.1 基线（实测，2026-08-10）

- **测试基线**：chat/ 行为测试共 **3139 行**、15 个 `*.test.ts`（vitest 单元/逻辑测试；`gatewayChat.test.ts` 964 / `eventTranslate.test.ts` 491 为大头；`useChatConnection` 有归属/恢复测试）。生产源 6247 行。
- **无 e2e / 截图测试基线**。
- **门槛命令**（每项 PR 必过）：`cd frontend && npm run test`（vitest 全绿）+ `npm run build`（vue-tsc 零错）。

### 3.2 每项「做完」的统一判据

1. **行为等价回归**：现有相关测试保持绿（各票文档列出「不动的回归网」用例，如 #560 的 `_sent` 前缀/漂移用例、#567 的 `_DEVICE_` 用例、#569 的归属/恢复测试）。
2. **新增/改写用例**：各票文档「验收标准 / 测试改写清单」节列出的实证用例（如 #560 §4 五条、#567 §五 V1–V6、#564 §七 五条）。
3. **门槛命令全绿**（§3.1）。

### 3.3 渲染项（#555/#568）的人工核对清单

渲染增强触 UI、无截图基建，**不引入截图测试**，改为实施 PR 附**人工核对清单**（逐项 UI 核对点，勾选验收）：

- **#555 工具渲染**：command（首行折叠/剥外壳）/ read（basename 加粗 + dir 淡显）/ edit（内联 diff + added/removed stat）/ write（全 add 预览）/ search / fetch / 多段聚合摘要（连续同类合并计数、失败追加 `· N failed`）/ generic 退化。
- **#568 附件渲染**：image（显示尺寸/体积）/ audio（显示时长/体积）/ video（显示尺寸/时长）/ **document（下载链接卡：`label/fileName + sizeBytes`）** / url 形态 src（`mediaSrc` 原样返回不拼 base64）。

> 清单各项「显示 X」的前提是数据可得——#568 history 路的元数据依赖网关回填（见 §3.4），核对时以「发送 echo 路必有数据」为主、history 路按实测结果勾选。

### 3.4 实施期验证项（先于代码，环境可用时执行）

- **#568 第 0 步**：起真容器 + 配对会话，发一条带附件的消息，`chat.history` 拉回原始 JSON，**实测 history 附件块真实字段**（裸 base64 四字段 vs 官方规整对象）。顺带核对 `document` 型与 `item.attachment`/`item.url` 形态是否真出现——**若无，则 #568 的「来源 3 + url 形态」收窄为纯防御（可不实现）**，只保留同形状条件透传 + 发送 echo。（本 worktree 沙箱断网无法实测，随实施环境先行。）

---

## 4. SDK 升级纪律

1. **锁定版本**：`@openclaw/gateway-client@2026.7.2-beta.6`（`latest` 是空壳，锁 beta）。
2. **可移植性四档**（#558）：**A** = SDK 包内 import 即用（如 `SessionProjection` 全套、`resolveSafeTimeoutDelayMs`、`shouldRetryGatewayWithDeviceToken`）；**B** = 官方纯 TS 0 共享层可直接抄（如 #555 四文件）；**C** = 依赖主仓 `src/` 共享层只能抄思路自写（如 #568 message-normalizer、#569 publishVisibleFinal）；**D** = 不在 beta.6，等升级。
3. **D 档项**（等升级，本次不实现）：
   - `storedDeviceTokenScopesAllowRead`（#567，scope 过滤子集）；
   - `resolveGatewayConnectScopes` 完整收敛（#567）；
   - **startup-unavailable 区分**（4013 + `retryAfterMs`，#558 P3，**刻意未 ticket 化**——无可移植对象，等升级后再 ticket）；
   - `reconcileSessionProjectionSnapshot`（#560，当前形态不适用——本地消息不入 projection）。
4. **触发式重估**（不立定期任务）：升级 SDK 的触发条件 = ① D 档项所需 helper 进入新版；② 安全/协议修复；③ 官方协议变更。升级时**重跑四档评估**（逐项核 A/B/C/D 归属是否变化）。
5. **官方 ui 上游**：**参考非依赖**（#558 决定性证据——官方 control-ui 与我们同款「裸协议机+手写编排+手写渲染」架构），需要时再回看，不立定期回看任务。

---

## 5. 全局风险 / 开放项（交接必读）

- **#567 R4 行为变化（标红）**：`gatewayChat.test.ts:903` 现有用例断言「`AUTH_TOKEN_MISMATCH` → `clearStoredToken` + `start()` 重连」。改造后该路径变为「`onConnectFailure` 设 `pendingDeviceTokenRetry` → `resolveClose` retry → 协议机自动重连（重发旧 token）」，**不再经 `clearStoredToken`/`recoverTokenMismatch`**（除非预算用尽走 R2 兜底）。**该用例需重写**——这是行为**变化点**，非纯等价重构，实施 PR 必须明示。
- **#567 R3 清零语义**：`deviceTokenRetryBudgetUsed`（hello 成功**无条件**清零）与 `pairingAttempts`（`acceptHello`-gated 清零）清零时机**不同、有意为之，不可合并**。
- **#566 开放项**：巡检周期是否对齐官方「周期 = clamped tick + 每 hello 重启 timer + 用 `>`」。**倾向不改**（动 timer 生命周期、收益低、超本票边界），保留 15s 固定周期 + `>=`。列此供实施期复核。
- **#560/#564 共同否定**：均**不引入 `reconcileSessionProjectionSnapshot`**（本地消息不入 projection）；**#564 不引入 `hasSessionProjectionAcceptedFinal` 做用户消息去重**（那是 assistant 侧重放网；用户消息去重用 `chat.send` 的 `idempotencyKey`）。
- **跨项文件合并**：`eventTranslate.ts`（#555/#565/#568）与 `useChatConnection.ts`（#564/#565）多 PR 并行时，按 §1.3 函数粒度对齐合并。

## 6. 交接清单（实施顺序逐项一 PR）

- [ ] **波1** `#560` SDK SessionProjection 减负 → 证据 [560](./560-session-projection-offload.md)
- [ ] **波2** `#555` 工具渲染体系（4 文件 + ToolLine 升级 + 人工渲染清单 §3.3）→ [555](./555-official-tool-call-files.md)
- [ ] **波2** `#564` outbox 离线待发最小版 → [564](./564-outbox-min-spec.md)
- [ ] **波2** `#565` 结构化 thinking 块提取 → [565](./565-structured-thinking-extract.md)
- [ ] **波2** `#566` tick 看门狗对齐 advertised tick → [566](./566-tick-watchdog-advertised-tick.md)
- [ ] **波2** `#567` token 自愈分码处理（**注意 §5 R4 测试重写**）→ [567](./567-token-self-heal-sdk-helper.md)
- [ ] **波2** `#568` history 附件元数据（**先做 §3.4 第 0 步实测**）→ [568](./568-history-normalization.md)
- [ ] **波3** `#569` 外来可见 final 局部插入（依赖 #560 落地）→ [569](./569-foreign-final-insert.md)

---

## 附：证据链索引

**本图证据文档**（同列 `docs/research/`）：[552](./552-gateway-client-tunnel-compat.md) 隧道兼容 · [553](./553-session-projection-coverage.md) SessionProjection 覆盖 · [555](./555-official-tool-call-files.md) 工具渲染 · [558](./558-official-ui-study.md) 官方 ui 深研（决定性）· [560](./560-session-projection-offload.md) · [564](./564-outbox-min-spec.md) · [565](./565-structured-thinking-extract.md) · [566](./566-tick-watchdog-advertised-tick.md) · [567](./567-token-self-heal-sdk-helper.md) · [568](./568-history-normalization.md) · [569](./569-foreign-final-insert.md) · [openclaw-gateway-client](./openclaw-gateway-client.md)（server 侧既有研究）。

**外部资产**：SDK `@openclaw/gateway-client@2026.7.2-beta.6`（`./browser` 导出）；官方 ui 源码 `github.com/openclaw/openclaw` 的 `ui/`（参考非依赖）。
