<script setup lang="ts">
defineOptions({ name: 'ChatView' })
// 对话页编排壳（#316 候选 B / #340：8 组件边界，本文件只做编排）。
// #793 chat 核心重写（#730 主骨架）：接线从网关协议机换轨 REST+SSE 三件套——
//   useEventStream（SSE 传输）+ chat/projection（投影归约器）+ useChatSession（会话编排）；
// 响应式投影（messages/approvals/sessions/输入）在 chatStore（纯 mutation）；8 个展示组件全
// props-in/emits-out 哑组件，6 slot 全开（msg-item/thinking/tool-line/empty/slash-menu/banner），
// 表现父注入、逻辑留宿主。容器维度退役（#730 §4.7）：无容器切换器/升级编排——侧栏 = 会话列表
//（扁平挂用户，story 4）+ 沙箱 lab 文件树（story 61）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { previewSessionRewind, uploadSessionAttachment } from '@/api/sessions'
import type { ModelRef, SystemCommandResult, RewindPreview, RewindScope } from '@/api/sessions'
import { useChatStore, type Msg } from '@/stores/chat'
import { useFileTabsStore } from '@/stores/fileTabs'
import { useAuthStore, tokenOwner } from '@/stores/auth'
import { safeLocalStorage } from '@/storage'
import { useChatSession, type SentAttachment } from '@/chat/useChatSession'
import { INLINE_RANGE_NARROW, INLINE_RANGE_WIDE } from '@/panels/triState'
import { usePanelGroup } from '@/panels/usePanelGroup'
import { usePanelTriState } from '@/panels/usePanelTriState'
import PanelTriState from '@/components/PanelTriState.vue'
import { prepareAttachment, validateAttachment, type PendingAttachment } from '@/chat/attachments'
import RewindDialog from '@/components/chat/RewindDialog.vue'
import ChatSidebar from '@/components/chat/ChatSidebar.vue'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import ChatStream from '@/components/chat/ChatStream.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import ApprovalDock from '@/components/chat/ApprovalDock.vue'
import TeamFolds from '@/components/chat/TeamFolds.vue'
import FileTabsPanel from '@/components/chat/FileTabsPanel.vue'

const chat = useChatStore()
const auth = useAuthStore()
// 视图专属态（errorMsg 上抛至此；connecting/disconnected/lastRunError/run 在 composable 内）
const errorMsg = ref('')
const availableModels = ref<readonly ModelRef[] | null>(null)
const modelStatus = ref('')
watch(() => chat.selectedSession, () => {
  availableModels.value = null
  modelStatus.value = ''
})

// #671 / #672：本页三态面板组（每页一个实例，非模块级单例）——左栏与右侧文件预览共用一组，
// 弹一个自动收回另一个（spec #667 US25）。互斥逻辑单一实现在 usePanelGroup。
const panelGroup = usePanelGroup()
// 左栏三态（inline 拖宽 160–560px / collapsed 窄条 / popped 浮层）：默认宽沿用原 220px 固定宽。
// 「会话｜文件」分段切换仍归本组件（sidebarTab），与呈现态正交。
const SIDEBAR_DEFAULT_WIDTH = 220
const sidebarPanel = usePanelTriState({
  view: 'chat',
  panel: 'sidebar',
  side: 'left',
  inlineRange: INLINE_RANGE_NARROW,
  defaultInlineWidth: SIDEBAR_DEFAULT_WIDTH,
  token: () => auth.token,
  group: panelGroup,
})
const {
  state: sidebarState,
  inlineWidth: sidebarWidth,
  poppedVw: sidebarPoppedVw,
  disabled: sidebarDisabled,
  viewportWidth: sidebarViewportWidth,
  onCollapse: onSidebarCollapse,
  onPop: onSidebarPop,
  onExpand: onSidebarExpand,
  onRestore: onSidebarRestore,
  onResizeInline: onSidebarResizeInline,
  onResizePopped: onSidebarResizePopped,
  onDragEnd: onSidebarDragEnd,
} = sidebarPanel

