// seam: useChatSession 会话编排 composable（#730 §4.1 拆三件之三 / #793 验收「会话列表/中断/
// 错误分类/标题 UI 接通真实 REST+SSE」）。api/sessions 全 mock（信封解包由 client 单测覆盖），
// EventSource stub 全局（贴 ChatView.test.ts 同款工具），restOutbox 走真 sessionStorage
// （vitest.setup MemoryStorage）——重点验证编排逻辑：幂等发送/门控/断线补偿/事件分派/审批/系统命令。
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatSession } from './useChatSession'

vi.mock('@/api/sessions', () => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getSessionProjection: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  abortSession: vi.fn(),
  resolveSessionApproval: vi.fn(),
  uploadSessionAttachment: vi.fn(),
}))

vi.mock('@/api/plugins', () => ({ listPlugins: vi.fn(), getPluginArgumentCompletions: vi.fn() }))
import { listPlugins, getPluginArgumentCompletions } from '@/api/plugins'
import * as api from '@/api/sessions'
import { ApiError } from '@/api/client'

class FakeEventSource extends EventTarget {
  // IDL 静态常量（真 EventSource 接口面）：useEventStream 以 EventSource.CLOSED 判连接终态
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []
  static last(): FakeEventSource | undefined {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]
  }
  url: string
  readyState = 1
  closed = false
  onerror: ((e: Event) => void) | null = null
  constructor(url: string) {
    super()
    this.url = url
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.closed = true
    this.readyState = 2
  }
  emit(type: string, event: Record<string, unknown>, lastEventId?: string): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(event), lastEventId }))
  }
  // 真 EventSource 的 onerror 是 IDL handler——显式调用以建模 error 事件
  fail(): void {
    this.onerror?.(new Event('error'))
  }
}

