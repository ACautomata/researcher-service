// seam: chat/ws —— ChatWebSocket（issue #41 / spec §8.4）。
// 覆盖：access_token subprotocol 携 jwt、start/send 帧、ready/text/done/error 分发、断线 onClose/onError。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

class MockWS {
  static last: MockWS | null = null
  // readyState 常量对齐原生 WebSocket（#198：sendRaw 的 CLOSING 窗口判断用 WebSocket.OPEN）
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  url: string
  protocols: string | string[]
  sent: unknown[] = []
  readyState = MockWS.CONNECTING
  closeCalled = false // 记录 close() 是否被调用（验证静默看门狗主动判死）
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null

  constructor(url: string, protocols?: string | string[]) {
    MockWS.last = this
    this.url = url
    this.protocols = protocols ?? []
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    // 进 CLOSING 窗口但不触发 onclose（onclose 由 fireClose 手动触发）——
    // 用于复现 close() 后、onclose 前的 send 竞态（#198 问题 5）
    this.closeCalled = true
    this.readyState = MockWS.CLOSING
  }

  fireOpen(): void {
    this.readyState = MockWS.OPEN
    this.onopen?.({})
  }

  fireMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  fireError(): void {
    this.onerror?.({})
  }

  fireClose(code = 1000): void {
    this.readyState = MockWS.CLOSED
    this.onclose?.({ code })
  }
}

import { ChatWebSocket } from './ws'

