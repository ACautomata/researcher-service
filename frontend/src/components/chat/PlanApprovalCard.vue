<script setup lang="ts">
// W4 实验方案审批卡（#920 §1 展示面 + #913 reason 交互面 · 853 §5.1/§6.2 卡内容契约）：
// ApprovalDock 按 source==='experiment-plan' 分流的专用子组件（其余四 source 仍 ApprovalCard）。
// 展示面（#920 §1）：标题 + 轮次徽标（第 N/3 轮，第 2/3 轮「最后一轮」提示）+ plan.title/summary
// + ▾ 方案全文折叠区（plan.text 经 MarkdownRenderer 渲染——spec 9 段结构化文档 plain pre 不可读）。
// reason 交互面（#913）：[批准并执行] 直点（可选附言经「添加附言」展开输入）/ [拒绝] 点击滑出
// 必填理由框 ≤2000 字（空理由禁提交）+ [确认拒绝][返回]——理由/附言输入仅限方案卡（漏斗卡
// deny 理由无消费面不回喂 agent，保持两键）。props-in/emits-out 哑组件（#316：#340 拆分边界）；
// resolve 契约两值 + 可选第三参 reason（server sessionApprovalSchema reason ≤2000 已支持）。
// 方案块缺失（畸形 fail-soft，#920 §1）→ 回退 toolCallSummary 展示，卡不停摆。
// 无 #796 teammate 徽标面：experiment-plan 由插件 research_workflow 工具产生（853 §5.1
// 流程内置门禁），恒主会话 escalation，teammateId 恒 null。
import { ref } from 'vue'
import type { ApprovalItem } from '@/stores/chat'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

const props = defineProps<{
  approval: ApprovalItem
  disconnected: boolean
}>()

const emit = defineEmits<{
  resolve: [approval: ApprovalItem, decision: 'allow' | 'deny', reason?: string]
}>()

// 轮次上限显示面（853 §5.1：上限 3 轮；真源 plugins/research/values.ts，前端不引插件代码）。
const PLAN_REVIEW_MAX_ROUNDS = 3

const planOpen = ref(false)
// 附言（approve 可选——落审计、随 resume 值作为执行注意事项传达）与拒绝理由框均为局部
// 视图态（#913）；收起即清值（C2 拍板）——重试/再展开不带滞留输入。
const noteOpen = ref(false)
const note = ref('')
const denyOpen = ref(false)
const denyReason = ref('')

const actionDisabled = () => props.approval.status !== 'pending' || props.disconnected

function toggleNote(): void {
  if (noteOpen.value) note.value = ''
  noteOpen.value = !noteOpen.value
}
function approve(): void {
  emit('resolve', props.approval, 'allow', note.value.trim() || undefined)
}
function confirmDeny(): void {
  const reason = denyReason.value.trim()
  if (reason === '') return
  emit('resolve', props.approval, 'deny', reason)
}
function backFromDeny(): void {
  denyOpen.value = false
  denyReason.value = ''
}
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
      <template v-if="!denyOpen">
        <button
          class="btn-approve"
          :disabled="actionDisabled()"
          :title="disconnected ? '连接已断开，请重新连接后操作' : '批准后流程自动续跑执行段'"
          :data-test="`approve-${approval.id}`"
          @click="approve()"
        >{{ approval.status === 'resolving' ? '处理中…' : '批准并执行' }}</button>
        <button
          class="btn-ghost"
          :disabled="actionDisabled()"
          title="附言随批准提交（可选，≤2000 字）"
          :data-test="`note-toggle-${approval.id}`"
          @click="toggleNote()"
        >{{ noteOpen ? '收起附言' : '添加附言' }}</button>
        <textarea
          v-if="noteOpen" v-model="note" class="note-input" rows="2" maxlength="2000"
          :data-test="`note-input-${approval.id}`" aria-label="批准附言（可选，≤2000 字）"
          placeholder="附言（可选，≤2000 字）：将作为执行注意事项传达"
        />
        <button
          class="btn-deny"
          :disabled="actionDisabled()"
          :title="disconnected ? '连接已断开，请重新连接后操作' : '拒绝后按理由修订下一轮方案'"
          :data-test="`deny-${approval.id}`"
          @click="denyOpen = true"
        >拒绝并说明理由</button>
      </template>
      <template v-else>
        <textarea
          v-model="denyReason" class="note-input" rows="3" maxlength="2000"
          :data-test="`deny-input-${approval.id}`" aria-label="拒绝理由（必填，≤2000 字）"
          placeholder="拒绝理由（必填，≤2000 字）：将回喂修订下一轮方案"
        />
        <button
          class="btn-deny"
          :disabled="denyReason.trim() === '' || actionDisabled()"
          title="确认拒绝：理由将回喂修订下一轮方案"
          :data-test="`deny-confirm-${approval.id}`"
          @click="confirmDeny()"
        >确认拒绝</button>
        <button class="btn-ghost" title="返回批准/拒绝选择" :data-test="`deny-back-${approval.id}`" @click="backFromDeny()">返回</button>
      </template>
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
.approval .a-actions { display: flex; gap: 9px; margin-top: 8px; flex-wrap: wrap; align-items: flex-start; }
.approval .a-actions button { border: none; border-radius: 7px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.approval .a-actions button:disabled { cursor: not-allowed; opacity: .5; }
.approval .btn-approve { background: var(--el-color-success); color: #fff; }
.approval .btn-deny { background: transparent; border: 1px solid var(--el-color-danger); color: var(--el-color-danger); }
.approval .btn-ghost { background: transparent; border: 1px solid var(--el-border-color); color: var(--el-text-color-secondary); }
.approval .note-input { flex-basis: 100%; min-width: 0; border: 1px solid var(--el-border-color); border-radius: 7px; padding: 6px 10px; font-size: 12.5px; font-family: inherit; resize: vertical; background: var(--el-bg-color); }
</style>