const S1 = { id: 'sess-1', title: '文献综述', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' }
const S2 = { id: 'sess-2', title: '实验记录', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' }

const projectionOf = (over: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1', title: '文献综述',
  messages: [
    { id: 'm1', turn: 1, role: 'user', content: '旧问题', anchorCheckpointId: null, createdAt: '2026-10-06T00:00:00Z' },
    { id: 'm2', turn: 2, role: 'assistant', content: '旧回答', anchorCheckpointId: 'ck-1', createdAt: '2026-10-06T00:00:01Z' },
  ],
  ...over,
})

const opened = () => FakeEventSource.last()!.emit('stream.opened', { type: 'stream.opened', payload: { protocolV: 1, serverSeq: 0, serverTime: '' } })

const actionsErr = vi.fn()
const loadErr = vi.fn()
const commandSpy = vi.fn()

async function mounted() {
  const conn = useChatSession({ onActionError: actionsErr, onError: loadErr, onCommand: commandSpy })
  opened()
  await flushPromises()
  return conn
}

beforeEach(() => {
  setActivePinia(createPinia())
  FakeEventSource.instances = []
  sessionStorage.clear()
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.clearAllMocks()
  vi.mocked(listPlugins).mockResolvedValue([])
  vi.mocked(api.listSessions).mockResolvedValue([S1, S2])
  vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf())
  vi.mocked(api.sendSessionMessage).mockResolvedValue({ messageId: 'm9', turn: 3, runId: 'r1', replay: false })
  vi.mocked(api.renameSession).mockResolvedValue(S1)
  actionsErr.mockClear()
  loadErr.mockClear()
  commandSpy.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('boot / 会话列表', () => {
  it('SSE 开流补偿：拉列表 + 选中最近会话 + 拉投影 → messages 为 fromProjection 产物', async () => {
    const conn = await mounted()
    const chat = conn.chat
    expect(chat.sessions.map((s) => s.id)).toEqual(['sess-1', 'sess-2'])
    expect(chat.selectedSession).toBe('sess-1')
    expect(chat.messages.map((m) => m.text)).toEqual(['旧问题', '旧回答'])
    expect(chat.messages[1].id).toBe('m2')
  })

  it('boot：未开流时显式调用同样建列表 + 自动选中', async () => {
    const conn = useChatSession({})
    await conn.boot()
    await flushPromises()
    expect(conn.chat.selectedSession).toBe('sess-1')
    expect(conn.chat.messages).toHaveLength(2)
  })

  it('selectSession：切会话清态重拉 + lab 文件树重置；迟到旧投影丢弃', async () => {
    const conn = await mounted()
    vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf({ sessionId: 'sess-2', title: '实验记录', messages: [] }))
    conn.selectSession('sess-2')
    await flushPromises()
    expect(conn.chat.selectedSession).toBe('sess-2')
    expect(conn.chat.messages).toHaveLength(0)
  })
})

describe('发送（幂等 + 乐观回显 + 门控）', () => {
  it('#795 响应丢失后用同一 key 和附件引用重试，不降为纯文本', async () => {
    const conn = await mounted()
    const attachment = { attachmentId: '123', mime: 'application/pdf', size: 12, fileName: 'paper.pdf' }
    vi.mocked(api.sendSessionMessage).mockRejectedValueOnce(new TypeError('response lost'))
    conn.chat.setInput('分析附件')
    expect(conn.send([attachment])).toBe(true)
    await flushPromises()
    const firstKey = vi.mocked(api.sendSessionMessage).mock.calls[0]![2]
    const pending = JSON.parse(sessionStorage.getItem('chat.restOutbox.v1')!).sessions['sess-1'][0]
    expect(pending.clientKey).toBe(firstKey)
    expect(pending.attachments).toEqual([attachment])
    expect(conn.chat.messages.at(-1)?.media).toEqual([attachment])
    opened(); await flushPromises()
    expect(api.sendSessionMessage).toHaveBeenLastCalledWith('sess-1', '分析附件', firstKey, ['123'])
    conn.dispose()
  })

  it('happy path：乐观 user 行 → POST 带 32-hex 幂等键 → messageId 回填 → 清输入', async () => {
    const conn = await mounted()
    conn.chat.setInput('新问题')
    expect(conn.send()).toBe(true)
    const chat = conn.chat
    expect(chat.messages.at(-1)).toMatchObject({ role: 'user', text: '新问题', sendKey: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect(chat.input).toBe('')
    await flushPromises()
    expect(api.sendSessionMessage).toHaveBeenCalledWith('sess-1', '新问题', expect.stringMatching(/^[0-9a-f]{32}$/), undefined)
    expect(chat.messages.at(-1)).toMatchObject({ role: 'user', text: '新问题', id: 'm9' })
  })

  it('门控：无会话 / connecting / 在飞 run / 审批挂起 → false 不发', async () => {
    const conn = await mounted()
    conn.chat.setInput('x')
    // 在飞 run：run.started 造 overlay
    FakeEventSource.last()!.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r1', payload: {} })
    await flushPromises()
    expect(conn.running.value).toBe(true)
    expect(conn.send()).toBe(false)
    // 审批挂起（先终态清 overlay）
    FakeEventSource.last()!.emit('run.completed', { type: 'run.completed', sessionId: 'sess-1', runId: 'r1', payload: {} })
    await flushPromises()
    conn.chat.addApproval({ id: 'e1', source: 'judge-limit', toolName: 'bash', toolCallSummary: 'x', teammateId: null })
    expect(conn.send()).toBe(false)
  })

  it('replay：response.replay → 乐观行不追加 id、以投影重拉整替', async () => {
    vi.mocked(api.sendSessionMessage).mockResolvedValue({ messageId: 'm1', turn: 1, runId: null, replay: true })
    const conn = await mounted()
    conn.chat.setInput('重发同文')
    conn.send()
    await flushPromises()
    // replay → refreshProjection：GET 再拉一次（自动选中首拉 + 这次 = 2 次）
    expect(api.getSessionProjection).toHaveBeenCalledTimes(2)
  })

  it('50005（多端在跑）→ 摘乐观行 + toast + 投影重拉', async () => {
    const err = new ApiError(200, 'run 进行中', 50005)
    vi.mocked(api.sendSessionMessage).mockRejectedValue(err)
    const conn = await mounted()
    conn.chat.setInput('并发消息')
    conn.send()
    await flushPromises()
    expect(actionsErr).toHaveBeenCalledWith('已有任务在进行中')
    expect(conn.chat.messages.some((m) => m.text === '并发消息')).toBe(false)
  })

  it('40043 配额满 → 摘乐观行 + toast', async () => {
    vi.mocked(api.sendSessionMessage).mockRejectedValue(new ApiError(200, '配额', 40043))
    const conn = await mounted()
    conn.chat.setInput('配额消息')
    conn.send()
    await flushPromises()
    expect(actionsErr).toHaveBeenCalledWith('并发配额已满，请稍后再试')
    expect(conn.chat.messages.some((m) => m.text === '配额消息')).toBe(false)
  })

  it('网络故障 → 摘乐观行 + 入待发 + toast（重连后按序注入）', async () => {
    vi.mocked(api.sendSessionMessage).mockRejectedValueOnce(new TypeError('fetch failed'))
    const conn = await mounted()
    conn.chat.setInput('断网消息')
    conn.send()
    await flushPromises()
    expect(actionsErr).toHaveBeenCalledWith('已加入待发，重连后自动发送')
    expect(JSON.parse(sessionStorage.getItem('chat.restOutbox.v1')!).sessions['sess-1']).toHaveLength(1)
  })

  // #796 story 26「leader 面不受扰」：server 50003 门禁是 per-thread（leader 线程不被 teammate
  // 审批挂起挡住）——前端预检只认 leader 卡（teammateId null），teammate 审批挂起时照发。
  it('teammate 审批挂起不挡 leader 发送；leader 审批挂起才禁发', async () => {
    const conn = await mounted()
    const chat = conn.chat
    chat.addApproval({ id: 'eT', source: 'cautious-mode', toolName: 'bash', toolCallSummary: 'x', teammateId: 'tm1' })
    chat.setInput('新问题')
    expect(conn.send()).toBe(true)
    await flushPromises()
    expect(api.sendSessionMessage).toHaveBeenCalledWith('sess-1', '新问题', expect.any(String), undefined)

    chat.addApproval({ id: 'eL', source: 'cautious-mode', toolName: 'bash', toolCallSummary: 'x', teammateId: null })
    chat.setInput('再来一问')
    expect(conn.send()).toBe(false)
    expect(api.sendSessionMessage).toHaveBeenCalledTimes(1)
  })
})

describe('断线补偿（story 12 outbox + 投影重拉）', () => {
  it('断线发送 → outbox 排队 + 乐观回显，重连 flush 按序注入（同 key 幂等）→ 投影重拉', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    // 断线：error（REST 探针 /auth/me 默认 mock 成功——刷新链活，不关流）
    src.fail()
    await flushPromises()
    expect(conn.disconnected.value).toBe(true)
    conn.chat.setInput('排队消息一')
    expect(conn.send()).toBe(true)
    conn.chat.setInput('排队消息二')
    expect(conn.send()).toBe(true)
    expect(api.sendSessionMessage).not.toHaveBeenCalled()
    // 重连：stream.opened → compensate → flush（两条按序 POST）→ 投影重拉
    vi.mocked(api.sendSessionMessage).mockClear()
    opened()
    await flushPromises()
    expect(api.sendSessionMessage).toHaveBeenCalledTimes(2)
    const [first, second] = vi.mocked(api.sendSessionMessage).mock.calls
    expect(first).toEqual(['sess-1', '排队消息一', expect.any(String)])
    expect(second).toEqual(['sess-1', '排队消息二', expect.any(String)])
    // 队列清空
    expect(sessionStorage.getItem('chat.restOutbox.v1')).toBeNull()
  })

  it('gap（丢帧）→ 投影重拉补偿（Last-Event-ID 只检测不重放）', async () => {
    await mounted()
    vi.mocked(api.getSessionProjection).mockClear()
    const src = FakeEventSource.last()!
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-1', runId: 'r1', payload: { delta: 'a' } }, '1')
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-1', runId: 'r1', payload: { delta: 'b' } }, '5') // gap
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalled()
  })

  it('手动 reconnect() → 投影重拉 + 待发注入', async () => {
    const conn = await mounted()
    vi.mocked(api.getSessionProjection).mockClear()
    conn.reconnect()
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalled()
  })
})

describe('SSE 事件分派', () => {
  it('text.delta 当前会话 → 归约 overlay；其它会话事件忽略', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    src.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r1', payload: {} })
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-1', runId: 'r1', payload: { delta: '流式' } }, '2')
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-OTHER', runId: 'r2', payload: { delta: '别处' } }, '3')
    await flushPromises()
    expect(conn.chat.messages.at(-1)).toMatchObject({ role: 'assistant', text: '流式', streaming: true })
    expect(conn.chat.messages).toHaveLength(3) // 旧两条 + 本会话 overlay
  })

  it('figure_run.progress 当前会话 → 写入匹配工具行 stage（#799）；他端 run 工具行不串扰', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    src.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r1', payload: {} })
    src.emit('tool.start', { type: 'tool.start', sessionId: 'sess-1', runId: 'r1', payload: { toolCallId: 'f1', name: 'figure_generate', input: '{"method_text":"x"}' } })
    src.emit('figure_run.progress', { type: 'figure_run.progress', sessionId: 'sess-1', runId: 'r1', payload: { toolCallId: 'f1', stage: 'templating' } })
    src.emit('figure_run.progress', { type: 'figure_run.progress', sessionId: 'sess-1', runId: 'r1', payload: { toolCallId: 'ghost', stage: 'rendering' } })
    await flushPromises()
    const overlay = conn.chat.messages.at(-1)!
    expect(overlay.tools[0]).toMatchObject({ id: 'f1', state: 'running', stage: 'templating' })
  })

  it('run.completed → 终态投影重拉（权威行整替 overlay）', async () => {
    const conn = await mounted()
    vi.mocked(api.getSessionProjection).mockClear()
    const src = FakeEventSource.last()!
    src.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r1', payload: {} })
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-1', runId: 'r1', payload: { delta: '答' } }, '2')
    src.emit('run.completed', { type: 'run.completed', sessionId: 'sess-1', runId: 'r1', payload: {} })
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalledTimes(1)
    expect(conn.chat.messages.at(-1)).toMatchObject({ role: 'assistant', text: '旧回答', streaming: false })
  })

  it('run.failed → 错误分类红显（story 10 三分类）+ 投影重拉；新 run 清除', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    src.emit('run.failed', { type: 'run.failed', sessionId: 'sess-1', runId: 'r1', payload: { errorKind: 'recursion_limit' } })
    await flushPromises()
    expect(conn.lastRunError.value).toEqual({ kind: 'recursion_limit', label: '运行步数达到上限' })
    src.emit('run.failed', { type: 'run.failed', sessionId: 'sess-1', runId: 'r2', payload: { errorKind: 'llm_error' } })
    await flushPromises()
    expect(conn.lastRunError.value).toEqual({ kind: 'llm_error', label: '模型请求失败' })
    src.emit('run.failed', { type: 'run.failed', sessionId: 'sess-1', runId: 'r3', payload: { errorKind: 'unknown_kind' } })
    await flushPromises()
    expect(conn.lastRunError.value).toEqual({ kind: 'unknown_kind', label: '运行失败' })
    src.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r4', payload: {} })
    await flushPromises()
    expect(conn.lastRunError.value).toBeNull()
  })

  it('session.updated {session} → 列表 upsert（story 5 自动标题经事件到达）；{projectionChanged} → 投影重拉', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    src.emit('session.updated', { type: 'session.updated', sessionId: 'sess-2', payload: { session: { ...S2, title: '新标题' } } })
    await flushPromises()
    expect(conn.chat.sessions.find((s) => s.id === 'sess-2')?.title).toBe('新标题')
    vi.mocked(api.getSessionProjection).mockClear()
    src.emit('session.updated', { type: 'session.updated', sessionId: 'sess-1', payload: { projectionChanged: true } })
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalled()
  })

  it('系统命令 /new：POST 响应 command → onCommand + 选中新会话（宿主导航语义）', async () => {
    vi.mocked(api.sendSessionMessage).mockResolvedValue({
      messageId: 'm9', turn: 1, runId: null, replay: false,
      command: { name: 'new', sessionId: 'sess-new' },
    })
    const conn = await mounted()
    conn.chat.setInput('/new')
    conn.send()
    await flushPromises()
    expect(commandSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'new', sessionId: 'sess-new' }))
  })

  it('系统命令 /model：POST 响应 command → onCommand（宿主提示）', async () => {
    vi.mocked(api.sendSessionMessage).mockResolvedValue({
      messageId: 'm9', turn: 1, runId: null, replay: false,
      command: { name: 'model', model: { providerId: 'p', modelId: 'm' }, appliesTo: 'next-run' },
    })
    const conn = await mounted()
    conn.chat.setInput('/model')
    conn.send()
    await flushPromises()
    expect(commandSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'model' }))
  })
})