// #672：右侧文件预览三态（inline 拖宽 240–720px / collapsed 窄条 / popped 浮层），贴右边。
// 默认宽沿用原 360px 固定宽；与左栏同组 → 同页至多一个浮层（与 wiki 页机制同源）。
const FILE_PANEL_DEFAULT_WIDTH = 360
const filePreviewPanel = usePanelTriState({
  view: 'chat',
  panel: 'file-preview',
  side: 'right',
  inlineRange: INLINE_RANGE_WIDE,
  defaultInlineWidth: FILE_PANEL_DEFAULT_WIDTH,
  token: () => auth.token,
  group: panelGroup,
})
const {
  state: filePanelState,
  inlineWidth: filePanelWidth,
  poppedVw: filePanelPoppedVw,
  disabled: filePanelDisabled,
  viewportWidth: filePanelViewportWidth,
  onCollapse: onFilePanelCollapse,
  onPop: onFilePanelPop,
  onExpand: onFilePanelExpand,
  onRestore: onFilePanelRestore,
  onResizeInline: onFilePanelResizeInline,
  onResizePopped: onFilePanelResizePopped,
  onDragEnd: onFilePanelDragEnd,
} = filePreviewPanel

// #626 T1：左栏「会话｜文件」分段态（视图专属，默认「会话」）+ lab 文件 tab store（决议 A）
const sidebarTab = ref<'sessions' | 'files'>('sessions')
const fileTabs = useFileTabsStore()
// 切到「文件」分段：树未加载则拉一次；切会话：fileTabs.reset 已清树，在 files 分段时重拉
watch(() => [fileTabs.tree, fileTabs.treeGeneration] as const, ([tree]) => {
  if (!tree && sidebarTab.value === 'files' && chat.selectedSession && !fileTabs.treeLoading) void fileTabs.loadTree()
})
watch(sidebarTab, (tab) => {
  if (tab === 'files' && chat.selectedSession && !fileTabs.tree && !fileTabs.treeLoading) {
    void fileTabs.loadTree()
  }
})
watch(() => chat.selectedSession, (id) => {
  if (sidebarTab.value === 'files' && id) void fileTabs.loadTree()
})
function switchSidebarTab(tab: 'sessions' | 'files'): void {
  sidebarTab.value = tab
}
function activateTab(path: string): void {
  fileTabs.activePath = path
}

