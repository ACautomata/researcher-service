// seam: chat/ws —— ChatWebSocket（issue #41 / spec §8.4）。
// 覆盖：access_token subprotocol 携 jwt、start/send 帧、ready/text/done/error 分发、断线 onClose/onError。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

class MockWS {
  static last: MockWS | null = null
  url: string
  protocols: string | string[]
  sent: unknown[] = []
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
    /* 测试手动触发 onclose */
  }

  fireOpen(): void {
    this.onopen?.({})
  }

  fireMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  fireError(): void {
    this.onerror?.({})
  }

  fireClose(): void {
    this.onclose?.({})
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
    expect(onError).toHaveBeenCalledWith('模型超时', 'r1')
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
    MockWS.last!.fireMessage({ type: 'approvalResolved', id: 'ap-1', decision: 'approve' })
    expect(onApprovalResolved).toHaveBeenCalledWith('ap-1', 'approve')
  })

  it('resolve sends a resolve frame with id/kind/decision once open', () => {
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    MockWS.last!.fireOpen()
    ws.resolve('ap-1', 'exec', 'deny')
    expect(MockWS.last!.sent).toEqual([{ type: 'resolve', id: 'ap-1', kind: 'exec', decision: 'deny' }])
  })
})
