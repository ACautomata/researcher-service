<script setup lang="ts">
// seam: teammate 具名折叠区（#796 / #730 §4.3「TraceFold 泛化」）——主时间线只挂 leader 发言
// 与产物，每个具名 teammate 的轨迹 + 信箱往来收进本组件的折叠区。props-in/emits-out 哑组件
// （贴 chat 展示组件家族形态）：开合态由父层 store 驱动（expanded prop），点击 emit('toggle')
// 回父层；轨迹行与主时间线同形状（ThinkingCard/ToolLine/MarkdownRenderer/MediaAttachmentHost
// 同一组渲染件，ToolRow 直接消费——同形状 = 同组件链）。状态徽标呈现八值终态（含审批局部冻结
// suspended / 注销归档 archived——归档不删，轨迹保留可回看）。
import type { ApprovalItem, TeamFold, TeamMail } from '@/stores/chat'
import ThinkingCard from './ThinkingCard.vue'
import ToolLine from './ToolLine.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'
import MediaAttachment from './MediaAttachmentHost.vue'

const props = defineProps<{
  teams: TeamFold[]
  approvals: ApprovalItem[] // 全局面待决卡（当事 teammate 挂起时折叠条呈冻结强调）
  expanded: Record<string, boolean> // 开合态（store 持有，与数据整替分离）
}>()

const emit = defineEmits<{ toggle: [id: string] }>()