// ---- 会话编排（三件套之三）----
const conn = useChatSession({
  onError(message: string) {
    errorMsg.value = message
  },
  onClearError() {
    errorMsg.value = ''
  },
  // 动作类失败走瞬时 toast，不进顶部连接横幅（贴 #461 删除会话失败 toast 先例）。
  onActionError(message: string) {
    ElMessage.error(message)
  },
  // Enter/斜杠发送统一走 sendMessage（含附件校验/清空预览条），与发送按钮同路径。
  // 箭头闭包延迟求值——sendMessage 为 function 声明提升，Enter 触发时 conn 已就绪。
  onSend() {
    void sendMessage()
  },
  // 系统命令结果：/new → 选中服务端新建的会话；/model → 提示当前生效面。
  onCommand(cmd: SystemCommandResult) {
    if (cmd.name === 'new' && cmd.sessionId) {
      conn.selectSession(cmd.sessionId)
      ElMessage.success('已新建会话')
      return
    }
    if (cmd.name === 'model') {
      availableModels.value = cmd.models ?? null
      if (cmd.models) {
        modelStatus.value = cmd.models.length ? '可用模型（输入 /model providerId/modelId 切换）' : '暂无可用模型'
      } else {
        const m = cmd.model
        modelStatus.value = m ? `下一轮对话起使用模型 ${m.providerId}/${m.modelId}` : '下一轮对话起使用面板默认模型'
        ElMessage.success(modelStatus.value)
      }
    }
  },
})
// 嵌套 ref 在模板中不解包（conn 是普通对象）——顶层解构后模板自动解包（slash 匹配单一来源在
// useChatSession，此处只消费）
const slashOpen = conn.slashOpen
const slashMatches = conn.slashMatches
const connecting = conn.connecting
const historyAvailable = conn.historyAvailable
const restoreTarget = ref<{ sessionId: string; messageId: string; preview: RewindPreview } | null>(null)
const restoreLoading = ref(false)
const restoreBusy = conn.historyBusy
const restoreResult = ref('')
let restoreGeneration = 0
function closeRestore(): void { restoreGeneration++; restoreTarget.value = null }
watch(() => chat.selectedSession, () => { closeRestore(); restoreResult.value = '' })
watch(() => chat.messages, closeRestore) // 他端回退/新 run 的投影变化使旧预览失效
onBeforeUnmount(closeRestore)
async function previewRestore(msg: Msg): Promise<void> {
  if (!historyAvailable.value || !msg.id || restoreLoading.value) return
  const sessionId = chat.selectedSession
  const gen = ++restoreGeneration
  restoreLoading.value = true
  try {
    const preview = await previewSessionRewind(sessionId, msg.id)
    if (gen === restoreGeneration && sessionId === chat.selectedSession) restoreTarget.value = { sessionId, messageId: msg.id, preview }
  } catch (e) {
    if (gen === restoreGeneration) ElMessage.error(e instanceof Error ? e.message : '预览失败')
  } finally { restoreLoading.value = false }
}
async function confirmRestore(scope: RewindScope): Promise<void> {
  const target = restoreTarget.value
  if (!target || target.sessionId !== chat.selectedSession || !historyAvailable.value) return
  const result = await conn.rewind(target.messageId, scope)
  if (!result || target.sessionId !== chat.selectedSession) return
  closeRestore()
  const files = result.files
  restoreResult.value = files?.degraded
    ? '已达到恢复深度上限：文件保持现状；对话按所选范围处理。'
    : files ? `恢复完成：已恢复 ${files.reverted} 次文件操作，缺失前像跳过 ${files.skippedMissing} 次。` : '对话已恢复，文件保持现状。'
}
const forkSource = computed(() => chat.sessions.find(s => s.id === chat.selectedSession)?.parentSessionKey)

const currentSessionTitle = computed(() => {
  const s = chat.sessions.find((x) => x.id === chat.selectedSession)
  return s?.title || (s ? s.id.slice(0, 8) : '') || ''
})

// 是否有在飞 run（流式 overlay）——发送门控 + 中断按钮 + 执行状态行（story 8 前端面）
const running = conn.running

// 连接/加载横幅 + 错误分类红显（story 10：llm_error/recursion_limit/infra）。
// run.error 横幅独立于连接横幅——run 失败不等于连接失败；进行态装饰随下次 run/切会话剥落。
const connectionState = computed(() => {
  if (connecting.value) return { tone: 'info', label: '正在连接…', detail: '', test: 'connection-banner' }
  if (conn.disconnected.value) return { tone: 'danger', label: '连接已断开', detail: errorMsg.value, test: 'reconnect-bar' }
  if (errorMsg.value) return { tone: 'danger', label: '加载失败', detail: errorMsg.value, test: 'connection-banner' }
  return null
})

// #542：执行状态指示——与上方连接横幅互补，横幅只报连接态（正在连接/断开/加载失败），
// 此行只反映「正在干活」的瞬时态；横幅可见时返回空串整行隐藏，不重复横幅文案。
// story 8：在飞 run 时行内挂「中断」入口（REST POST /abort；50006 无在飞 → toast）。
// #796 story 26：「等待批准」只认 leader 审批——teammate 审批挂起只冻结当事 teammate，leader 面照跑。
const executionStatus = computed(() => {
  if (connectionState.value) return ''
  if (chat.leaderApprovalPending) return '等待批准'
  if (running.value) return '模型正在回答…'
  if (chat.messages.some((m) => m.tools.some((t) => t.state === 'running'))) return '正在执行工具…'
  return '已连接'
})

