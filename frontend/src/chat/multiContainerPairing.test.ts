// 多容器配对 bug 回归测试（修复断言 · 用户定案：token 上移服务端 DB）。
// 根因（红态已证）：deviceToken 原存 localStorage，键 (clientId='webchat-ui', deviceId, role) 缺容器维度 →
// 跨容器共用 → 容器 2 复用容器 1 的 token → 网关 AUTH_DEVICE_TOKEN_MISMATCH（NON_RECOVERABLE）→ 连接即停。
// 修复：tokenStore 换服务端 DB 实现（createPanelTokenStore，按 URL 容器名读写 Pairing.deviceToken）。
// 断言：容器 1 配对（服务端有 alpha token）后，连容器 2（服务端无 beta token）→ buildConnectPlan 发
// beta 的 bootstrap token（不复用跨容器 token）；配对后连容器 1 → 复用 alpha token（不丢复用能力）。

import { describe, expect, it, vi, beforeEach } from 'vitest'

// ---- mock 协议机/隧道（保留真实官方 GatewayBrowserDeviceAuthLifecycle）----
const { MockGatewayProtocolClient, MockGatewayProtocolRequestError, MockShouldPauseReconnect } = vi.hoisted(() => {
  type MockOpts = {
    onClose?: (c: { code: number; reason: string }, d: unknown) => void
    resolveClose?: (c: Record<string, unknown>) => { retry: boolean; notify?: boolean }
    buildConnectPlan?: (p: unknown) => unknown | Promise<unknown>
    buildConnectParams?: (p: unknown) => unknown
    createSocket?: (h: unknown) => unknown
  }
  const MockShouldPauseReconnect = (params: { details?: unknown }): boolean => {
    const code = (params.details as { code?: string } | undefined)?.code
    return ['PAIRING_REQUIRED', 'AUTH_TOKEN_MISMATCH', 'AUTH_BOOTSTRAP_TOKEN_INVALID', 'AUTH_DEVICE_TOKEN_MISMATCH', 'AUTH_SCOPE_MISMATCH'].includes(code ?? '')
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
    constructor(opts: MockOpts) {
      this.opts = opts
      MockGatewayProtocolClient.last = this
    }
    close(context: { code: number; reason: string; connectFailure?: { error: Error } }): void {
      const decision = this.opts.resolveClose?.(context)
      this.opts.onClose?.(context, decision)
    }
  }
  return { MockGatewayProtocolClient, MockGatewayProtocolRequestError, MockShouldPauseReconnect }
})

vi.mock('@openclaw/gateway-client/browser', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  return {
    ...orig,
    GatewayProtocolClient: MockGatewayProtocolClient,
    GatewayProtocolRequestError: MockGatewayProtocolRequestError,
    shouldPauseGatewayReconnect: MockShouldPauseReconnect,
  }
})
vi.mock('./tunnelSocket', () => ({
  createPanelTunnelSocket: vi.fn(() => ({ isOpen: () => false, send: vi.fn(), close: vi.fn() })),
}))

// ---- mock 服务端配对 token REST（@/api/chat）：内存 Map<container, token> 模拟 Pairing.deviceToken ----
const { pairingTokenDB, MockApiChat } = vi.hoisted(() => {
  const pairingTokenDB = new Map<string, string>()
  const MockApiChat = {
    getDeviceToken: vi.fn(async (name: string) => pairingTokenDB.get(name) ?? null),
    putDeviceToken: vi.fn(async (name: string, token: string) => {
      pairingTokenDB.set(name, token)
    }),
    approvePairing: vi.fn(async () => {}),
  }
  return { pairingTokenDB, MockApiChat }
})
vi.mock('@/api/chat', () => MockApiChat)

import { createGatewayChat } from './gatewayChat'
import { createDeviceAuthLifecycle, hasStoredDeviceTokenFor } from './deviceAuth'
import { loadDeviceIdentity } from './deviceIdentity'

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
  }
}
const identityStorage = makeMemoryStorage() // 设备身份（密钥对）仍 localStorage

