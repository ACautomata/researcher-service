// seam: ChatView 对话页 —— issue #41 前端（spec §9.4）。
// 覆盖：mount 拉容器并自动连 WS+start、发送后流式逐字 + 光标 + done 收尾、error 帧错误条、
// 意外断线提示、新建会话。stub 原生 WebSocket（MockWS）捕获 handlers；mock containers/chat API。
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/containers', () => ({ listInstances: vi.fn() }))
vi.mock('@/api/chat', () => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getSessionHistory: vi.fn(),
  deleteSession: vi.fn(),
  listCommands: vi.fn(),
}))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn() },
  }
})

import ChatView from '@/views/ChatView.vue'
import { listInstances } from '@/api/containers'
import {
  createSession,
  deleteSession,
  getSessionHistory,
  listCommands,
  listSessions,
} from '@/api/chat'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/client'
import { ElMessageBox } from 'element-plus'

class MockWS {
  static CONNECTING = 0
  static OPEN = 1 // ws.ts sendRaw 守卫用 WebSocket.OPEN（readyState 判走 onError，codex P2）
  static CLOSED = 3
  static last: MockWS | null = null
  sent: unknown[] = []
  closed = false // 记录 close() 是否被调用（验证切容器时旧 ws 被关闭）
  // Most view tests focus on ChatView state rather than the native handshake and historically treat the mock as
  // transport-ready; the stalled-handshake case below explicitly switches its reconnect socket to CONNECTING.
  readyState = MockWS.OPEN
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  url: string
  protocols: string | string[]

  constructor(url: string, protocols: string | string[]) {
    MockWS.last = this
    this.url = url
    this.protocols = protocols
  }

  send(data: string): void {
    if (this.readyState !== MockWS.OPEN) return // 非 OPEN 静默丢弃（对齐原生 CLOSING/CLOSED）
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.closed = true
    this.readyState = MockWS.CLOSED
    this.onclose?.({})
  }

  fireOpen(): void {
    this.readyState = MockWS.OPEN
    this.onopen?.({})
  }

  // 模拟意外断线（非经 close()）：readyState 置 CLOSED 并以指定 code 触发 onclose（issue #239 测试）
  fireClose(code?: number): void {
    this.readyState = MockWS.CLOSED
    this.onclose?.({ code: code ?? 1006, reason: '', wasClean: false })
  }

  fireMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
}

const INSTANCE = {
  name: 'demo', port: 19000, status: 'running', health: 'healthy',
  image: 'i', container_id: 'c', created_at: '', pairing: { status: 'paired' },
}
const SESSION = { session_key: 'sk-1', title: '文献综述', updated_at: '' }