// #668：JWT 身份解析与 localStorage 安全访问收敛到共享实现（stores/auth.tokenOwner /
// storage.safeLocalStorage），面板三态宽度持久化共用同一套隔离语义。
function draftKey(session = chat.selectedSession): string {
  return `researcher:draft:${tokenOwner(auth.token)}:${session}`
}
watch(() => chat.selectedSession, () => {
  if (chat.selectedSession) chat.setInput(safeLocalStorage()?.getItem(draftKey()) ?? '')
})
watch(() => chat.input, (value) => {
  if (!chat.selectedSession) return
  const storage = safeLocalStorage(); if (!storage) return
  if (value) storage.setItem(draftKey(), value); else storage.removeItem(draftKey())
})

// story 5 标题可改：改名牌（ChatHeader）→ 确认框 → PATCH /sessions/:id。
async function renameSession(): Promise<void> {
  if (!chat.selectedSession) return
  try {
    const { value } = await ElMessageBox.prompt('输入新的会话标题', '重命名会话', {
      type: 'info',
      inputValue: currentSessionTitle.value,
      inputPattern: /\S/,
      inputErrorMessage: '标题不能为空',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    })
    await conn.renameSession(chat.selectedSession, value)
  } catch {
    // 用户取消
  }
}

// #547 / ADR 0014：pending/resolving 请求固定在 composer 上方 ApprovalDock，避免被长回答顶出可视区域。
// resolved/expired 卡不留痕（ADR 0014）——落定即从界面消失，不回时间线。
const activeApprovals = computed(() =>
  conn.chat.visibleApprovals.filter((a) => a.status === 'pending' || a.status === 'resolving'),
)

// #796：teammateId → 具名映射（审批卡徽标具名化——story 26 当事 teammate 卡片态标识）。
const teammateNames = computed(() => Object.fromEntries(conn.chat.teams.map((t) => [t.id, t.name])))

function toggleApprovalDetail(a: { id: string }): void {
  chat.toggleApprovalDetail(a.id)
}

// 删除会话：确认（ElMessageBox）由本壳注入（composable 内不持有 UI）。
// #461：文案明示硬删除不可恢复（删除即硬删，级联删沙箱由服务端负责）。
async function confirmRemoveSession(): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      '确认删除该会话？删除后不可恢复。',
      '删除会话',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    return true
  } catch {
    return false // 用户取消
  }
}

async function removeSession(id: string): Promise<void> {
  const res = await conn.removeSession(id, confirmRemoveSession)
  if (res === true) {
    safeLocalStorage()?.removeItem(draftKey(id))
    ElMessage.success('会话已删除')
  }
  else if (typeof res === 'string') ElMessage.error(res) // #461：失败 → 醒目错误 toast
  // null = 用户取消：无反馈
}

// #795 附件草稿：Blob 直接上传；成功上传的引用缓存用于部分失败后的重试。
const pendingAttachments = ref<PendingAttachment[]>([])
const attachmentBusy = ref(false)
const attachmentStatus = ref('')
let attachKey = 0
let attachmentGeneration = 0
let attachmentUpload: AbortController | undefined
let collecting: Promise<void> = Promise.resolve()

function clearAttachments(): void {
  attachmentGeneration++
  attachmentUpload?.abort()
  attachmentBusy.value = false
  attachmentStatus.value = ''
  for (const item of pendingAttachments.value) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
  pendingAttachments.value = []
}
watch(() => chat.selectedSession, clearAttachments, { flush: 'sync' })
onBeforeUnmount(clearAttachments)