describe('审批（#783 升级通道前端面）', () => {
  const escalation = { id: 'e1', source: 'cautious-mode', toolCallId: 't1', toolName: 'bash', toolCallSummary: 'rm -rf /tmp/x' }

  it('approval.requested → 卡入店；approval.resolved → 卡摘除（不留痕 ADR 0014）', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    src.emit('approval.requested', { type: 'approval.requested', sessionId: 'sess-1', payload: { escalation }, teammateId: null })
    await flushPromises()
    expect(conn.chat.approvals).toHaveLength(1)
    expect(conn.chat.approvals[0]).toMatchObject({ id: 'e1', toolName: 'bash', status: 'pending', teammateId: null })
    src.emit('approval.resolved', { type: 'approval.resolved', sessionId: 'sess-1', payload: { escalationId: 'e1', decision: 'allow' } })
    await flushPromises()
    expect(conn.chat.approvals).toHaveLength(0)
  })

  it('resolveApproval：POST allow → 成功摘卡；50004 → 摘卡 + 「已失效」toast；其它错 → 复位 pending 可重试', async () => {
    const conn = await mounted()
    const chat = conn.chat
    chat.addApproval({ id: 'e1', source: 'cautious-mode', toolName: 'bash', toolCallSummary: 'x', teammateId: null })
    vi.mocked(api.resolveSessionApproval).mockResolvedValueOnce(null)
    await conn.resolveApproval(chat.approvals[0], 'allow')
    expect(api.resolveSessionApproval).toHaveBeenCalledWith('sess-1', 'e1', 'allow')
    expect(chat.approvals).toHaveLength(0)

    chat.addApproval({ id: 'e2', source: 'judge-limit', toolName: 'bash', toolCallSummary: 'x', teammateId: null })
    vi.mocked(api.resolveSessionApproval).mockRejectedValueOnce(new ApiError(200, '无', 50004))
    await conn.resolveApproval(chat.approvals[0], 'deny')
    expect(actionsErr).toHaveBeenCalledWith('该审批已失效')
    expect(chat.approvals).toHaveLength(0)

    chat.addApproval({ id: 'e3', source: 'judge-limit', toolName: 'bash', toolCallSummary: 'x', teammateId: null })
    vi.mocked(api.resolveSessionApproval).mockRejectedValueOnce(new TypeError('网络'))
    await conn.resolveApproval(chat.approvals[0], 'deny')
    expect(chat.approvals[0].status).toBe('pending') // 可重试
  })
})

