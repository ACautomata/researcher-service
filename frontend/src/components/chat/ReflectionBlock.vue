<script setup lang="ts">
// 结构化反思块（#1080 RF-T04 · 父规格 I5）：显示操作、完整五部分、版本与不可逆影响。
// 正文不经工具行（4KiB 截断）——按展示引用读取完整版本；浏览器完整渲染后提交 display ack
// （ack 仅证明客户端已呈现该版本，不是写授权；确认仍由后续用户自然语言消息驱动）。
import { computed, onMounted, ref, watch } from 'vue'
import { ackReflectionDisplay, getReflectionDisplay, type ReflectionDisplay } from '@/api/reflections'
import type { PresentationRef } from '@/api/sessions'

const props = defineProps<{
  presentation: PresentationRef
  messageId?: string
}>()

const display = ref<ReflectionDisplay | null>(null)
const error = ref('')
const ackState = ref<'idle' | 'sent' | 'failed'>('idle')
const bodyEl = ref<HTMLElement | null>(null)

async function load(): Promise<void> {
  error.value = ''
  try {
    display.value = await getReflectionDisplay(props.presentation.displayId)
  } catch (err) {
    display.value = null
    error.value = err instanceof Error && err.message ? err.message : '反思展示读取失败'
  }
}

// 完整渲染判定：正文元素挂载且有实际高度（不是空块）后才回执，避免把截断/失败当已呈现。
async function ackIfRendered(): Promise<void> {
  if (ackState.value === 'sent' || ackState.value === 'failed') return
  const el = bodyEl.value
  const shown = display.value
  if (!el || !shown || !shown.body || !props.messageId) return
  if (shown.status !== 'active') return // 已 ack / 被新版本撤回 / 已删除：不重复回执
  if (shown.messageId !== props.messageId) return
  if (el.scrollHeight === 0) return
  try {
    await ackReflectionDisplay(shown.displayId, {
      version: shown.version,
      hash: shown.bodyHash,
      messageId: props.messageId,
    })
    ackState.value = 'sent'
  } catch {
    ackState.value = 'failed'
  }
}

onMounted(async () => {
  await load()
  await ackIfRendered()
})

watch(() => [props.presentation.displayId, props.presentation.version, props.messageId], async () => {
  ackState.value = 'idle'
  await load()
  await ackIfRendered()
})

const operationLabel = computed(() => (display.value?.action === 'revise' ? '修订反思草稿' : '新建反思草稿'))
// 可确认性以服务端实时读面为准（展示 ref 里的 confirmable 是 present 时快照，核验后会过期）。
const notConfirmable = computed(() => !(display.value?.body && (display.value?.confirmable ?? props.presentation.confirmable)))
const evidencePending = computed(() => (display.value?.evidence ?? []).filter((e) => e.status !== 'valid'))
</script>

