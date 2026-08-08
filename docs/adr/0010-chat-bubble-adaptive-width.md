# ADR 0010：聊天气泡自适应宽度——min/max 钳制区间，消除宽度参差与横向滚动

## 状态

已接受。经 grill-with-docs 会话逐项盘问产出（2026-08-08）。用户目标：**美学改善 + 自适应宽度**，不在意具体像素值；痛点是「Chat 界面的图像出现了滚动问题」与「对话框宽度参差不齐」。

## 背景

ChatView 消息气泡的宽度此前**没有任何显式策略**，完全由 flex 默认行为推导：

1. **AI 气泡**（`.msg.assistant`）：column flex 容器里 `align-self` 默认 `stretch` → 拉伸到父容器全宽，被 `.msg { max-width: 840px }` 单方面封顶，**与内容长度无关，恒为满宽块**。
2. **用户气泡**（`.msg.user`）：`align-self: flex-end` → 收缩到内容宽、靠右，上限同为 840px。

两种策略本质不同（block-fill vs fit-content），叠加 **ApprovalCard 独立的 `max-width: 560px`**（比 AI 气泡窄一截、左对齐），导致：

- **宽度参差**：一条只有一张小图/一句短回复的 AI 消息会**塌成很窄一条**（`.msg` 无 `min-width` 下限），与旁边满 840px 的长文消息宽度差巨大，视觉上「对话框宽度参差不齐」。
- **横向滚动隐患**：所有已知溢出源（pre/table/katex/工具参数/媒体）虽已被局部 `overflow-x:auto` 或 `max-width:100%` 收编（#478/#464），但宽度无下限 + 媒体 `object-fit:contain` 的组合让「图像消息」成为宽度波动最剧烈的源头。
- **ApprovalCard 突兀**：560px 比 AI 气泡窄，插在时间线里视觉断裂。

## 决定

**所有聊天气泡统一采用「fit-content + min/max 钳制区间」的自适应宽度策略**，宽度随内容自适应，但被钳在 `[280px, 840px]` 区间：

1. **AI / 用户气泡**（`ChatMessageItem.vue .msg`）：`min-width: 280px; max-width: 840px`。短回复/小图不再塌成细条（min 下限），长回复仍满 840px（max 上限）。对齐不变——AI 左对齐（默认 stretch→现为 min/max 钳制），用户 `align-self: flex-end` 靠右，形成清晰左右视觉分区。
2. **ApprovalCard**（`ApprovalCard.vue .approval`）：`max-width` 从 `560px` 提至 `840px`，新增 `min-width: 280px`，保持左对齐——与 AI 气泡同宽约束，不再突兀。
3. **SyntheticAnchor 虚拟气泡**（`ChatStream.vue .synthetic-anchor`）：新增 `min-width: 280px`（原有 `max-width: 840px` 不变），与 AI 气泡同约束。
4. **横向滚动**：消息流容器 `.stream` 本身**永不出现横向滚动条**——所有内容块（pre/table/katex/媒体/工具参数）继续局部 `overflow-x:auto` 收编溢出，气泡 `min-width:0`（`MarkdownRenderer` 根）把溢出压力转嫁给内部子块而非撑破气泡。

效果：所有消息宽度在 280px–840px 之间自适应，短消息有下限不塌、长消息有上限不溢出，AI 与 user 左右对齐分区清晰，ApprovalCard 与 AI 气泡同宽。

## 为什么

- **min/max 钳制而非固定 840px**：固定宽度会让用户短消息留大量空白，呆板；fit-content + 钳制区间既保留自适应的紧凑感，又用下限消除「塌缩」、上限消除「溢出」，是现代聊天 UI（ChatGPT/Claude 风格）的通行做法。
- **统一 280/840 两个锚点**：AI 气泡、用户气泡、ApprovalCard、SyntheticAnchor 四处共享同一对 min/max 值，视觉一致；此前 ApprovalCard 560px 是唯一异类。
- **纯 CSS 改动，零逻辑**：三处 scoped 样式各加/改一两个属性，不触碰任何组件逻辑、状态机或测试断言——jsdom 无布局引擎，宽度像素值本就无法 DOM 断言，现有测试覆盖（结构存在性 + 纵向滚动行为）不受影响。

## 考虑过但否决的方案

- **B. 全部固定 840px（AI 与 user 同宽）**：用户短消息留大量空白，呆板。否决（采用 min/max 钳制自适应）。
- **C. 全部 fit-content 靠左（无左右对齐差异）**：AI 回复拥挤、user 消息占全宽，失去聊天应用的左右分区视觉语言。否决。
- **抽 `--chat-max-width` 设计 token**：当前仅 4 处共享两个字面量，抽 token 收益低、违反 Simplicity First；若未来宽度锚点增多再提。本次否决（保留硬编码字面量，与现状一致）。

## 后果

- **`frontend/src/components/chat/ChatMessageItem.vue`**：`.msg` 加 `min-width: 280px`。
- **`frontend/src/components/chat/ApprovalCard.vue`**：`.approval` `max-width: 560px → 840px`，加 `min-width: 280px`。
- **`frontend/src/components/chat/ChatStream.vue`**：`.synthetic-anchor` 加 `min-width: 280px`。
- **验证**：`npm run test`（vitest 587 全过）+ `npm run build`（vue-tsc 类型检查通过）。宽度像素值无法 jsdom 断言，靠视觉验收。

本 ADR 与 [0009-chat-timeline-merge](./0009-chat-timeline-merge.md)（合并时间线 + SyntheticAnchor 虚拟气泡）相关——**不推翻**时间线合并结构，只统一其中各渲染单元的宽度约束。
