<script setup lang="ts">
// 消息流（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// ADR 0009 / #399：messages + approvals 双列表经 mergeTimeline（纯函数）合并为单一时间线——
// 审批卡按到达序号 seq 插入消息流（流式占位强制沉底），不再沉在全部消息底部聚团。
// #405-T2（#407）：anchorState（是否有待展示审批卡）——main 会话还没有任何 assistant 消息时，
// 时间线尾部合成 SyntheticAnchor 虚拟气泡承载审批卡（淡色虚线边框、无文本、高度贴近卡片）；
// 卡全 resolved 后虚拟气泡仍留存（时间线不跳动）。messages 数组零改动（#340 消息/审批分离）。
// ADR 0009 / #400：窗口自动向下滚动（范式 B 上滚让位 + rAF 节流）——宿主在本组件内部，
// 滚动容器即根元素 .stream；仅用户停留底部时跟随，上滚不抢滚动条，回到底部恢复；展开审批
// 详情（detailOpen）不联动滚动；一帧内多次流式 delta 合并滚一次（rAF 节流，平滑不抖动）。
// 渲染 messages（ChatMessageItem 注入 msg-item/thinking/tool-line slot）+ 审批卡（ApprovalCard）
// + 历史分页「加载更多」。thinking+回答保持同气泡、工具行挂 run 内（不扁平化）。
import { onBeforeUnmount, onUpdated, ref, watch } from 'vue'
import type { Msg, ApprovalItem } from '@/stores/chat'
import { isApprovalEntry, isSyntheticAnchor, mergeTimeline, type TimelineEntry } from '@/chat/timeline'
import { shouldFollowBottom } from '@/chat/scroll'
import ChatMessageItem from '@/components/chat/ChatMessageItem.vue'
import ApprovalCard from '@/components/chat/ApprovalCard.vue'

// props 供 script 侧 watch 追踪布局快照（模板按名访问，无需此绑定）
const props = defineProps<{
  messages: Msg[]
  approvals: ApprovalItem[]
  // #405-T2：是否有待展示审批卡（ChatView 由 visibleApprovals 计算传入）——
  // 无 assistant 消息时驱动时间线尾部合成 SyntheticAnchor 虚拟气泡承载审批卡
  anchorState: boolean
  disconnected: boolean
  historyHasMore: boolean
  historyLoading: boolean
}>()

const emit = defineEmits<{
  loadMore: []
  resolveApproval: [approval: ApprovalItem, decision: 'allow-once' | 'deny']
  toggleApprovalDetail: [approval: ApprovalItem]
  regenerate: [text: string]
}>()

function previousUserText(message: Msg): string {
  const index = props.messages.indexOf(message)
  for (let i = index - 1; i >= 0; i--) {
    const candidate = props.messages[i]
    if (candidate.role !== 'user') continue
    // 现有前端只能重发文本，无法从历史 Msg 安全重建原始附件；含附件时不显示入口，
    // 避免“重新生成”静默退化为只发送文字。
    return candidate.media.length === 0 ? candidate.text : ''
  }
  return ''
}

// 子组件发射多参数时 $event 仅取首参（Vue 3 组件事件语义），须经方法转发保持双参
function onResolve(a: ApprovalItem, d: 'allow-once' | 'deny'): void {
  emit('resolveApproval', a, d)
}

function onToggleDetail(a: ApprovalItem): void {
  emit('toggleApprovalDetail', a)
}

// 时间线条目 key 生成器：审批卡按 id、虚拟气泡恒为「synthetic」、消息按下标。
// key 稳定性保证流式原地 mutation（useChatConnection 对消息对象就地改 raw/text）不重建 DOM——
// 消息身份不变、key 不变，diff 复用节点；卡 key 与其 id 绑定，resolve 状态变化不换 key。
function entryKey(e: TimelineEntry, i: number): string {
  if (isSyntheticAnchor(e)) return 'synthetic'
  return isApprovalEntry(e) ? `a-${e.id}` : `m-${i}`
}

// ---- 自动滚动（ADR 0009 / #400，范式 B 上滚让位 + rAF 节流）----
// 滚动容器即根元素 .stream（overflow-y:auto）。stickyBottom 记录「用户是否停留在底部」：
// 由 scroll 事件实时判定；上滚离开底部 → false（新内容不抢滚动条），回到底部 → true（恢复跟随）。
const streamEl = ref<HTMLElement | null>(null)
const stickyBottom = ref(true)
const hasNewContent = ref(false)
let rafId = 0

// 滚动判定（范式 B）：距底 < 阈值视为停留底部。scroll 事件驱动——用户滚动操作与
// 程序性滚动（跟随触底）都经过这里；跟随触底时距底=0 保持 stickyBottom=true 不抖动。
function onScroll(): void {
  const el = streamEl.value
  if (!el) return
  stickyBottom.value = shouldFollowBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
  if (stickyBottom.value) hasNewContent.value = false
}

// rAF 节流跟随：一帧内多次流式 delta/审批卡插入合并滚一次到底（平滑不抖动）。
// 仅 stickyBottom（用户停留底部）时滚；上滚回看历史时不抢滚动条。
function scrollToBottom(): void {
  if (!stickyBottom.value) return
  if (rafId) return // 本帧已调度
  rafId = requestAnimationFrame(() => {
    rafId = 0
    const el = streamEl.value
    if (el && stickyBottom.value) el.scrollTop = el.scrollHeight
  })
}

function onTimelineContentChanged(): void {
  if (!stickyBottom.value) {
    hasNewContent.value = true
    return
  }
  scrollToBottom()
}

function jumpToBottom(): void {
  const el = streamEl.value
  if (!el) return
  stickyBottom.value = true
  hasNewContent.value = false
  el.scrollTop = el.scrollHeight
}

