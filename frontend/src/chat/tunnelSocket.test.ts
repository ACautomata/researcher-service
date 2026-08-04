// seam: chat/tunnelSocket —— createPanelTunnelSocket（#337 M5 · ADR 0006 隧道前端侧）。
// 覆盖：构造 URL（?container= 编码）与 JWT subprotocol、send/message/close/error 事件映射到
// GatewayProtocolSocketHandlers、isOpen 反映 readyState、非 OPEN 态 send 静默丢弃。
// 隧道是字节透传 → MockWS 记录原始字符串（不做 JSON.parse，区别于 ws.test.ts 的 MockWS）。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createPanelTunnelSocket } from './tunnelSocket'
import type { GatewayProtocolSocketHandlers } from '@openclaw/gateway-client/browser'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

class MockWS {
  static CONNECTING = CONNECTING
  static OPEN = OPEN
  static CLOSING = CLOSING
  static CLOSED = CLOSED
  static last: MockWS | null = null
  url: string
  protocols: string | string[]
  sent: string[] = []
  closedCode: number | undefined
  readyState = CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null

  constructor(url: string, protocols?: string | string[]) {
    MockWS.last = this
    this.url = url
    this.protocols = protocols ?? []
  }

  send(data: string): void {
    if (this.readyState === CONNECTING) throw new Error('InvalidStateError')
    if (this.readyState !== OPEN) return // CLOSING/CLOSED 静默丢弃（WHATWG）
    this.sent.push(data)
  }

  close(code?: number, _reason?: string): void {
    this.closedCode = code
    this.readyState = CLOSED
    this.onclose?.({ code: code ?? 1000, reason: '' })
  }

  fireOpen(): void {
    this.readyState = OPEN
    this.onopen?.()
  }

  fireMessage(data: string): void {
    this.onmessage?.({ data })
  }

  fireClose(code: number, reason = ''): void {
    this.readyState = CLOSED
    this.onclose?.({ code, reason })
  }

  fireError(ev?: unknown): void {
    this.onerror?.(ev)
  }
}

function makeHandlers(): GatewayProtocolSocketHandlers {
  return {
    open: vi.fn(),
    message: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
  }
}

describe('createPanelTunnelSocket（#337 M5 隧道）', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWS)
    MockWS.last = null
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('构造：URL 为相对 /ws/chat/?container=（F11：WHATWG 按文档 base URL 解析相对地址，既有 ChatWebSocket 同款）+ JWT subprotocol 两值格式', () => {
    const handlers = makeHandlers()
    createPanelTunnelSocket('alpha', 'jwt123', handlers)
    expect(MockWS.last?.url).toBe('/ws/chat/?container=alpha')
    expect(MockWS.last?.protocols).toEqual(['access_token', 'jwt123'])
  })

  it('容器名 encodeURIComponent（含特殊字符不破坏 query）', () => {
    createPanelTunnelSocket('a-b_c', 'jwt', makeHandlers())
    expect(MockWS.last?.url).toBe('/ws/chat/?container=a-b_c')
    createPanelTunnelSocket('a b&c', 'jwt', makeHandlers())
    expect(MockWS.last?.url).toBe('/ws/chat/?container=a%20b%26c')
  })

  it('open → handlers.open 被调；isOpen 反映 readyState', () => {
    const handlers = makeHandlers()
    const socket = createPanelTunnelSocket('alpha', 'jwt', handlers)
    expect(socket.isOpen()).toBe(false) // CONNECTING
    MockWS.last!.fireOpen()
    expect(handlers.open).toHaveBeenCalledTimes(1)
    expect(socket.isOpen()).toBe(true) // OPEN
  })

  it('send：OPEN 态原样发送原始帧（字节透传，不解析）', () => {
    const socket = createPanelTunnelSocket('alpha', 'jwt', makeHandlers())
    MockWS.last!.fireOpen()
    const frame = '{"type":"req","id":"r1","method":"connect"}'
    socket.send(frame)
    expect(MockWS.last!.sent).toEqual([frame])
  })

  it('send：CONNECTING 态不抛错、不发送（协议机未 open 前的帧静默丢弃，避免 InvalidStateError）', () => {
    const socket = createPanelTunnelSocket('alpha', 'jwt', makeHandlers())
    expect(() => socket.send('frame')).not.toThrow()
    expect(MockWS.last!.sent).toEqual([])
  })

  it('message → handlers.message 原样透传（网关原始帧）', () => {
    const handlers = makeHandlers()
    const socket = createPanelTunnelSocket('alpha', 'jwt', handlers)
    MockWS.last!.fireOpen()
    const challenge = '{"type":"event","event":"connect.challenge","payload":{"nonce":"n1"}}'
    socket.send(challenge) // 触发 mock 转发
    MockWS.last!.fireMessage('{"type":"res","id":"r1","ok":true}')
    expect(handlers.message).toHaveBeenCalledWith('{"type":"res","id":"r1","ok":true}')
  })

  it('close(code, reason) → 原生 close 调用（浏览器侧协议机主动关闭）', () => {
    const socket = createPanelTunnelSocket('alpha', 'jwt', makeHandlers())
    socket.close(4401, 'Unauthorized')
    expect(MockWS.last!.closedCode).toBe(4401)
  })

  it('服务端 close(4401) → handlers.close 收到 code/reason（认证失败刷新重连链路）', () => {
    const handlers = makeHandlers()
    createPanelTunnelSocket('alpha', 'jwt', handlers)
    MockWS.last!.fireOpen()
    MockWS.last!.fireClose(4401, 'Unauthorized')
    expect(handlers.close).toHaveBeenCalledWith(4401, 'Unauthorized')
  })

  it('error → handlers.error（ErrorEvent message 透传真实失败原因，F7）', () => {
    const handlers = makeHandlers()
    createPanelTunnelSocket('alpha', 'jwt', handlers)
    MockWS.last!.fireOpen()
    MockWS.last!.fireError(new ErrorEvent('error', { message: 'WebSocket connection to ws://x failed: ECONNREFUSED' }))
    expect(handlers.error).toHaveBeenCalledTimes(1)
    const err = (handlers.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('WebSocket connection to ws://x failed: ECONNREFUSED') // 非 'panel tunnel error' 常量
  })

  it('error 非 ErrorEvent（跨源受限等）→ 通用兜底 message（F7）', () => {
    const handlers = makeHandlers()
    createPanelTunnelSocket('alpha', 'jwt', handlers)
    MockWS.last!.fireOpen()
    MockWS.last!.fireError({}) // 无 message 的裸 Event
    expect((handlers.error as ReturnType<typeof vi.fn>).mock.calls[0][0].message).toBe('WebSocket transport error')
  })
})
