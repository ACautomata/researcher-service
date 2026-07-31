// seam: chat/ws —— ChatWebSocket（issue #41 / spec §8.4）。
// 覆盖：access_token subprotocol 携 jwt、start/send 帧、ready/text/done/error 分发、断线 onClose/onError。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// MockWS 用 readyState 模拟 CLOSING/CLOSED 窗口：非 OPEN 态 send 抛 InvalidStateError（对齐原生），
// 供 ws.ts 的 try/catch 收尾路径测试。
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

class MockWS {
  static last: MockWS | null = null
  url: string
  protocols: string | string[]
  sent: unknown[] = []
  readyState = OPEN
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
    if (this.readyState !== OPEN) throw new Error('InvalidStateError') // 对齐原生：非 OPEN 态 send 抛错
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    /* 测试手动触发 onclose */
  }

  fireOpen(): void {
    this.readyState = OPEN
    this.onopen?.({})
  }

  fireMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  fireRawMessage(raw: string): void {
    this.onmessage?.({ data: raw })
  }

  fireError(): void {
    this.onerror?.({})
  }

  fireClose(code?: number, reason?: string): void {
    this.readyState = CLOSED
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '', wasClean: true })
  }

  fireClosing(): void {
    // close() 之后、onclose 触发之前的窗口：readyState=CLOSING，原生 send() 抛 InvalidStateError
    this.readyState = CLOSING
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

  // ---- #237 帧健壮性（评审 issue #198 问题 4.1/5.1）----
  it('drops a malformed JSON frame with console.warn and keeps dispatching later frames', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onText = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onText })
    MockWS.last!.fireRawMessage('not-json{')
    expect(warn).toHaveBeenCalledTimes(1) // 仅 warn，不抛未捕获异常
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '你好' })
    expect(onText).toHaveBeenCalledWith('r1', '你好', undefined) // 后续正常帧继续分发
    warn.mockRestore()
  })

  it('drops a non-JSON text frame without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    expect(() => MockWS.last!.fireRawMessage('hello plain text')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(ws.isClosed).toBe(false) // 帧丢弃不影响连接
    warn.mockRestore()
  })

  it('forwards CloseEvent.code and reason to onClose (4401 判定用)', () => {
    const onClose = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onClose })
    MockWS.last!.fireClose(4401, 'Unauthorized')
    expect(onClose).toHaveBeenCalledWith(4401, 'Unauthorized')
  })

  it('normal close (code 1000) forwards code and empty reason', () => {
    const onClose = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onClose })
    MockWS.last!.fireClose(1000)
    expect(onClose).toHaveBeenCalledWith(1000, '')
  })

  it('CLOSING window send routes to onError, not a raw send (InvalidStateError 竞态)', () => {
    const onError = vi.fn()
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireOpen()
    MockWS.last!.fireClosing() // close() 后、onclose 前：readyState=CLOSING
    expect(() => ws.send('sk-1', 'hi')).not.toThrow()
    expect(onError).toHaveBeenCalledWith('连接已断开，请重试或切换容器')
    expect(MockWS.last!.sent).toEqual([]) // 未真正发出
  })
})
