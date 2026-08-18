// PHASE 2 retry-run handoff —— useChatConnection 的 run 认领状态机单元测试。
// 不 mount 组件：直接实例化 useChatConnection(status)，用 MockGatewayChat 驱动 openGateway/首连 +
// fireFrame 触达 handle*（text/attachment/done）。覆盖：
//   A 正常单 run（ack→delta/media→final）行为不变
//   B 本 run 空 final → gateway retry run 认领（media 进 pipeline，无 foreign 污染）
//   C retry run 复用相同 media path 不被旧 run dedupe 污染（resolvedMediaPaths 按 runId 分桶）
//   D 真 foreign run（pending active 期间陌生 runId）仍被丢弃
//   E empty final 无 retry → 明确失败提示 + 空白占位删除 + pending 清理
//   F 连续三次请求状态完全复位（run2 空 final→retry handoff 不污染 run3）
//   G foreign empty final（runId !== myRunId）不得开启 retryPending，后续陌生 run 不得被认领
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { useChatConnection, type ChatStatus } from './useChatConnection'

vi.mock('@/api/chat', () => ({ getBootstrapToken: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return { ...actual, apiFetch: vi.fn() }
})
vi.mock('@/chat/gatewayChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/chat/gatewayChat')>()
  return {
    ...actual, // #564: createRequestId 保留真实实现（useChatConnection 生成 outbox 幂等 id 用）
    createGatewayChat: vi.fn(),
  }
})

type MockHandlers = {
  onReady: () => void
  onFrame: (frame: unknown) => void
  onClose: (code: number, reason: string, retry: boolean, pairingRequired?: boolean) => void
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
    listPendingApprovals = vi.fn()
    start = vi.fn()
    stop = vi.fn()
    closeSocket = vi.fn()
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
    fireClose(code: number, reason = '', retry = true, pairingRequired?: boolean): void {
      this.handlers.onClose(code, reason, retry, pairingRequired)
    }
    fireError(message: string): void {
      this.handlers.onError(message)
    }
  }
  return { MockGatewayChat }
})

import { getBootstrapToken } from '@/api/chat'
import { createGatewayChat } from '@/chat/gatewayChat'
import { apiFetch } from '@/api/client'

const IMG_PATH = '/home/node/.openclaw/workspace/test.png'
const IMG_MEDIA = [{ type: 'image', mimeType: 'image/png', src: IMG_PATH }]

function setup(): { status: ChatStatus & Record<string, ReturnType<typeof vi.fn>>; conn: ReturnType<typeof useChatConnection>; chat: ReturnType<typeof useChatStore> } {
  const status: ChatStatus & Record<string, ReturnType<typeof vi.fn>> = {
    onConnecting: vi.fn(),
    onError: vi.fn(),
    onClearError: vi.fn(),
  }
  const conn = useChatConnection(status)
  const chat = useChatStore()
  chat.setSelectedContainer('demo')
  chat.setSelectedSession('sk-1')
  return { status, conn, chat }
}

// 首连：openGateway（mock bootstrap token）→ fireReady → onReady 就绪 → syncSessions/loadHistory
// 铺底（空历史）完成。返回当前 gateway。注意必须先 await flushPromises 让 loadHistory 落地——否则其
// 内部 resetForSession 会在测试进行中清空 send() 推入的消息（ChatView.test.ts mountReady 同款）。
async function connect(conn: ReturnType<typeof useChatConnection>): Promise<MockGatewayChat> {
  const ready = conn.openGateway()
  await flushPromises() // getBootstrapToken → createGatewayChat + start → 挂起等 onReady
  const gw = MockGatewayChat.last!
  gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
  gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
  gw.listCommands.mockResolvedValue([])
  gw.listPendingApprovals.mockResolvedValue([])
  gw.fireReady()
  await ready
  await flushPromises() // syncSessions → listSessions → loadHistory 铺底完成
  return gw
}

// 发送一条用户消息并等 ack 返回 runId（myRunId 就绪）。返回该 runId。
async function sendAndAck(conn: ReturnType<typeof useChatConnection>, chat: ReturnType<typeof useChatStore>, gw: MockGatewayChat, runId: string): Promise<void> {
  chat.setInput('帮我生成图片')
  gw.send.mockResolvedValue(runId)
  conn.send(false)
  await flushPromises() // gateway.send ack → myRunId = runId
}

