<script setup lang="ts">
// T06 权限审批卡（spec §9.4）：独立于 messages 的列表卡片——橙边待处理，处理后变淡显示结果。
// 拆出 messages 是为不破坏流式锚定/finalizeLast（审查 #5）。props-in/emits-out 哑组件
// （#316：#340 拆分边界）；resolve 由父注入（slot `approvals` 外）+ 本组件内置按钮发出。
import type { ApprovalItem } from '@/stores/chat'

defineProps<{
  approval: ApprovalItem
  disconnected: boolean
}>()

const emit = defineEmits<{
  resolve: [approval: ApprovalItem, decision: 'allow-once' | 'deny']
  toggleDetail: [approval: ApprovalItem]
}>()

// 审批卡副标题（说明 agent 请求执行 elevated 命令）
function approvalSubtitle(a: ApprovalItem): string {
  return `${a.kind ?? 'exec'} agent 请求执行一条 elevated 命令，请确认后批准或拒绝：`
}

function resolvedTagText(a: ApprovalItem): string {
  return a.decision === 'allow-once'
    ? '已批准'
    : a.decision === 'allow-always'
      ? '已批准（始终）'
      : a.decision === 'deny'
        ? '已拒绝'
        : '未知'
}
</script>

<template>
  <div class="approval" :class="{ resolved: approval.status === 'resolved' }" :data-test="`approval-${approval.id}`">
    <div class="a-head">
      ⚠️ 请求提升权限
      <span v-if="approval.status === 'resolved'" class="resolved-tag" :class="approval.decision">
        {{ resolvedTagText(approval) }}
      </span>
    </div>
    <div class="a-sub">{{ approvalSubtitle(approval) }}</div>
    <div class="a-cmd">{{ approval.command }}</div>
    <div v-if="approval.detailOpen" class="a-detail" :data-test="`approval-detail-${approval.id}`">
      命令全文：<code>{{ approval.command }}</code><br>
      审批 id：<code>{{ approval.id }}</code> · 类型：<code>{{ approval.kind }}</code>
      · 经审批事件推送，审批接口回覆
    </div>
    <div v-if="approval.status !== 'resolved'" class="a-actions">
      <button
        class="btn-approve"
        :disabled="approval.status !== 'pending' || disconnected"
        :data-test="`approve-${approval.id}`"
        @click="emit('resolve', approval, 'allow-once')"
      >批准</button>
      <button
        class="btn-deny"
        :disabled="approval.status !== 'pending' || disconnected"
        :data-test="`deny-${approval.id}`"
        @click="emit('resolve', approval, 'deny')"
      >拒绝</button>
      <button class="btn-ghost" :data-test="`detail-${approval.id}`" @click="emit('toggleDetail', approval)">查看细节</button>
    </div>
  </div>
</template>

<style scoped>
.approval { align-self: flex-start; border: 1px solid var(--el-color-warning); background: var(--el-color-warning-light-9); border-radius: 11px; padding: 12px 14px; margin: 4px 0; max-width: 560px; }
.approval .a-head { display: flex; align-items: center; gap: 8px; color: var(--el-color-warning); font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.approval .resolved-tag { margin-left: auto; font-size: 11.5px; color: var(--el-color-success); font-weight: 600; }
.approval .resolved-tag.deny { color: var(--el-color-danger); }
.approval .resolved-tag.unknown { color: var(--el-text-color-secondary); }
.approval .a-sub { color: var(--el-text-color-secondary); font-size: 13px; }
.approval .a-cmd { font-family: ui-monospace, monospace; background: var(--el-fill-color-darker); border: 1px solid var(--el-border-color); border-radius: 7px; padding: 8px 10px; margin: 8px 0; font-size: 12.5px; white-space: pre-wrap; word-break: break-all; }
.approval .a-detail { font-size: 11px; color: var(--el-text-color-secondary); margin-bottom: 6px; }
.approval .a-detail code { background: var(--el-fill-color); border-radius: 4px; padding: 1px 4px; }
.approval .a-actions { display: flex; gap: 9px; margin-top: 8px; }
.approval .a-actions button { border: none; border-radius: 7px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.approval .btn-approve { background: var(--el-color-success); color: #fff; }
.approval .btn-deny { background: transparent; border: 1px solid var(--el-color-danger); color: var(--el-color-danger); }
.approval .btn-ghost { background: transparent; border: 1px solid var(--el-border-color); color: var(--el-text-color-secondary); }
.approval.resolved { opacity: .55; border-color: var(--el-border-color); }
</style>
