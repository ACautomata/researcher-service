<script setup lang="ts">
// 消息流（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// ADR 0009 / #399：messages + approvals 双列表经 mergeTimeline（纯函数）合并为单一时间线——
// 审批卡按到达序号 seq 插入消息流（流式占位强制沉底），不再沉在全部消息底部聚团。
// 渲染 messages（ChatMessageItem 注入 msg-item/thinking/tool-line slot）+ 审批卡（ApprovalCard）
// + 历史分页「加载更多」。thinking+回答保持同气泡、工具行挂 run 内（不扁平化）。
import type { Msg, ApprovalItem } from '@/stores/chat'
import { isApprovalEntry, mergeTimeline } from '@/chat/timeline'
import ChatMessageItem from '@/components/chat/ChatMessageItem.vue'
import ApprovalCard from '@/components/chat/ApprovalCard.vue'

defineProps<{
  messages: Msg[]
  approvals: ApprovalItem[]
  disconnected: boolean
  historyHasMore: boolean
  historyLoading: boolean
}>()

const emit = defineEmits<{
  loadMore: []
  resolveApproval: [approval: ApprovalItem, decision: 'allow-once' | 'deny']
  toggleApprovalDetail: [approval: ApprovalItem]
}>()

// 子组件发射多参数时 $event 仅取首参（Vue 3 组件事件语义），须经方法转发保持双参
function onResolve(a: ApprovalItem, d: 'allow-once' | 'deny'): void {
  emit('resolveApproval', a, d)
}

function onToggleDetail(a: ApprovalItem): void {
  emit('toggleApprovalDetail', a)
}

defineSlots<{
  'msg-item'?: (props: { msg: Msg }) => unknown
  thinking?: (props: { thinking: string; thinkingOpen: boolean }) => unknown
  'tool-line'?: (props: { tool: Msg['tools'][number] }) => unknown
  empty?: (props: {}) => unknown
}>()
</script>

<template>
  <div class="stream" data-test="stream">
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
    <!-- ADR 0009：合并时间线单列表——审批卡按 seq 插入消息流（流式占位强制沉底） -->
    <template v-for="(e, i) in mergeTimeline(messages, approvals)" :key="isApprovalEntry(e) ? `a-${e.id}` : `m-${i}`">
      <!-- msg-item slot：父注入消息表现（默认 ChatMessageItem）；thinking/tool-line 透传给叶子 -->
      <slot v-if="!isApprovalEntry(e)" name="msg-item" :msg="e">
        <ChatMessageItem :msg="e" />
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
  </div>
</template>

<style scoped>
.stream { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.load-more { align-self: center; background: transparent; border: 1px dashed var(--el-border-color); border-radius: 8px; padding: 5px 18px; cursor: pointer; color: var(--el-text-color-secondary); font-size: 12.5px; }
.load-more:disabled { cursor: default; opacity: .6; }
</style>
