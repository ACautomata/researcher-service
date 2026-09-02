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
async function connect(conn: ReturnType<typeof useChatConnection>): Promise<InstanceType<typeof MockGatewayChat>> {
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
async function sendAndAck(conn: ReturnType<typeof useChatConnection>, chat: ReturnType<typeof useChatStore>, gw: InstanceType<typeof MockGatewayChat>, runId: string): Promise<void> {
  chat.setInput('帮我生成图片')
  gw.send.mockResolvedValue(runId)
  conn.send(false)
  await flushPromises() // gateway.send ack → myRunId = runId
}

// 三组 describe（retry-run handoff / 轮次折叠 #664 T1 / 执行时长 #665 T2）共享的 mock 环境
//（#665 审查 S1：第三份逐字样板收敛）。fake timers（含 Date——墙钟差精确断言依赖）+ 每用例
// 独立 pinia + MockGatewayChat 工厂 + apiFetch/Blob/URL stub。在 describe 内首行调用
//（vitest 钩子注册进当前 suite，同款描述内作用域语义不变）。
function setupConnTestEnv() {
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
}

describe('useChatConnection retry-run handoff', () => {
  setupConnTestEnv()

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

// T1 轮次折叠（#664）——行为接缝：直实例化 composable + mock 网关驱动帧（贴 retry-run handoff 先例）。
// 覆盖：done 自动折叠（有轨迹）/ error·断线·8s 宽限三路收尾不折叠 / 手动开合 mutation +
// 自动折叠一次性（done 后手动展开不再被自动收起）。只测外部行为（store 投影），不测闭包内部态。
describe('useChatConnection 轮次折叠（#664 T1）', () => {
  setupConnTestEnv()

  // 发送并流式注入一轮带轨迹的内容（replace 快照带结构化思考 + 一条工具行），不发 done
  async function sendAndStreamTrace(
    conn: ReturnType<typeof useChatConnection>,
    chat: ReturnType<typeof useChatStore>,
    gw: InstanceType<typeof MockGatewayChat>,
    runId: string,
  ): Promise<void> {
    await sendAndAck(conn, chat, gw, runId)
    gw.fireFrame({ type: 'text', runId, delta: '中间思考与正文', replace: true, thinking: '思考内容' })
    gw.fireFrame({ type: 'tool', runId, name: 'exec', state: 'done', id: 't1', title: null, input: 'ls', result: '' })
  }

  it('done 帧到达后有轨迹 → 最后一条 assistant 消息折叠态置 true；正文与附件数据不变', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndStreamTrace(conn, chat, gw, 'run-A')
    expect(chat.messages[1].traceFolded).toBeFalsy() // 流式中未折叠

    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].traceFolded).toBe(true) // done 独占折叠信号
    expect(chat.messages[1].text).toBe('中间思考与正文') // 正文数据不变
    expect(chat.messages[1].thinking).toBe('思考内容') // 思考数据不变
    expect(chat.messages[1].tools).toHaveLength(1) // 工具行数据不变
  })

  it('done 帧到达后无轨迹（纯文本回复）→ 不置折叠态', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')
    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '纯文本回复', replace: false })
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].traceFolded).toBeFalsy() // 无轨迹：无折叠条可言
  })

  it('error 帧收尾（有轨迹）→ 不折叠（保持展开）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndStreamTrace(conn, chat, gw, 'run-A')

    gw.fireFrame({ type: 'error', runId: 'run-A', message: 'run 失败' })
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].traceFolded).toBeFalsy() // 异常收尾保持展开
  })

  it('断线 onClose 收尾（有轨迹）→ 不折叠（保持展开）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndStreamTrace(conn, chat, gw, 'run-A')

    gw.fireClose(1006) // 意外断线（非授权门）
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].traceFolded).toBeFalsy() // 断线收尾保持展开
  })

  it('8s 宽限收尾 → 不折叠（外来 done-first 落定占位走共享收尾）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    // 外来 done-first（runId !== myRunId）→ 只武装 8s 宽限
    gw.fireFrame({ type: 'done', runId: 'run-foreign' })
    await flushPromises()
    expect(chat.messages[1].streaming).toBe(true) // 宽限内占位仍在
    await vi.advanceTimersByTimeAsync(8000) // 宽限 fire：finalizeLast 落定占位

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].traceFolded).toBeFalsy() // 宽限收尾（共享 finalize 路）不置折叠态
  })

  it('手动开合 mutation 生效；done 后手动展开不再被自动收起（自动折叠一次性）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndStreamTrace(conn, chat, gw, 'run-A')
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()
    expect(chat.messages[1].traceFolded).toBe(true)

    chat.toggleTraceFold(chat.messages[1]) // 手动展开
    expect(chat.messages[1].traceFolded).toBe(false)
    // 推进时钟 + 后续迟到帧（同一 runId 的 done 不会二次到达；此处防任何延迟自动收起）
    await vi.advanceTimersByTimeAsync(10000)
    expect(chat.messages[1].traceFolded).toBe(false) // 手动展开不被自动覆盖

    chat.toggleTraceFold(chat.messages[1]) // 再手动收起（可再收起）
    expect(chat.messages[1].traceFolded).toBe(true)
  })
})

