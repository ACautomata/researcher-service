// seam: chat/deviceAuth —— 官方 GatewayBrowserDeviceAuthLifecycle + 浏览器 localStorage tokenStore（ADR 0006）。
// 方向 A（回归 ADR 0006「每浏览器设备 × 每容器」）：deviceToken 按 (container, deviceId, role) 存 localStorage。
// 用真实官方包（非 mock）+ 注入 storage（绕过 vitest 全局 localStorage 不可用），验证 buildPlan/acceptHello/
// clearStoredToken + hasStoredDeviceTokenFor（identity-aware）+ 多容器/多浏览器隔离 + clear 真删。

import { describe, expect, it } from 'vitest'
import { GatewayBrowserDeviceAuthLifecycle } from '@openclaw/gateway-client/browser'
import { createDeviceAuthLifecycle, hasStoredDeviceTokenFor, createContainerTokenStore } from './deviceAuth'

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

describe('deviceAuth（官方 lifecycle + localStorage tokenStore · ADR 0006）', () => {
  it('createDeviceAuthLifecycle 返回官方 lifecycle（接口对齐）', () => {
    expect(createDeviceAuthLifecycle('alpha', makeMemoryStorage())).toBeInstanceOf(GatewayBrowserDeviceAuthLifecycle)
  })

  it('buildPlan 首连（无 token）→ bootstrap token + 设备签名块（deviceId 来自本地身份）', async () => {
    const lc = createDeviceAuthLifecycle('alpha', makeMemoryStorage())
    const plan = await lc.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read', 'operator.write'],
      bootstrapToken: 'boot-1',
      nonce: 'n1',
    })
    expect(plan.identity).not.toBeNull()
    expect(plan.auth).toMatchObject({ bootstrapToken: 'boot-1' })
    expect(plan.auth!.deviceToken).toBeUndefined()
    expect(plan.device!.id).toBe(plan.identity!.deviceId)
  })

  it('acceptHello 下发 deviceToken → 持久化 localStorage（按 container+deviceId）；重连复用', async () => {
    const storage = makeMemoryStorage()
    const lc = createDeviceAuthLifecycle('alpha', storage)
    const plan1 = await lc.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n1',
    })
    await lc.acceptHello({ auth: { deviceToken: 'dt-1', role: 'operator', scopes: ['operator.read'] } }, plan1)
    const plan2 = await lc.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n2',
    })
    expect(plan2.auth!.deviceToken).toBe('dt-1')
    expect(plan2.auth!.bootstrapToken).toBeUndefined()
  })

  it('多容器隔离：alpha 配对不影响 beta（同浏览器同 deviceId，不同 container 键）', async () => {
    const storage = makeMemoryStorage()
    const lc = createDeviceAuthLifecycle('alpha', storage)
    const plan = await lc.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-a',
      nonce: 'n1',
    })
    await lc.acceptHello({ auth: { deviceToken: 'dt-alpha', role: 'operator', scopes: [] } }, plan)
    expect(await hasStoredDeviceTokenFor('alpha', client.id, 'operator', storage)).toBe(true)
    expect(await hasStoredDeviceTokenFor('beta', client.id, 'operator', storage)).toBe(false)
  })

  it('多浏览器隔离（切换浏览器）：新 storage = 新 deviceId = 无 token → bootstrap（核心修复）', async () => {
    // 浏览器 A 配对 alpha
    const storageA = makeMemoryStorage()
    const lcA = createDeviceAuthLifecycle('alpha', storageA)
    const planA = await lcA.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-a',
      nonce: 'n1',
    })
    await lcA.acceptHello({ auth: { deviceToken: 'dt-A', role: 'operator', scopes: [] } }, planA)
    // 浏览器 B：新 storage → 新 deviceId-B → 无 alpha token（即使 A 配对过）
    const storageB = makeMemoryStorage()
    expect(await hasStoredDeviceTokenFor('alpha', client.id, 'operator', storageB)).toBe(false)
    const lcB = createDeviceAuthLifecycle('alpha', storageB)
    const planB = await lcB.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-alpha',
      nonce: 'n1',
    })
    expect(planB.auth!.bootstrapToken).toBe('boot-alpha')
    expect(planB.auth!.deviceToken).toBeUndefined()
  })

  it('clearStoredToken 真删（MISMATCH 自愈前提）：clear 后回 bootstrap', async () => {
    const storage = makeMemoryStorage()
    const lc = createDeviceAuthLifecycle('alpha', storage)
    const plan1 = await lc.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n1',
    })
    await lc.acceptHello({ auth: { deviceToken: 'dt-old', role: 'operator', scopes: [] } }, plan1)
    expect(await hasStoredDeviceTokenFor('alpha', client.id, 'operator', storage)).toBe(true)
    // MISMATCH 自愈（recoverTokenMismatch）调此 → 真删旧 token
    await lc.clearStoredToken(plan1)
    expect(await hasStoredDeviceTokenFor('alpha', client.id, 'operator', storage)).toBe(false)
    const plan2 = await lc.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n2',
    })
    expect(plan2.auth!.bootstrapToken).toBe('boot-1')
    expect(plan2.auth!.deviceToken).toBeUndefined()
  })

  it('storage 不可用（null）→ buildPlan 无设备身份（纯 bootstrap 降级）', async () => {
    const lc = createDeviceAuthLifecycle('alpha', null)
    const plan = await lc.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n1',
    })
    expect(plan.identity).toBeNull()
    expect(plan.device).toBeUndefined()
    expect(plan.auth!.bootstrapToken).toBe('boot-1')
  })

  it('createContainerTokenStore：load/store/clear 按 (container, deviceId, role) 隔离 + clear 真删', async () => {
    const storage = makeMemoryStorage()
    const alphaStore = createContainerTokenStore('alpha', storage)
    await alphaStore.store({ clientId: 'webchat-ui', deviceId: 'dev-1', role: 'operator', token: 'dt-a1', scopes: [] })
    expect((await alphaStore.load({ clientId: 'webchat-ui', deviceId: 'dev-1', role: 'operator' }))?.token).toBe('dt-a1')
    // 不同 container / deviceId 隔离
    expect(
      await createContainerTokenStore('beta', storage).load({ clientId: 'webchat-ui', deviceId: 'dev-1', role: 'operator' }),
    ).toBeNull()
    expect(await alphaStore.load({ clientId: 'webchat-ui', deviceId: 'dev-2', role: 'operator' })).toBeNull()
    // clear 真删（非 no-op）
    await alphaStore.clear({ clientId: 'webchat-ui', deviceId: 'dev-1', role: 'operator' })
    expect(await alphaStore.load({ clientId: 'webchat-ui', deviceId: 'dev-1', role: 'operator' })).toBeNull()
  })
})
