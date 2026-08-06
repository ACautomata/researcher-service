// seam: chat/deviceAuth —— 面板存储层与官方 GatewayBrowserDeviceAuthLifecycle 的组合接缝（#375 · 多容器修复）。
// 用**真实官方包**（非 mock）+ 面板 deviceIdentity（localStorage 身份）+ createPanelTokenStore（服务端 DB
// token），验证「接口对齐」可被配对编排切片直接消费：bootstrap 首连 → PAIRING_REQUIRED 后 acceptHello
// 持久化 deviceToken（服务端）→ 重连复用（不再走 bootstrap）。
//
// 多容器配对 bug 修复（用户定案）：deviceToken 持久化上移服务端 DB（Pairing.deviceToken 密文列，按
// containerId 一对一），替代原 localStorage（键缺容器维度 → 跨容器共用 → AUTH_DEVICE_TOKEN_MISMATCH）。
// 本文件 mock @/api/chat 的配对 token REST（内存 Map 模拟服务端），断言 token 读写按容器名隔离。
// 设备身份（Ed25519 密钥对）仍 localStorage（签名握手本地）。

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { GatewayBrowserDeviceAuthLifecycle } from '@openclaw/gateway-client/browser'

// mock 服务端配对 token REST：内存 Map<container, token> 模拟 Pairing.deviceToken
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

import { createDeviceAuthLifecycle, hasStoredDeviceTokenFor, createPanelTokenStore } from './deviceAuth'

const client = { id: 'webchat-ui', mode: 'webchat', platform: 'browser', version: 'test' } as const

