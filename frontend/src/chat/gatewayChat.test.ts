// seam: chat/gatewayChat —— createGatewayChat（#369 M5 前端接线 Facade）。
// mock 官方 GatewayProtocolClient + 面板隧道 createPanelTunnelSocket，断言：
// 构造（bootstrapToken/connect params/事件路由/close 决策）+ RPC 参数与响应校准
// （sessions.list/create/delete、chat.history/send、commands.list、exec.approval.resolve）。

import { describe, expect, it, vi, beforeEach } from 'vitest'

// 假协议机：捕获 options（含 onEvent/onClose/resolveClose/buildConnectPlan），request/start/stop 可控。
// vi.hoisted：vi.mock 工厂被 hoist 到文件顶部执行，须经 vi.hoisted 共享类定义。
const { MockGatewayProtocolClient } = vi.hoisted(() => {
  // 官方包不导出 GatewayProtocolClientOptions 顶层类型；mock 只消费下面几个回调/字段
  type MockOpts = {
    onEvent?: (e: unknown) => void
    onHello?: () => void
    onClose?: (c: { code: number; reason: string }, d: unknown) => void
    resolveClose?: (c: Record<string, unknown>) => { retry: boolean }
    onConnectError?: (e: Error) => void
    buildConnectPlan?: (p: unknown) => unknown | Promise<unknown>
    buildConnectParams?: (p: unknown) => unknown
    createSocket?: (h: unknown) => unknown
  }
  class MockGatewayProtocolClient {
    static last: MockGatewayProtocolClient | null = null
    opts: MockOpts
    request: ReturnType<typeof vi.fn> = vi.fn()
    start = vi.fn()
    stop = vi.fn()
    connected = false
    connecting = false
    constructor(opts: MockOpts) {
      this.opts = opts
      MockGatewayProtocolClient.last = this
    }
    emitEvent(frame: unknown): void {
      this.opts.onEvent?.(frame)
    }
    fireHello(): void {
      this.opts.onHello?.()
    }
    close(context: { code: number; reason: string }): void {
      const decision = this.opts.resolveClose?.(context)
      this.opts.onClose?.(context, decision)
    }
    connectError(message: string): void {
      this.opts.onConnectError?.(new Error(message))
    }
  }
  return { MockGatewayProtocolClient }
})

vi.mock('@openclaw/gateway-client/browser', () => ({
  GatewayProtocolClient: MockGatewayProtocolClient,
}))

vi.mock('./tunnelSocket', () => ({
  createPanelTunnelSocket: vi.fn((container: string, jwt: string, handlers: unknown) => ({
    isOpen: () => false,
    send: vi.fn(),
    close: vi.fn(),
    // 供测试断言 createSocket 透传了 handlers
    __container: container,
    __jwt: jwt,
    __handlers: handlers,
  })),
}))

import { createGatewayChat } from './gatewayChat'

function makeHandlers() {
  return {
    onReady: vi.fn(),
    onFrame: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
  }
}

function makeGateway(handlers = makeHandlers()) {
  const gw = createGatewayChat({ container: 'alpha', jwt: 'jwt-1', bootstrapToken: 'boot-1', handlers })
  const client = MockGatewayProtocolClient.last!
  return { gw, client, handlers }
}

beforeEach(() => {
  vi.clearAllMocks()
  MockGatewayProtocolClient.last = null
})

