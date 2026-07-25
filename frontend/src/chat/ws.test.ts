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

  it('start sends a start frame', () => {
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    ws.start('demo')
    expect(MockWS.last!.sent).toEqual([{ type: 'start', container: 'demo' }])
  })

  it('send sends a send frame with sessionKey and message', () => {
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    ws.send('sk-1', '你好')
    expect(MockWS.last!.sent).toEqual([{ type: 'send', sessionKey: 'sk-1', message: '你好' }])
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
    expect(onText).toHaveBeenCalledWith('r1', '你好')
  })

  it('dispatches done to onDone', () => {
    const onDone = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onDone })
    MockWS.last!.fireMessage({ type: 'done', runId: 'r1' })
    expect(onDone).toHaveBeenCalledWith('r1')
  })

  it('dispatches error message to onError', () => {
    const onError = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireMessage({ type: 'error', message: '模型超时' })
    expect(onError).toHaveBeenCalledWith('模型超时')
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
})
