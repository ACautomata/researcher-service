<!-- THROWAWAY PROTOTYPE for issue #316 —— 粗略组件树 + 桩代码，供评审拆分边界。
     非生产实现：类型/事件名照抄现状，但逻辑只画骨架。真正执行 effort 另起。 -->

# ChatView 拆分方案（粗略组件树 + 桩代码）

## 0. 目标与非目标

- **目标**：把 1092 行 ChatView 拆成「薄壳编排 + 哑展示子组件（slot 组合）+ 一个状态宿主」，让每块
  单一职责、可独立测试、父组件用 slot 注入表现而不接管逻辑。
- **非目标**：不重写任何协议/重连/runId 语义（那些已在 `chat/ws.ts` 与现状视图里验证过）；
  不引入新依赖；不改 `deploy/` 契约。本图只定**组件边界**。

## 1. 现在 ChatView 里纠缠了什么（拆分依据）

| 关注点 | 现状位置 | 复杂度 |
|---|---|---|
| 容器/会话侧栏（列表+新建+删除） | template `aside.side` + `selectContainer/pickSession/newSession/removeSession` | 低 |
| **WS 连接生命周期**（connect/openSocket/重连退避/4401 恢复/断线恢复 run 认领） | `connect/scheduleReconnect/recoverUnauthorized/claimResumedRun…` | **高** |
| **runId 路由**（activeRunId/abandonedRunIds/pendingSend/孤儿 FIFO） | onText/onDone/onTool 内联 | **高** |
| 消息流渲染（bubble/thinking 卡/工具行/历史分页） | template `.stream` + `finalizeLast/loadHistory/loadMoreHistory` | 中 |
| 审批卡 | template `.approval` + `resolveApproval/recoverPendingApprovals` | 中 |
| 斜杠命令补全 | `slashQuery/slashMatches/onComposerKeydown/pickSlash` + `.slash-menu` | 中 |
| 顶栏 + 错误/断线/配对引导条 | template `.topbar/.error/.pair-guide` | 低 |

> 纠缠点：连接生命周期 × runId 路由 × 消息投影三者共享 `activeRunId/abandonedRunIds/
> pendingSend/resumePending/resumeClaimed` 这一小簇非响应式可变态 —— 它们必须待在**同一个
> 状态宿主**里，不能散到多个组件。这是本方案最重要的约束。

## 2. 组件树

```
ChatView.vue  (smart container / 编排壳 —— 唯一知道 store 与路由的组件)
├── ChatSidebar.vue            (哑) 容器+会话列表、新建/删除按钮
│     props: instances, sessions, selectedContainer, selectedSession
│     emits: select-container, select-session, new-session, delete-session
│
├── ChatHeader.vue             (哑) 顶栏标题+容器 tag+连接中 tag
│     props: title, container, connecting
│     slot: banner            ← 父注入「错误条/断线条/配对引导条」的呈现
│
├── ChatStream.vue             (哑壳) 滚动消息流容器
│     props: messages, visibleApprovals, historyHasMore, historyLoading, disconnected
│     emits: load-more, resolve-approval, toggle-approval-detail
│     ├─ slot: msg-item (作用域 slot, 暴露 m:Msg)
│     │     默认实现 → ChatMessageItem.vue
│     ├─ slot: approvals    ← 父注入审批卡列表呈现
│     │     默认实现 → ApprovalCard.vue (v-for over visibleApprovals)
│     └─ slot: empty        ← 空态（无消息且无审批）
│
├── ChatComposer.vue           (哑) 输入框+发送按钮
│     props: modelValue(input), sendDisabled, slashOpen, slashMatches, slashIndex
│     emits: update:modelValue, input, keydown, send, pick-slash
│     slot: slash-menu        ← 父注入斜杠菜单呈现（默认实现可内联）
│
└── (无组件) 状态宿主 —— 见 §3 的两个候选
```

叶子哑组件（被 slot 默认实现引用，纯展示、零逻辑）：