function makeHandlers() {
  return { onReady: vi.fn(), onFrame: vi.fn(), onClose: vi.fn(), onError: vi.fn() }
}

beforeEach(async () => {
  vi.clearAllMocks()
  MockGatewayProtocolClient.last = null
  pairingTokenDB.clear()
  identityStorage.clear()
  await loadDeviceIdentity(identityStorage) // 生成共享设备身份（跨容器同一份，签名握手本地）
})

describe('多容器配对 bug 回归（token 上移服务端 DB）', () => {
  it('核心修复断言：容器 1 配对后，连容器 2 发 bootstrap token（不复用容器 1 的跨容器 token）', async () => {
    // Arrange：容器 1 (alpha) 已配对——服务端 Pairing.deviceToken 有 alpha 的 token（beta 无）
    pairingTokenDB.set('alpha', 'token-from-ALPHA')
    expect(await hasStoredDeviceTokenFor('beta', 'webchat-ui', 'operator')).toBe(false) // beta 未配对

    // Act：连容器 2 (beta)
    const handlers = makeHandlers()
    const gw = createGatewayChat({
      container: 'beta',
      jwt: 'jwt-1',
      bootstrapToken: 'boot-BETA',
      handlers,
      deviceAuth: createDeviceAuthLifecycle('beta', identityStorage),
    })
    const client = MockGatewayProtocolClient.last!
    const plan = (await client.opts.buildConnectPlan!({ nonce: 'n', generation: 0 })) as { auth?: Record<string, unknown> }

    // Assert：发 beta 的 bootstrap token，不复用跨容器 token（绿 = 修复生效；红态时此处是 deviceToken:ALPHA）。
    // 官方 buildGatewayConnectAuth 恒带 deviceToken key（未配对时 = undefined），故断言值非 key 存在性。
    expect(plan.auth?.token).toBe('boot-BETA')
    expect(plan.auth?.deviceToken).toBeUndefined()
    gw.stop()
  })

  it('复用能力保留：容器 1 配对后，重连容器 1 复用其 deviceToken（不走 bootstrap）', async () => {
    pairingTokenDB.set('alpha', 'token-from-ALPHA')
    expect(await hasStoredDeviceTokenFor('alpha', 'webchat-ui', 'operator')).toBe(true)

    const handlers = makeHandlers()
    const gw = createGatewayChat({
      container: 'alpha',
      jwt: 'jwt-1',
      bootstrapToken: 'boot-ALPHA',
      handlers,
      deviceAuth: createDeviceAuthLifecycle('alpha', identityStorage),
    })
    const client = MockGatewayProtocolClient.last!
    const plan = (await client.opts.buildConnectPlan!({ nonce: 'n', generation: 0 })) as { auth?: Record<string, unknown> }

    // 已配对容器复用自己的 token（官方 lifecycle usingStoredDeviceToken 路径），不发 bootstrap
    expect(plan.auth?.token).toBe('token-from-ALPHA')
    gw.stop()
  })

  it('跨容器隔离端到端：连 alpha 配对落 token 不影响 beta 凭证选择', async () => {
    // alpha 配对：hello-ok 下发 token → acceptHello → createPanelTokenStore.store → PUT 落服务端
    pairingTokenDB.set('alpha', 'token-from-ALPHA')

    // beta 凭证选择不受 alpha token 影响（服务端按容器名隔离，clientId 恒定也无妨）
    const betaStore = (await import('./deviceAuth')).createPanelTokenStore('beta')
    expect(await betaStore.load({ clientId: 'webchat-ui', deviceId: 'dev-1', role: 'operator' })).toBeNull()
    const alphaStore = (await import('./deviceAuth')).createPanelTokenStore('alpha')
    expect((await alphaStore.load({ clientId: 'webchat-ui', deviceId: 'dev-1', role: 'operator' }))?.token).toBe('token-from-ALPHA')
    expect(MockApiChat.getDeviceToken).toHaveBeenCalledWith('beta')
    expect(MockApiChat.getDeviceToken).toHaveBeenCalledWith('alpha')
  })
})