describe('createGatewayChat（#369 隧道 Facade）', () => {
  it('构造：buildConnectPlan 用 bootstrapToken + operator scopes + tool-events；start/stop 透传协议机', async () => {
    const handlers = makeHandlers()
    const gw = createGatewayChat({ container: 'alpha', jwt: 'jwt-1', bootstrapToken: 'boot-1', handlers })
    const client = MockGatewayProtocolClient.last!
    const plan = await client.opts.buildConnectPlan!({ nonce: 'n', generation: 0 })
    expect(plan).toEqual({
      role: 'operator',
      scopes: ['operator.read', 'operator.write', 'operator.approvals'],
      caps: ['tool-events'],
      token: 'boot-1',
    })
    const params = client.opts.buildConnectParams!(plan)
    expect(params).toMatchObject({ minProtocol: 4, maxProtocol: 4, auth: { token: 'boot-1' } })
    expect((params as { caps: string[] }).caps).toEqual(['tool-events'])
    gw.start()
    expect(client.start).toHaveBeenCalledTimes(1)
    gw.stop()
    expect(client.stop).toHaveBeenCalledTimes(1)
  })

  it('createSocket 用容器名 + JWT 建面板隧道（容器名进 URL、token 进 subprotocol）', () => {
    const { client } = makeGateway()
    const socket = client.opts.createSocket!({} as never) as unknown as {
      __container: string
      __jwt: string
      __handlers: unknown
    }
    expect(socket.__container).toBe('alpha')
    expect(socket.__jwt).toBe('jwt-1')
    expect(socket.__handlers).toBeTruthy() // open/message/close/error handlers 透传给隧道 socket
  })

  it('onHello → handlers.onReady', () => {
    const { client, handlers } = makeGateway()
    client.fireHello()
    expect(handlers.onReady).toHaveBeenCalledTimes(1)
  })

  it('onEvent → 事件翻译路由到 handlers.onFrame（chat delta → text 帧）', () => {
    const { client, handlers } = makeGateway()
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'delta', deltaText: '你好' } })
    expect(handlers.onFrame).toHaveBeenCalledWith({ type: 'text', runId: 'r1', delta: '你好' })
  })

  it('close 决策：4401/4404/4403 → retry:false + notify；4402 → retry:true；其他 → retry:true', () => {
    const { client, handlers } = makeGateway()
    client.close({ code: 4401, reason: 'Unauthorized' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4401, 'Unauthorized')
    client.close({ code: 4404, reason: 'container denied' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4404, 'container denied')
    client.close({ code: 4403, reason: 'must change password' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4403, 'must change password')
    client.close({ code: 4402, reason: 'gateway down' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4402, 'gateway down')
    client.close({ code: 1006, reason: 'abnormal' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(1006, 'abnormal')
    // 各 code 的 retry 决策
    const decisions: boolean[] = []
    for (const code of [4401, 4404, 4403, 4402, 1006]) {
      decisions.push(client.opts.resolveClose!({ code, reason: '', generation: 0, socketOpened: true, helloReceived: false, connectRequestSent: false }).retry)
    }
    expect(decisions).toEqual([false, false, false, true, true])
  })

  it('onConnectError → handlers.onError（传输级错误上报）', () => {
    const { client, handlers } = makeGateway()
    client.connectError('WebSocket connection failed: ECONNREFUSED')
    expect(handlers.onError).toHaveBeenCalledWith('WebSocket connection failed: ECONNREFUSED')
  })

  it('listSessions → sessions.list RPC + 响应校准（key/derivedTitle/updatedAt，跳过非法项）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({
      sessions: [
        { key: 's1', derivedTitle: '标题', updatedAt: '2026-08-04' },
        { sessionKey: 's2' },
        { key: 123 },
        'not-a-dict',
      ],
    })
    const list = await gw.listSessions()
    expect(client.request).toHaveBeenCalledWith('sessions.list', { includeDerivedTitles: true })
    expect(list).toEqual([
      { session_key: 's1', title: '标题', updated_at: '2026-08-04' },
      { session_key: 's2', title: '', updated_at: '' },
    ])
  })

  it('createSession → sessions.create（幂等 key + label）+ 返回网关 key', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({ key: 'new-session-key' })
    await expect(gw.createSession('我的会话')).resolves.toBe('new-session-key')
    expect(client.request).toHaveBeenCalledWith('sessions.create', expect.objectContaining({ label: '我的会话' }))
    const params = client.request.mock.calls[0][1] as { key: string }
    expect(params.key).toMatch(/^[a-z0-9]{32}$/) // 幂等 key 为 hex uuid
  })

  it('createSession 网关未返回 key → 抛错', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    await expect(gw.createSession()).rejects.toThrow('会话创建失败')
  })

  it('deleteSession → sessions.delete{key, archivedOnly:true}', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    await gw.deleteSession('sk-1')
    expect(client.request).toHaveBeenCalledWith('sessions.delete', { key: 'sk-1', archivedOnly: true })
  })

  it('getHistory → chat.history{sessionKey,limit?,messageId?} + 响应校准（messages 过滤非 dict、分页字段）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({
      messages: [{ role: 'assistant', text: 'a' }, 'skip-me'],
      hasMore: true,
      nextOffset: 5,
    })
    const h = await gw.getHistory('sk-1', 20, 'mid-9')
    expect(client.request).toHaveBeenCalledWith('chat.history', { sessionKey: 'sk-1', limit: 20, messageId: 'mid-9' })
    expect(h).toEqual({ messages: [{ role: 'assistant', text: 'a' }], hasMore: true, nextOffset: 5 })
  })

  it('getHistory 缺省分页字段 → 回退', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({ messages: [] })
    const h = await gw.getHistory('sk-1')
    expect(h).toEqual({ messages: [], hasMore: false, nextOffset: null })
  })

  it('send → chat.send{sessionKey,message,idempotencyKey}', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    await gw.send('sk-1', '你好')
    expect(client.request).toHaveBeenCalledWith('chat.send', {
      sessionKey: 'sk-1',
      message: '你好',
      idempotencyKey: expect.any(String),
    })
  })

  it('listCommands → commands.list + 响应校准（textAliases 缺省回退 /name）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({
      commands: [
        { name: 'model', description: '切换模型', textAliases: ['/model', '/m'] },
        { name: 'plain', description: '无别名' },
        { name: 7 },
      ],
    })
    const list = await gw.listCommands()
    expect(client.request).toHaveBeenCalledWith('commands.list', {})
    expect(list).toEqual([
      { name: 'model', description: '切换模型', aliases: ['/model', '/m'] },
      { name: 'plain', description: '无别名', aliases: ['/plain'] },
    ])
  })

  it('resolveApproval → {kind}.approval.resolve，params 仅 id/decision（kind 派生 method 名）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({ applied: true, approval: {} })
    await gw.resolveApproval('ap-1', 'exec', 'allow-once')
    expect(client.request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'ap-1',
      decision: 'allow-once',
    })
    await gw.resolveApproval('ap-2', 'plugin', 'deny')
    expect(client.request).toHaveBeenLastCalledWith('plugin.approval.resolve', {
      id: 'ap-2',
      decision: 'deny',
    })
  })
})
