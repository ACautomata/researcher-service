// seam: ChatView 对话页 —— issue #41 前端（spec §9.4）+ #369 M5 隧道接线。
// 覆盖：mount 拉容器 → bootstrap-token → 建 GatewayChat → listSessions/history、发送后流式逐字 +
// 光标 + done 收尾、error 帧错误条、断线提示、审批卡、工具行、thinking 剥离、历史分页、4401 刷新重建。
// mock @/chat/gatewayChat（createGatewayChat → 可控 MockGatewayChat），触发 onReady/onFrame/onClose。

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/containers', () => ({ listInstances: vi.fn() }))
vi.mock('@/api/chat', () => ({ getBootstrapToken: vi.fn() }))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn() },
  }
})

type MockHandlers = {
  onReady: () => void
  onFrame: (frame: unknown) => void
  onClose: (code: number, reason: string) => void
  onError: (message: string) => void
}

const { MockGatewayChat } = vi.hoisted(() => {
  class MockGatewayChat {
    static last: MockGatewayChat | null = null
    static instances: MockGatewayChat[] = []
    handlers: MockHandlers
    listSessions = vi.fn()
    createSession = vi.fn()
    deleteSession = vi.fn()
    getHistory = vi.fn()
    send = vi.fn()
    listCommands = vi.fn()
    resolveApproval = vi.fn()
    start = vi.fn()
    stop = vi.fn()
    constructor(handlers: MockHandlers) {
      this.handlers = handlers
      MockGatewayChat.instances.push(this)
      MockGatewayChat.last = this
    }
    fireReady(): void {
      this.handlers.onReady()
    }
    fireFrame(frame: unknown): void {
      this.handlers.onFrame(frame)
    }
    fireClose(code: number, reason = ''): void {
      this.handlers.onClose(code, reason)
    }
    fireError(message: string): void {
      this.handlers.onError(message)
    }
  }
  return { MockGatewayChat }
})

vi.mock('@/chat/gatewayChat', () => ({
  createGatewayChat: vi.fn(),
}))

import ChatView from '@/views/ChatView.vue'
import { listInstances } from '@/api/containers'
import { getBootstrapToken } from '@/api/chat'
import { createGatewayChat } from '@/chat/gatewayChat'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/client'
import { ElMessageBox } from 'element-plus'

const INSTANCE = {
  name: 'demo', port: 19000, status: 'running', health: 'healthy',
  image: 'i', container_id: 'c', created_at: '', pairing: { status: 'unpaired' },
}
const OTHER_INSTANCE = {
  name: 'other', port: 19001, status: 'running', health: 'healthy',
  image: 'i', container_id: 'd', created_at: '', pairing: { status: 'unpaired' },
}
const SESSION = { session_key: 'sk-1', title: '文献综述', updated_at: '' }

// 挂载 ChatView 并完成首连：listInstances → selectContainer → bootstrap-token → createGatewayChat →
// fireReady（openGateway 就绪）→ listSessions → loadHistory。返回当前 gateway 供触发事件。
async function mountReady() {
  const w = mount(ChatView)
  await flushPromises() // listInstances → selectContainer → getBootstrapToken → createGatewayChat + start
  const gw = MockGatewayChat.last!
  gw.listSessions.mockResolvedValue([SESSION])
  gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
  gw.createSession.mockResolvedValue('sk-new')
  gw.listCommands.mockResolvedValue([])
  gw.send.mockResolvedValue(undefined)
  gw.deleteSession.mockResolvedValue(undefined)
  gw.resolveApproval.mockResolvedValue(undefined)
  gw.fireReady() // openGateway 连接就绪
  await flushPromises() // selectContainer 续 listSessions + loadHistory
  return { w, gw }
}

