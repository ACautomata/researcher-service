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

  closedReason = ''

  close(code?: number, reason?: string): void {
    // WHATWG：非 1000/3000-4999 的 close code 抛 InvalidAccessError（对齐浏览器原生行为——此前
    // MockWS 不校验，掩盖了协议机传 1008/1013 等应用码时 createPanelTunnelSocket.close 崩溃的 bug）
    if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
      throw new DOMException(`The provided close code (${code}) is not valid.`, 'InvalidAccessError')
    }
    // WHATWG：reason 超 123 UTF-8 字节抛 SyntaxError——合法码分支若原样透传超长 reason，协议机
    // close 流程内同步抛错、socket 关不掉、onclose 不触发 → 重连永不调度（隧道假活）
    if (reason !== undefined && new TextEncoder().encode(reason).length > 123) {
      throw new DOMException(`The provided reason is longer than 123 UTF-8 bytes.`, 'SyntaxError')
    }
    this.closedCode = code
    this.closedReason = reason ?? ''
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

  it('#4 close(1008/1013 等协议机应用码) → 映射为合法码关闭，不抛 InvalidAccessError（否则 socket 关不掉、onclose 不触发 → 重连永不调度）', () => {
    // 官方协议机 connect 失败路径（challenge 超时 1008、gateway starting 1013 等）用 RFC 应用码调
    // socket.close——非 1000/3000-4999 的码经原生 WebSocket.close 抛 InvalidAccessError（MockWS 现
    // 已校验码），socket 关不掉、协议机重连（由 handlers.close 驱动）永不调度，隧道假活。
    const handlers = makeHandlers()
    const socket = createPanelTunnelSocket('alpha', 'jwt', handlers)
    expect(() => socket.close(1008, 'connect challenge timeout')).not.toThrow() // 修复前：抛 InvalidAccessError → 红
    expect(MockWS.last!.closedCode).toBe(1000) // 非法码映射 1000 关闭（WHATWG 合法）
    expect(MockWS.last!.closedReason).toContain('1008') // 原码带进 reason 保排障
  })

  it('#3 close 合法码分支超长 reason（>123 UTF-8 字节）→ 省略 reason 不抛 SyntaxError（WHATWG close() 规定，含多字节字符按字节计）', () => {
    // 合法码分支（4401 等）原样透传 reason——WHATWG WebSocket.close(code, reason) 的 reason 超 123
    // UTF-8 字节即抛 SyntaxError。异常从协议机调用 socket.close 的路径同步抛出：socket 关不掉、
    // handlers.close（onclose）不触发 → 协议机重连永不调度（隧道假活）。须按字节省略超长 reason。
    const handlers = makeHandlers()
    const socket = createPanelTunnelSocket('alpha', 'jwt', handlers)
    // 200 字节 ASCII（>123 字节上限）；另验多字节：80 个中文 '界'（80×3=240 字节 > 123）
    expect(() => socket.close(4401, 'x'.repeat(200))).not.toThrow() // 修复前：原生 close 抛 SyntaxError → 红
    expect(() => socket.close(4401, '界'.repeat(80))).not.toThrow()
    // 省略超长 reason 后仍以合法码关闭，code 语义保留（reason 空）
    expect(MockWS.last!.closedCode).toBe(4401)
    expect(MockWS.last!.closedReason).toBe('')
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
