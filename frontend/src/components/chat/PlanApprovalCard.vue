<script setup lang="ts">
// W4 实验方案审批卡（#920 §1 · 853 §5.1/§6.2 卡内容契约）：ApprovalDock 按
// source==='experiment-plan' 分流的专用子组件（其余四 source 仍 ApprovalCard）。
// 标题 + 轮次徽标（第 N/3 轮，第 2/3 轮「最后一轮」提示）+ plan.title/summary + ▾ 方案全文
// 折叠区（plan.text 经 MarkdownRenderer 渲染——spec 9 段结构化文档 plain pre 不可读）。
// 盲批窗口修复面：方案全文已内联 escalation.plan.text，卡面必须可读后才允许审批。
// props-in/emits-out 哑组件（#316：#340 拆分边界）；resolve 两值契约与 ApprovalCard 同形
//（deny 理由输入与 reason 传递链归 #913，后端 bare deny 落「未说明理由」语义闭环）。
// 方案块缺失（畸形 fail-soft）→ 回退 toolCallSummary 展示，卡不停摆。
// 无 #796 teammate 徽标面：experiment-plan 由插件 research_workflow 工具产生（853 §5.1
// 流程内置门禁），恒主会话 escalation，teammateId 恒 null。
import { ref } from 'vue'
import type { ApprovalItem } from '@/stores/chat'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

defineProps<{
  approval: ApprovalItem
  disconnected: boolean
}>()

const emit = defineEmits<{
  resolve: [approval: ApprovalItem, decision: 'allow' | 'deny']
}>()

// 轮次上限显示面（853 §5.1：上限 3 轮；真源 plugins/research/values.ts，前端不引插件代码）。
const PLAN_REVIEW_MAX_ROUNDS = 3

const planOpen = ref(false)
</script>

<template>
  <div class="approval plan" :data-test="`approval-${approval.id}`">
    <div class="a-head">
      📋 实验方案待审批
      <span v-if="approval.plan" class="round-badge" data-test="plan-round">
        第 {{ approval.plan.round }}/{{ PLAN_REVIEW_MAX_ROUNDS }} 轮<template v-if="approval.plan.round >= 2"> · 最后一轮</template>
      </span>
      <span v-if="approval.status === 'expired'" class="resolved-tag expired" data-test="approval-expired">
        已失效
      </span>
    </div>
    <template v-if="approval.plan">
      <div class="plan-title" data-test="plan-title">{{ approval.plan.title }}</div>
      <div class="a-sub" data-test="plan-summary">{{ approval.plan.summary }}</div>
      <button v-if="approval.plan.text !== ''" class="plan-fold" :data-test="`plan-fold`" @click="planOpen = !planOpen">
        {{ planOpen ? '▴ 收起方案全文' : '▾ 方案全文' }}
      </button>
      <div v-if="planOpen" class="plan-text" :data-test="`plan-text`">
        <MarkdownRenderer :text="approval.plan.text" :streaming="false" />
      </div>
    </template>
    <div v-else class="a-cmd" :title="approval.toolCallSummary">{{ approval.toolCallSummary }}</div>
    <div v-if="approval.status !== 'expired'" class="a-actions">
      <button
        class="btn-approve"
        :disabled="approval.status !== 'pending' || disconnected"
        :title="disconnected ? '连接已断开，请重新连接后操作' : '批准后流程自动续跑执行段'"
        :data-test="`approve-${approval.id}`"
        @click="emit('resolve', approval, 'allow')"
      >{{ approval.status === 'resolving' ? '处理中…' : '批准并执行' }}</button>
      <button
        class="btn-deny"
        :disabled="approval.status !== 'pending' || disconnected"
        :title="disconnected ? '连接已断开，请重新连接后操作' : '拒绝本方案'"
        :data-test="`deny-${approval.id}`"
        @click="emit('resolve', approval, 'deny')"
      >拒绝</button>
    </div>
  </div>
</template>

<style scoped>
/* 骨架与 ApprovalCard 同族（853 §5.1「复用 ApprovalCard 骨架」）——类名对齐便于 Dock 深度选择器生效。 */
.approval { align-self: flex-start; border: 1px solid var(--el-color-warning); background: var(--el-color-warning-light-9); border-radius: 11px; padding: 12px 14px; margin: 4px 0; min-width: 280px; max-width: 840px; }
.approval .a-head { display: flex; align-items: center; gap: 8px; color: var(--el-color-warning); font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.approval .round-badge { display: inline-flex; align-items: center; font-size: 11.5px; font-weight: 600; color: var(--el-text-color-secondary); background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 10px; padding: 1px 8px; white-space: nowrap; }
.approval .resolved-tag { margin-left: auto; font-size: 11.5px; color: var(--el-text-color-secondary); font-weight: 600; }
.approval .a-sub { color: var(--el-text-color-secondary); font-size: 13px; }
.approval .plan-title { font-size: 13.5px; font-weight: 600; color: var(--el-text-color-primary); margin-top: 2px; }
.approval .plan-fold { background: transparent; border: none; color: var(--el-color-primary); cursor: pointer; font-size: 12.5px; padding: 6px 0 0; }
.approval .plan-text { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: 7px; padding: 4px 12px; margin-top: 6px; max-height: 40vh; overflow-y: auto; font-size: 13px; }
.approval .a-cmd { font-family: ui-monospace, monospace; background: var(--el-fill-color-darker); border: 1px solid var(--el-border-color); border-radius: 7px; padding: 8px 10px; margin: 8px 0; font-size: 12.5px; white-space: pre-wrap; word-break: break-all; }
.approval .a-actions { display: flex; gap: 9px; margin-top: 8px; }
.approval .a-actions button { border: none; border-radius: 7px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.approval .a-actions button:disabled { cursor: not-allowed; opacity: .5; }
.approval .btn-approve { background: var(--el-color-success); color: #fff; }
.approval .btn-deny { background: transparent; border: 1px solid var(--el-color-danger); color: var(--el-color-danger); }
</style>