// ---- teammate 具名折叠区编排（#796 / #730 §4.3）：teammateId 分区路由 + 主时间线隔离 ----
describe('teammate 折叠区编排（#796）', () => {
  const tm = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'tm1', name: '文献员', task: '整理文献', status: 'completed',
    messages: [{ id: 'pm1', turn: 1, role: 'assistant', content: '队友产出', anchorCheckpointId: null, createdAt: '2026-10-06T01:00:00Z' }],
    mailbox: [{ id: 'mail1', senderTeammateId: 'tm1', recipientTeammateId: null, kind: 'message', content: '已完成', createdAt: '2026-10-06T01:01:00Z' }],
    ...over,
  })

  it('SSE 轨迹事件带 teammateId → 分区进 fold（主时间线不受污染）', async () => {
    // teammate.started 触发投影重拉：REST 是权威面（新 teammate 行已落库，inFlight 从 checkpoint
    // 重建）——mock 返回 running 行模拟真实整替；占位 fold 语义（重拉竞态窗口内不丢帧）由
    // projection.test.ts 的 applyTeamEvent 单测覆盖。
    vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf({
      teammates: [tm({ status: 'running', inFlight: { runId: 'rT', state: 'running', turn: { content: '检索中' } } })],
    }))
    const conn = await mounted()
    const src = FakeEventSource.last()!
    const base = conn.chat.messages.length
    src.emit('teammate.started', { type: 'teammate.started', sessionId: 'sess-1', runId: 'rT', teammateId: 'tm1', payload: { teammateId: 'tm1', name: '文献员' } })
    src.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'rT', teammateId: 'tm1', payload: {} })
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-1', runId: 'rT', teammateId: 'tm1', payload: { delta: '检索中' } })
    await flushPromises()
    expect(conn.chat.teams).toHaveLength(1)
    expect(conn.chat.teams[0]).toMatchObject({ id: 'tm1', name: '文献员', status: 'running' })
    expect(conn.chat.teams[0].msgs.at(-1)).toMatchObject({ text: '检索中', streaming: true })
    expect(conn.chat.messages).toHaveLength(base) // 主时间线零污染
  })

  it('投影重拉灌 teams（REST teammates 行 → teamFoldsFromProjection，含 mailbox）', async () => {
    vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf({ teammates: [tm()] }))
    const conn = await mounted()
    expect(conn.chat.teams).toHaveLength(1)
    expect(conn.chat.teams[0]).toMatchObject({ id: 'tm1', name: '文献员', task: '整理文献', status: 'completed' })
    expect(conn.chat.teams[0].msgs[0]).toMatchObject({ text: '队友产出', streaming: false })
    expect(conn.chat.teams[0].mailbox).toHaveLength(1)
  })

  it('teammate.* 状态事件与 run 终态 → 投影重拉（mailbox/task 补全 = REST-only 面）', async () => {
    const conn = await mounted()
    vi.mocked(api.getSessionProjection).mockClear()
    const src = FakeEventSource.last()!
    src.emit('teammate.completed', { type: 'teammate.completed', sessionId: 'sess-1', teammateId: 'tm1', payload: { teammateId: 'tm1', name: '文献员' } })
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalled()
    vi.mocked(api.getSessionProjection).mockClear()
    src.emit('run.failed', { type: 'run.failed', sessionId: 'sess-1', runId: 'rT', teammateId: 'tm1', payload: { errorKind: 'llm_error' } })
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalled()
    // leader 面不受扰：teammate run.failed 不进主时间线错误横幅
    expect(conn.lastRunError.value).toBeNull()
  })

  it('teammate run.resumed（信箱唤醒帧）→ 投影重拉：等待者被信唤醒点即见自身信箱新邮件', async () => {
    const conn = await mounted()
    const base = conn.chat.messages.length
    vi.mocked(api.getSessionProjection).mockClear()
    const src = FakeEventSource.last()!
    src.emit('run.resumed', { type: 'run.resumed', sessionId: 'sess-1', runId: 'rT', teammateId: 'tm1', payload: {} })
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalled()
    // 分流纪律：teammate 的 run.resumed 同样不进 leader 主时间线
    expect(conn.chat.messages).toHaveLength(base)
  })

  it('teammate 审批（approval.requested 带 teammateId）→ 卡带 teammateId + 投影重拉；resolved 摘卡', async () => {
    const escalation = { id: 'e9', source: 'cautious-mode', toolCallId: 't9', toolName: 'bash', toolCallSummary: 'x' }
    // 事件先到建卡；紧随的投影重拉是权威面（pendingApprovalProjection 带 teammateId 标注）——
    // 双路同形（setApprovalsFromProjection 幂等整替），mock 投影带同卡模拟真实面。
    vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf({ approvals: [{ escalation, teammateId: 'tm1' }] }))
    const conn = await mounted()
    const src = FakeEventSource.last()!
    src.emit('approval.requested', { type: 'approval.requested', sessionId: 'sess-1', teammateId: 'tm1', payload: { escalation, teammateId: 'tm1' } })
    await flushPromises()
    expect(conn.chat.approvals[0]).toMatchObject({ id: 'e9', teammateId: 'tm1' })
    expect(api.getSessionProjection).toHaveBeenCalled()
    // resolved 后 REST 权威面不再含该审批（pendingApprovalProjection 摘除）
    vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf())
    src.emit('approval.resolved', { type: 'approval.resolved', sessionId: 'sess-1', teammateId: 'tm1', payload: { escalationId: 'e9', decision: 'allow' } })
    await flushPromises()
    expect(conn.chat.approvals).toHaveLength(0)
  })

  it('展开态与数据分离：投影重拉整替 teams 不重置 teamExpanded', async () => {
    vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf({ teammates: [tm()] }))
    const conn = await mounted()
    conn.chat.toggleTeamExpanded('tm1')
    expect(conn.chat.teamExpanded.tm1).toBe(true)
    vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf({ teammates: [tm({ status: 'failed' })] }))
    const src = FakeEventSource.last()!
    src.emit('session.updated', { type: 'session.updated', sessionId: 'sess-1', payload: { projectionChanged: true } })
    await flushPromises()
    expect(conn.chat.teams[0].status).toBe('failed')
    expect(conn.chat.teamExpanded.tm1).toBe(true)
  })

  it('切会话清 teams 与展开态', async () => {
    vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf({ teammates: [tm()] }))
    const conn = await mounted()
    conn.chat.toggleTeamExpanded('tm1')
    vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf({ sessionId: 'sess-2', title: '实验记录', messages: [] }))
    conn.selectSession('sess-2')
    await flushPromises()
    expect(conn.chat.teams).toHaveLength(0)
    expect(conn.chat.teamExpanded).toEqual({})
  })
})