// DOM 更新后（新消息/审批卡插入/历史加载更多 prepend）跟随。onUpdated 只对「本组件 render effect
// 失效」触发——流式 delta 是 useChatConnection 对消息对象**原地 mutation**（last.raw/text 就地改，
// 数组与对象身份不变），本组件渲染不读 text/thinking，render effect 不失效，onUpdated 不触发，
// 流式逐字追加会漏滚（#400 验收①第三场景，code-review 实证）。故补 layoutWatch：投影快照
// 只追踪「渲染布局相关字段」（role/streaming/raw 决定气泡高度与占位沉底；seq 决定审批卡插入位），
// detailOpen/tools/decision 等不属布局变化、天然不进快照——展开审批详情不联动滚动（验收④）
// 由快照字段白名单保证，不因 deep watch 被破坏。anchorState 决定虚拟气泡（SyntheticAnchor）
// 是否合成——虚拟气泡出现/消失是布局变化，须入快照（#405-T2）。watch 回调统一走 scrollToBottom
// （rAF 节流）。
watch(
  () =>
    props.messages.map((m) => `${m.role}|${m.streaming}|${m.raw.length}`).concat(
      props.approvals.map((a) => `${a.id}|${a.seq}|${a.status}`),
    ) + `|anchor:${props.anchorState}`,
  onTimelineContentChanged,
)
// 非时间线更新（例如断线状态、审批详情展开）不得制造“有新消息”；在底部时仍允许布局更新后校正滚底。
onUpdated(() => { if (stickyBottom.value) scrollToBottom() })
onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
})

defineSlots<{
  'msg-item'?: (props: { msg: Msg }) => unknown
  thinking?: (props: { thinking: string; thinkingOpen: boolean }) => unknown
  'tool-line'?: (props: { tool: Msg['tools'][number] }) => unknown
  empty?: (props: {}) => unknown
}>()
</script>

<template>
  <!-- ADR 0009 / #400：.stream 即滚动容器（根元素，overflow-y:auto）——ref 供范式 B 跟随滚底，
       @scroll 实时判定 stickyBottom（用户停留底部则跟随、上滚则让位） -->
  <div class="stream" data-test="stream" ref="streamEl" role="log" aria-live="polite" aria-label="对话消息" @scroll="onScroll">
    <!-- T3 历史分页（issue #82）：hasMore 时顶部「加载更多」向回翻更旧消息，prepend 到头部。 -->
    <button
      v-if="historyHasMore"
      class="load-more"
      :disabled="historyLoading"
      data-test="load-more"
      @click="emit('loadMore')"
    >
      {{ historyLoading ? '加载中…' : '加载更多' }}
    </button>
    <!-- ADR 0009：合并时间线单列表——审批卡按 seq 插入消息流（流式占位强制沉底）；
         #405-T2：anchorState 驱动尾部 SyntheticAnchor 虚拟气泡承载审批卡（无 assistant 消息时） -->
    <template v-for="(e, i) in mergeTimeline(messages, approvals, anchorState)" :key="entryKey(e, i)">
      <!-- 虚拟气泡（#405-T2）：无 assistant 消息时承载审批卡的合成落点——淡色虚线边框、
           无文本、高度贴近卡片的虚拟助手气泡；卡全 resolved 后仍留存（时间线不跳动） -->
      <div v-if="isSyntheticAnchor(e)" class="synthetic-anchor" data-test="synthetic-anchor" aria-hidden="true"></div>
      <!-- msg-item slot：父注入消息表现（默认 ChatMessageItem）；thinking/tool-line 透传给叶子 -->
      <slot v-else-if="!isApprovalEntry(e)" name="msg-item" :msg="e">
        <ChatMessageItem :msg="e" :regenerate-text="e.role === 'assistant' ? previousUserText(e) : ''" @regenerate="emit('regenerate', $event)" />
      </slot>
      <!-- T06 权限审批卡（spec §9.4）：橙边待处理，处理后变淡显示结果 -->
      <ApprovalCard
        v-else
        :approval="e"
        :disconnected="disconnected"
        @resolve="onResolve"
        @toggle-detail="onToggleDetail"
      />
    </template>
    <slot name="empty" />
    <button v-if="!stickyBottom" class="jump-bottom" data-test="jump-bottom" @click="jumpToBottom">
      {{ hasNewContent ? '有新消息 · 回到底部' : '回到底部' }}
    </button>
  </div>
</template>

<style scoped>
.stream { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.load-more { align-self: center; background: transparent; border: 1px dashed var(--el-border-color); border-radius: 8px; padding: 5px 18px; cursor: pointer; color: var(--el-text-color-secondary); font-size: 12.5px; }
.load-more:disabled { cursor: default; opacity: .6; }
.jump-bottom { position: sticky; bottom: 4px; align-self: center; border: 1px solid var(--el-border-color); border-radius: 18px; padding: 7px 14px; background: var(--el-bg-color-overlay); color: var(--el-color-primary); box-shadow: var(--el-box-shadow-light); cursor: pointer; z-index: 2; }
/* #405-T2 虚拟助手气泡（SyntheticAnchor）：淡色虚线边框、无文本、高度贴近审批卡片的虚拟气泡——
   无 assistant 消息时承载审批卡的稳定落点；卡全 resolved 后仍留存（时间线不跳动）。
   宽度对齐 assistant 气泡（max-width 840px，默认 stretch 填满流宽）——空内容 div 若
   align-self:flex-start 且无宽度会收缩成 0 宽细条（code-review c1 实证） */
.synthetic-anchor { min-height: 92px; min-width: 280px; max-width: 840px; border: 1.5px dashed var(--el-border-color-lighter); border-radius: 11px; background: var(--el-fill-color-lighter); }
</style>