describe('ChatWebSocket', () => {
  beforeEach(() => {
    MockWS.last = null
    vi.stubGlobal('WebSocket', MockWS)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('connects with access_token subprotocol carrying jwt', () => {
    new ChatWebSocket('/ws/chat/', 'jwt-abc', {})
    expect(MockWS.last!.url).toBe('/ws/chat/')
    expect(MockWS.last!.protocols).toEqual(['access_token', 'jwt-abc'])
  })

  it('start buffers the start frame until open, then flushes', () => {
    // 原生 WebSocket 在 CONNECTING 态调 send() 抛 InvalidStateError → 必须缓冲到 onopen 后再发（codex P1）
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    ws.start('demo')
    expect(MockWS.last!.sent).toEqual([]) // CONNECTING 期间缓冲，未发出
    MockWS.last!.fireOpen()
    expect(MockWS.last!.sent).toEqual([{ type: 'start', container: 'demo' }])
  })

  it('send sends a send frame with sessionKey and message once open', () => {
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    MockWS.last!.fireOpen()
    ws.send('sk-1', '你好')
    expect(MockWS.last!.sent).toEqual([{ type: 'send', sessionKey: 'sk-1', message: '你好' }])
  })

  it('buffers multiple frames in order until open, then flushes', () => {
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    ws.start('demo')
    ws.send('sk-1', 'hi')
    expect(MockWS.last!.sent).toEqual([])
    MockWS.last!.fireOpen()
    expect(MockWS.last!.sent).toEqual([
      { type: 'start', container: 'demo' },
      { type: 'send', sessionKey: 'sk-1', message: 'hi' },
    ])
  })

  it('dispatches ready frame to onReady', () => {
    const onReady = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onReady })
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    expect(onReady).toHaveBeenCalledWith('demo')
  })

  it('dispatches text delta to onText', () => {
    const onText = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onText })
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '你好' })
    expect(onText).toHaveBeenCalledWith('r1', '你好', undefined)
  })

  it('forwards replace flag on text frames', () => {
    const onText = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onText })
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '你好世界', replace: true })
    expect(onText).toHaveBeenCalledWith('r1', '你好世界', true)
  })

  it('dispatches done to onDone', () => {
    const onDone = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onDone })
    MockWS.last!.fireMessage({ type: 'done', runId: 'r1' })
    expect(onDone).toHaveBeenCalledWith('r1')
  })

  it('dispatches error message and runId to onError', () => {
    const onError = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireMessage({ type: 'error', runId: 'r1', message: '模型超时' })
    expect(onError).toHaveBeenCalledWith('模型超时', 'r1', undefined)
  })

  it('dispatches approval id on a resolve-error frame (codex R2 P2)', () => {
    const onError = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireMessage({ type: 'error', message: '审批回覆失败', id: 'ap-1' })
    expect(onError).toHaveBeenCalledWith('审批回覆失败', undefined, 'ap-1')
  })

  it('fires onClose when underlying socket closes (断线)', () => {
    const onClose = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onClose })
    MockWS.last!.fireClose()
    expect(onClose).toHaveBeenCalled()
  })

  it('fires onError when underlying socket errors', () => {
    const onError = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireError()
    expect(onError).toHaveBeenCalledWith('连接错误')
  })

  it('routes send to onError after the socket has closed (no throw, codex P2)', () => {
    // socket 关闭后原生 WebSocket.send() 会抛 InvalidStateError 且不触发 handler；
    // wrapper 标记 closed 后改走 onError，不真正发出（codex #4）
    const onError = vi.fn()
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireOpen()
    MockWS.last!.fireClose()
    expect(() => ws.send('sk-1', 'hi')).not.toThrow()
    expect(onError).toHaveBeenCalledWith('连接已断开，请重试或切换容器')
    expect(MockWS.last!.sent).toEqual([]) // CLOSED 态未真正发出
  })

  // ---- T06 权限审批（issue #42 / spec §8.2）----
  it('dispatches approval card to onApproval (连接级，无 runId，带 sessionKey)', () => {
    const onApproval = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onApproval })
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'rm -rf /tmp', sessionKey: 'sk-1' })
    expect(onApproval).toHaveBeenCalledWith({ id: 'ap-1', kind: 'exec', command: 'rm -rf /tmp', sessionKey: 'sk-1' })
  })

  it('dispatches approvalResolved to onApprovalResolved (回执 → 卡片标记已处理)', () => {
    const onApprovalResolved = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onApprovalResolved })
    MockWS.last!.fireMessage({ type: 'approvalResolved', id: 'ap-1', decision: 'allow-once' })
    expect(onApprovalResolved).toHaveBeenCalledWith('ap-1', 'allow-once')
  })

  it('resolve sends a resolve frame with id/kind/decision once open', () => {
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    MockWS.last!.fireOpen()
    ws.resolve('ap-1', 'exec', 'deny')
    expect(MockWS.last!.sent).toEqual([{ type: 'resolve', id: 'ap-1', kind: 'exec', decision: 'deny' }])
  })

  // ---- T08 工具执行（issue #44 / spec §9.4 / r26 §3）----
  // tool 帧（runId 级，挂在所属 chat run 内）→ onTool 回调；前端按 name 聚合 start→result 渲染一行标题+状态。
  it('dispatches tool frame to onTool', () => {
    const onTool = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onTool })
    MockWS.last!.fireMessage({
      type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running',
      id: 'call-1', title: '检索', input: { q: 'x' }, result: null,
    })
    expect(onTool).toHaveBeenCalledWith({
      runId: 'r1', name: 'wiki.search', state: 'running',
      id: 'call-1', title: '检索', input: { q: 'x' }, result: null,
    })
  })

  // ---- issue #198：close code 透传 / 畸形帧防护 / CLOSING 窗口 / 静默看门狗 ----
  it('forwards the CloseEvent code to onClose (4401=JWT 失效可识别, #198 问题 2)', () => {
    const onClose = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onClose })
    MockWS.last!.fireClose(4401)
    expect(onClose).toHaveBeenCalledWith(4401)
  })

  it('drops a malformed JSON frame with a warn and keeps dispatching (#198 问题 4)', () => {
    const onText = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    new ChatWebSocket('/ws/chat/', 'jwt', { onText })
    expect(() => MockWS.last!.onmessage?.({ data: '{bad json' })).not.toThrow() // 畸形帧不炸
    expect(onText).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: 'ok' }) // 后续正常帧继续分发
    expect(onText).toHaveBeenCalledWith('r1', 'ok', undefined)
    warn.mockRestore()
  })

  it('routes send to onError in the CLOSING window without throwing (#198 问题 5)', () => {
    // close() 已调、onclose 未到（readyState=CLOSING、closed 标志未置位）：
    // 原生 send() 会抛 InvalidStateError → wrapper 走与 CLOSED 相同的 onError 收尾
    const onError = vi.fn()
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireOpen()
    ws.close()
    expect(() => ws.send('sk-1', 'hi')).not.toThrow()
    expect(onError).toHaveBeenCalledWith('连接已断开，请重试或切换容器')
    expect(MockWS.last!.sent).toEqual([]) // CLOSING 窗口未真正发出
  })

  it('closes the socket after silenceTimeoutMs without any frame (静默看门狗, #198 问题 1)', () => {
    vi.useFakeTimers()
    try {
      new ChatWebSocket('/ws/chat/', 'jwt', {}, { silenceTimeoutMs: 1000 })
      MockWS.last!.fireOpen()
      vi.advanceTimersByTime(999)
      expect(MockWS.last!.closeCalled).toBe(false) // 未到阈值不判死
      vi.advanceTimersByTime(1)
      expect(MockWS.last!.closeCalled).toBe(true) // 静默超时主动 close → 上层退避重连
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the silence watchdog on incoming frames', () => {
    vi.useFakeTimers()
    try {
      new ChatWebSocket('/ws/chat/', 'jwt', {}, { silenceTimeoutMs: 1000 })
      MockWS.last!.fireOpen()
      vi.advanceTimersByTime(900)
      MockWS.last!.fireMessage({ type: 'ready', container: 'demo' }) // 下行帧 = 存活信号
      vi.advanceTimersByTime(900)
      expect(MockWS.last!.closeCalled).toBe(false)
      vi.advanceTimersByTime(100)
      expect(MockWS.last!.closeCalled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire the watchdog after the socket has closed', () => {
    vi.useFakeTimers()
    try {
      new ChatWebSocket('/ws/chat/', 'jwt', {}, { silenceTimeoutMs: 1000 })
      MockWS.last!.fireOpen()
      MockWS.last!.fireClose()
      vi.advanceTimersByTime(5000)
      expect(MockWS.last!.closeCalled).toBe(false) // 已关闭：看门狗已清理，不再 close
    } finally {
      vi.useRealTimers()
    }
  })
})