describe('中断 / 标题 / 删除 / slash', () => {
  it('abort：POST /abort；50006 → 「没有可中断的运行」', async () => {
    const conn = await mounted()
    vi.mocked(api.abortSession).mockResolvedValueOnce({ runId: 'r1' })
    await conn.abort()
    expect(api.abortSession).toHaveBeenCalledWith('sess-1')
    vi.mocked(api.abortSession).mockRejectedValueOnce(new ApiError(200, 'x', 50006))
    await conn.abort()
    expect(actionsErr).toHaveBeenCalledWith('没有可中断的运行')
  })

  it('renameSession：PATCH → 列表 upsert（story 5 可改）', async () => {
    const conn = await mounted()
    vi.mocked(api.renameSession).mockResolvedValueOnce({ ...S1, title: '改名后' })
    await conn.renameSession('sess-1', '改名后')
    expect(api.renameSession).toHaveBeenCalledWith('sess-1', '改名后')
    expect(conn.chat.sessions.find((s) => s.id === 'sess-1')?.title).toBe('改名后')
  })

  it('removeSession：确认后 DELETE；删当前会话 → 清投影态', async () => {
    const conn = await mounted()
    const confirmed = async () => true
    const res = await conn.removeSession('sess-1', confirmed)
    expect(res).toBe(true)
    expect(api.deleteSession).toHaveBeenCalledWith('sess-1')
    expect(conn.chat.sessions.map((s) => s.id)).toEqual(['sess-2'])
    expect(conn.chat.selectedSession).toBe('')
    expect(conn.chat.messages).toHaveLength(0)
  })

  it('removeSession：确认取消 → null 不发 DELETE', async () => {
    const conn = await mounted()
    const res = await conn.removeSession('sess-1', async () => false)
    expect(res).toBeNull()
    expect(api.deleteSession).not.toHaveBeenCalled()
  })

  it('newSession：POST /sessions → 置顶 + 选中', async () => {
    vi.mocked(api.createSession).mockResolvedValue({ id: 'sess-new', title: '', createdAt: '', updatedAt: '' })
    const conn = await mounted()
    const s = await conn.newSession()
    expect(s?.id).toBe('sess-new')
    expect(conn.chat.selectedSession).toBe('sess-new')
    expect(conn.chat.sessions[0].id).toBe('sess-new')
  })

  it('slash 系统命令：/m 匹配 /model；pickSlash 填入；Esc 关闭态由 store 承载', async () => {
    const conn = await mounted()
    conn.chat.setInput('/m')
    expect(conn.slashMatches.value.map((o) => o.alias)).toEqual(['/model'])
    expect(conn.slashOpen.value).toBe(true)
    conn.pickSlash('/model')
    expect(conn.chat.input).toBe('/model ')
    expect(conn.slashOpen.value).toBe(false) // dismissed
  })

  it('composer Enter（无修饰键）→ onSend 回调（宿主接线 sendMessage）', () => {
    const onSend = vi.fn()
    const conn = useChatSession({ onSend })
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onSend).toHaveBeenCalledTimes(1)
  })
})