describe('useChatConnection retry-run handoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    MockGatewayChat.instances = []
    MockGatewayChat.last = null
    vi.clearAllMocks()
    useAuthStore().$patch({ token: 'jwt-test' })
    ;(getBootstrapToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('boot-1')
    ;(createGatewayChat as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (params: { handlers: MockHandlers }) => new MockGatewayChat(params.handlers),
    )
    // jsdom 的 Blob 无 stream()，真 Response 构造会抛 object.stream is not a function——
    // mock 成 resolveAttachment 消费的最小形状（resp.ok + resp.blob()）
    ;(apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    })
    const origURL = globalThis.URL
    vi.stubGlobal(
      'URL',
      Object.assign(Object.create(origURL), {
        createObjectURL: vi.fn(() => 'blob:mock-media'),
        revokeObjectURL: vi.fn(),
      }),
    )
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('A: 正常单 run——ack → delta/media → final 行为不变', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '第一张图片已生成', replace: false })
    gw.fireFrame({ type: 'attachment', runId: 'run-A', media: IMG_MEDIA })
    await flushPromises() // resolveAttachment：files/raw → blob → objectURL
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()

    expect(chat.messages.length).toBe(2)
    const last = chat.messages[1]
    expect(last.role).toBe('assistant')
    expect(last.text).toBe('第一张图片已生成')
    expect(last.media.length).toBe(1)
    expect(last.media[0].src).toBe('blob:mock-media')
    expect(last.streaming).toBe(false)
  })

  it('B: 本 run 空 final → retry run 认领，media 进 pipeline，无 foreign 污染', async () => {
    const { conn, chat, status } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    // 本 run 空 final（首帧即终态、无内容，runId === myRunId）→ retryPending 开启
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()
    // gateway 自动重试：新 runId run-B 到达
    gw.fireFrame({ type: 'text', runId: 'run-B', delta: '重试生成的图片', replace: false })
    gw.fireFrame({ type: 'attachment', runId: 'run-B', media: IMG_MEDIA })
    await flushPromises()
    gw.fireFrame({ type: 'done', runId: 'run-B' })
    await flushPromises()

    expect(chat.messages.length).toBe(2)
    const last = chat.messages[1]
    expect(last.text).toBe('重试生成的图片')
    expect(last.media.length).toBe(1)
    expect(last.media[0].src).toBe('blob:mock-media')
    expect(last.streaming).toBe(false)
    expect(status.onError).not.toHaveBeenCalled() // 无失败提示、无 foreign 污染
    // run-B 未被加入 foreignRunIds：后续同 runId 的帧仍正常（已 finalize，此处仅验证未报错）
  })

  it('C: retry run 复用相同 media path——不被旧 run 的 resolvedMediaPaths dedupe 污染', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)

    // run1 正常完成并 resolve 图片路径 X
    await sendAndAck(conn, chat, gw, 'run-1')
    gw.fireFrame({ type: 'text', runId: 'run-1', delta: '第一张', replace: false })
    gw.fireFrame({ type: 'attachment', runId: 'run-1', media: IMG_MEDIA })
    await flushPromises()
    gw.fireFrame({ type: 'done', runId: 'run-1' })
    await flushPromises()
    expect(chat.messages[1].media.length).toBe(1)

    // 第二次请求：本 run 空 final → retry run-3 引用同一图片路径 X
    await sendAndAck(conn, chat, gw, 'run-2')
    gw.fireFrame({ type: 'done', runId: 'run-2' })
    await flushPromises()
    gw.fireFrame({ type: 'text', runId: 'run-3', delta: '第二张', replace: false })
    gw.fireFrame({ type: 'attachment', runId: 'run-3', media: IMG_MEDIA })
    await flushPromises()
    gw.fireFrame({ type: 'done', runId: 'run-3' })
    await flushPromises()

    expect(chat.messages.length).toBe(4)
    const last = chat.messages[3]
    expect(last.text).toBe('第二张')
    expect(last.media.length).toBe(1) // per-runId dedupe：run-3 有自己的 Set，X 不被 run-1 记录跳过
    expect(last.media[0].src).toBe('blob:mock-media')
  })

  it('D: 真 foreign run——pending 正常 active 时陌生 runId 仍被丢弃', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '正常回复', replace: false }) // activeRunId=run-A
    // 突然出现 B（真 foreign，非 retry 条件）——不得污染 A 的占位
    gw.fireFrame({ type: 'text', runId: 'run-B', delta: 'foreign 文本', replace: false })
    await flushPromises()

    expect(chat.messages[1].text).toBe('正常回复') // B 的 delta 未 append
    expect(chat.messages[1].media.length).toBe(0)
  })

  it('E: empty final 无 retry——明确失败提示 + 空白占位删除 + pending 清理', async () => {
    const { conn, chat, status } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()
    // 推进 RETRY_HANDOFF_MS(2000)——无 retry run 到达
    await vi.advanceTimersByTimeAsync(2000)

    expect(status.onError).toHaveBeenCalledWith('消息未生成成功，请稍后重试')
    expect(chat.messages.length).toBe(1) // 空白 assistant 占位被 pop，只剩 user
    expect(chat.messages[0].role).toBe('user')
    // pending 已清理：下一次 send 正常发起（不残留 retryPending）
    await sendAndAck(conn, chat, gw, 'run-B')
    gw.fireFrame({ type: 'text', runId: 'run-B', delta: '重试成功', replace: false })
    await flushPromises()
    const last = chat.messages[chat.messages.length - 1] // 第二次 send 的 assistant 占位（索引非 1）
    expect(last.text).toBe('重试成功')
  })

  it('F: 连续三次请求——run2 空 final→retry handoff 不污染 run1/run3', async () => {
    const { conn, chat, status } = setup()
    const gw = await connect(conn)

    // run1 正常
    await sendAndAck(conn, chat, gw, 'run-1')
    gw.fireFrame({ type: 'text', runId: 'run-1', delta: 'r1', replace: false })
    gw.fireFrame({ type: 'done', runId: 'run-1' })
    await flushPromises()
    expect(chat.messages[1].text).toBe('r1')

    // run2 空 final → retry handoff（认领 run-2r）
    await sendAndAck(conn, chat, gw, 'run-2')
    gw.fireFrame({ type: 'done', runId: 'run-2' })
    await flushPromises()
    gw.fireFrame({ type: 'text', runId: 'run-2r', delta: 'r2 retry', replace: false })
    gw.fireFrame({ type: 'done', runId: 'run-2r' })
    await flushPromises()
    expect(chat.messages[3].text).toBe('r2 retry')

    // run3 正常（状态无污染）
    await sendAndAck(conn, chat, gw, 'run-3')
    gw.fireFrame({ type: 'text', runId: 'run-3', delta: 'r3', replace: false })
    gw.fireFrame({ type: 'done', runId: 'run-3' })
    await flushPromises()
    expect(chat.messages[5].text).toBe('r3')
    expect(status.onError).not.toHaveBeenCalled()
  })

  it('G: foreign empty final（runId !== myRunId）不得开启 retry handoff', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    // foreign empty final B（B !== myRunId=A，且 B 从未被认领）——只 armPendingGrace，不开启 retryPending
    gw.fireFrame({ type: 'done', runId: 'run-B' })
    await flushPromises()
    // 后续陌生 run C 到达：若 retryPending 被误开启，C 会被认领；正确实现下 C 应被 foreign 丢弃
    gw.fireFrame({ type: 'text', runId: 'run-C', delta: '不应被认领', replace: false })
    await flushPromises()

    expect(chat.messages[1].text).toBe('') // 占位仍空：C 的 delta 被丢弃，未污染占位
    expect(chat.messages[1].media.length).toBe(0)
    // 本 run 自身的首帧（runId === myRunId）仍可正常认领（B3 语义未破坏）
    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '本 run 首帧', replace: false })
    await flushPromises()
    expect(chat.messages[1].text).toBe('本 run 首帧')
  })
})
