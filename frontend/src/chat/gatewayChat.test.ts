// seam: chat/gatewayChat —— createGatewayChat（#369 M5 前端接线 Facade）。
// mock 官方 GatewayProtocolClient + 面板隧道 createPanelTunnelSocket，断言：
// 构造（bootstrapToken/connect params/事件路由/close 决策）+ RPC 参数与响应校准
// （sessions.list/create/delete、chat.history/send、commands.list、exec.approval.resolve）。

import { describe, expect, it, vi, beforeEach } from 'vitest'

// 假协议机：捕获 options（含 onEvent/onClose/resolveClose/buildConnectPlan），request/start/stop 可控。
// vi.hoisted：vi.mock 工厂被 hoist 到文件顶部执行，须经 vi.hoisted 共享类定义。
const { MockGatewayProtocolClient, MockGatewayProtocolRequestError, MockShouldPauseReconnect } = vi.hoisted(() => {
  // 官方包不导出 GatewayProtocolClientOptions 顶层类型；mock 只消费下面几个回调/字段
  type MockOpts = {
    onEvent?: (e: unknown) => void
    onHello?: () => void
    onClose?: (c: { code: number; reason: string }, d: unknown) => void
    resolveClose?: (c: Record<string, unknown>) => { retry: boolean; notify?: boolean; reconnectDelayMs?: number }
    onConnectError?: (e: Error) => void
    onRequestTiming?: (t: { errorCode?: string }) => void
    onActivity?: () => void
    buildConnectPlan?: (p: unknown) => unknown | Promise<unknown>
    buildConnectParams?: (p: unknown) => unknown
    createSocket?: (h: unknown) => unknown
    handshake?: unknown
    requestTimeoutMs?: number
  }
  // 简化实现：details.code 在真实网关错误详情里是 ConnectErrorDetailCodes 之一
  const MockShouldPauseReconnect = (params: { details?: unknown; tokenMismatchIsTerminal?: boolean; deviceTokenRetryPending?: boolean; protocolMismatchIsTerminal?: boolean; clientVersionMismatchIsTerminal?: boolean }): boolean => {
    const code = (params.details as { code?: string } | undefined)?.code
    return [
      'PAIRING_REQUIRED',
      'AUTH_TOKEN_MISMATCH',
      'AUTH_BOOTSTRAP_TOKEN_INVALID',
      'AUTH_DEVICE_TOKEN_MISMATCH',
      'AUTH_SCOPE_MISMATCH',
    ].includes(code ?? '')
  }
  class MockGatewayProtocolRequestError extends Error {
    code: string
    gatewayCode: string
    details?: unknown
    constructor(error: { code?: string; message?: string; gatewayCode?: string; details?: unknown }) {
      super(error.message ?? '')
      this.code = error.code ?? ''
      this.gatewayCode = error.gatewayCode ?? ''
      this.details = error.details
    }
  }
  class MockGatewayProtocolClient {
    static last: MockGatewayProtocolClient | null = null
    opts: MockOpts
    request: ReturnType<typeof vi.fn> = vi.fn()
    start = vi.fn()
    stop = vi.fn()
    closeSocket = vi.fn()
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
    fireRequestTiming(timing: { errorCode?: string }): void {
      this.opts.onRequestTiming?.(timing)
    }
    fireActivity(): void {
      this.opts.onActivity?.()
    }
    close(context: { code: number; reason: string }): void {
      const decision = this.opts.resolveClose?.(context)
      this.opts.onClose?.(context, decision)
    }
    connectError(message: string): void {
      this.opts.onConnectError?.(new Error(message))
    }
  }
  return { MockGatewayProtocolClient, MockGatewayProtocolRequestError, MockShouldPauseReconnect }
})