describe('#797 slash 键盘与参数提示', () => {
  it('启动加载插件目录；选择官方命令提示参数，发送仍保留 /命令原文', async () => {
    vi.mocked(listPlugins).mockResolvedValue([{ id: 'fig', name: 'Fig', description: '', version: '1', enabled: true, commands: [{ name: 'figure', description: '绘图' }] }])
    const conn = await mounted()
    conn.chat.setInput('/')
    expect(conn.slashMatches.value.map(c => c.alias)).toContain('/figure')
    conn.chat.setInput('/r')
    conn.onComposerInput()
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Tab' }))
    expect(conn.chat.input).toBe('/research ')
    expect(conn.slashArgumentHint.value).toContain('$ARGUMENTS')
    conn.chat.setInput('/research 电池材料')
    expect(conn.send()).toBe(true)
    expect(conn.chat.messages.at(-1)?.text).toBe('/research 电池材料')
    await flushPromises()
    expect(api.sendSessionMessage).toHaveBeenCalledWith('sess-1', '/research 电池材料', expect.any(String), undefined)
    conn.dispose()
  })

  it.each(['/new', '/compact', '/model'])('键盘选中 %s 后，第二次 Enter 发送原文', async (alias) => {
    const onSend = vi.fn()
    const conn = useChatSession({ onSend })
    conn.chat.setInput(alias)
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(conn.chat.input).toBe(`${alias} `)
    expect(onSend).not.toHaveBeenCalled()
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(onSend).toHaveBeenCalledOnce()
    conn.dispose()
  })

  it('菜单中 Shift+Enter 和 IME Enter 保留输入；上下键选择、Esc 关闭、重新输入可打开', async () => {
    const conn = await mounted()
    conn.chat.setInput('/')
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
    expect(conn.chat.input).toBe('/')
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(conn.chat.input).toBe('/compact ')
    conn.chat.setInput('/m')
    conn.onComposerInput()
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(conn.slashOpen.value).toBe(false)
    conn.chat.setInput('/mo')
    conn.onComposerInput()
    expect(conn.slashOpen.value).toBe(true)
    conn.dispose()
  })
})