function addFiles(files: File[]): Promise<void> {
  if (attachmentBusy.value) return Promise.resolve()
  const generation = attachmentGeneration
  attachmentBusy.value = true
  collecting = collecting.then(async () => {
    try {
      for (const file of files) {
        if (generation !== attachmentGeneration) return
        const error = validateAttachment(file, pendingAttachments.value.length)
        if (error) { ElMessage.error(`${file.name}：${error}`); continue }
        attachmentStatus.value = `正在处理 ${file.name}`
        try {
          const att = await prepareAttachment(file)
          if (generation !== attachmentGeneration) return
          pendingAttachments.value.push({
            key: ++attachKey, att,
            previewUrl: att.mimeType.startsWith('image/') ? URL.createObjectURL(att.blob) : '',
          })
        } catch (cause) {
          if (generation === attachmentGeneration) ElMessage.error(cause instanceof Error ? cause.message : '附件读取失败')
        }
      }
    } finally {
      if (generation === attachmentGeneration) { attachmentBusy.value = false; attachmentStatus.value = '' }
    }
  })
  return collecting
}

function removeAttachment(key: number): void {
  if (attachmentBusy.value) return
  const item = pendingAttachments.value.find((p) => p.key === key)
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
  pendingAttachments.value = pendingAttachments.value.filter((p) => p.key !== key)
}

async function sendMessage(): Promise<void> {
  if (attachmentBusy.value || running.value) return
  const sessionId = chat.selectedSession
  const generation = attachmentGeneration
  const pending = [...pendingAttachments.value]
  let refs: SentAttachment[] | undefined
  if (pending.length) {
    if (conn.disconnected.value) { ElMessage.error('连接已断开，暂不能发送附件'); return }
    if (!chat.input.trim()) { ElMessage.warning('请填写消息后发送附件'); return }
    if (!sessionId) { ElMessage.error('请先选择会话'); return }
    attachmentBusy.value = true
    attachmentUpload = new AbortController()
    const signal = attachmentUpload.signal
    try {
      refs = []
      for (const [index, item] of pending.entries()) {
        attachmentStatus.value = `正在上传附件 ${index + 1}/${pending.length}：${item.att.fileName}`
        const meta = item.uploaded ?? await uploadSessionAttachment(
          sessionId, item.att.blob, item.att.fileName, item.att.mimeType, signal,
        )
        if (generation !== attachmentGeneration) return
        item.uploaded = meta
        refs.push({ attachmentId: meta.attachmentId, mime: meta.mimeType, size: meta.size, fileName: meta.fileName })
      }
    } catch (cause) {
      if (generation === attachmentGeneration) ElMessage.error(cause instanceof Error ? cause.message : '附件上传失败')
      if (generation === attachmentGeneration) { attachmentBusy.value = false; attachmentStatus.value = '' }
      return
    }
  }
  if (generation !== attachmentGeneration) return
  try {
    if (refs) attachmentStatus.value = '正在发送消息…'
    const accepted = refs
      ? await new Promise<boolean>((resolve) => { if (!conn.send(refs, resolve)) resolve(false) })
      : conn.send()
    if (accepted && generation === attachmentGeneration) clearAttachments()
  } finally {
    if (generation === attachmentGeneration) { attachmentBusy.value = false; attachmentStatus.value = '' }
  }
}

async function regenerate(text: string): Promise<void> {
  if (!text || running.value || conn.disconnected.value) return
  chat.setInput(text)
  await nextTick()
  await sendMessage()
}

onMounted(() => {
  void conn.boot()
})
onBeforeUnmount(() => {
  conn.dispose()
})

defineExpose({
  // #9：暴露的发送统一走 sendMessage（含附件校验/清空预览条），与按钮/Enter 同路径，不分叉。
  send: () => sendMessage(),
  newSession: conn.newSession,
  selectSession: conn.selectSession,
})
</script>