vi.mock('@openclaw/gateway-client/browser', () => ({
  GatewayProtocolClient: MockGatewayProtocolClient,
  GatewayProtocolRequestError: MockGatewayProtocolRequestError,
  shouldPauseGatewayReconnect: MockShouldPauseReconnect,
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
    expect(handlers.onClose).toHaveBeenLastCalledWith(4401, 'Unauthorized', false, false)
    client.close({ code: 4404, reason: 'container denied' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4404, 'container denied', false, false)
    client.close({ code: 4403, reason: 'must change password' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4403, 'must change password', false, false)
    client.close({ code: 4402, reason: 'gateway down' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4402, 'gateway down', true, false)
    client.close({ code: 1006, reason: 'abnormal' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(1006, 'abnormal', true, false)
    // 各 code 的 retry 决策
    const decisions: boolean[] = []
    for (const code of [4401, 4404, 4403, 4402, 1006]) {
      decisions.push(client.opts.resolveClose!({ code, reason: '', generation: 0, socketOpened: true, helloReceived: false, connectRequestSent: false }).retry)
    }
    expect(decisions).toEqual([false, false, false, true, true])
  })

  it('D2: give-up（连续失败超阈值）→ onClose 透传 retry:false（UI 如实提示手动重连）', () => {
    const { client, handlers } = makeGateway()
    for (let i = 0; i < 5; i++) client.close({ code: 4402, reason: 'down' })
    // 第 5 次 close：resolveClose 达阈值返回 retry:false → onClose 第三个参数 false
    expect(handlers.onClose).toHaveBeenLastCalledWith(4402, 'down', false, false)
  })

  it('F1: connect 阶段被拒（PAIRING_REQUIRED / AUTH 错误）→ retry:false（防 #369 空转重连）', () => {
    const { client } = makeGateway()
    const connError = new MockGatewayProtocolRequestError({
      code: 'connect',
      message: 'gateway connect failed',
      gatewayCode: 'ERR_PAIRING_REQUIRED',
      details: { code: 'PAIRING_REQUIRED' },
    })
    const decision = client.opts.resolveClose!({
      code: 1000, // tunnelSocket 把 connect 失败码 1008 映射为 1000
      reason: 'closed(1008)',
      generation: 0,
      socketOpened: true,
      helloReceived: false,
      connectRequestSent: true,
      connectFailure: { error: connError },
    })
    expect(decision.retry).toBe(false)
    expect(decision.notify).toBe(true)
  })

  it('F1: connect 被拒但错误非非恢复类（如网关启动中）→ 仍 retry（交退避自愈）', () => {
    const { client } = makeGateway()
    const connError = new MockGatewayProtocolRequestError({
      code: 'connect',
      message: 'gateway starting',
      gatewayCode: '',
      details: { code: 'SOMETHING_ELSE' },
    })
    const decision = client.opts.resolveClose!({
      code: 1013,
      reason: 'gateway starting',
      generation: 0,
      socketOpened: true,
      helloReceived: false,
      connectRequestSent: true,
      connectFailure: { error: connError },
    })
    expect(decision.retry).toBe(true)
    expect(decision.reconnectDelayMs).toBeUndefined()
  })

  it('F2: resolveClose 省略 reconnectDelayMs（交协议机指数退避，防退避/尝试上限成死代码）', () => {
    const { client } = makeGateway()
    const ctx = {
      code: 4402,
      reason: '',
      generation: 0,
      socketOpened: true,
      helloReceived: false,
      connectRequestSent: false,
    }
    const d1 = client.opts.resolveClose!(ctx)
    expect(d1.retry).toBe(true)
    expect(d1.reconnectDelayMs).toBeUndefined()
    const d2 = client.opts.resolveClose!({ ...ctx, code: 1006 })
    expect(d2.retry).toBe(true)
    expect(d2.reconnectDelayMs).toBeUndefined()
  })

  it('F2: 连续失败达阈值 → 停止自动重连转手动（give-up 防无限空转）；hello 重置计数', () => {
    const { client } = makeGateway()
    const ctx = {
      code: 4402,
      reason: '',
      generation: 0,
      socketOpened: true,
      helloReceived: false,
      connectRequestSent: false,
    }
    const retries: boolean[] = []
    for (let i = 0; i < 5; i++) retries.push(client.opts.resolveClose!(ctx).retry)
    expect(retries).toEqual([true, true, true, true, false])
    client.fireHello() // 重连成功 → 重置计数，可再次退避重试
    expect(client.opts.resolveClose!(ctx).retry).toBe(true)
  })

  it('P1-6: 稳定连接（hello 后存活超阈值）断开不计失败预算；crash-loop（hello 即崩）计数累积', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const { client } = makeGateway()
      const ctx = {
        code: 4402,
        reason: '',
        generation: 0,
        socketOpened: true,
        helloReceived: true, // 已 hello
        connectRequestSent: true,
      }
      // 场景 A：hello 后存活超过 30s 稳定阈值再断（如看门狗自发 closeSocket / 网络抖动）→ 不计费
      client.fireHello()
      vi.advanceTimersByTime(31_000)
      expect(client.opts.resolveClose!(ctx).retry).toBe(true) // 稳定断开不消耗预算
      // 场景 B：crash-loop——hello 后立即崩（<30s 阈值），连续 5 次仍累积到 give-up
      for (let i = 0; i < 4; i++) {
        client.fireHello()
        vi.advanceTimersByTime(1_000) // 存活 1s 即崩
        expect(client.opts.resolveClose!(ctx).retry).toBe(true)
      }
      client.fireHello()
      vi.advanceTimersByTime(1_000)
      expect(client.opts.resolveClose!(ctx).retry).toBe(false) // 第 5 次 → give-up（crash-loop 不再无限空转）
    } finally {
      vi.useRealTimers()
    }
  })

  it('F4: 构造带 requestTimeoutMs（RPC 有界等待，防半开连接 promise 永挂）', () => {
    const { client } = makeGateway()
    expect(client.opts.requestTimeoutMs).toBe(30_000)
  })

  it('A2: RPC 超时（CLIENT_TIMEOUT）→ 仅 reject 请求，不 teardown 整条连接（防慢请求全量重连循环）', () => {
    const { client } = makeGateway()
    client.fireRequestTiming({ errorCode: 'CLIENT_TIMEOUT' })
    expect(client.closeSocket).not.toHaveBeenCalled()
    // 非超时错误码同样不关
    client.closeSocket.mockClear()
    client.fireRequestTiming({ errorCode: 'SESSION_NOT_FOUND' })
    expect(client.closeSocket).not.toHaveBeenCalled()
  })

  it('A2/看门狗: 60s 无网关帧 → closeSocket 强制重连（黑洞自愈）；onActivity 刷新则不误杀', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const { gw, client } = makeGateway()
      gw.start()
      // 刚 start：未超时
      vi.advanceTimersByTime(15_000)
      expect(client.closeSocket).not.toHaveBeenCalled()
      // 收到网关帧 → 刷新活动时间
      client.fireActivity()
      vi.advanceTimersByTime(45_000) // onActivity 后 45s，仍未到 60s 阈值
      expect(client.closeSocket).not.toHaveBeenCalled()
      // 继续无帧 → 超 60s → 强制重连
      vi.advanceTimersByTime(15_001)
      expect(client.closeSocket).toHaveBeenCalledWith(1000, 'silence timeout')
      gw.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('A3: crypto.randomUUID 不可用（非安全上下文）→ 兜底生成 requestId / 幂等 key（RPC 层不崩）', async () => {
    // 非安全上下文：crypto 存在但无 randomUUID（jsdom 有 getRandomValues）——A3 修复用
    // getRandomValues 兜底（32-hex），不依赖 Math.random 坍缩路径
    vi.stubGlobal('crypto', { getRandomValues: (arr: Uint8Array) => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 7) % 256; return arr } } as unknown as Crypto)
    try {
      const { gw, client } = makeGateway()
      client.request.mockResolvedValue({})
      // send 的幂等 key 走 createRequestId 兜底（不抛 TypeError）
      await expect(gw.send('sk-1', 'hi')).resolves.toBeUndefined()
      expect(client.request).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      )
      const params = client.request.mock.calls[0][1] as { idempotencyKey: string }
      // P2-4（code review）：兜底路径也须 32-hex（原 Math.random 兜底 ~30 位 base36，违反自钉契约
      // /^[a-z0-9]{32}$/ 且跨路径与 randomUUID 格式不一致）
      expect(params.idempotencyKey).toMatch(/^[a-z0-9]{32}$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('P2-4: getRandomValues 兜底产出 32-hex（无 randomUUID 时 createSession/send 幂等 key 同格式）', async () => {
    // 只去掉 randomUUID（保留 getRandomValues）——A3 测试已覆盖兜底路径
    const cryptoNoUUID = {
      getRandomValues: (arr: Uint8Array) => {
        // 真实随机填充（确定性 mock 会让两次调用产出同 key，无法断言不碰撞）
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256)
        return arr
      },
    } as unknown as Crypto
    vi.stubGlobal('crypto', cryptoNoUUID)
    try {
      const { gw, client } = makeGateway()
      client.request.mockResolvedValue({ key: 'sk-new' })
      await gw.createSession()
      await gw.send('sk-1', 'hi')
      const createKey = (client.request.mock.calls[0][1] as { key: string }).key
      const sendKey = (client.request.mock.calls[1][1] as { idempotencyKey: string }).idempotencyKey
      expect(createKey).toMatch(/^[a-z0-9]{32}$/)
      expect(sendKey).toMatch(/^[a-z0-9]{32}$/) // 跨路径统一 32-hex
      expect(createKey).not.toBe(sendKey) // 不同调用不同 key（不碰撞）
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('F10: 握手超时 ≥ 隧道侧网关连接超时（server CONNECT_TIMEOUT_MS=5000）+ 余量', () => {
    const { client } = makeGateway()
    expect(client.opts.handshake).toMatchObject({ mode: 'require-challenge' })
    expect((client.opts.handshake as { timeoutMs: number }).timeoutMs).toBeGreaterThanOrEqual(5000)
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

  it('deleteSession → sessions.delete{key}（不带 archivedOnly——网关对未归档会话恒拒，P0）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    await gw.deleteSession('sk-1')
    // P0 回归：恒带 archivedOnly:true 让所有正常会话删除被网关 INVALID_REQUEST 拒绝
    expect(client.request).toHaveBeenCalledWith('sessions.delete', { key: 'sk-1' })
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