describe('#797 插件启用刷新与命令重发', () => {
  it('重新打开菜单时刷新启用集；插件关闭后菜单选中项仍可通过 Enter 选择', async () => {
    vi.mocked(listPlugins).mockResolvedValue([{ id: 'fig', name: 'Fig', description: '', version: '1', enabled: true, commands: [{ name: 'figure', description: '绘图' }] }])
    const conn = await mounted()
    conn.chat.setInput('/')
    for (let i = 0; i < 4; i++) conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    vi.mocked(listPlugins).mockResolvedValue([])
    conn.onComposerInput()
    // catalog reload can arrive while the user moves the selection
    for (let i = 0; i < 4; i++) conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    await flushPromises()
    expect(conn.slashMatches.value.map(c => c.alias)).not.toContain('/figure')
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(conn.chat.input).toBe('/new ')
    conn.dispose()
  })

  it('插件目录请求失败仍可选择官方命令，并给出重试提示', async () => {
    vi.mocked(listPlugins).mockRejectedValue(new Error('offline'))
    const conn = await mounted()
    conn.chat.setInput('/r')
    expect(conn.slashMatches.value.map(c => c.alias)).toEqual(['/research'])
    expect(actionsErr).toHaveBeenCalledWith(expect.stringContaining('重新输入 /'))
    conn.dispose()
  })

  it('幂等重发的 /model 结果仍可提示，不误当作普通聊天消息', async () => {
    const conn = await mounted()
    vi.mocked(api.sendSessionMessage).mockResolvedValueOnce({ messageId: 'm9', turn: 3, runId: null, replay: true, command: { name: 'model', model: { providerId: 'p', modelId: 'm' }, appliesTo: 'next-run' } })
    conn.chat.setInput('/model p/m')
    conn.send()
    await flushPromises()
    expect(commandSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'model', appliesTo: 'next-run' }))
    conn.dispose()
  })
})


