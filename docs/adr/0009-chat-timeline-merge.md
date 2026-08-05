# ADR 0009：聊天时间线合并渲染——审批卡按到达序入流，不扁平化 thinking/工具

## 状态

已接受。经 grill-with-docs 会话逐项盘问产出（2026-08-05）。修正在 `ChatStream` 中「审批卡独立列表渲染在全部消息之后」的既有结构（#316/#340 拆分产物），**不触碰** thinking 与回答同气泡、工具行挂 run 的既有形态。

## 背景

对话页渲染原本是**双列表**：`messages[]`（气泡流）+ `approvals[]`（审批卡，渲染在**全部消息之后**）。用户指出两个问题：

1. **同类聚团**：同一 run 内多次工具调用全部堆在一个气泡里、thinking 卡聚团——用户**不要求**扁平化（thinking+回答保持同气泡是用户明确选择），只要求**审批卡**按到达时间入流。
2. **无自动滚动**：前端 grep 零结果——完全没有滚动逻辑，更别说「窗口自动向下滚动」。

且审批卡有「连接级、无 runId」特性（既有注释明示「独立列表渲染，不混入 messages——避免破坏流式锚定/finalizeLast」）——这是**真约束**：底层状态机 `claimRun`/`handleText`/`finalizeLast`（`useChatConnection.ts`）几十处都假设「`messages` 数组最后一条 = 当前 run 的流式占位」，审批卡若物理混入 `messages` 即崩。

## 决定

**双列表保留 + 渲染期纯函数合并为单一时间线**，审批卡按**全局单调到达序号** `seq` 插入；流式占位**强制沉底**；滚动用**范式 B（上滚让位）+ rAF 节流**。具体：

1. **数据模型（store）**：`ApprovalItem` 增 `seq: number`；store 增全局 `seqCounter`，`addApproval` 时赋 `++seqCounter`；`seqCounter` 随 `resetForContainer`/`resetForSession` 重置（与审批清空同生命周期，编号干净）。`messages` 数组的 mutation **全部零改动**——几十处状态机代码不碰。

2. **渲染期合并（新纯函数模块 `frontend/src/chat/timeline.ts`）**：输入 `messages[]` + `approvals[]` → 输出单一有序条目列表。规则：
   - 消息按原序；审批卡按 `seq` 插入；
   - **流式占位（`streaming === true` 的最后一条 assistant 消息）强制沉底**——任何审批卡（哪怕 `seq` 更大）都插在流式占位**之前**；占位落定（`finalizeLast`）后它退回普通条目，「审批卡插在最后一条 assistant 气泡之前」规则恢复。效果：审批卡「趴在回答上方」，且**状态机「数组最后一条 = 占位」假设恒成立**——这是把 UX 决定做成渲染期不变式，而非改状态机。
   - 锚定规则（决定「在哪插」）：插入时刻有流式占位 → 插占位后；无流式占位且末尾是已落定 assistant 气泡 → 插该气泡**之前**；无 assistant 消息 → 插末尾；多卡间按到达先后（`seq` 序）。
   - `seq` 只决定「审批卡与审批卡之间、审批卡与已落定气泡之间」的相对顺序；`seq` 单调递增，不受历史 prepend/清空影响。

3. **自动滚动（宿主在 `ChatStream.vue`，滚动容器即根元素 `.stream`）**：范式 B——仅当用户停留在底部（滚动位置距底 < 阈值）时自动跟随（流式追加、新消息、新审批卡都滚）；用户上滚离开底部后**不抢滚动条**，回到底部后恢复跟随。触发粒度：rAF 节流（一帧内多次 delta 合并滚一次）。**展开审批详情（`detailOpen`）不联动滚动**——展开详情与跟随互不影响（标准行为）。

4. **重连补拉**：重连补拉的审批卡按到达顺序排在所有现有卡**之后**（`seq` 单调递增天然如此）——语义是「重连后重新确认到的新事件流」，未决审批浮到最新位置方便用户处理；`addApproval` 按 id 幂等去重不变，断线前的卡不会被重复插入。

## 为什么