describe('deviceAuth（组合层：官方 GatewayBrowserDeviceAuthLifecycle 接入 · 多容器修复）', () => {
  beforeEach(() => {
    localStorage.clear()
    pairingTokenDB.clear()
    vi.clearAllMocks()
  })

  it('createDeviceAuthLifecycle 返回官方 GatewayBrowserDeviceAuthLifecycle 实例（接口对齐）', () => {
    const lifecycle = createDeviceAuthLifecycle('alpha')
    expect(lifecycle).toBeInstanceOf(GatewayBrowserDeviceAuthLifecycle)
    expect(typeof lifecycle.buildPlan).toBe('function')
    expect(typeof lifecycle.acceptHello).toBe('function')
    expect(typeof lifecycle.clearStoredToken).toBe('function')
  })

  it('buildPlan 首连（服务端无该容器 token）→ 用 bootstrap token + 设备签名块（deviceId 来自本地身份）', async () => {
    const lifecycle = createDeviceAuthLifecycle('alpha')
    const plan = await lifecycle.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read', 'operator.write'],
      bootstrapToken: 'boot-1',
      nonce: 'n1',
    })
    expect(plan.identity).not.toBeNull()
    expect(plan.auth).toMatchObject({ bootstrapToken: 'boot-1' })
    expect(plan.auth!.deviceToken).toBeUndefined() // 首连无 deviceToken
    expect(plan.device).toBeTruthy() // 有设备签名块（网关逐字节校验）
    expect(plan.device!.id).toBe(plan.identity!.deviceId)
    expect(plan.device!.publicKey).toBe(plan.identity!.publicKey)
    expect(plan.device!.signedAt).toBeTypeOf('number')
  })

  it('acceptHello 下发 deviceToken → 持久化到服务端（按容器名）；重连 buildPlan 复用（不再走 bootstrap）', async () => {
    const lifecycle = createDeviceAuthLifecycle('alpha')
    const plan1 = await lifecycle.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n1',
    })
    await lifecycle.acceptHello(
      { auth: { deviceToken: 'dt-1', role: 'operator', scopes: ['operator.read'] } },
      plan1,
    )
    // token 落到服务端（按容器名 alpha），非 localStorage
    expect(MockApiChat.putDeviceToken).toHaveBeenCalledWith('alpha', 'dt-1')
    expect(pairingTokenDB.get('alpha')).toBe('dt-1')
    // 重连：服务端有该容器 token → 用 deviceToken，不再 bootstrap
    const plan2 = await lifecycle.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n2',
    })
    expect(plan2.auth!.deviceToken).toBe('dt-1')
    expect(plan2.auth!.bootstrapToken).toBeUndefined()
  })

  it('多容器隔离（核心修复断言）：alpha 配对落 token 不影响 beta 凭证选择（beta 仍走 bootstrap）', async () => {
    // alpha 配对落 token（服务端）
    pairingTokenDB.set('alpha', 'dt-alpha')
    // beta 的 lifecycle 读不到 alpha 的 token → 首连走 bootstrap
    const betaLifecycle = createDeviceAuthLifecycle('beta')
    const betaPlan = await betaLifecycle.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-beta',
      nonce: 'n1',
    })
    expect(betaPlan.auth!.bootstrapToken).toBe('boot-beta')
    expect(betaPlan.auth!.deviceToken).toBeUndefined()
    expect(MockApiChat.getDeviceToken).toHaveBeenCalledWith('beta') // 按容器名读
    // alpha 的 lifecycle 复用自己的 token
    const alphaLifecycle = createDeviceAuthLifecycle('alpha')
    const alphaPlan = await alphaLifecycle.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-alpha',
      nonce: 'n1',
    })
    expect(alphaPlan.auth!.deviceToken).toBe('dt-alpha')
  })

  it('token 失效（网关重置）：clear 为 no-op（每容器一份语义下由下次 PUT 覆盖收敛），重配对后 store 覆盖', async () => {
    const lifecycle = createDeviceAuthLifecycle('alpha')
    const plan1 = await lifecycle.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n1',
    })
    await lifecycle.acceptHello({ auth: { deviceToken: 'dt-old', role: 'operator', scopes: [] } }, plan1)
    expect(pairingTokenDB.get('alpha')).toBe('dt-old')
    // clearStoredToken 调面板 store.clear（no-op）——不删服务端 token（避免误清后无法重连）
    await lifecycle.clearStoredToken(plan1)
    expect(MockApiChat.putDeviceToken).toHaveBeenCalledTimes(1) // clear 不触发新 REST 写
    // 重新配对：新 hello-ok 下发 dt-new → store 覆盖 → 服务端收敛为新 token
    await lifecycle.acceptHello({ auth: { deviceToken: 'dt-new', role: 'operator', scopes: [] } }, plan1)
    expect(pairingTokenDB.get('alpha')).toBe('dt-new')
  })

  it('storage 不可用（null）→ buildPlan 无设备身份（identity null，纯 bootstrap 降级；token 仍走服务端）', async () => {
    const lifecycle = createDeviceAuthLifecycle('alpha', null)
    const plan = await lifecycle.buildPlan({
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

  it('hasStoredDeviceTokenFor：服务端无该容器 token → false；acceptHello 持久化后 → true；跨容器 → false', async () => {
    // 未配对（服务端空）→ false（gatewayChat 据此走首连 bootstrap token）
    expect(await hasStoredDeviceTokenFor('alpha', client.id, 'operator')).toBe(false)
    const lifecycle = createDeviceAuthLifecycle('alpha')
    const plan = await lifecycle.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n1',
    })
    await lifecycle.acceptHello({ auth: { deviceToken: 'dt-1', role: 'operator', scopes: [] } }, plan)
    // 服务端已落该容器 token → true（走 deviceToken 复用）
    expect(await hasStoredDeviceTokenFor('alpha', client.id, 'operator')).toBe(true)
    // 跨容器：beta 未配对 → false（核心隔离——clientId 恒定也不误判）
    expect(await hasStoredDeviceTokenFor('beta', client.id, 'operator')).toBe(false)
  })

  it('createPanelTokenStore.load：服务端读异常（网络/归属）→ null（降级 bootstrap 首连，不阻断配对）', async () => {
    MockApiChat.getDeviceToken.mockRejectedValueOnce(new Error('network down'))
    const store = createPanelTokenStore('alpha')
    // 官方 load 接口带键参数（clientId/deviceId/role），面板实现忽略（按容器名读）
    expect(await store.load({ clientId: 'webchat-ui', deviceId: 'dev-1', role: 'operator' })).toBeNull()
  })
})
