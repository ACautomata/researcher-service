// seam: ChatView 对话页 —— issue #41 前端（spec §9.4）。
// 覆盖：mount 拉容器并自动连 WS+start、发送后流式逐字 + 光标 + done 收尾、error 帧错误条、
// 意外断线提示、新建会话。stub 原生 WebSocket（MockWS）捕获 handlers；mock containers/chat API。
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/containers', () => ({ listInstances: vi.fn() }))
vi.mock('@/api/chat', () => ({ listSessions: vi.fn(), createSession: vi.fn() }))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }
})

import ChatView from '@/views/ChatView.vue'
import { listInstances } from '@/api/containers'
import { createSession, listSessions } from '@/api/chat'
import { useAuthStore } from '@/stores/auth'

class MockWS {
  static last: MockWS | null = null
  sent: unknown[] = []
  closed = false // 记录 close() 是否被调用（验证切容器时旧 ws 被关闭）
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
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.closed = true
    this.onclose?.({})
  }

  fireOpen(): void {
    this.onopen?.({})
  }

  fireMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
}

const INSTANCE = {
  name: 'demo', port: 19000, status: 'running', health: 'healthy',
  image: 'i', container_id: 'c', created_at: '', pairing: { status: 'paired' },
}
const SESSION = { id: 1, session_key: 'sk-1', title: '文献综述', created_at: '' }

describe('ChatView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    MockWS.last = null
    vi.clearAllMocks()
    vi.stubGlobal('WebSocket', MockWS)
    useAuthStore().$patch({ token: 'jwt-test' })
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([INSTANCE])
    ;(listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([SESSION])
    ;(createSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION)
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
    const SESS2 = { id: 2, session_key: 'sk-2', title: 'S2', created_at: '' }
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
    resolveB.fn!([{ id: 2, session_key: 'sk-b', title: 'B', created_at: '' }]) // other 先回
    await flushPromises()
    resolveA.fn!([{ id: 9, session_key: 'sk-stale', title: 'Stale', created_at: '' }]) // demo 迟到
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
    const SESS2 = { id: 2, session_key: 'sk-2', title: 'S2', created_at: '' }
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
    expect(MockWS.last!.sent).toContainEqual({ type: 'resolve', id: 'ap-1', kind: 'exec', decision: 'approve' })
    await nextTick()
    // pending：按钮禁用但卡片未标记 resolved（等服务端回执，不乐观假成功）
    const card = w.find('[data-test="approval-ap-1"]')
    expect(card.classes()).not.toContain('resolved')
    expect((w.find('[data-test="approve-ap-1"]').element as HTMLButtonElement).disabled).toBe(true)
    // 服务端回执到达才落定变淡
    MockWS.last!.fireMessage({ type: 'approvalResolved', id: 'ap-1', decision: 'approve' })
    await nextTick()
    const card2 = w.find('[data-test="approval-ap-1"]')
    expect(card2.classes()).toContain('resolved')
    expect(card2.text()).toContain('已批准')
  })

  it('approvalResolved uses authoritative decision, not requested (codex P1)', async () => {
    const w = await mountReady()
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'cmd', sessionKey: 'sk-1' })
    await nextTick()
    await w.find('[data-test="approve-ap-1"]').trigger('click') // 请求 approve
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
    const SESS2 = { id: 2, session_key: 'sk-2', title: 'S2', created_at: '' }
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
    expect(MockWS.last!.sent).toContainEqual({ type: 'resolve', id: 'ap-x', kind: 'exec', decision: 'approve' })
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
})