<template>
  <div class="chat">
    <!-- #671：左栏接入三态包装（拖宽/窄条/浮层）；窄屏整体禁用，退回本页原响应式布局。 -->
    <PanelTriState
      :state="sidebarState"
      side="left"
      label="侧栏"
      :disabled="sidebarDisabled"
      :inline-width="sidebarWidth"
      :default-width="SIDEBAR_DEFAULT_WIDTH"
      :popped-vw="sidebarPoppedVw"
      :viewport-width="sidebarViewportWidth"
      @collapse="onSidebarCollapse"
      @pop="onSidebarPop"
      @expand="onSidebarExpand"
      @restore="onSidebarRestore"
      @resize-inline="onSidebarResizeInline"
      @resize-popped="onSidebarResizePopped"
      @drag-end="onSidebarDragEnd"
    >
      <ChatSidebar
        :sessions="chat.sessions"
        :selected-session="chat.selectedSession"
        :sidebar-tab="sidebarTab"
        :tree="fileTabs.tree"
        :tree-error="fileTabs.treeError"
        :active-file-path="fileTabs.activePath ?? ''"
        @select-session="conn.selectSession"
        @remove-session="removeSession"
        @new-session="conn.newSession"
        @switch-tab="switchSidebarTab"
        @open-file="(path: string) => void fileTabs.openFromTree(path)"
      />
    </PanelTriState>
    <main class="main">
      <ChatHeader
        :title="currentSessionTitle"
        :connecting="connecting"
        :renameable="!!chat.selectedSession"
        @rename="renameSession"
      />
      <div v-if="connectionState" class="connection-banner" :class="connectionState.tone" role="status" aria-live="polite" :data-test="connectionState.test">
        <span class="connection-label">{{ connectionState.label }}</span>
        <span v-if="connectionState.detail" class="connection-detail" data-test="error-bar">{{ connectionState.detail }}</span>
        <button v-if="conn.disconnected.value" class="reconnect" data-test="reconnect" @click="conn.reconnect()">重新连接</button>
      </div>
      <!-- story 10 错误分类红显：run.failed 的三分类横幅（进行态装饰——随新 run/切会话剥落） -->
      <div v-if="conn.lastRunError.value" class="connection-banner danger run-error" role="alert" data-test="run-error">
        <span class="connection-label">运行失败（{{ conn.lastRunError.value.kind }}）</span>
        <span class="connection-detail">{{ conn.lastRunError.value.label }}</span>
      </div>
      <div v-if="executionStatus" class="execution-status" role="status" aria-live="polite" data-test="execution-status">
        <span>{{ executionStatus }}</span>
        <button v-if="running" type="button" class="abort" data-test="abort" @click="conn.abort()">中断</button>
      </div>
      <div v-if="forkSource" class="execution-status" data-test="fork-source">
        分叉自 {{ forkSource }} <button v-if="chat.sessions.some(s => s.id === forkSource)" @click="conn.selectSession(forkSource)">查看源会话</button>
      </div>
      <div v-if="restoreResult" class="connection-banner" role="status" data-test="restore-result">{{ restoreResult }}</div>
      <div v-if="restoreLoading" class="execution-status" role="status">正在加载恢复预览…</div>
      <RewindDialog v-if="restoreTarget" :preview="restoreTarget.preview" :busy="restoreBusy" @confirm="confirmRestore" @cancel="closeRestore" />
      <ChatStream
        :rewind-available="historyAvailable && !restoreLoading"
        :fork-available="historyAvailable && !restoreLoading"
        :rewind-preview-required="true"
        @rewind="previewRestore"
        @fork="(msg: Msg) => msg.id && conn.fork(msg.id)"
        :messages="chat.messages"
        :history-has-more="false"
        :history-loading="false"
        @regenerate="regenerate"
        @toggle-trace-fold="chat.toggleTraceFold"
      >
        <!-- #796 teammate 具名折叠区：主时间线（leader 发言与产物）之后的分区容器 -->
        <template #team-folds>
          <TeamFolds
            :teams="chat.teams"
            :approvals="activeApprovals"
            :expanded="chat.teamExpanded"
            @toggle="chat.toggleTeamExpanded"
          />
        </template>
        <!-- #461：无选中会话（含删除当前会话后）→ 空态视图 + 「新建会话」入口 -->
        <template #empty>
          <div v-if="!chat.selectedSession" class="empty-state" data-test="empty-state">
            <p class="empty-title">未选择会话</p>
            <p class="empty-hint">选择一个会话继续对话，或新建会话</p>
            <button
              type="button"
              class="empty-new"
              data-test="empty-new-session"
              :disabled="conn.disconnected.value"
              @click="conn.newSession"
            >＋ 新建会话</button>
          </div>
        </template>
      </ChatStream>
      <ApprovalDock
        :approvals="activeApprovals"
        :disconnected="conn.disconnected.value"
        :teammate-names="teammateNames"
        @resolve="conn.resolveApproval"
        @toggle-detail="toggleApprovalDetail"
      />
      <div v-if="modelStatus" class="model-command-result" data-test="model-command-result" role="status">
        <p>{{ modelStatus }}</p>
        <ul v-if="availableModels?.length">
          <li v-for="m in availableModels" :key="`${m.providerId}/${m.modelId}`"><code>{{ m.providerId }}/{{ m.modelId }}</code></li>
        </ul>
      </div>
      <ChatComposer
        :rewind-busy="restoreBusy"
        :fork-busy="restoreBusy"
        v-model="chat.input"
        :matches="slashMatches"
        :slash-open="slashOpen"
        :slash-index="chat.slashIndex"
        :argument-hint="conn.slashArgumentHint.value"
        :connecting="connecting"
        :streaming="running"
        :disconnected="conn.disconnected.value"
        :pending-attachments="pendingAttachments"
        :attachment-busy="attachmentBusy"
        :attachment-status="attachmentStatus"
        @input="conn.onComposerInput"
        @keydown="conn.onComposerKeydown"
        @send="sendMessage"
        @pick-slash="conn.pickSlash"
        @add-files="addFiles"
        @remove-attachment="removeAttachment"
      >
        <!-- T07 斜杠补全菜单表现（父注入，逻辑留宿主 useChatSession） -->
        <template #slash-menu="{ matches, slashIndex }">
          <div v-if="matches.length" class="slash-menu" id="slash-command-menu" data-test="slash-menu" role="listbox" aria-label="命令补全">
            <div
              v-for="(o, i) in matches"
              :key="o.alias"
              class="slash-item"
              :id="`slash-command-${i}`"
              role="option"
              :aria-selected="i === slashIndex"
              :class="{ sel: i === slashIndex }"
              data-test="slash-item"
              @mousedown.prevent="conn.pickSlash(o.alias)"
            >
              <span class="cmd">{{ o.alias }}</span><span v-if="o.argumentHint" class="args">{{ o.argumentHint }}</span><span class="desc">{{ o.description }}</span>
            </div>
          </div>
        </template>
      </ChatComposer>
    </main>
    <!-- #672：无 tab 时连三态包装一起不渲染（不残留幽灵手柄/浮层入口）；有 tab 时恒以
         inline 起步（呈现态不持久化），拖宽/折叠/弹出由三态包装接管。 -->
    <PanelTriState
      v-if="fileTabs.tabs.length"
      :state="filePanelState"
      side="right"
      label="文件预览"
      :disabled="filePanelDisabled"
      :inline-width="filePanelWidth"
      :default-width="FILE_PANEL_DEFAULT_WIDTH"
      :popped-vw="filePanelPoppedVw"
      :viewport-width="filePanelViewportWidth"
      @collapse="onFilePanelCollapse"
      @pop="onFilePanelPop"
      @expand="onFilePanelExpand"
      @restore="onFilePanelRestore"
      @resize-inline="onFilePanelResizeInline"
      @resize-popped="onFilePanelResizePopped"
      @drag-end="onFilePanelDragEnd"
    >
      <FileTabsPanel
        :tabs="fileTabs.tabs"
        :active-path="fileTabs.activePath"
        @activate="activateTab"
        @close="fileTabs.closeTab"
        @close-all="fileTabs.closeAll"
        @retry="fileTabs.retry"
      />
    </PanelTriState>
  </div>