<template>
  <section class="reflection-block" data-test="reflection-block">
    <header class="rf-head">
      <span class="rf-title">反思草稿</span>
      <span class="rf-version">v{{ presentation.version }}</span>
      <span class="rf-action">{{ operationLabel }}</span>
      <span v-if="notConfirmable" class="rf-badge pending" data-test="reflection-not-confirmable">证据未核验，暂不可确认</span>
      <span v-else class="rf-badge ready">可在下方对话中确认保存</span>
      <span v-if="display && display.status === 'revoked'" class="rf-badge revoked" data-test="reflection-revoked">已被新版本替代</span>
    </header>

    <p v-if="error" class="rf-error" role="alert">{{ error }}</p>
    <p v-else-if="!display" class="rf-loading">正在读取完整草稿…</p>

    <div v-else-if="display.deleted" class="rf-deleted" data-test="reflection-deleted">该反思展示已删除，正文不可再读。</div>

    <article v-else-if="display.body" ref="bodyEl" class="rf-body" data-test="reflection-body">
      <h4 class="rf-body-title">{{ display.body.title }}</h4>
      <p class="rf-category">类别：{{ display.categoryLabel }}</p>

      <h5>一、问题与影响</h5>
      <p class="rf-text">{{ display.body.problem }}</p>

      <h5>二、原始证据</h5>
      <ul class="rf-evidence">
        <li v-for="e in display.evidence" :key="e.position" :class="e.status">
          <span class="rf-ev-num">[{{ e.position }}]</span>
          <span class="rf-ev-ref">{{ e.sessionId }}{{ e.messageId ? ` · ${e.messageId}` : ' · 当前轮在飞' }} · {{ e.region }}</span>
          <span class="rf-ev-excerpt">{{ e.excerpt }}</span>
          <span class="rf-ev-status">{{ e.status === 'valid' ? '已核验' : e.status === 'preparing' ? '待持久化' : `不可核验${e.reason ? `（${e.reason}）` : ''}` }}</span>
        </li>
      </ul>

      <h5>三、原因分析</h5>
      <ul class="rf-causes">
        <li v-for="(c, i) in display.body.causes" :key="i">
          <span class="rf-kind" :class="c.kind">{{ c.kind === 'fact' ? '事实' : '推测' }}</span>
          <span>{{ c.text }}</span>
          <span v-if="c.evidence.length" class="rf-cause-ev">（证据 {{ c.evidence.join('、') }}）</span>
        </li>
      </ul>

      <h5>四、可执行改进建议</h5>
      <ul class="rf-improvements">
        <li v-for="(s, i) in display.body.improvements" :key="i">{{ s }}</li>
      </ul>

      <h5>五、适用范围</h5>
      <p class="rf-scope">标签：{{ display.body.scope.labels.join('、') || '（无）' }}</p>
      <p class="rf-scope">条件：{{ display.body.scope.conditions || '（无）' }}</p>
      <p class="rf-scope">排除：{{ display.body.scope.exclusions || '（无）' }}</p>

      <footer class="rf-foot">
        <span>hash {{ display.bodyHash.slice(0, 12) }}…</span>
        <span>{{ ackState === 'sent' ? '已确认客户端完整展示' : ackState === 'failed' ? '展示回执失败' : '' }}</span>
      </footer>
      <p v-if="evidencePending.length > 0" class="rf-note">证据 {{ evidencePending.map((e) => e.position).join('、') }} 尚未完成持久化核验；本轮草稿不可确认。</p>
    </article>
  </section>
</template>

<style scoped>
.reflection-block { margin: 8px 0; border: 1px solid var(--el-border-color); border-radius: 10px; padding: 10px 14px; background: var(--el-fill-color-lighter); }
.rf-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12.5px; color: var(--el-text-color-secondary); }
.rf-title { font-weight: 600; color: var(--el-text-color-primary); }
.rf-version { font-variant-numeric: tabular-nums; }
.rf-badge { border-radius: 9px; padding: 1px 8px; font-size: 12px; }
.rf-badge.pending { background: var(--el-color-warning-light-9); color: var(--el-color-warning); }
.rf-badge.ready { background: var(--el-color-success-light-9); color: var(--el-color-success); }
.rf-badge.revoked { background: var(--el-fill-color); color: var(--el-text-color-secondary); }
.rf-body { margin-top: 8px; font-size: 13.5px; line-height: 1.6; }
.rf-body-title { margin: 0 0 4px; font-size: 15px; }
.rf-category { margin: 0 0 8px; color: var(--el-text-color-secondary); }
.rf-body h5 { margin: 12px 0 4px; font-size: 13px; color: var(--el-text-color-primary); }
.rf-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.rf-evidence, .rf-causes, .rf-improvements { margin: 0; padding-left: 18px; }
.rf-evidence li { margin-bottom: 4px; }
.rf-ev-num { margin-right: 4px; color: var(--el-text-color-secondary); }
.rf-ev-ref { display: block; font-size: 11.5px; color: var(--el-text-color-placeholder); }
.rf-ev-excerpt { white-space: pre-wrap; overflow-wrap: anywhere; }
.rf-ev-status { margin-left: 6px; font-size: 11.5px; color: var(--el-text-color-secondary); }
.rf-evidence li.preparing .rf-ev-status, .rf-evidence li.not_ready .rf-ev-status { color: var(--el-color-warning); }
.rf-kind { display: inline-block; min-width: 34px; margin-right: 6px; font-size: 11.5px; border-radius: 4px; padding: 0 4px; }
.rf-kind.fact { background: var(--el-color-success-light-9); color: var(--el-color-success); }
.rf-kind.inference { background: var(--el-color-warning-light-9); color: var(--el-color-warning); }
.rf-cause-ev { color: var(--el-text-color-secondary); }
.rf-scope { margin: 2px 0; white-space: pre-wrap; }
.rf-foot { display: flex; justify-content: space-between; margin-top: 10px; font-size: 11.5px; color: var(--el-text-color-placeholder); }
.rf-note { margin: 6px 0 0; font-size: 12px; color: var(--el-color-warning); }
.rf-error { color: var(--el-color-danger); font-size: 12.5px; }
.rf-loading, .rf-deleted { color: var(--el-text-color-secondary); font-size: 12.5px; }
</style>