describe('ChatView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    MockGatewayChat.instances = []
    MockGatewayChat.last = null
    vi.clearAllMocks()
    useAuthStore().$patch({ token: 'jwt-test' })
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([INSTANCE, OTHER_INSTANCE])
    ;(getBootstrapToken as ReturnType<typeof vi.fn>).mockResolvedValue('boot-1')
    ;(createGatewayChat as ReturnType<typeof vi.fn>).mockImplementation(
      (params: { handlers: MockHandlers }) => new MockGatewayChat(params.handlers),
    )
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mount 拉容器 → bootstrap-token → 建隧道 gateway → listSessions 渲染会话', async () => {
    const { w, gw } = await mountReady()
    expect(getBootstrapToken).toHaveBeenCalledWith('demo')
    expect(createGatewayChat).toHaveBeenCalledTimes(1)
    const params = (createGatewayChat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(params.container).toBe('demo')
    expect(params.jwt).toBe('jwt-test')
    expect(params.bootstrapToken).toBe('boot-1')
    expect(gw.listSessions).toHaveBeenCalled()
    expect(gw.start).toHaveBeenCalledTimes(1)
    expect(w.find('[data-test="container-demo"]').exists()).toBe(true)
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(true)
  })

  it('发送消息 → 流式 text 逐字 + 光标 → done 收尾', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('你好')
    await w.find('[data-test="send"]').trigger('click')
    expect(gw.send).toHaveBeenCalledWith('sk-1', '你好')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '回答' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('回答')
    expect(w.find('.cursor').exists()).toBe(true)
    gw.fireFrame({ type: 'done', runId: 'r1' })
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(false)
  })

  it('error 帧（消费者级，无 runId）→ 错误条', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'error', message: '模型超时' })
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('模型超时')
  })

  it('F8: 空闲时外来 run 的 error 不显示、不动占位（防误伤用户 run）', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'error', runId: 'foreign-1', message: '外来 run 失败' })
    await nextTick()
    expect(w.find('[data-test="error-bar"]').exists()).toBe(false)
    // 用户发送正常：占位不受影响
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('回复')
    gw.fireFrame({ type: 'done', runId: 'user-run' })
  })

  it('F8: pendingSend 期间外来 run 的 error 不终结占位/清 flag（用户 run 首帧仍正常）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    // 在途（pendingSend=true，首帧未到）：外来 run 的 error → 只显示错误，不终结占位
    gw.fireFrame({ type: 'error', runId: 'foreign-1', message: '外来 run 失败' })
    await nextTick()
    // 用户 run 首帧到达 → 正常 claim 并 append（若 flag 被清/占位被终结，此处会丢）
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '真实回复' })
    await nextTick()
    const streamText = w.find('[data-test="stream"]').text()
    expect(streamText).toContain('真实回复')
    expect(streamText).toContain('我的问题')
    gw.fireFrame({ type: 'done', runId: 'user-run' })
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(false) // done 收尾，光标消失
  })

  it('F7: 空闲期外来 run 首帧被记录，其续帧（用户 send 后）不劫持用户 run', async () => {
    const { w, gw } = await mountReady()
    // 空闲：外来 run 首帧 → 不渲染、runId 被记录
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '外来文本' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('外来文本')
    // 用户发送 → 在途
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    // 外来 run 续帧先到（用户 run 首帧之前）→ 按 runId 丢弃，不抢占 activeRunId
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '（外来追加）' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('（外来追加）')
    // 用户 run 首帧 → 正常 claim
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '真实回复' })
    await nextTick()
    const streamText = w.find('[data-test="stream"]').text()
    expect(streamText).toContain('真实回复')
    expect(streamText).toContain('我的问题')
    gw.fireFrame({ type: 'done', runId: 'user-run' })
  })

  it('F3: send RPC 失败 → pendingSend 复位（切会话不产生 phantom orphan，下次首帧不被吞）', async () => {
    const { w, gw } = await mountReady()
    gw.send.mockRejectedValueOnce(new Error('未配对'))
    await w.find('[data-test="input"]').setValue('第一条')
    await w.find('[data-test="send"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="error-bar"]').text()).toContain('未配对')
    // 切到新会话（abandonActiveRun）
    gw.createSession.mockResolvedValueOnce('sk-2')
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    // 第二次发送（新会话）→ 首帧不被 pendingAbandonCount 吞
    await w.find('[data-test="input"]').setValue('第二条')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r2', delta: '第二条回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('第二条回复')
  })

  it('意外断线（非 4401）→ disconnected 提示 + 禁发', async () => {
    const { w, gw } = await mountReady()
    gw.fireClose(1006)
    await nextTick()
    expect(w.find('[data-test="reconnect-bar"]').exists()).toBe(true)
    expect(w.find('[data-test="send"]').attributes('disabled')).toBeDefined()
  })

  it('新建会话 → gateway.createSession + 列表追加', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    expect(gw.createSession).toHaveBeenCalled()
    expect(w.find('[data-test="session-sk-new"]').exists()).toBe(true)
  })

  it('assistant 流式中禁用发送（防止并发 send 卡住旧消息）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: 'x' })
    await nextTick()
    expect(w.find('[data-test="send"]').attributes('disabled')).toBeDefined()
  })

  it('切容器后旧 gateway 的迟到帧不污染新会话（stale guard）', async () => {
    const { w } = await mountReady()
    const first = MockGatewayChat.last!
    // 切到另一容器：selectContainer → openGateway → 新 gateway 实例
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const second = MockGatewayChat.last!
    expect(second).not.toBe(first) // 新 gateway
    second.listSessions.mockResolvedValue([])
    second.createSession.mockResolvedValue('sk-other')
    second.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    second.listCommands.mockResolvedValue([])
    second.send.mockResolvedValue(undefined)
    second.fireReady() // 新容器连接就绪 → listSessions([]) → newSession(sk-other)
    await flushPromises()
    // 旧 gateway 的迟到 text 帧 → stale guard 丢弃（gateway !== myGw）
    first.fireFrame({ type: 'text', runId: 'old-run', delta: '旧回答' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('旧回答')
    first.stop()
  })

  it('切会话（newSession）后旧 run 的迟到 delta 丢弃（runId 路由）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '第一段' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('第一段')
    // 新建会话 → abandonActiveRun 标记 r1 + 清空消息
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '迟到' }) // 旧 run 迟到帧
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('迟到')
  })

  it('审批卡：requested → 渲染；resolve → RPC + 回执权威落定', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: null })
    await nextTick()
    expect(w.find('[data-test="approval-ap-1"]').exists()).toBe(true)
    await w.find('[data-test="approve-ap-1"]').trigger('click')
    expect(gw.resolveApproval).toHaveBeenCalledWith('ap-1', 'exec', 'allow-once')
    gw.fireFrame({ type: 'approvalResolved', id: 'ap-1', decision: 'allow-once' })
    await nextTick()
    expect(w.find('[data-test="approval-ap-1"]').text()).toContain('已批准')
  })

  it('审批卡未知权威 decision → 显示「未知」而非已批准', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-2', kind: 'exec', command: 'x', sessionKey: null })
    await nextTick()
    gw.fireFrame({ type: 'approvalResolved', id: 'ap-2', decision: 'expired' })
    await nextTick()
    expect(w.find('[data-test="approval-ap-2"]').text()).toContain('未知')
  })

  it('resolve RPC 失败 → 恢复该卡为 pending 可重试', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-3', kind: 'exec', command: 'x', sessionKey: null })
    await nextTick()
    gw.resolveApproval.mockRejectedValue(new Error('gateway down'))
    await w.find('[data-test="approve-ap-3"]').trigger('click')
    await flushPromises()
    // 恢复 pending：批准按钮重新可用
    expect(w.find('[data-test="approve-ap-3"]').attributes('disabled')).toBeUndefined()
  })

  it('切容器清空审批卡', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-9', kind: 'exec', command: 'x', sessionKey: null })
    await nextTick()
    expect(w.find('[data-test="approval-ap-9"]').exists()).toBe(true)
    // 切到另一容器 → approvals 清空
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const second = MockGatewayChat.last!
    second.listSessions.mockResolvedValue([])
    second.createSession.mockResolvedValue('sk-other')
    second.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    second.listCommands.mockResolvedValue([])
    second.fireReady()
    await flushPromises()
    expect(w.find('[data-test="approval-ap-9"]').exists()).toBe(false)
  })

  it('工具行：start → running 行；result → done 状态', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('搜资料')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running', id: 'call-1', title: null, input: { query: '对比' }, result: null })
    await nextTick()
    expect(w.find('[data-test="tool-line"]').text()).toContain('wiki.search')
    expect(w.find('[data-test="tool-line"]').text()).toContain('⟳')
    gw.fireFrame({ type: 'tool', runId: 'r1', name: 'wiki.search', state: 'done', id: 'call-1', title: null, input: null, result: { count: 3 } })
    await nextTick()
    expect(w.find('[data-test="tool-line"]').text()).toContain('✓')
  })

  it('thinking 剥离：<thinking> 折叠卡 + 正文不含标签', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '<thinking>内心独白</thinking>回答' })
    await nextTick()
    expect(w.find('[data-test="cot-card"]').exists()).toBe(true)
    expect(w.find('[data-test="stream"]').text()).toContain('回答')
    expect(w.find('[data-test="stream"]').text()).not.toContain('<thinking>')
  })

  it('会话历史加载：切会话 → gateway.getHistory 渲染', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION, { session_key: 'sk-2', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    gw.fireReady()
    await flushPromises() // 选中 sk-1 + loadHistory(空)
    gw.getHistory.mockResolvedValue({
      messages: [{ role: 'assistant', text: '历史回答' }],
      hasMore: false,
      nextOffset: null,
    })
    await w.find('[data-test="session-sk-2"]').trigger('click')
    await flushPromises()
    expect(gw.getHistory).toHaveBeenCalled()
    expect(w.find('[data-test="stream"]').text()).toContain('历史回答')
  })

  it('历史分页：hasMore 时 load-more 用 nextOffset 锚点拉更旧页', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION])
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    // 首次 loadHistory 返回 hasMore:true（触发「加载更多」按钮）；load-more 拉更旧页
    gw.getHistory
      .mockResolvedValueOnce({ messages: [{ role: 'user', text: '旧页' }], hasMore: true, nextOffset: 10 })
      .mockResolvedValueOnce({ messages: [{ role: 'user', text: '更旧页' }], hasMore: false, nextOffset: null })
    gw.fireReady()
    await flushPromises() // selectContainer 续 listSessions + loadHistory(hasMore:true)
    expect(w.find('[data-test="load-more"]').exists()).toBe(true)
    await w.find('[data-test="load-more"]').trigger('click')
    await flushPromises()
    expect(gw.getHistory).toHaveBeenLastCalledWith('sk-1', undefined, '10')
    expect(w.find('[data-test="stream"]').text()).toContain('更旧页')
  })

  it('删除会话：确认后 gateway.deleteSession + 列表移除', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="delete-session-sk-1"]').trigger('click')
    await flushPromises()
    expect(gw.deleteSession).toHaveBeenCalledWith('sk-1')
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(false)
  })

  it('取消删除确认 → 不调 deleteSession', async () => {
    const { w, gw } = await mountReady()
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cancel'))
    await w.find('[data-test="delete-session-sk-1"]').trigger('click')
    await flushPromises()
    expect(gw.deleteSession).not.toHaveBeenCalled()
  })

  it('4401 close → forceRefresh 成功 → 新 token 重建 gateway', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const first = MockGatewayChat.last!
    first.listSessions.mockResolvedValue([SESSION])
    first.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    first.listCommands.mockResolvedValue([])
    first.send.mockResolvedValue(undefined)
    const auth = useAuthStore()
    vi.spyOn(auth, 'forceRefresh').mockImplementation(async () => {
      auth.token = 'jwt-refreshed'
      auth.refreshExhausted = false
    })
    first.fireReady()
    await flushPromises()
    first.fireClose(4401) // JWT 过期
    await flushPromises() // forceRefresh + openGateway
    expect(auth.forceRefresh).toHaveBeenCalled()
    expect(MockGatewayChat.last).not.toBe(first) // 已重建 gateway
    const second = MockGatewayChat.last!
    expect(second.handlers).toBeTruthy()
    // 重建后的 token 参数
    const params = (createGatewayChat as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    expect(params.jwt).toBe('jwt-refreshed')
    // F5: 重建后 fireReady → onReady 会 syncSessions 补拉会话，需配置 mock
    second.listSessions.mockResolvedValue([SESSION])
    second.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    second.listCommands.mockResolvedValue([])
    second.send.mockResolvedValue(undefined)
    second.fireReady()
    await flushPromises()
    expect(w.find('[data-test="container-demo"]').exists()).toBe(true)
    w.unmount()
  })

  it('4401 close → refreshExhausted → 清会话跳登录，不重建', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const first = MockGatewayChat.last!
    first.listSessions.mockResolvedValue([SESSION])
    first.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    first.listCommands.mockResolvedValue([])
    first.send.mockResolvedValue(undefined)
    const auth = useAuthStore()
    vi.spyOn(auth, 'forceRefresh').mockImplementation(async () => {
      auth.refreshExhausted = true
    })
    first.fireReady()
    await flushPromises()
    const before = MockGatewayChat.instances.length
    first.fireClose(4401)
    await flushPromises()
    expect(MockGatewayChat.instances.length).toBe(before) // 未重建
    w.unmount()
  })

  it('bootstrap-token 20040（容器归属拒绝）→ 容器不可访问，不建 gateway', async () => {
    ;(getBootstrapToken as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(20040, 'denied'))
    const w = mount(ChatView)
    await flushPromises()
    expect(createGatewayChat).not.toHaveBeenCalled()
    expect(w.find('[data-test="error-bar"]').text()).toContain('容器不可访问')
  })

  it('协议机重连成功（everConnected 后再 onReady）→ loadHistory 恢复投影', async () => {
    const { w, gw } = await mountReady()
    gw.getHistory.mockResolvedValue({
      messages: [{ role: 'assistant', text: '恢复后的历史' }],
      hasMore: false,
      nextOffset: null,
    })
    gw.fireReady() // 第二次 onReady（协议机重连成功）
    await flushPromises()
    expect(gw.getHistory).toHaveBeenCalled()
    expect(w.find('[data-test="stream"]').text()).toContain('恢复后的历史')
  })

  it('F5: 首连失败（onClose before onReady）→ 协议机重连成功 onReady → 补拉会话', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw1 = MockGatewayChat.last!
    gw1.listSessions.mockResolvedValue([SESSION])
    gw1.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw1.send.mockResolvedValue(undefined)
    // 首连失败：onClose(4402) 于 onReady 之前 → openGateway 决议 false、selectContainer return
    gw1.fireClose(4402)
    await flushPromises()
    expect(gw1.listSessions).not.toHaveBeenCalled() // selectContainer 未续 listSessions
    // 协议机自动重连成功：同一实例再次 onReady（everConnected=false 分支）→ 补拉会话
    gw1.fireReady()
    await flushPromises()
    expect(gw1.listSessions).toHaveBeenCalled() // F5: 重连成功补拉会话（会话加载与首连解耦）
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(true)
  })

  it('F6: 首连未就绪时切容器 → 旧 openGateway 等待方被决议、新容器正常', async () => {
    const w = mount(ChatView)
    await flushPromises() // selectContainer('demo') → openGateway 挂起（未 fireReady）
    const gw1 = MockGatewayChat.last!
    gw1.listSessions.mockResolvedValue([SESSION])
    gw1.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    // 未 fireReady（pendingConnect 挂起）时切另一容器 → 第二次 openGateway 替换
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    expect(gw2).not.toBe(gw1)
    expect(gw1.stop).toHaveBeenCalled() // 旧连接被替换
    // 新容器首连就绪
    gw2.listSessions.mockResolvedValue([SESSION])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.send.mockResolvedValue(undefined)
    gw2.fireReady()
    await flushPromises()
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(true)
  })

  it('F12: 切容器后旧 gateway 的 listCommands 迟到 reject 不覆盖新容器命令（gen 守卫）', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw1 = MockGatewayChat.last!
    let rejectOld!: (e: Error) => void
    gw1.listCommands.mockImplementation(() => new Promise((_, rej) => { rejectOld = rej }))
    gw1.listSessions.mockResolvedValue([SESSION])
    gw1.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw1.send.mockResolvedValue(undefined)
    gw1.fireReady() // 首连：loadCommands 发起（在途，未 resolve）
    await flushPromises()
    // 切到另一容器：commands 清空 → 新容器命令填充
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    gw2.listSessions.mockResolvedValue([SESSION])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([{ name: 'model', description: '切换模型', aliases: ['/model'] }])
    gw2.send.mockResolvedValue(undefined)
    gw2.fireReady()
    await flushPromises()
    // 旧 gateway 的 in-flight listCommands 迟到 reject（模拟 stop flush）→ F12 守卫应丢弃
    rejectOld(new Error('gateway client stopped'))
    await flushPromises()
    await w.find('[data-test="input"]').setValue('/m')
    await nextTick()
    expect(w.find('[data-test="slash-item"]').text()).toContain('/model') // 新容器命令保留
    expect(w.find('[data-test="slash-item"]').text()).not.toContain('/old')
  })

  it('命令清单：onReady 首连拉取；输入 / 弹补全菜单', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listCommands.mockResolvedValue([
      { name: 'model', description: '切换模型', aliases: ['/model', '/m'] },
    ])
    gw.listSessions.mockResolvedValue([SESSION])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.send.mockResolvedValue(undefined)
    gw.fireReady() // 首连就绪 → loadCommands
    await flushPromises()
    await w.find('[data-test="input"]').setValue('/m')
    await nextTick()
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(true)
    expect(w.find('[data-test="slash-item"]').text()).toContain('/model')
  })

  it('卸载 → stop gateway', async () => {
    const { w, gw } = await mountReady()
    w.unmount()
    expect(gw.stop).toHaveBeenCalled()
  })
})
