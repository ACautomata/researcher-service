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
    this.onclose?.({})
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
    expect(w.find('[data-test="container-demo"]').exists()).toBe(true)
    expect(MockWS.last).not.toBeNull()
    expect(MockWS.last!.sent).toContainEqual({ type: 'start', container: 'demo' })
  })

  it('sends a message and streams the assistant reply with cursor then done', async () => {
    const w = mount(ChatView, { global: { plugins: [createPinia()] } })
    await flushPromises()
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
    oldWs!.fireMessage({ type: 'ready', container: 'demo' })
    await nextTick()

    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises() // selectContainer → connect 新 ws
    const newWs = MockWS.last // other 的 ws
    newWs!.fireMessage({ type: 'ready', container: 'other' })
    await nextTick()

    // 旧 ws 推 text → onText stale guard（ws !== myWs）拦截，不污染新会话
    oldWs!.fireMessage({ type: 'text', runId: 'r1', delta: 'STALE' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('STALE')
  })
})
