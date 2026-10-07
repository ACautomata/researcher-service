// useChatSession —— 会话编排 composable（#730 §4.1 拆三件之三，useChatConnection 编排位的继任）。
// 职责：会话列表/切换/新建/改名/删除 + 发送（幂等 + 乐观回显 + 门控）+ 中断 + 审批回覆 +
// 断线补偿（restOutbox 注入 + 投影重拉）+ slash 系统命令 + composer 键位。
// **不含**投影逻辑（chat/projection.ts 归约器管）与连接逻辑（useEventStream.ts 管）。
//
// 数据流（单管线渲染 #730 §1）：
//   SSE 事件（当前会话）→ applyEvent 增量归约 → chat.setMessages；
//   终态/投影变化/重连/gap → GET /messages → fromProjection 整替（投影重拉完成即权威）；
//   run.failed 错误分类 = 编排层叠加态（lastRunError → 红显横幅），不进归约器——投影行不含
//   失败信息（server TurnReducer 不落 run.*），刷新回放自然剥落，两入口零差异不被污染。
// 历史分页：#730 §4.1 提及「分页」，但 #778 服务端投影 GET /messages 无分页参数（全量返回）——
// 旧网关锚点分页随协议机退役，ChatStream 分页 props 传常量 false（骨架保留，服务端分页面就绪后接线）。
import { computed, ref, watch, type Ref } from 'vue'
import { ApiError } from '@/api/client'
import {
  abortSession,
  forkSession as forkSessionApi,
  rewindSession as rewindSessionApi,
  type RewindScope,
  type RewindResult,
  createSession,
  deleteSession,
  getSessionProjection,
  listSessions,
  renameSession as renameSessionApi,
  resolveSessionApproval,
  sendSessionMessage,
  type MediaRef,
  type SessionSummary,
  type SystemCommandResult,
} from '@/api/sessions'
import { approvalCardFields, useChatStore, type ApprovalItem } from '@/stores/chat'
import { useFileTabsStore } from '@/stores/fileTabs'
import { applyEvent, coerceJsonish, fromProjection } from './projection'
import { createRestOutbox, newClientKey, type RestOutbox } from './restOutbox'
import { useEventStream, type EventStream, type SessionEvent } from './useEventStream'

import { listPlugins, getPluginArgumentCompletions } from '@/api/plugins'
import { mergeSlashCommands, type SlashOption } from './slashCommands'
export { SYSTEM_COMMANDS, type SlashOption } from './slashCommands'

// 错误分类红显（story 10：llm_error/recursion_limit/infra 三分类）。
const RUN_ERROR_LABELS: Record<string, string> = {
  llm_error: '模型请求失败',
  recursion_limit: '运行步数达到上限',
  infra: '运行环境异常',
}
export interface RunError { kind: string; label: string }

export interface ChatSessionDeps {
  /** 动作类失败（用户主动发起的发送/中断/审批/删除）→ 瞬时 toast，不进顶部横幅 */
  onActionError?(message: string): void
  /** 加载失败（投影/列表拉取）→ 顶部横幅 detail */
  onError?(message: string): void
  onClearError?(): void
  /** composer Enter 统一发送入口（宿主接线附件校验后调 send） */
  onSend?(): void
  /** 系统命令结果（/new → 宿主导航新会话；/model → 宿主提示） */
  onCommand?(command: SystemCommandResult): void
}

// 发送附件引用（ChatView 先经 POST /sessions/:id/attachments 上传，把 AttachmentMeta 映射为
// MediaRef 形态传入——乐观回显与 attachmentIds 同源）。
export type SentAttachment = MediaRef

export interface ChatSession {
  chat: ReturnType<typeof useChatStore>
  connecting: Ref<boolean>
  disconnected: Ref<boolean>
  /** 在飞 run 存在（流式 overlay 可见）——发送门控 + 中断按钮 + 执行状态行 */
  running: Ref<boolean>
  /** 最近一次 run.failed 的分类（红显横幅；新 run/切会话清除） */
  lastRunError: Ref<RunError | null>
  historyBusy: Ref<boolean>
  historyAvailable: Ref<boolean>
  rewind(messageId: string, scope: RewindScope): Promise<RewindResult | null>
  fork(messageId: string): Promise<void>
  reconnect(): void
  boot(): Promise<void>
  selectSession(id: string): void
  newSession(): Promise<SessionSummary | null>
  renameSession(id: string, title: string): Promise<void>
  removeSession(id: string, confirm: () => Promise<boolean>): Promise<true | string | null>
  /** 发送（含乐观回显/幂等/断线排队）；attachments 为已上传附件引用。返回是否受理 */
  send(attachments?: SentAttachment[], onSettled?: (accepted: boolean) => void): boolean
  abort(): Promise<void>
  resolveApproval(a: ApprovalItem, decision: 'allow' | 'deny'): Promise<void>
  slashQuery: Ref<string | null>
  slashMatches: Ref<SlashOption[]>
  slashOpen: Ref<boolean>
  slashArgumentHint: Ref<string | null>
  pickSlash(alias: string): void
  onComposerInput(): void
  onComposerKeydown(e: KeyboardEvent): void
  dispose(): void
}