// T2 执行时长（#665）——行为接缝：直实例化 composable + mock 网关驱动帧 + fake timers（同上两先例）。
// 覆盖：send 起算墙钟、done 落定精确时长（fake Date 差值）、error 收尾不落定、retry-run handoff
// 与原请求同轮连续计时（不重置）、断线 resume 续帧含中断间隔（墙钟连续）、离线重发路径同样起算。
// 只测外部行为（store 投影 turnDurationMs），不测闭包内部态。
describe('useChatConnection 执行时长（#665 T2）', () => {
  setupConnTestEnv()

  it('send 后推进 T 毫秒到 done → 落定 turnDurationMs 精确等于 T（折叠信号不变）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '流式正文', replace: true, thinking: '思考' })
    gw.fireFrame({ type: 'tool', runId: 'run-A', name: 'exec', state: 'done', id: 't1', title: null, input: 'ls', result: '' })
    await vi.advanceTimersByTimeAsync(42_000) // fake Date 同步推进：执行 42s 后 done
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].turnDurationMs).toBe(42_000) // 墙钟差精确 = T
    expect(chat.messages[1].traceFolded).toBe(true) // 折叠信号（#664）不变
  })

  it('error 收尾 → 不落定时长（异常轮无「已执行」可言）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')
    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '正文', replace: false })
    await vi.advanceTimersByTimeAsync(5_000)
    gw.fireFrame({ type: 'error', runId: 'run-A', message: 'run 失败' })
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].turnDurationMs).toBeUndefined() // 时长信号独占 done（同折叠信号）
  })

  it('空 final → retry-run handoff 认领的重试 run 的 done 落定时长从原 send 起算（计时不重置）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A') // 原请求 send（计时起点）

    // 本 run 空 final（retryPending 开启）——不落定不清起点
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(500) // t+500ms：gateway 自动重试的新 runId 到达
    gw.fireFrame({ type: 'text', runId: 'run-B', delta: '重试正文', replace: false })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(41_500) // t+42s：retry run done
    gw.fireFrame({ type: 'done', runId: 'run-B' })
    await flushPromises()

    expect(chat.messages[1].text).toBe('重试正文')
    expect(chat.messages[1].turnDurationMs).toBe(42_000) // 含空 final 后的 handoff 间隙（同一轮连续计时）
  })

  it('断线 resume 续帧后 done → 时长含中断间隔（墙钟连续）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')
    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '前半', replace: false })
    await flushPromises()
    gw.fireClose(1006) // 意外断线：finalizeLast + 记 resumeRun（不动计时起点）
    await flushPromises()

    await vi.advanceTimersByTimeAsync(30_000) // 30s 中断间隔
    // 协议机自动重连（B5）：同一 GatewayChat 实例的 onReady 再次触发——everConnected 已 true 且
    // resumeRun 在案 → 保留占位 armResumeWait 等续帧（手动 openGateway 是新连接新 run 语境，
    // 会清 resumeRun 走 loadHistory，非本用例模拟的路径）
    gw.fireReady()
    await flushPromises()

    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '后半', replace: false }) // resume 续帧复活占位
    await flushPromises()
    await vi.advanceTimersByTimeAsync(12_000)
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()

    expect(chat.messages[1].text).toBe('前半后半') // 续帧照常追加（B5 语义不变）
    expect(chat.messages[1].turnDurationMs).toBe(42_000) // 含 30s 中断：send→done 墙钟
  })

  it('离线重发（outbox resendOutbox）路径同样起算计时', async () => {
    // 预置 outbox 残留（「已点发送但网关没回执」的刷新场景）——首连 syncSessions 铺底后自动重发
    sessionStorage.setItem(
      'openclaw.panel.outbox.v1:demo',
      JSON.stringify({
        version: 1,
        sessions: { 'sk-1': [{ id: 'oid-1', text: '离线期间的消息', createdAt: Date.now() }] },
      }),
    )
    const { conn, chat } = setup()
    // 不用 connect() helper：resendOutbox 在 onReady 链内同步触发，gateway.send 的 mock（ack 返
    // runId）须在 fireReady 前就位，否则重发的 fire-and-forget .then 打在 undefined 上
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.send.mockResolvedValue('run-resend') // 重发 ack
    gw.fireReady()
    await ready
    await flushPromises() // syncSessions → loadHistory（空历史）→ resendOutbox（乐观 echo）

    expect(chat.messages[0].text).toBe('离线期间的消息') // user echo
    expect(chat.messages[1].role).toBe('assistant') // 占位
    await vi.advanceTimersByTimeAsync(7_000) // 重发后执行 7s 到 done
    gw.fireFrame({ type: 'text', runId: 'run-resend', delta: '重发的回复', replace: false })
    gw.fireFrame({ type: 'done', runId: 'run-resend' })
    await flushPromises()

    expect(chat.messages[1].turnDurationMs).toBe(7_000) // 重发路径同款 send 起算
  })
})