// 状态徽标（八值镜像 server TeammateStatus；未知值回退原文）。
const STATUS_LABELS: Record<string, string> = {
  requested: '待启动',
  queued: '排队中',
  running: '运行中',
  waiting: '等待来信',
  suspended: '等待审批',
  completed: '已完成',
  failed: '已停止',
  archived: '已归档',
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

// 信箱方向：发出（recipient null = 给 leader）/ 收到（sender null = 来自 leader）。
function mailDirection(fold: TeamFold, mail: TeamMail): string {
  if (mail.senderTeammateId === fold.id) return mail.recipientTeammateId === null ? '发给主助手' : '发给队友'
  return mail.senderTeammateId === null ? '来自主助手' : '来自队友'
}

// 信箱 kind 标签（story 23 追问/广播呈现；镜像 server 全量 kind——teammates/service.requestSpawn
// 'request'、tools.broadcast 'broadcast'、runService 信箱超时唤醒 'timeout'/'timeout-follow-up'
// （追问本体/广播升级）。未知 kind 回退空串（kind 原文不入呈现）。查表 Record 与上方
// STATUS_LABELS 同款形态。
const MAIL_KIND_LABELS: Record<string, string> = {
  request: '协助申请',
  broadcast: '广播',
  timeout: '超时提醒',
  'timeout-follow-up': '超时追问',
}

function mailKindLabel(mail: TeamMail): string {
  return MAIL_KIND_LABELS[mail.kind] ?? ''
}

// request 类信箱内容呈现：server requestSpawn 落库 content = JSON.stringify({name, task})——
// 解析出「申请派生 <name> · <task>」；解析失败/形态不符兜底原文（0 信任宽容度）。
function mailContent(mail: TeamMail): string {
  if (mail.kind !== 'request') return mail.content
  try {
    const parsed = JSON.parse(mail.content) as Record<string, unknown>
    if (typeof parsed.name === 'string' && typeof parsed.task === 'string') {
      return `申请派生 ${parsed.name} · ${parsed.task}`
    }
  } catch {
    // 非 JSON 原文兜底
  }
  return mail.content
}

// 局部冻结（story 26）：当事 teammate 有待决审批（与 status=suspended 双信号互证——正常时序
// 两者同现，仅投影重拉竞态窗口内可能短暂单边）。
function isFrozen(fold: TeamFold, approvals: ApprovalItem[]): boolean {
  return fold.status === 'suspended' || approvals.some((a) => a.teammateId === fold.id && (a.status === 'pending' || a.status === 'resolving'))
}
</script>
<template>
  <section v-if="teams.length" class="team-folds" data-test="team-folds" aria-label="协作队友">
    <article
      v-for="fold in teams"
      :key="fold.id"
      class="team-fold"
      :class="{ frozen: isFrozen(fold, approvals) }"
      :data-teammate-id="fold.id"
    >
      <button
        type="button"
        class="fold-bar"
        data-test="teammate-toggle"
        :aria-expanded="!!expanded[fold.id]"
        :aria-controls="`teammate-body-${fold.id}`"
        @click="emit('toggle', fold.id)"
      >
        <span class="caret" :class="{ open: !!expanded[fold.id] }">▶</span>
        <span class="name" data-test="teammate-name">{{ fold.name || '队友' }}</span>
        <span v-if="isFrozen(fold, approvals)" class="freeze-dot" aria-hidden="true" />
        <span class="status" :class="[fold.status]" data-test="teammate-status">{{ statusLabel(fold.status) }}</span>
      </button>
      <div v-if="expanded[fold.id]" :id="`teammate-body-${fold.id}`" class="fold-body" :data-test="`teammate-body-${fold.id}`">
        <p v-if="fold.task" class="task" data-test="teammate-task">{{ fold.task }}</p>
        <!-- 轨迹平铺：text/thinking/tool 行与主时间线同组件链同形状；轮次 traceFolded 不在此
             消费（折叠区自身已是折叠容器，不嵌套二级折叠条） -->
        <div class="trace" data-test="teammate-trace">
          <template v-for="(m, i) in fold.msgs" :key="`turn-${i}`">
            <ThinkingCard v-if="m.thinking" :thinking="m.thinking" :thinking-open="m.thinkingOpen" />
            <ToolLine v-for="(tool, ti) in m.tools" :key="`${i}-${tool.id ?? ti}`" :tool="tool" />
            <MarkdownRenderer :text="m.text" :streaming="m.streaming" />
            <div v-if="m.media.length" class="media-list">
              <MediaAttachment v-for="media in m.media" :key="media.attachmentId" :media="media" />
            </div>
          </template>
          <p v-if="!fold.msgs.length" class="empty" data-test="teammate-trace-empty">暂无轨迹</p>
        </div>
        <!-- 信箱往来（story 23 追问/广播）：REST-only 面（server sendMail 不发事件），随投影重拉整替 -->
        <details v-if="fold.mailbox.length" class="mailbox" data-test="teammate-mailbox">
          <summary>通信记录 · {{ fold.mailbox.length }}</summary>
          <p v-for="mail in fold.mailbox" :key="mail.id" class="mail" :data-test="`mail-${mail.id}`">
            <span class="mail-direction">{{ mailDirection(fold, mail) }}</span>
            <span v-if="mailKindLabel(mail)" class="mail-kind" :class="mail.kind">{{ mailKindLabel(mail) }}</span>
            <span class="mail-content">{{ mailContent(mail) }}</span>
          </p>
        </details>
      </div>
    </article>
  </section>
</template>
<style scoped>
.team-folds { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 840px; align-self: center; min-width: 0; margin-top: 6px; }
.team-fold { border: 1px solid var(--el-border-color); border-radius: 10px; overflow: hidden; background: var(--el-bg-color); }
.team-fold.frozen { border-color: var(--el-color-warning); }
.fold-bar { display: flex; align-items: center; gap: 9px; width: 100%; min-width: 0; padding: 9px 14px; border: 0; background: var(--el-fill-color-light); color: var(--el-text-color-primary); font-size: 13px; text-align: left; cursor: pointer; user-select: none; }
.fold-bar .caret { display: inline-block; font-size: 10px; color: var(--el-text-color-secondary); transition: transform .18s; }
.fold-bar .caret.open { transform: rotate(90deg); }
.fold-bar .name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fold-bar .status { margin-left: auto; flex-shrink: 0; font-size: 11.5px; color: var(--el-text-color-secondary); background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 10px; padding: 1px 9px; }
.fold-bar .status.running { color: var(--el-color-primary); }
.fold-bar .status.suspended { color: var(--el-color-warning); }
.fold-bar .status.failed { color: var(--el-color-danger); }
.freeze-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--el-color-warning); flex-shrink: 0; animation: freeze-pulse 1.2s ease-in-out infinite; }
@keyframes freeze-pulse { 50% { opacity: .35; } }
.fold-body { padding: 10px 14px 12px; border-top: 1px solid var(--el-border-color-lighter); }
.fold-body .task { margin: 0 0 8px; color: var(--el-text-color-secondary); font-size: 12.5px; overflow-wrap: anywhere; }
.trace { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.trace .media-list { display: flex; flex-direction: column; gap: 8px; }
.trace .empty { margin: 0; color: var(--el-text-color-placeholder); font-size: 12.5px; }
.mailbox { margin-top: 10px; border: 1px dashed var(--el-border-color); border-radius: 9px; padding: 6px 12px; font-size: 12.5px; }
.mailbox summary { cursor: pointer; color: var(--el-text-color-secondary); }
.mail { margin: 7px 0 0; overflow-wrap: anywhere; }
.mail-direction { color: var(--el-text-color-secondary); margin-right: 6px; }
.mail-kind { display: inline-block; margin-right: 6px; font-size: 11px; font-weight: 600; border-radius: 8px; padding: 0 7px; background: var(--el-fill-color); color: var(--el-text-color-secondary); }
.mail-kind.broadcast { color: var(--el-color-primary); }
.mail-kind.request { color: var(--el-color-warning); }
.mail-kind.timeout-follow-up { color: var(--el-color-warning); }
</style>