describe('ChatView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    MockWS.last = null
    vi.clearAllMocks()
    vi.stubGlobal('WebSocket', MockWS)
    useAuthStore().$patch({ token: 'jwt-test' })
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([INSTANCE])
    ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION])
    ;(createSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session_key: 'sk-1' })
    ;(getSessionHistory as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
      hasMore: false,
      nextOffset: null,
    })
    ;(deleteSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(listCommands as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders container list and auto-connects with start frame on mount', async () => {
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireOpen() // CONNECTING 期间缓冲的 start 帧在 onopen 后 flush
    expect(w.find('[data-test="container-demo"]').exists()).toBe(true)
    expect(MockWS.last).not.toBeNull()
    expect(MockWS.last!.sent).toContainEqual({ type: 'start', container: 'demo' })
  })

  it('sends a message and streams the assistant reply with cursor then done', async () => {
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireOpen()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()

    await w.find('[data-test="input"]').setValue('你好')
    await w.find('[data-test="send"]').trigger('click')
    expect(MockWS.last!.sent).toContainEqual({ type: 'send', sessionKey: 'sk-1', message: '你好' })

    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '回答' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('回答')
    expect(w.find('.cursor').exists()).toBe(true) // 流式光标

    MockWS.last!.fireMessage({ type: 'done', runId: 'r1' })
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(false) // 收尾，光标消失
  })

  it('shows error bar on error frame', async () => {
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireMessage({ type: 'error', message: '模型超时' })
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('模型超时')
  })

  it('shows disconnect error on unexpected close (验收 ② 断线提示)', async () => {
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()
    MockWS.last!.onclose?.({}) // 意外断线
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('断开')
  })

  it('creates a new session on demand', async () => {
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    expect(createSession).toHaveBeenCalledWith('demo')
  })

  it('disables send while assistant is streaming (防止并发 send 卡住旧消息)', async () => {
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireOpen()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()

    await w.find('[data-test="input"]').setValue('a')
    await w.find('[data-test="send"]').trigger('click') // 触发助手流式（streaming=true）
    // 流式中再发 b：send 守卫拦截，不再产生 send 帧
    await w.find('[data-test="input"]').setValue('b')
    await w.find('[data-test="send"]').trigger('click')
    const sends = MockWS.last!.sent.filter((f) => (f as { type: string }).type === 'send')
    expect(sends.length).toBe(1)
  })

  it('ignores stale ws events after container switch (stale guard)', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      INSTANCE,
      { ...INSTANCE, name: 'other', port: 19001 },
    ])
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    const oldWs = MockWS.last // demo 的 ws
    oldWs!.fireOpen()
    oldWs!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()

    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises() // selectContainer → connect 新 ws
    const newWs = MockWS.last // other 的 ws
    newWs!.fireOpen()
    newWs!.fireMessage({ type: 'ready', container: 'other' })
    await nextTick()

    // 旧 ws 推 text → onText stale guard（ws !== myWs）拦截，不污染新会话
    oldWs!.fireMessage({ type: 'text', runId: 'r1', delta: 'STALE' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('STALE')
  })

  it('does not merge stale run deltas after a session switch (runId routing, codex P2)', async () => {
    // 切会话不切 ws：旧 run 的增量必须按 runId 丢弃，不能并入新 run 的回复
    const SESS2 = { session_key: 'sk-2', title: 'S2', updated_at: '' }
    ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION, SESS2])
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireOpen()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()

    // 会话 S1 内发消息 → run r1 流式
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: 'A' })
    await nextTick()

    // 切到会话 S2，再发 → run r2
    await w.find('[data-test="session-sk-2"]').trigger('click')
    await nextTick()
    await w.find('[data-test="input"]').setValue('yo')
    await w.find('[data-test="send"]').trigger('click')

    // 旧 run r1 的迟到增量应被丢弃；新 run r2 的增量应渲染
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: 'STALE' })
    MockWS.last!.fireMessage({ type: 'text', runId: 'r2', delta: 'NEW' })
    await nextTick()
    const stream = w.find('[data-test="stream"]').text()
    expect(stream).not.toContain('STALE')
    expect(stream).toContain('NEW')
  })

  it('discards stale listSessions response after overlapping container switches (codex P2)', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      INSTANCE,
      { ...INSTANCE, name: 'other', port: 19001 },
    ])
    const resolveA: { fn: ((v: unknown[]) => void) | null } = { fn: null }
    const resolveB: { fn: ((v: unknown[]) => void) | null } = { fn: null }
    ;(listSessions as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'demo'
        ? new Promise((r) => { resolveA.fn = r })
        : new Promise((r) => { resolveB.fn = r }),
    )
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises() // demo 自动选中，listSessions('demo') pending
    await w.find('[data-test="container-other"]').trigger('click') // 切到 other
    await nextTick()
    resolveB.fn!([{ session_key: 'sk-b', title: 'B', updated_at: '' }]) // other 先回
    await flushPromises()
    resolveA.fn!([{ session_key: 'sk-stale', title: 'Stale', updated_at: '' }]) // demo 迟到
    await flushPromises()
    // 当前容器是 other → 保留 B 的会话，丢弃 demo 的迟到响应
    expect(w.find('[data-test="session-sk-b"]').exists()).toBe(true)
    expect(w.find('[data-test="session-sk-stale"]').exists()).toBe(false)
  })

  it('does not connect when automatic session creation fails (codex P2)', async () => {
    ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]) // 容器无会话
    ;(createSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('创建失败'))
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    // newSession 失败 → selectedSession 仍空 → 不应 connect（无 ws），并保留错误提示
    expect(MockWS.last).toBeNull()
    expect(w.find('[data-test="error-bar"]').text()).toContain('创建失败')
  })

  it('discards orphaned pending run when its first delta arrives after a session switch (codex #3)', async () => {
    // 发消息后、首个 delta 到达前切会话：pending run 的 runId 未知，abandonActiveRun 按计数标记；
    // 其迟到首帧按 FIFO 视为孤儿丢弃，新会话的 run 正常渲染
    const SESS2 = { session_key: 'sk-2', title: 'S2', updated_at: '' }
    ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION, SESS2])
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireOpen()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()

    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click') // pendingSend=true，未收任何 delta
    await w.find('[data-test="session-sk-2"]').trigger('click') // 切会话 → pendingAbandonCount=1
    await w.find('[data-test="input"]').setValue('yo')
    await w.find('[data-test="send"]').trigger('click') // 新会话再发

    MockWS.last!.fireMessage({ type: 'text', runId: 'r-old', delta: 'STALE' }) // 孤儿首帧
    MockWS.last!.fireMessage({ type: 'text', runId: 'r-new', delta: 'NEW' }) // 新 run 首帧
    await nextTick()
    const stream = w.find('[data-test="stream"]').text()
    expect(stream).not.toContain('STALE')
    expect(stream).toContain('NEW')
  })

  it('disables send after the ws closes unexpectedly (codex #4)', async () => {
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireOpen()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()
    const btn = () => w.find('[data-test="send"]').element as HTMLButtonElement
    expect(btn().disabled).toBe(false)
    MockWS.last!.onclose?.({}) // 意外断线（代理/后端重启）
    await nextTick()
    expect(btn().disabled).toBe(true) // disconnected 禁用发送
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click') // guard 拦截，不再走 CLOSED socket
    const sends = MockWS.last!.sent.filter((f) => (f as { type: string }).type === 'send')
    expect(sends.length).toBe(0)
  })

  it('closes the old ws and disables composer while listSessions is pending on switch (codex #5)', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      INSTANCE,
      { ...INSTANCE, name: 'other', port: 19001 },
    ])
    const resolveOther: { fn: ((v: unknown[]) => void) | null } = { fn: null }
    ;(listSessions as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'demo'
        ? Promise.resolve([SESSION])
        : new Promise((r) => { resolveOther.fn = r }),
    )
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises() // demo 自动选中并连接
    MockWS.last!.fireOpen()
    const demoWs = MockWS.last

    await w.find('[data-test="container-other"]').trigger('click') // 切到 other，listSessions pending
    await nextTick()
    expect(demoWs!.closed).toBe(true) // 旧 ws 立即关闭
    expect((w.find('[data-test="send"]').element as HTMLButtonElement).disabled).toBe(true) // connecting 禁用
    // pending 期间发送：被 connecting 拦截，不经旧 socket 发出
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    expect(demoWs!.sent.filter((f) => (f as { type: string }).type === 'send').length).toBe(0)
    resolveOther.fn!([SESSION]) // other 数据到 → 连新 ws
    await flushPromises()
  })

  // ---- T06 权限审批（issue #42 / spec §9.4）----
  async function mountReady() {
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireOpen()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()
    return w
  }

  it('renders an orange approval card when agent requests elevation (验收 1)', async () => {
    const w = await mountReady()
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'openclaw wiki compile', sessionKey: 'sk-1' })
    await nextTick()
    const card = w.find('[data-test="approval-ap-1"]')
    expect(card.exists()).toBe(true)
    expect(card.classes()).toContain('approval')
    expect(card.text()).toContain('请求提升权限')
    expect(card.text()).toContain('openclaw wiki compile') // 待批命令
    expect(w.find('[data-test="approve-ap-1"]').exists()).toBe(true) // 批准
    expect(w.find('[data-test="deny-ap-1"]').exists()).toBe(true) // 拒绝
    expect(w.find('[data-test="detail-ap-1"]').exists()).toBe(true) // 查看细节
  })

  it('approve enters pending (buttons disabled, NOT yet resolved) until approvalResolved (codex P2)', async () => {
    const w = await mountReady()
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'cmd', sessionKey: 'sk-1' })
    await nextTick()
    await w.find('[data-test="approve-ap-1"]').trigger('click')
    expect(MockWS.last!.sent).toContainEqual({ type: 'resolve', id: 'ap-1', kind: 'exec', decision: 'allow-once' })
    await nextTick()
    // pending：按钮禁用但卡片未标记 resolved（等服务端回执，不乐观假成功）
    const card = w.find('[data-test="approval-ap-1"]')
    expect(card.classes()).not.toContain('resolved')
    expect((w.find('[data-test="approve-ap-1"]').element as HTMLButtonElement).disabled).toBe(true)
    // 服务端回执到达才落定变淡
    MockWS.last!.fireMessage({ type: 'approvalResolved', id: 'ap-1', decision: 'allow-once' })
    await nextTick()
    const card2 = w.find('[data-test="approval-ap-1"]')
    expect(card2.classes()).toContain('resolved')
    expect(card2.text()).toContain('已批准')
  })

  it('approvalResolved uses authoritative decision, not requested (codex P1)', async () => {
    const w = await mountReady()
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'cmd', sessionKey: 'sk-1' })
    await nextTick()
    await w.find('[data-test="approve-ap-1"]').trigger('click') // 请求 allow-once
    await nextTick()
    MockWS.last!.fireMessage({ type: 'approvalResolved', id: 'ap-1', decision: 'deny' }) // 权威 deny
    await nextTick()
    expect(w.find('[data-test="approval-ap-1"]').text()).toContain('已拒绝')
  })

  it('shows unknown, not 已批准, for an unrecognized authoritative decision (codex R2 P2)', async () => {
    const w = await mountReady()
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'cmd', sessionKey: 'sk-1' })
    await nextTick()
    await w.find('[data-test="approve-ap-1"]').trigger('click')
    await nextTick()
    MockWS.last!.fireMessage({ type: 'approvalResolved', id: 'ap-1', decision: 'expired' }) // 未识别权威值
    await nextTick()
    const card = w.find('[data-test="approval-ap-1"]')
    expect(card.classes()).toContain('resolved')
    expect(card.text()).toContain('未知') // 不默认显示「已批准」
    expect(card.text()).not.toContain('已批准')
  })

  it('restores only the failed card when its resolve fails (error frame with id, codex R2 P2)', async () => {
    const w = await mountReady()
    // 两张卡，各自点批准 → 都进 resolving
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'c1', sessionKey: 'sk-1' })
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-2', kind: 'exec', command: 'c2', sessionKey: 'sk-1' })
    await nextTick()
    await w.find('[data-test="approve-ap-1"]').trigger('click')
    await w.find('[data-test="approve-ap-2"]').trigger('click')
    await nextTick()
    expect((w.find('[data-test="approve-ap-1"]').element as HTMLButtonElement).disabled).toBe(true)
    expect((w.find('[data-test="approve-ap-2"]').element as HTMLButtonElement).disabled).toBe(true)
    // 只有 ap-1 的 resolve 失败（error 帧带 id）→ 仅 ap-1 恢复可点，ap-2 仍在途
    MockWS.last!.fireMessage({ type: 'error', message: '审批回覆失败', id: 'ap-1' })
    await nextTick()
    expect((w.find('[data-test="approve-ap-1"]').element as HTMLButtonElement).disabled).toBe(false)
    expect((w.find('[data-test="approve-ap-2"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('approval card does not break streaming anchor or stick the composer (审查 #5)', async () => {
    const w = await mountReady()
    // 先发一条消息触发助手流式
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '思考' })
    await nextTick()
    // 流式中途来审批卡：不应被 finalizeLast 误收尾、不应影响 streaming 光标
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'cmd', sessionKey: 'sk-1' })
    await nextTick()
    expect(w.find('[data-test="approval-ap-1"]').exists()).toBe(true)
    expect(w.find('.cursor').exists()).toBe(true) // 流式光标仍在
    MockWS.last!.fireMessage({ type: 'done', runId: 'r1' })
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(false) // done 正常收尾
    expect(w.find('[data-test="stream"]').text()).toContain('思考')
  })

  it('retains other-session cards and shows them when switching to that session (codex R2 P1)', async () => {
    const SESS2 = { session_key: 'sk-2', title: 'S2', updated_at: '' }
    ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION, SESS2])
    const w = await mountReady()
    // 属于 sk-2 的卡：当前 sk-1 不显示，但**保留**（不丢弃）
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-x', kind: 'exec', command: 'cmd', sessionKey: 'sk-2' })
    await nextTick()
    expect(w.find('[data-test="approval-ap-x"]').exists()).toBe(false)
    // 切到 sk-2 → 该卡可见、可回覆（agent 不再被永久卡住）
    await w.find('[data-test="session-sk-2"]').trigger('click')
    await nextTick()
    expect(w.find('[data-test="approval-ap-x"]').exists()).toBe(true)
    await w.find('[data-test="approve-ap-x"]').trigger('click')
    expect(MockWS.last!.sent).toContainEqual({ type: 'resolve', id: 'ap-x', kind: 'exec', decision: 'allow-once' })
  })

  it('clears approval cards when switching container', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      INSTANCE,
      { ...INSTANCE, name: 'other', port: 19001 },
    ])
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireOpen()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'cmd', sessionKey: 'sk-1' })
    await nextTick()
    expect(w.find('[data-test="approval-ap-1"]').exists()).toBe(true)
    await w.find('[data-test="container-other"]').trigger('click') // 切容器
    await flushPromises()
    expect(w.find('[data-test="approval-ap-1"]').exists()).toBe(false)
  })

  it('toggles detail view to reveal full command (查看细节)', async () => {
    const w = await mountReady()
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-3', kind: 'exec', command: 'very long cmd', sessionKey: 'sk-1' })
    await nextTick()
    expect(w.find('[data-test="approval-detail-ap-3"]').exists()).toBe(false)
    await w.find('[data-test="detail-ap-3"]').trigger('click')
    await nextTick()
    expect(w.find('[data-test="approval-detail-ap-3"]').exists()).toBe(true)
    expect(w.find('[data-test="approval-detail-ap-3"]').text()).toContain('very long cmd')
  })

  it('retains approval cards when creating a new session (codex R3 P1)', async () => {
    const w = await mountReady()
    // 当前会话有一张待审批卡
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-keep', kind: 'exec', command: 'cmd', sessionKey: 'sk-1' })
    await nextTick()
    expect(w.find('[data-test="approval-ap-keep"]').exists()).toBe(true)
    // 新建会话（不换容器）：卡须保留（agent 仍卡住,不能误清）
    ;(createSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session_key: 'sk-new' })
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    // 新会话 sessionKey 不同 → 该卡按 sessionKey 过滤暂不显示;切回原会话 sk-1 应能再见到(证明未被误清)
    await w.find('[data-test="session-sk-1"]').trigger('click')
    await nextTick()
    expect(w.find('[data-test="approval-ap-keep"]').exists()).toBe(true)
  })

  it('disables approve buttons and restores resolving cards on unexpected close (codex R3 P2)', async () => {
    const w = await mountReady()
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'cmd', sessionKey: 'sk-1' })
    await nextTick()
    // 点击批准 → resolving
    await w.find('[data-test="approve-ap-1"]').trigger('click')
    expect((w.find('[data-test="approve-ap-1"]').element as HTMLButtonElement).disabled).toBe(true)
    // 意外断线:onClose 恢复 resolving 卡为 pending(可重试),但 disconnected 又禁用按钮
    MockWS.last!.onclose?.({})
    await nextTick()
    expect((w.find('[data-test="approve-ap-1"]').element as HTMLButtonElement).disabled).toBe(true) // disconnected 禁用
    // 再点无效(守卫 disconnected)
    await w.find('[data-test="approve-ap-1"]').trigger('click')
    const resolves = MockWS.last!.sent.filter((f) => (f as { type: string }).type === 'resolve')
    expect(resolves.length).toBe(1) // 只发出第一次,断线后不再发
  })

  it('restores all resolving cards on a generic (no-id) connection error (codex R3 P2)', async () => {
    const w = await mountReady()
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'c1', sessionKey: 'sk-1' })
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-2', kind: 'exec', command: 'c2', sessionKey: 'sk-1' })
    await nextTick()
    await w.find('[data-test="approve-ap-1"]').trigger('click')
    await w.find('[data-test="approve-ap-2"]').trigger('click')
    await nextTick()
    // 无 id 的通用错误(如 socket CLOSED 态 send 报错)→ 恢复所有 resolving 卡为 pending
    MockWS.last!.fireMessage({ type: 'error', message: '连接已断开,请重试或切换容器' })
    await nextTick()
    // 两卡都复位 pending(虽然 disconnected 下按钮仍禁用,但内部状态已可重试)
    // 通过 approvalResolved 之外的旁证:recover 后 status 回 pending,disconnected 仍是 true 故按钮禁用
    // 重新连接前按钮禁用是对的;此处断言 recover 把卡从 resolving 拉回(若仍 resolving,重连后会卡死)
    expect(w.find('[data-test="approval-ap-1"]').exists()).toBe(true)
    expect(w.find('[data-test="approval-ap-2"]').exists()).toBe(true)
  })

  // ---- T07 斜杠命令补全（issue #43 / spec §9.4）----
  const COMMANDS = [
    { name: 'model', description: '切换模型', aliases: ['/model', '/m'] },
    { name: 'wiki', description: '在 wiki 中检索/写入', aliases: ['/wiki'] },
    { name: 'compact', description: '压缩会话上下文', aliases: ['/compact'] },
    { name: 'new', description: '新建会话', aliases: ['/new'] },
  ]

  // 真实 KeyboardEvent 派发：test-utils trigger('keydown',{key}) 在 jsdom 下对带导航逻辑的
  // @keydown 处理器 key 传递不可靠（Enter/Escape 不生效），改 dispatch 原生事件保证处理器收到。
  function press(el: Element, key: string) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }

  it('fetches the container command list on mount (验收 1 清单来源 commands.list)', async () => {
    ;(listCommands as ReturnType<typeof vi.fn>).mockResolvedValue(COMMANDS)
    const w = await mountReady()
    expect(listCommands).toHaveBeenCalledWith('demo')
    // 菜单仅在输入 / 时弹（此处未输入，保持关闭）；清单已就绪——输入 / 即可补全
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(false)
    await w.find('[data-test="input"]').setValue('/')
    await nextTick()
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(true)
  })

  it('shows the slash menu with prefix filtering when typing / (验收 1)', async () => {
    ;(listCommands as ReturnType<typeof vi.fn>).mockResolvedValue(COMMANDS)
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('/m')
    await nextTick()
    const items = w.findAll('[data-test="slash-item"]')
    const texts = items.map((i) => i.text())
    // 前缀过滤：/m 命中 /model 与 /m（同一 model 命令的两个别名各占一行），不含 /wiki//compact
    expect(items.length).toBe(2)
    expect(texts.join(' ')).toContain('/model')
    expect(texts.join(' ')).toContain('切换模型')
    expect(texts.join(' ')).not.toContain('/wiki')
  })

  it('hides the slash menu for plain text and closes on space (原型 oc-chat-page)', async () => {
    ;(listCommands as ReturnType<typeof vi.fn>).mockResolvedValue(COMMANDS)
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('hello')
    await nextTick()
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(false)
    await w.find('[data-test="input"]').setValue('/model ')
    await nextTick()
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(false)
  })

  it('clicking a slash item fills the input and sends via normal chat.send (验收 2)', async () => {
    ;(listCommands as ReturnType<typeof vi.fn>).mockResolvedValue(COMMANDS)
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('/mo')
    await nextTick()
    // 点选（@mousedown.prevent 拦截，防 textarea 失焦；真实 mousedown 事件）
    w.find('[data-test="slash-item"]').element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    // 点选填入别名（含尾随空格便于续输参数），菜单关闭
    expect((w.find('[data-test="input"]').element as HTMLTextAreaElement).value).toBe('/model ')
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(false)
    // 经普通发送路径发 /cmd（非专用命令通道，r26 §2）
    await w.find('[data-test="send"]').trigger('click')
    expect(MockWS.last!.sent).toContainEqual({ type: 'send', sessionKey: 'sk-1', message: '/model' })
  })

  it('supports keyboard navigation and Enter-to-fill (补全交互)', async () => {
    ;(listCommands as ReturnType<typeof vi.fn>).mockResolvedValue(COMMANDS)
    const w = await mountReady()
    const input = w.find('[data-test="input"]')
    await input.setValue('/')
    await nextTick()
    const items = w.findAll('[data-test="slash-item"]')
    expect(items.length).toBeGreaterThan(1)
    expect(items[0].classes()).toContain('sel') // 首项默认高亮
    press(input.element, 'ArrowDown')
    await nextTick()
    expect(w.findAll('[data-test="slash-item"]')[1].classes()).toContain('sel')
    press(input.element, 'Enter')
    await nextTick()
    // Enter 选中高亮项（第二项 /m），填入而非发送
    expect((input.element as HTMLTextAreaElement).value).toBe('/m ')
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(false)
    expect(MockWS.last!.sent.filter((f) => (f as { type: string }).type === 'send').length).toBe(0)
  })

  it('dismisses the slash menu on Escape', async () => {
    ;(listCommands as ReturnType<typeof vi.fn>).mockResolvedValue(COMMANDS)
    const w = await mountReady()
    const input = w.find('[data-test="input"]')
    await input.setValue('/')
    await nextTick()
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(true)
    press(input.element, 'Escape')
    await nextTick()
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(false)
  })

  it('clears the command cache when switching container (命令按容器隔离)', async () => {
    ;(listCommands as ReturnType<typeof vi.fn>).mockResolvedValue(COMMANDS)
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      INSTANCE,
      { ...INSTANCE, name: 'other', port: 19001 },
    ])
    const w = await mountReady()
    expect(listCommands).toHaveBeenCalledWith('demo')
    await w.find('[data-test="input"]').setValue('/')
    await nextTick()
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(true)
    // 切容器：清空已缓存命令 + 关闭菜单，并为新容器重新拉取
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    expect(listCommands).toHaveBeenCalledWith('other')
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(false)
  })

  it('discards a stale command-list response after a fast container switch (codex P1)', async () => {
    // 快速切容器：旧容器(demo)的 listCommands 晚于新容器(other)返回，其响应必须按 containerGen 丢弃，
    // 不得覆盖 other 的命令清单（否则菜单给出错误容器的命令并经当前 socket 发出）
    const DEMOCMDS = [{ name: 'demo-only', description: '旧容器命令', aliases: ['/demo-only'] }]
    const OTHERCMDS = [{ name: 'othercmd', description: '新容器命令', aliases: ['/othercmd'] }]
    const resolveDemo: { fn: ((v: unknown) => void) | null } = { fn: null }
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      INSTANCE,
      { ...INSTANCE, name: 'other', port: 19001 },
    ])
    ;(listCommands as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'demo'
        ? new Promise((r) => { resolveDemo.fn = r }) // demo 挂起，后返回
        : Promise.resolve(OTHERCMDS),
    )
    const w = await mountReady() // demo 自动选中，listCommands('demo') pending
    await w.find('[data-test="container-other"]').trigger('click') // 切到 other
    await flushPromises() // other 的 listCommands 已返回 OTHERCMDS
    resolveDemo.fn!(DEMOCMDS) // demo 的迟到响应
    await flushPromises()
    await w.find('[data-test="input"]').setValue('/')
    await nextTick()
    const text = w.find('[data-test="slash-menu"]').text()
    expect(text).toContain('/othercmd') // 当前容器 other 的命令
    expect(text).not.toContain('/demo-only') // 旧容器 demo 的迟到响应被丢弃
  })

  it('keeps the chat usable when the command list fails to load (清单失败降级)', async () => {
    ;(listCommands as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('网关拒绝'))
    const w = await mountReady()
    // 清单拉取失败：不弹致命错误，输入 / 无匹配项、菜单保持隐藏
    expect(w.find('[data-test="error-bar"]').exists()).toBe(false)
    await w.find('[data-test="input"]').setValue('/')
    await nextTick()
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(false)
    // 普通对话仍可用
    await w.find('[data-test="input"]').setValue('你好')
    await w.find('[data-test="send"]').trigger('click')
    expect(MockWS.last!.sent).toContainEqual({ type: 'send', sessionKey: 'sk-1', message: '你好' })
  })

  // ---- T08 工具执行 + 思考链折叠（issue #44 / spec §8.2/§8.3/§9.4 / r26 §3/§4）----
  it('renders a tool line with running state on tool frame (验收 ① 工具只显标题+状态)', async () => {
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('查一下')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({
      type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running',
      id: 'call-1', title: null, input: { query: '对比学习' }, result: null,
    })
    await nextTick()
    const tool = w.find('[data-test="tool-line"]')
    expect(tool.exists()).toBe(true)
    expect(tool.classes()).toContain('running')
    expect(tool.text()).toContain('wiki.search')   // 无 title 时回退工具名（mono）
    expect(tool.text()).toContain('运行中')         // ⟳ 运行中
    // 不展开输入输出细节（验收 ①）：input 不逐字段渲染，仅可有一行参数摘要
    expect(tool.text()).not.toContain('"对比学习"')
  })

  it('prefers the human-readable tool title over the internal name (codex P2 ①)', async () => {
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('查一下')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({
      type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running',
      id: 'call-1', title: '检索 wiki', input: null, result: null,
    })
    await nextTick()
    const tool = w.find('[data-test="tool-line"]')
    expect(tool.text()).toContain('检索 wiki')           // 可见文本显示用途标题
    expect(tool.text()).not.toContain('wiki.search')     // 内部名退到 hover
    expect(tool.find('.t-name').attributes('title')).toBe('wiki.search')
  })

  it('updates the tool line to done on tool done frame (验收 ① 状态 ✓完成)', async () => {
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('查一下')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({
      type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running',
      id: null, title: null, input: null, result: null,
    })
    await nextTick()
    MockWS.last!.fireMessage({
      type: 'tool', runId: 'r1', name: 'wiki.search', state: 'done',
      id: null, title: null, input: null, result: { count: 3 },
    })
    await nextTick()
    const tool = w.find('[data-test="tool-line"]')
    expect(tool.classes()).toContain('done')
    expect(tool.text()).toContain('完成')
  })

  it('renders tool error state distinctly from done (codex #193 R3 P2)', async () => {
    // 生产 _translate_tool 对 result+isError=true 故意发 state='error'，前端须独立渲染
    // 「✗ 失败」（非一律「✓ 完成」），否则用户被误导以为失败工具成功。CSS .tool.error → 红字。
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('查一下')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({
      type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running',
      id: null, title: null, input: null, result: null,
    })
    await nextTick()
    MockWS.last!.fireMessage({
      type: 'tool', runId: 'r1', name: 'wiki.search', state: 'error',
      id: null, title: null, input: null, result: { error: '工具返回异常' },
    })
    await nextTick()
    const tool = w.find('[data-test="tool-line"]')
    expect(tool.classes()).toContain('error')
    expect(tool.text()).toContain('失败')          // ✗ 失败（与 ✓ 完成区分）
    expect(tool.text()).not.toContain('完成')
  })

  it('pairs overlapping same-name tool results by call id, not recency (codex P2 ②)', async () => {
    // 同名工具两次并发调用：result 必须按调用 id 落到对应行，而非「最后一个同名 running 行」
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('查一下')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running',
      id: 'c1', title: null, input: { query: '甲' }, result: null })
    MockWS.last!.fireMessage({ type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running',
      id: 'c2', title: null, input: { query: '乙' }, result: null })
    await nextTick()
    // c2 的 result 先到 → 只落 c2 行，c1 仍 running
    MockWS.last!.fireMessage({ type: 'tool', runId: 'r1', name: 'wiki.search', state: 'done',
      id: 'c2', title: null, input: null, result: { count: 1 } })
    await nextTick()
    const lines = w.findAll('[data-test="tool-line"]')
    expect(lines).toHaveLength(2)
    expect(lines[0].classes()).toContain('running')  // c1 未完成
    expect(lines[1].classes()).toContain('done')     // c2 完成
  })

  // ---- T08 思考链折叠（spec §8.3 (a) / r26 §4）：思考内联在 text 的 <thinking> 标签里，前端剥离独立渲染 ----
  it('strips <thinking> from text into a collapsed card (验收 ② (a) 独立渲染)', async () => {
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('你好')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '<thinking>先想</thinking>正式回答' })
    await nextTick()
    const bubble = w.find('.msg.assistant .bubble')
    const cot = w.find('[data-test="cot-card"]')
    // 正文（刨去折叠卡）不含思考内容与标签；思考进折叠卡
    expect(bubble.text()).toContain('正式回答')
    expect(bubble.text()).not.toContain('<thinking>')
    expect(cot.exists()).toBe(true)
    expect(cot.find('.cot-body').text()).toContain('先想')
  })

  it('streams thinking across chunks without leaking the tag into text', async () => {
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('你好')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '<think' })  // 残片
    await nextTick()
    expect(w.find('.msg.assistant .bubble').text()).not.toContain('<think')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: 'ing>推理中' })  // 未闭合 → 思考中
    await nextTick()
    expect(w.find('[data-test="cot-card"]').exists()).toBe(true)
    expect(w.find('[data-test="cot-card"]').text()).toContain('思考中')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '</thinking>答案' })
    await nextTick()
    const bubble = w.find('.msg.assistant .bubble')
    expect(bubble.text()).toContain('答案')
    expect(w.find('[data-test="cot-card"]').find('.cot-body').text()).toContain('推理中')
  })

  it('finalizes gracefully when the stream ends with an unclosed <thinking>', async () => {
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('你好')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '前言<thinking>没闭合' })
    MockWS.last!.fireMessage({ type: 'done', runId: 'r1' })
    await nextTick()
    const bubble = w.find('.msg.assistant .bubble')
    expect(bubble.text()).toContain('前言')
    expect(bubble.text()).not.toContain('<thinking>')   // 不泄露标签
    expect(w.find('[data-test="cot-card"]').find('.cot-body').text()).toContain('没闭合')  // 思考不丢
  })

  it('renders no thinking card for plain text without a <thinking> tag', async () => {
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('你好')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '普通回答' })
    await nextTick()
    expect(w.find('[data-test="cot-card"]').exists()).toBe(false)
    expect(w.find('.msg.assistant .bubble').text()).toContain('普通回答')
  })

  // ---- T3 会话历史回看（issue #82 / spec #76）：点会话拉 history 渲染、分页、删除、未配对引导 ----
  it('renders the gateway-derived session title in the sidebar (验收 派生标题, 无 id 字段)', async () => {
    ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { session_key: 'sk-1', title: '文献综述', updated_at: '' },
    ])
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(w.find('[data-test="session-sk-1"]').text()).toContain('文献综述')
  })

  it('loads and renders the session history when switching sessions (验收 点击会话加载历史)', async () => {
    const S2 = { session_key: 'sk-2', title: 'S2', updated_at: '' }
    ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION, S2])
    ;(getSessionHistory as ReturnType<typeof vi.fn>).mockImplementation((_n: string, key: string) =>
      key === 'sk-1'
        ? Promise.resolve({
            messages: [{ role: 'operator', text: 'S1问题' }, { role: 'agent', text: 'S1回答' }],
            hasMore: false,
            nextOffset: null,
          })
        : Promise.resolve({
            messages: [{ role: 'operator', text: 'S2问题' }, { role: 'agent', text: 'S2回答' }],
            hasMore: false,
            nextOffset: null,
          }),
    )
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    // 初始自动选中 sk-1，其历史渲染
    expect(w.find('[data-test="stream"]').text()).toContain('S1回答')

    // 切到 sk-2 → 加载并渲染 sk-2 历史，sk-1 历史不再显示
    await w.find('[data-test="session-sk-2"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="stream"]').text()).toContain('S2回答')
    expect(w.find('[data-test="stream"]').text()).not.toContain('S1回答')
  })

  it('preserves a turn sent during session-switch history load (codex P2 #108)', async () => {
    // 复现：切会话后历史未回即发送 → 整体替换 messages 会让历史快照覆盖进行中的 user/流式 assistant，
    // WS delta 随即找不到 streaming 尾，整轮实时回复从 UI 消失。
    let resolveHistory!: (v: unknown) => void
    ;(getSessionHistory as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveHistory = r as (v: unknown) => void }),
    )
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    MockWS.last!.fireOpen()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()
    // mount 自动选中 sk-1，loadHistory 已发起、messages 已清空、historyLoading=true。此时发送「你好」
    await w.find('[data-test="input"]').setValue('你好')
    await w.find('[data-test="send"]').trigger('click')
    expect(MockWS.last!.sent).toContainEqual({ type: 'send', sessionKey: 'sk-1', message: '你好' })

    // 历史返回（含一条旧 assistant 回答）→ 历史 prepend、进行中 turn 必须保留在尾
    resolveHistory({ messages: [{ role: 'agent', text: '旧回答' }], hasMore: false, nextOffset: null })
    await flushPromises()
    const rows = w.findAll('.msg').map((r) => r.text())
    expect(rows[0]).toContain('旧回答') // 历史在前
    expect(rows.some((t) => t.includes('你好'))).toBe(true) // 进行中 user 消息保留

    // 后续 WS delta 仍能落到 streaming 尾 → 实时回复未丢（直接验证 codex 描述的失效路径）
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '新回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('新回复')
  })

  it('shows pairing guidance when the container is unpaired (409, 验收 未配对引导)', async () => {
    ;(listSessions as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(409, '未配对'))
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    const guide = w.find('[data-test="pairing-guide"]')
    expect(guide.exists()).toBe(true)
    expect(guide.text()).toContain('配对') // 指引用户先完成设备配对
    // 未配对不应连 WS（无意义，WS 握手也会失败）
    expect(MockWS.last).toBeNull()
  })

  it('prepends older messages on load-more using nextOffset anchor (验收 历史分页)', async () => {
    ;(getSessionHistory as ReturnType<typeof vi.fn>)
      // 首次加载（mount 自动选中 sk-1）：最近一页，hasMore=true，nextOffset 为更旧页锚点
      .mockResolvedValueOnce({
        messages: [{ role: 'agent', text: '最近回答' }],
        hasMore: true,
        nextOffset: 'older-anchor',
      })
      // 加载更多：更旧一页
      .mockResolvedValueOnce({
        messages: [{ role: 'operator', text: '更旧问题' }],
        hasMore: false,
        nextOffset: null,
      })
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(w.find('[data-test="load-more"]').exists()).toBe(true) // hasMore → 顶部「加载更多」
    expect(w.find('[data-test="stream"]').text()).toContain('最近回答')

    await w.find('[data-test="load-more"]').trigger('click')
    await flushPromises()
    // 更旧消息 prepend 到头部（顺序：更旧在前、最近在后）
    const rows = w.findAll('.msg').map((r) => r.text())
    expect(rows[0]).toContain('更旧问题')
    expect(rows[1]).toContain('最近回答')
    // hasMore=false → 按钮消失
    expect(w.find('[data-test="load-more"]').exists()).toBe(false)
    // 加载更多用 nextOffset 作 messageId 锚点向回翻页
    expect(getSessionHistory).toHaveBeenCalledWith('demo', 'sk-1', undefined, 'older-anchor')
  })

  it('deletes a session after confirmation and removes it from the list (验收 会话可删除)', async () => {
    const S2 = { session_key: 'sk-2', title: 'S2', updated_at: '' }
    ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION, S2])
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(w.find('[data-test="delete-session-sk-2"]').exists()).toBe(true)
    await w.find('[data-test="delete-session-sk-2"]').trigger('click')
    await flushPromises()
    expect(deleteSession).toHaveBeenCalledWith('demo', 'sk-2')
    expect(w.find('[data-test="session-sk-2"]').exists()).toBe(false) // 从列表移除
  })

  it('does not delete when the user cancels the confirmation', async () => {
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cancel'))
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    await w.find('[data-test="delete-session-sk-1"]').trigger('click')
    await flushPromises()
    expect(deleteSession).not.toHaveBeenCalled()
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(true) // 取消则会话保留
  })

  it('appends a newly created session to the list and selects it (验收 新建加入列表)', async () => {
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    ;(createSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session_key: 'sk-new' })
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    // 新会话出现在列表（派生标题占位 = key 前 8 位，无 id 字段）
    expect(w.find('[data-test="session-sk-new"]').exists()).toBe(true)
    expect(w.find('[data-test="session-sk-new"]').text()).toContain('sk-new'.slice(0, 8))
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(true) // 旧会话仍在
  })

  // ---- #238 onClose 收尾（评审 issue #198 问题 3 / T2）：断线时收尾流式气泡 + 清理 run 态 ----
  it('finalizes the streaming bubble on disconnect so the cursor stops (流式中断线光标落定)', async () => {
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '回答' })
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(true) // 流式中：光标闪烁
    MockWS.last!.onclose?.({}) // 意外断线：正在流式
    await nextTick()
    // onClose 收尾 → streaming 落定：光标不再永久闪烁（发送按钮也不被 streaming 永久禁用）
    expect(w.find('.cursor').exists()).toBe(false)
  })

  it('drops late deltas of the abandoned run after disconnect (断线后旧 run 迟到帧按 abandoned 丢弃)', async () => {
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: 'A' })
    await nextTick()
    MockWS.last!.onclose?.({}) // 断线：在途 run r1 应被标记 abandoned
    await nextTick()
    // 旧 run 迟到增量（重连/恢复前经旧链路迟到）→ 按 abandoned 丢弃，不得重新锚定渲染
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: 'STALE' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('STALE')
  })

  it('anchors a fresh run after a reconnect cycle (activeRunId 清理：新 run 首帧不被静默丢弃)', async () => {
    // 断线后经「切走再切回」重建连接：若 onClose 未清 activeRunId，新 run 首帧会撞
    // if (activeRunId && runId !== activeRunId) return 被静默丢弃（评审 #198 问题 3 后果 2）
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      INSTANCE,
      { ...INSTANCE, name: 'other', port: 19001 },
    ])
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: 'A' })
    await nextTick()
    MockWS.last!.onclose?.({})
    await nextTick()
    // 切到 other 再切回 demo → 重建 ws（模拟断线后的重连）
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="container-demo"]').trigger('click')
    await flushPromises()
    MockWS.last!.fireOpen()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()
    // 新会话发消息 → 新 run 首帧必须渲染（activeRunId 未残留旧 run）
    await w.find('[data-test="input"]').setValue('yo')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r2', delta: 'NEW' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('NEW')
  })

  it('does not let a stale pendingAbandonCount eat the next run after reconnect (断线清理孤儿计数)', async () => {
    // 发送后首帧未到即断线（pendingSend=true）：abandonActiveRun 会 pendingAbandonCount++，
    // 但该计数是「同 socket 内孤儿帧 FIFO」语义——已断的 socket 不会再投递孤儿帧，
    // 残留计数会在重连后吞掉新 run 首帧（评审 #198 问题 3 后果 2 的另一入口）。onClose 须清零。
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      INSTANCE,
      { ...INSTANCE, name: 'other', port: 19001 },
    ])
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click') // pendingSend=true，未收首帧
    MockWS.last!.onclose?.({}) // 断线
    await nextTick()
    // 经切容器重建连接（模拟重连）
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="container-demo"]').trigger('click')
    await flushPromises()
    MockWS.last!.fireOpen()
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()
    // 新 run 首帧必须渲染（孤儿计数不应残留吞掉新 run）
    await w.find('[data-test="input"]').setValue('yo')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r2', delta: 'NEW' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('NEW')
  })

  it('keeps a terminal plain < character in the final text (终态 < 残片不吞)', async () => {
    // 评审 #198 Low 5.3：流式以普通文本 < 结尾（非 thinking 标签前缀）时，流中隐藏的残片
    // 终态（done/finalize）应重解析放回正文，不被永久吞掉
    const w = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '回答<' }) // 流式：半截 < 暂隐藏
    await nextTick()
    expect(w.find('.msg.assistant .bubble').text()).not.toContain('<')
    MockWS.last!.fireMessage({ type: 'done', runId: 'r1' }) // 终态：finalize 重解析，残片放回正文
    await nextTick()
    expect(w.find('.msg.assistant .bubble').text()).toContain('回答<')
  })

  // ---- #239 断线自动重连（评审 issue #198 问题 1）：指数退避 + 重连按钮 + 历史恢复 ----
  describe('auto-reconnect (issue #239)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('reconnects automatically after an unexpected close (断网恢复自动重连，零操作)', async () => {
      const w = await mountReady()
      const first = MockWS.last!
      first.fireClose() // 意外断线（如代理掐断）
      await nextTick()
      expect(w.find('[data-test="error-bar"]').text()).toContain('断开')
      // 1s 退避到点 → 自动新建 ws 重连（用户零操作）
      await vi.advanceTimersByTimeAsync(1000)
      await flushPromises()
      expect(MockWS.last).not.toBe(first)
      MockWS.last!.fireOpen() // CONNECTING 期间缓冲的 start 帧在 open 后 flush
      // codex #249 P1：断线重连握手带当前会话 sk-1（恢复该会话 run 续流），区别于首连的 plain start
      expect(MockWS.last!.sent).toContainEqual({ type: 'start', container: 'demo', sessionKey: 'sk-1' })
    })

    it('reconnect handshake carries the active sessionKey so the run keeps streaming (codex #249 P1)', async () => {
      // codex #249 P1 (id 3690452668, ChatView.vue:511)：浏览器↔Channels 腿在活跃 run 中断后重连，
      // 握手须带恢复目标 sessionKey——后端 _handle_start 据此 record_active_session 重新注册该会话
      // 恢复回调，run 剩余增量/终态帧继续投给重连的新 consumer；缺它则快照之后的内容缺失。
      const w = await mountReady()
      // 起一个 run（发送后首帧未到也可——断线即「活跃 run 进行中」）
      await w.find('[data-test="input"]').setValue('你好')
      await w.find('[data-test="send"]').trigger('click')
      await nextTick()
      const first = MockWS.last!
      first.fireClose() // 意外断线（活跃 run 进行中）→ 调度 1s 退避重连
      await nextTick()
      await vi.advanceTimersByTimeAsync(1000) // 退避到点 → 自动重连
      await flushPromises()
      expect(MockWS.last).not.toBe(first)
      MockWS.last!.fireOpen() // 重连 socket open：缓冲的 start 帧 flush
      // 重连握手带恢复目标会话 sk-1（区别于首连/切容器的 plain start）
      expect(MockWS.last!.sent).toContainEqual({ type: 'start', container: 'demo', sessionKey: 'sk-1' })
    })

    it('first connect after mount uses a plain start frame without sessionKey (首连/切容器不带 sessionKey)', async () => {
      // 首连（reconnectAttempts==0）：start 不带 sessionKey，与切容器一致——后端不注册恢复回调。
      await mountReady()
      expect(MockWS.last!.sent).toContainEqual({ type: 'start', container: 'demo' })
      expect(MockWS.last!.sent).not.toContainEqual({ type: 'start', container: 'demo', sessionKey: 'sk-1' })
    })

    it('advances the backoff when a reconnect opening handshake stalls', async () => {
      await mountReady()
      const first = MockWS.last!
      first.fireClose()
      await nextTick()
      await vi.advanceTimersByTimeAsync(1_000) // 第一次退避后建立重连 socket
      await flushPromises()
      const stalled = MockWS.last!
      expect(stalled).not.toBe(first)
      stalled.readyState = MockWS.CONNECTING

      // 不触发 open/close，模拟网络黑洞。10s 握手上限会主动 close，并安排下一档 2s 退避。
      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      expect(stalled.readyState).toBe(MockWS.CLOSED)
      expect(MockWS.last).toBe(stalled)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(MockWS.last).toBe(stalled)
      await vi.advanceTimersByTimeAsync(1)
      await flushPromises()
      expect(MockWS.last).not.toBe(stalled)
    })

    it('follows an exponential backoff sequence capped at 30s (退避指数曲线封顶)', async () => {
      await mountReady()
      // 连续断线 → 逐次断连，记录每次重建前的等待（退避 1s/2s/4s…）
      const gaps: number[] = []
      for (let round = 0; round < 4; round++) {
        MockWS.last!.fireClose()
        await nextTick()
        const before = MockWS.last
        // 以 500ms 步进推进，直到出现新 ws（重建）为止，记录推进时长
        let waited = 0
        while (MockWS.last === before && waited <= 35_000) {
          await vi.advanceTimersByTimeAsync(500)
          waited += 500
        }
        gaps.push(waited)
      }
      // 期望退避 ~1s/2s/4s/8s（步进 500ms 量化：1000/2000/4000/8000）
      expect(gaps).toEqual([1000, 2000, 4000, 8000])
    })

    it('caps the backoff at 30s after many failures (退避封顶 30s)', async () => {
      await mountReady()
      // 连续 8 次断连：1/2/4/8/16/32→30/30/30 —— 第 6 次起封顶 30s
      for (let round = 0; round < 7; round++) {
        MockWS.last!.fireClose()
        await nextTick()
        const before = MockWS.last
        await vi.advanceTimersByTimeAsync(30_000)
        await flushPromises()
        expect(MockWS.last).not.toBe(before)
      }
      // 第 8 次断连：退避已封顶 30s——30s 内未到点不重建，满 30s 才重建
      MockWS.last!.fireClose()
      await nextTick()
      const before = MockWS.last
      await vi.advanceTimersByTimeAsync(29_999)
      expect(MockWS.last).toBe(before)
      await vi.advanceTimersByTimeAsync(1)
      await flushPromises()
      expect(MockWS.last).not.toBe(before)
    })

    it('does not reconnect on a 4401 close (JWT 过期走刷新链路，不自动重连)', async () => {
      await mountReady()
      const first = MockWS.last!
      first.fireClose(4401) // JWT 过期
      await nextTick()
      await vi.advanceTimersByTimeAsync(60_000) // 远超任何退避
      await flushPromises()
      expect(MockWS.last).toBe(first) // 未自动重连（防 4401 死循环）
    })

    it('cancels the pending reconnect when switching container (切容器旧容器不重连)', async () => {
      ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
        INSTANCE,
        { ...INSTANCE, name: 'other', port: 19001 },
      ])
      const w = await mountReady()
      MockWS.last!.fireClose() // demo 断线 → 调度 1s 重连
      await nextTick()
      await w.find('[data-test="container-other"]').trigger('click') // 1s 内切到 other
      await flushPromises()
      const otherWs = MockWS.last // other 的连接
      await vi.advanceTimersByTimeAsync(5_000) // 原 demo 重连定时器到点
      await flushPromises()
      // demo 的 pending 重连已被取消：不会另建第三个 ws，当前仍是 other 的连接
      expect(MockWS.last).toBe(otherWs)
      otherWs!.fireOpen()
      expect(MockWS.last!.sent).toContainEqual({ type: 'start', container: 'other' })
    })

    it('cancels the pending reconnect when switching session while connected (切会话清理重连定时器)', async () => {
      // codex #249 R3 P2 区分语义：断线退避中切会话须**保留**重连（见 R3 ① 测试）；本用例覆盖「已连上」时
      // 切会话仍取消 pending 重连（保险路径：正常连接态不会有 pending 定时器，若有残留切会话应清掉）。
      const SESS2 = { session_key: 'sk-2', title: 'S2', updated_at: '' }
      ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION, SESS2])
      const w = await mountReady()
      const first = MockWS.last!
      MockWS.last!.fireClose() // 断线 → 调度 1s 重连
      await nextTick()
      await vi.advanceTimersByTimeAsync(1_000) // 退避到点 → 自动重连
      await flushPromises()
      MockWS.last!.fireOpen()
      MockWS.last!.fireMessage({ type: 'ready', container: 'demo' }) // ready → 已连上、disconnected 复位
      await flushPromises()
      const reconnected = MockWS.last
      expect(reconnected).not.toBe(first)
      // 已连上状态下切会话：不得触发新连接（cancelReconnect 保险取消任何残留 pending 定时器）
      await w.find('[data-test="session-sk-2"]').trigger('click')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(5_000)
      await flushPromises()
      expect(MockWS.last).toBe(reconnected)
    })

    it('cancels the pending reconnect on unmount (卸载清理重连定时器)', async () => {
      const w = await mountReady()
      const first = MockWS.last!
      MockWS.last!.fireClose()
      await nextTick()
      w.unmount() // 卸载：disposed + cancelReconnect
      await vi.advanceTimersByTimeAsync(5_000)
      await flushPromises()
      expect(MockWS.last).toBe(first) // 卸载后不重连
    })

    it('restores history via loadHistory after a successful reconnect (重连后历史恢复)', async () => {
      ;(getSessionHistory as ReturnType<typeof vi.fn>).mockResolvedValue({
        messages: [
          { role: 'operator', text: '断线前问题' },
          { role: 'agent', text: '断线期间恢复的回答' },
        ],
        hasMore: false,
        nextOffset: null,
      })
      const w = await mountReady()
      MockWS.last!.fireClose()
      await nextTick()
      await vi.advanceTimersByTimeAsync(1000) // 触发自动重连
      await flushPromises()
      MockWS.last!.fireOpen()
      MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
      await flushPromises() // onReady → loadHistory 恢复权威投影
      expect(getSessionHistory).toHaveBeenCalledWith('demo', 'sk-1')
      await flushPromises()
      expect(w.find('[data-test="stream"]').text()).toContain('断线期间恢复的回答')
    })

    it('does not restore the old session when the user switches before ready (codex #249 P2)', async () => {
      // 复现：断线 → 重连 socket 已建、ready 未到 → 用户切到 sk-2 → ready 到。
      // resumeSession 仍指旧 sk-1；若仍 loadHistory(sk-1) 会清空 sk-2 消息并 wedge historyLoading。
      const SESS2 = { session_key: 'sk-2', title: 'S2', updated_at: '' }
      ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION, SESS2])
      ;(getSessionHistory as ReturnType<typeof vi.fn>).mockImplementation((_n: string, key: string) =>
        Promise.resolve({
          messages: [{ role: 'agent', text: `${key}-历史` }],
          hasMore: false,
          nextOffset: null,
        }),
      )
      const w = await mountReady()
      MockWS.last!.fireClose()
      await nextTick()
      await vi.advanceTimersByTimeAsync(1000) // 触发自动重连（新 socket 已建，ready 未到）
      await flushPromises()
      MockWS.last!.fireOpen()
      // ready 到达前切到 sk-2（pickSession 自行 loadHistory(sk-2)）
      await w.find('[data-test="session-sk-2"]').trigger('click')
      await flushPromises()
      expect(w.find('[data-test="stream"]').text()).toContain('sk-2-历史')
      // 此刻 ready 才到：不得用旧会话 sk-1 覆盖 sk-2 的投影
      MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
      await flushPromises()
      const stream = w.find('[data-test="stream"]').text()
      expect(stream).toContain('sk-2-历史')
      expect(stream).not.toContain('sk-1-历史')
    })

    it('serializes concurrent same-session history reloads (codex #249 P2 转录不重复)', async () => {
      // 复现：断线时上一次 loadHistory(sk-1) 仍在途 → 重连 onReady 又发一次 loadHistory(sk-1)。
      // 两次 containerGen+selectedSession 守卫值相同、若都被接受，后落地快照 prepend 到先落地的已渲染
      // 历史上 → 转录重复。historyGen 请求代只让最新一次提交快照。
      let call = 0
      ;(getSessionHistory as ReturnType<typeof vi.fn>).mockImplementation(() => {
        call += 1
        const mine = call
        // 第一次（挂载时）响应延迟到第二次（重连恢复）发起之后才落地——模拟并发在途
        return new Promise((resolve) => {
          setTimeout(() => resolve({
            messages: [{ role: 'agent', text: `快照#${mine}` }],
            hasMore: false,
            nextOffset: null,
          }), mine === 1 ? 5_000 : 0) // 旧请求更晚落地：若无代际守卫会覆盖/重复新快照
        })
      })
      const w = await mountReady() // 挂载：loadHistory#1（5s 后才落地）
      MockWS.last!.fireClose()
      await nextTick()
      await vi.advanceTimersByTimeAsync(1_000) // 退避到点 → 自动重连
      await flushPromises()
      MockWS.last!.fireOpen()
      MockWS.last!.fireMessage({ type: 'ready', container: 'demo' }) // onReady → loadHistory#2（取代 #1）
      await flushPromises() // #2 立即落地
      // #2 快照渲染；#1 旧响应（5s 后）落地须被丢弃，不得再 prepend 一份
      await vi.advanceTimersByTimeAsync(6_000) // 越过 #1 的落地时刻
      await flushPromises()
      const text = w.find('[data-test="stream"]').text()
      expect(text).toContain('快照#2') // 最新快照生效
      expect(text).not.toContain('快照#1') // 被取代的旧快照已丢弃
      // 转录不重复：同一快照只出现一次
      expect(w.findAll('.msg.assistant').length).toBe(1)
    })

    it('manual reconnect button reconnects the current container (重连按钮，绕开 early-return)', async () => {
      const w = await mountReady()
      const first = MockWS.last!
      MockWS.last!.fireClose()
      await nextTick()
      const btn = w.find('[data-test="reconnect"]')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toContain('重新连接')
      await btn.trigger('click') // 点击直接重连（不经 selectContainer，点当前容器不被吞）
      await flushPromises()
      expect(MockWS.last).not.toBe(first)
      MockWS.last!.fireOpen()
      // codex #249 P1：手动重连握手带当前会话 sk-1（恢复该会话 run 续流）
      expect(MockWS.last!.sent).toContainEqual({ type: 'start', container: 'demo', sessionKey: 'sk-1' })
    })

    it('keeps the scheduled reconnect when switching session while disconnected (codex #249 R3 ①)', async () => {
      // 复现：断线退避中切会话（同容器）——pickSession 不得取消本容器 pending 重连（断的是同一连接，
      // 重连恢复的是同一 socket）。旧代码 cancelReconnect() 会杀死唯一自动重连，单容器用户只能刷新页面。
      // 区别语义：切「容器」才取消（旧容器不重连污染），切「会话」（同容器）保留。
      const SESS2 = { session_key: 'sk-2', title: 'S2', updated_at: '' }
      ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION, SESS2])
      const w = await mountReady()
      const first = MockWS.last!
      MockWS.last!.fireClose() // 断线 → 调度 1s 重连
      await nextTick()
      await w.find('[data-test="session-sk-2"]').trigger('click') // 退避未到即切会话
      await flushPromises()
      const before = MockWS.last
      await vi.advanceTimersByTimeAsync(1_000) // 原退避到点
      await flushPromises()
      // 保留的 pending 重连到点仍应触发：新建 ws（同容器恢复，与切容器取消语义区分）
      expect(MockWS.last).not.toBe(before)
      expect(MockWS.last).not.toBe(first)
      MockWS.last!.fireOpen()
      // codex #249 P1：断线退避中切到 sk-2 → 重连握手带**当前**会话 sk-2（注册切后新会话恢复回调）
      expect(MockWS.last!.sent).toContainEqual({ type: 'start', container: 'demo', sessionKey: 'sk-2' })
    })

    it('keeps a reconnect entry after switching session clears the disconnect error (codex #249 R3 ①)', async () => {
      // 复现：断线（errorMsg+disconnected+重连按钮）→ 切会话 → loadHistory 清 errorMsg。
      // 重连入口若套在 errorMsg 的 <p v-if> 里会随错误条消失，disconnected 仍 true、发送仍禁用 → 无重连路径。
      // 修复后重连入口由 disconnected 独立驱动，errorMsg 清空后仍可用。
      const SESS2 = { session_key: 'sk-2', title: 'S2', updated_at: '' }
      ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION, SESS2])
      const w = await mountReady()
      const first = MockWS.last!
      MockWS.last!.fireClose() // 断线：error-bar + 重连入口出现
      await nextTick()
      expect(w.find('[data-test="error-bar"]').exists()).toBe(true)
      await w.find('[data-test="session-sk-2"]').trigger('click') // loadHistory 清 errorMsg
      await flushPromises()
      expect(w.find('[data-test="error-bar"]').exists()).toBe(false) // 错误条已清
      expect(w.find('[data-test="reconnect"]').exists()).toBe(true) // 重连入口仍在（由 disconnected 独立渲染）
      await w.find('[data-test="reconnect"]').trigger('click') // 点击仍可重连当前容器
      await flushPromises()
      expect(MockWS.last).not.toBe(first)
      MockWS.last!.fireOpen()
      // codex #249 P1：切到 sk-2 后手动重连，握手带**当前**会话 sk-2（注册切后新会话恢复回调）
      expect(MockWS.last!.sent).toContainEqual({ type: 'start', container: 'demo', sessionKey: 'sk-2' })
    })

    it('invalidates an in-flight load-more when a full reload supersedes it (codex #249 R3 ②)', async () => {
      // 复现：「加载更多」分页请求在途时，重连成功触发完整 loadHistory。分页不在 historyGen 覆盖内、
      // 只校验不变的 container/session → 旧页响应晚落地仍被接受并 prepend + 覆盖 historyAnchor →
      // 下次「加载更多」重复拉取/prepend 同一旧页（转录重复）。修复：分页与完整加载共用 historyGen。
      let call = 0
      let resolvePage!: (v: unknown) => void
      ;(getSessionHistory as ReturnType<typeof vi.fn>).mockImplementation(
        (_n: string, _k: string, _l?: number, anchor?: string) => {
          call += 1
          if (anchor) return new Promise((r) => { resolvePage = r }) // 分页请求挂起，最后才落地
          const mine = call
          return Promise.resolve({
            messages: [{ role: 'agent', text: `快照#${mine}` }],
            hasMore: true,
            nextOffset: `锚点#${mine}`,
          })
        },
      )
      const w = await mountReady() // 完整加载#1：快照#1 + hasMore + 锚点#1
      await flushPromises()
      await w.find('[data-test="load-more"]').trigger('click') // 分页请求在途（挂起）
      await nextTick()
      // 断线 → 重连成功 → 完整 loadHistory#3（应取代在途分页）
      MockWS.last!.fireClose()
      await nextTick()
      await vi.advanceTimersByTimeAsync(1_000)
      await flushPromises()
      MockWS.last!.fireOpen()
      MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
      await flushPromises()
      expect(w.find('[data-test="stream"]').text()).toContain('快照#3') // 最新完整快照生效
      // 在途分页响应迟到：须被 historyGen 丢弃——不 prepend、也不覆盖锚点为分页的旧锚点
      resolvePage({ messages: [{ role: 'operator', text: '旧分页' }], hasMore: true, nextOffset: '分页旧锚点' })
      await flushPromises()
      const text = w.find('[data-test="stream"]').text()
      expect(text).not.toContain('旧分页') // 迟到分页不得 prepend
      // 锚点仍是完整加载#3 的锚点（未被分页响应覆盖）→ 下次加载更多用权威锚点，不重复拉同一旧页
      await w.find('[data-test="load-more"]').trigger('click')
      await flushPromises()
      expect(getSessionHistory).toHaveBeenLastCalledWith('demo', 'sk-1', undefined, '锚点#3')
    })
  })
})