```
ChatMessageItem.vue   props:{ m: Msg }   slot:thinking, slot:tool-line, slot:text
ThinkingCard.vue      props:{ thinking, open }            (折叠卡, <details>)
ToolLine.vue          props:{ tool: ToolRow }  slot:args  (默认 formatToolInput)
ApprovalCard.vue      props:{ a: ApprovalItem, disconnected }
                      emits: resolve, toggle-detail        slot:detail
```

## 3. 状态宿主 —— 唯一的真决策点（两个候选）

非响应式 runId 簇 + WS 句柄 + 定时器，与响应式投影（messages/approvals/sessions）强耦合。
放哪，是整个拆分的分水岭：

### 候选 A —— 单一 `useChatStore`（Pinia，贴 wiki store 先例）
一个 `stores/chat.ts` 装全部：连接生命周期 action（connect/scheduleReconnect/
recoverUnauthorized/claimResumedRun）、runId 路由、消息投影 mutation、审批、斜杠。
ChatView 极薄，只把 store getter 绑到子组件 props、把子组件 emit 转发给 store action。

- ✅ 与 `useWikiStore` 完全同款；options-API 风格统一；可独立于组件测。
- ✅ 跨组件共享态（sidebar 需 sessions、composer 需 streaming、stream 需 messages）
  天然落在一个 store，不传长 props 链。
- ⚠ 非响应式簇（`let ws / activeRunId / abandonedRunIds / 定时器`）放 Pinia 需小心
  别被 reactive 包裹 —— 用 `markRaw` 或留在模块级闭包。
- ⚠ store 会变「上帝对象」：连接 + runId + 投影 + 审批 + 斜杠 全在一处。

### 候选 B —— `chatStore`(响应式投影) + `useChatConnection` composable(非响应式生命周期)
- `stores/chat.ts`：只装**响应式领域态**（instances/sessions/messages/approvals/
  commands/分页态/flags）+ 纯 mutation（applyText/applyTool/finalizeLast/upsertApproval…）。
- `useChatConnection()`：一个 composable 封装 `ChatWebSocket` 句柄 + runId 簇 +
  重连/4401/恢复状态机，把 ws 帧翻译成对 chatStore mutation 的调用。
- ChatView `setup()` 里 `const conn = useChatConnection(store)`，再把两者绑给子组件。

- ✅ 连接/runId 那团最脆的非响应式态有了清晰的家（composable 闭包），不被 Pinia reactive 化；
  与响应式投影分离，符合「响应式归 store、命令式句柄归 composable」。
- ✅ store 不再是上帝对象；连接机可独立测（注入假 ChatWebSocket）。
- ⚠ 引入代码库尚无先例的 composable 层（现全是 store + 哑组件）。
- ⚠ store↔composable 边界要定清（谁调 loadHistory？谁持有 containerGen/historyGen？）。

> **倾向候选 B**：runId 簇/WS 句柄/定时器本质上是命令式、带生命周期的，塞进 Pinia reactive
> 会有 markRaw 杂讯；composable 闭包才是其自然形态。但这是评审要你拍板的点。

## 3.1 ✅ 评审定案（2026-08-01，HITL）

- **状态宿主 = 候选 B**：`chatStore`(Pinia，响应式投影 + 纯 mutation) + `useChatConnection`
  composable(命令式连接生命周期 + runId 簇，闭包持有 ws/定时器/runId 集，ws 帧 → store mutation)。
  评审确认：runId 簇/定时器/WS 句柄是命令式带 dispose 生命周期的，composable 闭包比 Pinia
  reactive 更贴合，且连接机可独立测（注入假 `ChatWebSocket`)、store 不成上帝对象。代价=引入代码库
  首个 composable 先例（接受）。
- **slot 粒度 = 认可当前粒度**：`msg-item`/`thinking`/`tool-line`/`approvals`/`empty`/`slash-menu`/
  `banner` 全开 slot——表现全可定制、逻辑全留宿主。
- **组件边界 = 按推荐的 8 组件**：`ChatSidebar`/`ChatHeader`/`ChatStream`/`ChatComposer`/
  `ChatMessageItem`/`ThinkingCard`/`ToolLine`/`ApprovalCard`。

## 4. 各组件 props/emits 桩（候选 B 落地）

—— 见下附 stub 文件，仅画边界，不实现逻辑。