- **不扁平化**：thinking+回答同气泡、工具行挂 run 是用户明确要保留的形态（问题 1 盘问定案）。扁平化会大改状态机且不符合用户预期。
- **方案 B（双列表 + seq）而非方案 A（统一 timeline 列表）**：`claimRun`/`finalizeLast`/`loadHistory`/`send` 等几十处代码只碰 `messages`，方案 A 要改全部；方案 B 它们一行不用动。合并是纯渲染期纯函数，可单测。
- **`seq` 而非「归属索引」（insertAfterMsgIdx）**：`insertAfterMsgIdx` 在断线重连补拉、历史 prepend 旧消息时会失效；`seq` 是单调的，不受 prepend/清空影响。
- **选项 A（渲染期强制占位沉底）而非改状态机**：状态机「最后一条 = 占位」假设恒成立，零改动；视觉上审批卡「趴在回答上方」与用户 UX 决定完全一致（问题 8 定案）。
- **范式 B（上滚让位）而非无条件跟随**：审批卡、工具执行常伴长停顿，用户可能上滚回看历史；A 会粗暴拉回底部。B 是标准聊天 UX。
- **rAF 节流而非每帧滚**：高频 delta 帧每帧重排滚动会抖动；rAF 合并一帧内多次增量滚一次，视觉上与逐字追底几乎无差。

## 考虑过但否决的方案

- **A. 统一时间线列表（messages 改单一条目数组 `timeline`）**：`claimRun`/`finalizeLast`/`loadHistory`/`send` 等几十处代码全部要改；审批卡物理混入还会破坏「数组最后一条 = 占位」假设。否决（改动面大、风险高）。
- **B. 改状态机（让 `claimRun`/`handleText` 找流式占位而非假设最后一条）**：改动面大、风险高（几十处状态机逻辑）；收益仅是审批卡沉在回答之下——用户明确否决（「审批一直趴在回答框上方吧，一直跳不舒服」）。否决。
- **C. `insertAfterMsgIdx` 归属索引**：断线重连补拉、历史 prepend 时索引全失效。否决（改用 `seq`）。
- **范式 A（无条件跟随）**：用户上滚回看历史时被拉回底部。否决（改用范式 B）。
- **滚动宿主放新组件/连接层**：滚动容器就是 `.stream` 根元素，`ChatStream.vue` 内部 `onUpdated`/watch 足够，不引入新组件。否决。
- **展开审批详情联动滚动跟随**：用户上滚展开详情时跟随暂停——标准聊天 UX 不这么做。否决（不联动）。

## 后果

- **`frontend/src/stores/chat.ts`**：`ApprovalItem` 加 `seq`；新增 `seqCounter`（随容器/会话切换重置）；`addApproval` 赋 `seq`；`messages` mutation 零改动。
- **新增 `frontend/src/chat/timeline.ts`**（与 `eventTranslate.ts` 并列的纯翻译层）：合并排序 + 占位沉底 + 锚定规则，可单测。
- **`frontend/src/components/chat/ChatStream.vue`**：模板从「消息 v-for + 审批 v-for」改成「合并时间线 v-for」；根元素 `.stream` 加范式 B 自动滚动（滚轮阈值检测 + rAF 节流 + `onUpdated` 跟随）。
- **`frontend/src/chat/useChatConnection.ts`**：状态机零改动；`handleApproval` 不动（`seq` 在 store 内赋值）。
- **既有行为不变**：审批卡仍按 sessionKey 过滤（`visibleApprovals`）、断线仍 `recoverPendingApprovals` 复位 resolving 卡、按 id 幂等去重、切容器/切会话清空。
- **验证**：`timeline.ts` 纯函数单测（占位沉底 / 锚定三分支 / seq 排序 / 重连补拉排尾）+ `npm run build`（vue-tsc 类型检查）+ 现有全量测试回归。

本 ADR 与 [0006-browser-direct-gateway-via-panel-tunnel](./0006-browser-direct-gateway-via-panel-tunnel.md)（#340 前端拆分的后续演进）、#316/#340（ChatView 8 组件拆分）相关——**不推翻**拆分边界，只改 `ChatStream` 的渲染数据源与滚动行为。