</template>

<style scoped>
.chat { display: flex; height: 100%; min-height: 0; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
/* 原 .file-panel 固定宽（360px）已移除：宽度由 PanelTriState 三态接管，避免双重定宽。 */
.connection-banner { display: flex; align-items: center; gap: 10px; padding: 8px 18px; font-size: 13px; }
.connection-banner.info { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.connection-banner.danger { color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
.connection-label { font-weight: 600; }
.connection-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.connection-banner .reconnect { margin-left: auto; background: transparent; border: 1px solid currentColor; border-radius: 6px; padding: 2px 10px; cursor: pointer; color: inherit; font-size: 12.5px; }
.execution-status { display: flex; align-items: center; gap: 10px; padding: 5px 18px; border-bottom: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 12px; }
.execution-status .abort { margin-left: auto; background: transparent; border: 1px solid var(--el-color-danger); color: var(--el-color-danger); border-radius: 6px; padding: 2px 10px; cursor: pointer; font-size: 12px; }
.execution-status .abort:hover { background: var(--el-color-danger-light-9); }

/* T07 斜杠补全菜单（spec §9.4 / 原型 oc-chat-page.html）：弹在输入框上方，cmd mono + 描述 */
.slash-menu { position: absolute; bottom: calc(100% + 6px); left: 18px; right: 18px; max-height: 280px; overflow-y: auto; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color); border-radius: 11px; box-shadow: 0 -8px 30px rgba(0, 0, 0, .18); z-index: 10; }
.slash-item { display: flex; align-items: center; gap: 10px; padding: 9px 14px; cursor: pointer; }
.slash-item.sel, .slash-item:hover { background: var(--el-fill-color); }
.slash-item .cmd { font-family: ui-monospace, monospace; color: var(--el-color-primary); font-size: 13px; }
.model-command-result { padding: 8px 18px; font-size: 13px; max-height: 180px; overflow-y: auto; background: var(--el-fill-color-light); }
.model-command-result p { margin: 0; }
.model-command-result ul { margin: 6px 0 0; }
.slash-item .args { font-size: 12px; color: var(--el-text-color-secondary); }
.slash-item .desc { margin-left: auto; color: var(--el-text-color-secondary); font-size: 12px; }
@media (max-width: 720px) {
  .chat { flex: 1; min-height: 0; flex-direction: column; }
  /* #671 / #672：窄屏三态整体禁用，两侧面板退回「整列常驻块」——覆盖包装的默认宽度与贴边竖边框
     （原 .side 上的同款规则上移到包装），横向堆叠改纵向分区。 */
  .chat :deep(.panel.plain) { width: auto; border-right: 0; border-bottom: 1px solid var(--el-border-color); }
  .chat :deep(.side) { max-height: 34vh; }
  .chat :deep(.stream) { padding: 12px; }
  .chat :deep(.composer) { padding: 10px 12px; }
  .chat :deep(.msg), .chat :deep(.approval) { min-width: 0; max-width: 100%; box-sizing: border-box; }
}

/* #461：无选中会话空态视图（删除当前会话后停留空聊天区）——居中提示 + 新建会话入口 */
.empty-state { margin: auto; text-align: center; color: var(--el-text-color-secondary); }
.empty-title { margin: 0 0 6px; font-size: 14px; }
.empty-hint { margin: 0 0 12px; font-size: 12.5px; }
.empty-new { background: transparent; border: 1px dashed var(--el-border-color); border-radius: 7px; padding: 6px 16px; cursor: pointer; color: var(--el-text-color-secondary); font-size: 13px; }
.empty-new:disabled { cursor: default; opacity: .6; }
</style>