export function useChatSession(deps: ChatSessionDeps = {}): ChatSession {
  const chat = useChatStore()
  const fileTabs = useFileTabsStore()
  const outbox: RestOutbox = createRestOutbox()

  const connecting = ref(false)
  const disconnected = ref(false)
  const lastRunError = ref<RunError | null>(null)
  let disposed = false
  const historyBusy = ref(false)
  const historyAvailable = computed(() => Boolean(chat.selectedSession) && !connecting.value && !disconnected.value && !running.value && !historyBusy.value && chat.approvals.length === 0)

  async function rewind(messageId: string, scope: RewindScope): Promise<RewindResult | null> {
    if (!historyAvailable.value) return null
    const id = chat.selectedSession
    historyBusy.value = true
    try {
      const result = await rewindSessionApi(id, messageId, scope)
      if (!disposed && chat.selectedSession === id) {
        pendingToolInputs.clear()
        fileTabs.reset()
        lastRunError.value = null
        await refreshProjection()
      }
      return result
    } catch (e) {
      deps.onActionError?.(e instanceof Error ? e.message : '回退失败')
      return null
    } finally { historyBusy.value = false }
  }

  async function fork(messageId: string): Promise<void> {
    if (!historyAvailable.value) return
    const id = chat.selectedSession
    historyBusy.value = true
    try {
      const result = await forkSessionApi(id, messageId)
      if (disposed) return
      chat.prependSession(result.session)
      if (chat.selectedSession === id) selectSession(result.session.id)
    } catch (e) {
      deps.onActionError?.(e instanceof Error ? e.message : '分叉失败')
    } finally { historyBusy.value = false }
  }


  const running = computed(() => chat.messages.some((m) => m.role === 'assistant' && m.streaming))

  // ---- 投影重拉（权威读模型整替；gen 守卫丢弃迟到响应）----
  let projectionGen = 0
  async function refreshProjection(): Promise<void> {
    const id = chat.selectedSession
    if (!id || disposed) return
    const gen = ++projectionGen
    try {
      const p = await getSessionProjection(id)
      if (disposed || chat.selectedSession !== id || gen !== projectionGen) return
      chat.setMessages(fromProjection(p))
      chat.setApprovalsFromProjection(p.approvals)
      deps.onClearError?.()
    } catch (e) {
      if (disposed || chat.selectedSession !== id || gen !== projectionGen) return
      deps.onError?.(e instanceof Error ? e.message : '加载失败')
    }
  }

  // ---- 会话列表 ----
  async function refreshSessions(): Promise<void> {
    const sessions = await listSessions()
    if (disposed) return
    chat.setSessions(sessions)
  }

  // ---- 断线补偿（#726/#779 story 12）：待发注入 + 投影重拉 ----
  async function tryFlush(): Promise<void> {
    const id = chat.selectedSession
    if (!id || disposed || disconnected.value || running.value || historyBusy.value) return
    // interrupted（审批挂起）禁新输入（50003 预检）——排队条目等审批解除后的下次补偿。
    if (chat.approvals.some((a) => a.status === 'pending' || a.status === 'resolving')) return
    if (outbox.pending(id).length === 0) return
    try {
      await outbox.flush(id, async (sid, entry) => {
        const result = await (entry.attachments?.length
          ? sendSessionMessage(sid, entry.content, entry.clientKey, entry.attachments.map((media) => media.attachmentId))
          : sendSessionMessage(sid, entry.content, entry.clientKey))
        if (!disposed && chat.selectedSession === sid && result.command) deps.onCommand?.(result.command)
      })
    } catch {
      return // 网络/门控拒绝 → 保序停止，条目保留，下次补偿续传
    }
    if (!disposed && chat.selectedSession === id) await refreshProjection()
  }

  async function compensate(): Promise<void> {
    void refreshSlashCommands()
    deps.onClearError?.()
    try {
      await refreshSessions()
    } catch {
      // 列表失败不阻断投影重拉
    }
    // 无选中（首连先于 boot / 删除当前会话后重连）→ 自愈选中最近会话（selectSession 自带首次拉取）
    let autoSelected = false
    if (!disposed && !chat.selectedSession && chat.sessions.length) {
      selectSession(chat.sessions[0].id)
      autoSelected = true
    }
    await tryFlush()
    if (!autoSelected && !disposed && chat.selectedSession) await refreshProjection()
  }

  // ---- SSE（传输面）----
  const stream: EventStream = useEventStream({
    onEvent,
    onOpen: () => {
      void compensate()
    },
    onDisconnect: () => {},
    onGap: () => {
      void refreshProjection() // 丢帧只检测不重放 → 投影重拉补偿
    },
  })
  watch(stream.status, (s) => {
    connecting.value = s === 'connecting'
    disconnected.value = s === 'disconnected' || s === 'closed'
  })

  // ---- SSE 事件分派（业务面）----
  function onEvent(e: SessionEvent): void {
    if (e.type === 'session.created') {
      const s = readSummary(e.payload.session)
      if (s) chat.upsertSession(s)
      return
    }
    if (e.type === 'session.updated') {
      const s = readSummary(e.payload.session)
      if (s) {
        chat.upsertSession(s)
        return
      }
      if (e.payload.projectionChanged === true && e.sessionId === chat.selectedSession) {
        void refreshProjection()
      }
      return
    }
    if (e.type === 'session.invalidated') {
      if (e.sessionId === chat.selectedSession) { fileTabs.reset(); void refreshProjection() } // 他端 rewind 同步对话与文件
      return
    }
    // session.* / stream 生命周期之外的事件都带 sessionId——非当前会话忽略（选中时投影自见）。
    if (e.sessionId !== chat.selectedSession) return

    if (e.type === 'run.started' || e.type === 'run.resumed') {
      lastRunError.value = null
      chat.setMessages(applyEvent(chat.messages, e))
      return
    }
    if (e.type === 'text.delta' || e.type === 'thinking.delta' || e.type === 'attachment') {
      chat.setMessages(applyEvent(chat.messages, e))
      return
    }
    if (e.type === 'tool.start' || e.type === 'tool.end' || e.type === 'figure_run.progress') {
      chat.setMessages(applyEvent(chat.messages, e))
      if (e.type !== 'figure_run.progress') bridgeFileTabs(e)
      return
    }
    if (e.type === 'approval.requested') {
      const card = approvalCardFromPayload(e)
      if (card) chat.addApproval(card)
      return
    }
    if (e.type === 'approval.resolved') {
      const id = typeof e.payload.escalationId === 'string' ? e.payload.escalationId : ''
      if (id) chat.removeApproval(id) // ADR 0014：落定即从界面消失，不留痕
      return
    }
    if (e.type === 'run.failed') {
      const kind = typeof e.payload.errorKind === 'string' ? e.payload.errorKind : ''
      lastRunError.value = { kind, label: RUN_ERROR_LABELS[kind] ?? '运行失败' }
      pendingToolInputs.clear()
      void refreshProjection()
      return
    }
    if (e.type === 'run.completed' || e.type === 'run.aborted' || e.type === 'run.suspended') {
      lastRunError.value = null
      pendingToolInputs.clear()
      void refreshProjection().then(() => tryFlush()) // 终态后补偿注入排队消息
    }
  }

  // ---- 文件 tab 桥（#793 story 61：写类工具自动弹 lab tab）----
  // tool.end 无 input（server 事件目录）——tool.start 时记 input，end 时查回（run 终态清表）。
  const pendingToolInputs = new Map<string, { name: string; input: unknown }>()
  function bridgeFileTabs(e: SessionEvent): void {
    if (disposed || e.sessionId !== chat.selectedSession) return
    const toolCallId = typeof e.payload.toolCallId === 'string' ? e.payload.toolCallId : ''
    if (!toolCallId) return
    if (e.type === 'tool.start') {
      const name = typeof e.payload.name === 'string' ? e.payload.name : ''
      const input = coerceJsonish(typeof e.payload.input === 'string' ? e.payload.input : '')
      pendingToolInputs.set(toolCallId, { name, input })
      if (name) fileTabs.onToolEvent({ name, state: 'running', input, result: null })
      return
    }
    const started = pendingToolInputs.get(toolCallId)
    pendingToolInputs.delete(toolCallId)
    if (!started) return
    const state = e.payload.state === 'success' ? 'done' : 'error'
    fileTabs.onToolEvent({ name: started.name, state, input: started.input, result: coerceJsonish(typeof e.payload.details === 'string' ? e.payload.details : '') })
  }

  // ---- 审批卡（形状构造单一来源在 stores/chat.approvalCardFields）----
  function approvalCardFromPayload(e: SessionEvent): ReturnType<typeof approvalCardFields> {
    return approvalCardFields(e.payload.escalation, e.teammateId)
  }

  async function resolveApproval(a: ApprovalItem, decision: 'allow' | 'deny'): Promise<void> {
    const id = chat.selectedSession
    if (!id || disconnected.value) return
    chat.markApproval(a.id, 'resolving')
    try {
      await resolveSessionApproval(id, a.id, decision)
      chat.removeApproval(a.id) // resolved 卡不留痕（ADR 0014）；SSE resolved 事件幂等
    } catch (e) {
      if (e instanceof ApiError && e.code === 50004) {
        chat.removeApproval(a.id) // 已失效/他端已处理 → 终态不可回覆
        deps.onActionError?.('该审批已失效')
        return
      }
      chat.markApproval(a.id, 'pending') // 可重试
      deps.onActionError?.(e instanceof Error ? e.message : '审批回覆失败')
    }
  }

  // ---- 会话管理 ----
  function readSummary(v: unknown): SessionSummary | null {
    if (!v || typeof v !== 'object') return null
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id) return null
    return {
      id: r.id,
      title: typeof r.title === 'string' ? r.title : '',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
      ...(typeof r.parentSessionKey === 'string' ? { parentSessionKey: r.parentSessionKey } : {}),
    }
  }

  function selectSession(id: string): void {
    if (chat.selectedSession === id) return
    projectionGen++ // 旧会话迟到响应作废
    lastRunError.value = null
    pendingToolInputs.clear()
    chat.resetForSession()
    chat.setSelectedSession(id)
    fileTabs.reset() // lab 随会话生灭：切会话即换树（#730 §4.7 生命周期差异）
    if (id) {
      void refreshProjection()
      void tryFlush() // 本会话断线期排队消息（连接正常时立即注入）
    }
  }

  async function boot(): Promise<void> {
    void refreshSlashCommands()
    try {
      await refreshSessions()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return // 刷新链已跳登录
      deps.onError?.(e instanceof Error ? e.message : '加载失败')
      return
    }
    if (!chat.selectedSession && chat.sessions.length) selectSession(chat.sessions[0].id)
  }

  async function newSession(): Promise<SessionSummary | null> {
    try {
      const s = await createSession()
      if (disposed) return null
      chat.prependSession(s)
      selectSession(s.id)
      return s
    } catch (e) {
      deps.onActionError?.(e instanceof Error ? e.message : '创建会话失败')
      return null
    }
  }

  async function renameSession(id: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      const s = await renameSessionApi(id, trimmed.slice(0, 200))
      chat.upsertSession(s)
    } catch (e) {
      deps.onActionError?.(e instanceof Error ? e.message : '改名失败')
    }
  }

  async function removeSession(id: string, confirm: () => Promise<boolean>): Promise<true | string | null> {
    if (disconnected.value) return '连接已断开，无法删除'
    if (!(await confirm())) return null // 用户取消
    try {
      await deleteSession(id)
    } catch (e) {
      return e instanceof Error ? e.message : '删除失败'
    }
    chat.removeSession(id)
    if (chat.selectedSession === id) {
      projectionGen++
      chat.resetForSession()
      chat.setSelectedSession('')
      fileTabs.reset()
      lastRunError.value = null
    }
    return true
  }

  // ---- 发送（幂等 + 乐观回显 + 门控 + 断线排队）----
  function send(attachments?: SentAttachment[], onSettled?: (accepted: boolean) => void): boolean {
    const content = chat.input.trim()
    if (!content) return false
    const id = chat.selectedSession
    if (!id || connecting.value || running.value || historyBusy.value) return false
    // interrupted（审批挂起）禁新输入（50003 预检）
    if (chat.approvals.some((a) => a.status === 'pending' || a.status === 'resolving')) return false
    if (disconnected.value) {
      // 断线排队（#779 story 12）：附件不排队（上传面依赖在线 REST）——有附件时拒发保真
      if (attachments?.length) {
        deps.onActionError?.('连接已断开，暂不能发送附件')
        return false
      }
      outbox.enqueue(id, content)
      pushOptimistic(content, undefined, undefined)
      chat.setInput('')
      return true
    }
    const key = newClientKey()
    pushOptimistic(content, key, attachments)
    chat.setInput('')
    void dispatchSend(id, content, key, attachments).then((accepted) => onSettled?.(accepted))
    return true
  }

  function pushOptimistic(content: string, key: string | undefined, attachments: SentAttachment[] | undefined): void {
    chat.pushMessage({
      role: 'user',
      raw: content,
      text: content,
      thinking: '',
      thinkingOpen: false,
      streaming: false,
      tools: [],
      media: attachments ? [...attachments] : [],
      ...(key ? { sendKey: key } : {}),
    })
  }

  async function dispatchSend(id: string, content: string, key: string, attachments: SentAttachment[] | undefined): Promise<boolean> {
    try {
      const result = await sendSessionMessage(id, content, key, attachments?.map((a) => a.attachmentId))
      if (disposed || chat.selectedSession !== id) return true
      if (result.command) deps.onCommand?.(result.command)
      if (result.replay) {
        void refreshProjection() // 重发 replay：以权威行回填（乐观行随整替消失）
        return true
      }
      chat.markMessageId(key, result.messageId)
      return true
    } catch (e) {
      if (disposed) return false
      chat.removeMessage(key)
      const restoreDraft = () => {
        if (chat.selectedSession === id && chat.input === '') chat.setInput(content)
      }
      if (e instanceof ApiError && (e.code === 50005 || e.code === 50003)) {
        deps.onActionError?.('已有任务在进行中') // 多端门禁：另一端先发了
        void refreshProjection()
        restoreDraft()
        return false
      }
      if (e instanceof ApiError && e.code === 40043) {
        deps.onActionError?.('并发配额已满，请稍后再试')
        restoreDraft()
        return false
      }
      if (e instanceof ApiError && e.code === 50007) {
        deps.onActionError?.('发送冲突（幂等键已用于不同内容），请刷新后重试')
        restoreDraft()
        return false
      }
      // 网络/未知故障：消息可能已到达（幂等键保不重复）→ 入待发，重连后按序注入（replay 幂等）
      outbox.enqueue(id, content, { clientKey: key, attachments })
      if (chat.selectedSession === id) pushOptimistic(content, key, attachments)
      deps.onActionError?.('已加入待发，重连后自动发送')
      return true
    }
  }

  // ---- 中断（story 8）----
  async function abort(): Promise<void> {
    const id = chat.selectedSession
    if (!id || disconnected.value) return
    try {
      await abortSession(id)
    } catch (e) {
      if (e instanceof ApiError && e.code === 50006) {
        deps.onActionError?.('没有可中断的运行')
        return
      }
      deps.onActionError?.(e instanceof Error ? e.message : '中断失败')
    }
    // run.aborted 事件 → 终态 → 投影重拉
  }

  // ---- slash 系统命令 + composer 键位（T07 逻辑保留，数据源换前端常量）----
  const slashCommands = ref<SlashOption[]>(mergeSlashCommands([]))
  let slashCatalogGen = 0
  async function refreshSlashCommands(): Promise<void> {
    const gen = ++slashCatalogGen
    try {
      const plugins = await listPlugins()
      if (!disposed && gen === slashCatalogGen) slashCommands.value = mergeSlashCommands(plugins)
    } catch {
      if (disposed || gen !== slashCatalogGen) return
      slashCommands.value = mergeSlashCommands([])
      deps.onActionError?.('插件命令加载失败；重新输入 / 可重试')
    }
  }
  const slashArgumentHint = computed<string | null>(() => {
    const alias = /^\/([a-z][a-z0-9-]*)\s/i.exec(chat.input)?.[1]?.toLowerCase()
    return slashCommands.value.find(c => c.alias === `/${alias}`)?.argumentHint ?? null
  })
  const slashQuery = computed<string | null>(() => {
    const v = chat.input
    if (!v.startsWith('/') || /\s/.test(v)) return null
    return v.slice(1).toLowerCase()
  })
  const argumentMatches = ref<SlashOption[]>([])
  let argumentTimer: ReturnType<typeof setTimeout> | undefined
  let argumentGen = 0
  const argumentQuery = computed(() => {
    if (chat.slashDismissed) return null
    const match = /^\/([a-z][a-z0-9-]*)\s+([\s\S]*)$/.exec(chat.input)
    if (!match || match[2].length > 1000) return null
    const pluginId = slashCommands.value.find(c => c.alias === `/${match[1]}`)?.pluginId
    return pluginId ? { pluginId, name: match[1], prefix: match[2] } : null
  })
  watch(argumentQuery, (query) => {
    const gen = ++argumentGen
    clearTimeout(argumentTimer)
    argumentMatches.value = []
    if (!query || disposed) return
    argumentTimer = setTimeout(async () => {
      try {
        const items = await getPluginArgumentCompletions(query.pluginId, query.name, query.prefix)
        if (disposed || gen !== argumentGen) return
        argumentMatches.value = items.map(item => ({ alias: `/${query.name} ${item.value}`, description: item.description ?? '' }))
      } catch {
        if (!disposed && gen === argumentGen) deps.onActionError?.('命令参数补全加载失败，请重新输入参数重试')
      }
    }, 250)
  })
  const slashMatches = computed<SlashOption[]>(() => {
    const q = slashQuery.value
    if (q === null) return argumentMatches.value
    return slashCommands.value.filter((c) => c.alias.slice(1).toLowerCase().startsWith(q))
  })
  watch(slashMatches, (matches) => {
    if (chat.slashIndex >= matches.length) chat.setSlashIndex(0)
  })
  const slashOpen = computed(
    () => !chat.slashDismissed && slashMatches.value.length > 0,
  )
  function pickSlash(alias: string): void {
    chat.setInput(`${alias} `)
    chat.setSlashDismissed(true)
  }
  let promptHistoryIndex = -1
  let promptDraft = ''
  function onComposerInput(): void {
    promptHistoryIndex = -1
    promptDraft = ''
    chat.setSlashDismissed(false)
    if (slashQuery.value === '') void refreshSlashCommands()
    chat.setSlashIndex(0)
  }
  function triggerSend(): void {
    deps.onSend?.()
  }
  function onComposerKeydown(e: KeyboardEvent): void {
    // IME 确认候选词的 Enter 不当发送/选令牌（isComposing 标准信号 + keyCode 229 兼容）
    if (e.isComposing || e.keyCode === 229) return
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
    if (slashOpen.value) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        chat.setSlashIndex((chat.slashIndex + 1) % slashMatches.value.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        chat.setSlashIndex((chat.slashIndex - 1 + slashMatches.value.length) % slashMatches.value.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const m = slashMatches.value[chat.slashIndex]
        if (m) pickSlash(m.alias)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        chat.setSlashDismissed(true)
      }
      return
    }
    // #524：空输入框 ↑ 浏览历史输入，↓ 返回草稿
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const prompts = chat.messages.filter((m) => m.role === 'user').map((m) => m.text).filter(Boolean)
      if (prompts.length && (chat.input === '' || promptHistoryIndex >= 0)) {
        e.preventDefault()
        if (promptHistoryIndex < 0) promptDraft = chat.input
        promptHistoryIndex = e.key === 'ArrowUp'
          ? Math.min(promptHistoryIndex + 1, prompts.length - 1)
          : promptHistoryIndex - 1
        chat.setInput(promptHistoryIndex < 0 ? promptDraft : prompts[prompts.length - 1 - promptHistoryIndex])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      triggerSend()
    }
  }

  function reconnect(): void {
    // SSE 断线由 EventSource 原生重连 + 401 探测兜底；本入口供手动补偿（重拉 + 注入待发）。
    void compensate()
  }

  function dispose(): void {
    disposed = true
    argumentGen++
    clearTimeout(argumentTimer)
    argumentMatches.value = []
    pendingToolInputs.clear()
    stream.close()
  }

  return {
    chat,
    connecting,
    disconnected,
    running,
    lastRunError,
    historyBusy,
    historyAvailable,
    rewind,
    fork,
    reconnect,
    boot,
    selectSession,
    newSession,
    renameSession,
    removeSession,
    send,
    abort,
    resolveApproval,
    slashQuery,
    slashMatches,
    slashOpen,
    slashArgumentHint,
    pickSlash,
    onComposerInput,
    onComposerKeydown,
    dispose,
  }
}

// ---- 局部小工具 ----
