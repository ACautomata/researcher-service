<script setup lang="ts">
// 消息流（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// 渲染 messages（ChatMessageItem 注入 msg-item/thinking/tool-line slot）+ 审批卡列表
// （ApprovalCard）+ 历史分页「加载更多」。审批卡经 approvals slot 全开，父可注入表现。
import type { Msg, ApprovalItem } from '@/stores/chat'
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
  approvals?: (props: { approvals: ApprovalItem[] }) => unknown
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
    <!-- msg-item slot：父注入消息表现（默认 ChatMessageItem）；thinking/tool-line 透传给叶子 -->
    <template v-for="(m, i) in messages" :key="`m-${i}`">
      <slot name="msg-item" :msg="m">
        <ChatMessageItem :msg="m" />
      </slot>
    </template>
    <!-- T06 权限审批卡（spec §9.4）：独立于 messages 的列表，橙边待处理，处理后变淡显示结果。 -->
    <slot name="approvals" :approvals="approvals">
      <ApprovalCard
        v-for="a in approvals"
        :key="a.id"
        :approval="a"
        :disconnected="disconnected"
        @resolve="onResolve"
        @toggle-detail="onToggleDetail"
      />
    </slot>
    <slot name="empty" />
  </div>
</template>

<style scoped>
.stream { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.load-more { align-self: center; background: transparent; border: 1px dashed var(--el-border-color); border-radius: 8px; padding: 5px 18px; cursor: pointer; color: var(--el-text-color-secondary); font-size: 12.5px; }
.load-more:disabled { cursor: default; opacity: .6; }
</style>