it('#797 断线排队的系统命令重连后仍展示返回结果', async () => {
  const conn = await mounted()
  FakeEventSource.last()!.fail()
  await flushPromises()
  conn.chat.setInput('/model')
  expect(conn.send()).toBe(true)
  vi.mocked(api.sendSessionMessage).mockResolvedValueOnce({ messageId: 'm9', turn: 3, runId: null, replay: false, command: { name: 'model', models: [] } })
  opened()
  await flushPromises()
  expect(commandSpy).toHaveBeenCalledWith({ name: 'model', models: [] })
  conn.dispose()
})


it('#797 插件参数补全防抖后可用 Tab 选择，并按 user 原文发送', async () => {
  vi.mocked(listPlugins).mockResolvedValue([{ id: 'fig', name: 'Fig', description: '', version: '1', enabled: true, commands: [{ name: 'figure', description: '绘图', hasArgumentCompletions: true }] }])
  vi.mocked(getPluginArgumentCompletions).mockResolvedValue([{ value: 'flow chart', description: '流程图' }])
  const conn = await mounted()
  vi.useFakeTimers()
  conn.chat.setInput('/figure fl')
  conn.onComposerInput()
  await flushPromises()
  await vi.advanceTimersByTimeAsync(100)
  conn.chat.setInput('/figure flow')
  conn.onComposerInput()
  await flushPromises()
  await vi.advanceTimersByTimeAsync(249)
  expect(getPluginArgumentCompletions).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(getPluginArgumentCompletions).toHaveBeenCalledWith('fig', 'figure', 'flow')
  expect(conn.slashMatches.value).toEqual([{ alias: '/figure flow chart', description: '流程图' }])
  conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Tab' }))
  expect(conn.chat.input).toBe('/figure flow chart ')
  expect(conn.slashOpen.value).toBe(false)
  conn.send()
  await flushPromises()
  expect(api.sendSessionMessage).toHaveBeenCalledWith('sess-1', '/figure flow chart', expect.any(String), undefined)
  conn.dispose()
})

it('#797 参数补全迟到时不覆盖新输入，dispose 取消尚未发送的请求', async () => {
  vi.mocked(listPlugins).mockResolvedValue([{ id: 'fig', name: 'Fig', description: '', version: '1', enabled: true, commands: [{ name: 'figure', description: '绘图', hasArgumentCompletions: true }] }])
  let complete!: (items: { value: string }[]) => void
  vi.mocked(getPluginArgumentCompletions).mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
  const conn = await mounted()
  vi.useFakeTimers()
  conn.chat.setInput('/figure old')
  conn.onComposerInput()
  await flushPromises()
  await vi.advanceTimersByTimeAsync(250)
  conn.chat.setInput('新的普通消息')
  conn.onComposerInput()
  await flushPromises()
  complete([{ value: 'old suggestion' }])
  await flushPromises()
  expect(conn.slashOpen.value).toBe(false)
  expect(conn.chat.input).toBe('新的普通消息')
  conn.chat.setInput('/figure new')
  conn.onComposerInput()
  await flushPromises()
  conn.dispose()
  await vi.advanceTimersByTimeAsync(250)
  expect(getPluginArgumentCompletions).toHaveBeenCalledTimes(1)
})
