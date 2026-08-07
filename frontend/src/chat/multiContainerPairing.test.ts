// 多容器 + 多浏览器配对回归（方向 A · 回归 ADR 0006「每浏览器设备 × 每容器」）。
// deviceToken 按 (container, deviceId, role) 存浏览器 localStorage——多容器（container 维度）+ 多浏览器
//（deviceId 维度）天然隔离。切换浏览器 = 新 deviceId = 无 token = 自动走 bootstrap 重新配对。
// 历史：#425 曾上移服务端 DB（违背 ADR 0006 行 53 否决），切换浏览器匹配不上——已回退。

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
// approvePairing 仍走 @/api chat（PAIRING_REQUIRED 自动配对编排）；deviceToken 不再经服务端（localStorage）。
vi.mock('@/api/chat', () => ({
  approvePairing: vi.fn(async () => {}),
}))

import { createGatewayChat } from './gatewayChat'
import { createDeviceAuthLifecycle, hasStoredDeviceTokenFor } from './deviceAuth'

const client = { id: 'webchat-ui', mode: 'webchat', platform: 'browser', version: 'test' } as const

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

function makeHandlers() {
  return { onReady: vi.fn(), onFrame: vi.fn(), onClose: vi.fn(), onError: vi.fn() }
}

// 配对 arrange：在 storage 里为 container 配对一个 deviceToken（acceptHello 路径）。
async function pairContainer(storage: Storage, container: string, token: string): Promise<void> {
  const lc = createDeviceAuthLifecycle(container, storage)
  const plan = await lc.buildPlan({ client, role: 'operator', defaultScopes: ['operator.read'], bootstrapToken: 'boot', nonce: 'n1' })
  await lc.acceptHello({ auth: { deviceToken: token, role: 'operator', scopes: [] } }, plan)
}

beforeEach(() => {
  vi.clearAllMocks()
  MockGatewayProtocolClient.last = null
})

describe('多容器 + 多浏览器配对（localStorage · ADR 0006 每浏览器设备 × 每容器）', () => {
  it('多容器隔离：浏览器配对 alpha 不影响 beta 凭证选择（不同 container 键）', async () => {
    const storage = makeMemoryStorage()
    await pairContainer(storage, 'alpha', 'dt-alpha')

    const handlers = makeHandlers()
    const gw = createGatewayChat({
      container: 'beta',
      jwt: 'jwt-1',
      bootstrapToken: 'boot-BETA',
      handlers,
      deviceAuth: createDeviceAuthLifecycle('beta', storage),
      hasStoredDeviceToken: () => hasStoredDeviceTokenFor('beta', client.id, 'operator', storage),
    })
    const c = MockGatewayProtocolClient.last!
    const plan = (await c.opts.buildConnectPlan!({ nonce: 'n', generation: 0 })) as { auth?: Record<string, unknown> }
    // beta 无 token（同浏览器同 deviceId，但 container=beta 键空）→ bootstrap
    expect(plan.auth?.token).toBe('boot-BETA')
    gw.stop()
  })

  it('复用能力保留：配对 alpha 后重连复用 deviceToken（不走 bootstrap）', async () => {
    const storage = makeMemoryStorage()
    await pairContainer(storage, 'alpha', 'dt-alpha')

    const handlers = makeHandlers()
    const gw = createGatewayChat({
      container: 'alpha',
      jwt: 'jwt-1',
      bootstrapToken: 'boot-ALPHA',
      handlers,
      deviceAuth: createDeviceAuthLifecycle('alpha', storage),
      hasStoredDeviceToken: () => hasStoredDeviceTokenFor('alpha', client.id, 'operator', storage),
    })
    const c = MockGatewayProtocolClient.last!
    const plan = (await c.opts.buildConnectPlan!({ nonce: 'n', generation: 0 })) as { auth?: Record<string, unknown> }
    expect(plan.auth?.token).toBe('dt-alpha') // deviceToken 复用（gatewayChat 层 auth.token）
    gw.stop()
  })

  it('切换浏览器（新设备身份）不复用旧设备 token（核心修复 · 用户报「切换浏览器匹配不上」）', async () => {
    // 浏览器 A 配对 alpha
    const storageA = makeMemoryStorage()
    await pairContainer(storageA, 'alpha', 'dt-from-deviceA')
    // 浏览器 B：新 storage → 新 deviceId-B → 无 alpha token（即使 A 配对过）
    const storageB = makeMemoryStorage()
    const handlers = makeHandlers()
    const gw = createGatewayChat({
      container: 'alpha',
      jwt: 'jwt-1',
      bootstrapToken: 'boot-ALPHA',
      handlers,
      deviceAuth: createDeviceAuthLifecycle('alpha', storageB),
      hasStoredDeviceToken: () => hasStoredDeviceTokenFor('alpha', client.id, 'operator', storageB),
    })
    const c = MockGatewayProtocolClient.last!
    const plan = (await c.opts.buildConnectPlan!({ nonce: 'n', generation: 0 })) as { auth?: Record<string, unknown> }
    // 绿（方向 A）：B 走 bootstrap（localStorage 按 deviceId 隔离，B 无 A 的 token）→ 重新配对
    expect(plan.auth?.token).toBe('boot-ALPHA')
    gw.stop()
  })
})
