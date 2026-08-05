// seam: chat/deviceAuth —— 面板存储层与官方 GatewayBrowserDeviceAuthLifecycle 的组合接缝（#375）。
// 用**真实官方包**（非 mock）+ 面板的 deviceIdentity/deviceTokenStore，验证「接口对齐」可被配对编排
// 切片（#371-2）直接消费：bootstrap 首连 → PAIRING_REQUIRED 后 acceptHello 持久化 deviceToken →
// 重连复用（不再走 bootstrap）→ clearStoredToken 回到首连路径。不依赖真实网关。

import { describe, expect, it, beforeEach } from 'vitest'
import { GatewayBrowserDeviceAuthLifecycle } from '@openclaw/gateway-client/browser'
import { createDeviceAuthLifecycle, hasStoredDeviceTokenFor } from './deviceAuth'
import { createDeviceTokenStore } from './deviceTokenStore'

const client = { id: 'webchat-ui', mode: 'webchat', platform: 'browser', version: 'test' } as const

describe('deviceAuth（#375 组合层：官方 GatewayBrowserDeviceAuthLifecycle 接入）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('createDeviceAuthLifecycle 返回官方 GatewayBrowserDeviceAuthLifecycle 实例（接口对齐）', () => {
    const lifecycle = createDeviceAuthLifecycle()
    expect(lifecycle).toBeInstanceOf(GatewayBrowserDeviceAuthLifecycle)
    expect(typeof lifecycle.buildPlan).toBe('function')
    expect(typeof lifecycle.acceptHello).toBe('function')
    expect(typeof lifecycle.clearStoredToken).toBe('function')
  })

  it('buildPlan 首连（无存储 deviceToken）→ 用 bootstrap token + 设备签名块（deviceId 来自本地身份）', async () => {
    const lifecycle = createDeviceAuthLifecycle()
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
    // beta.6 打包版 buildPlan 无 challengeTs 参数（signedAtMs = nowMs ?? Date.now），断言类型不断言值
    expect(plan.device!.signedAt).toBeTypeOf('number')
  })

  it('acceptHello 下发 deviceToken → 持久化到 (clientId,deviceId,role) 键；重连 buildPlan 复用（不再走 bootstrap）', async () => {
    const lifecycle = createDeviceAuthLifecycle()
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
    // tokenStore 实际落盘（独立实例读同一 localStorage 验证）
    const store = createDeviceTokenStore()
    const rec = await store.load({ clientId: client.id, deviceId: plan1.identity!.deviceId, role: 'operator' })
    expect(rec).toEqual({ token: 'dt-1', scopes: ['operator.read'] })
    // 重连：有存储 deviceToken → 用 deviceToken，不再 bootstrap
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

  it('token 失效 → clearStoredToken 清除持久化 token，再连回到 bootstrap 首连路径（重配对）', async () => {
    const lifecycle = createDeviceAuthLifecycle()
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
    await lifecycle.clearStoredToken(plan1)
    const store = createDeviceTokenStore()
    expect(await store.load({ clientId: client.id, deviceId: plan1.identity!.deviceId, role: 'operator' })).toBeNull()
    const plan2 = await lifecycle.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n2',
    })
    expect(plan2.auth!.deviceToken).toBeUndefined()
    expect(plan2.auth!.bootstrapToken).toBe('boot-1') // 回到首连路径
  })

  it('storage 不可用（null）→ buildPlan 无设备身份（identity null，纯 bootstrap 降级）', async () => {
    const lifecycle = createDeviceAuthLifecycle(null)
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

  it('hasStoredDeviceTokenFor：无存储 token → false；acceptHello 持久化后 → true；clearStoredToken 后 → false', async () => {
    // 未配对（localStorage 空）→ 无 deviceToken → false（gatewayChat 据此走首连 token）
    expect(await hasStoredDeviceTokenFor(client.id, 'operator')).toBe(false)
    const lifecycle = createDeviceAuthLifecycle()
    const plan = await lifecycle.buildPlan({
      client,
      role: 'operator',
      defaultScopes: ['operator.read'],
      bootstrapToken: 'boot-1',
      nonce: 'n1',
    })
    await lifecycle.acceptHello(
      { auth: { deviceToken: 'dt-1', role: 'operator', scopes: ['operator.read'] } },
      plan,
    )
    // acceptHello 已把 deviceToken 落到 localStorage → 重连凭证判断返回 true（走 deviceToken）
    expect(await hasStoredDeviceTokenFor(client.id, 'operator')).toBe(true)
    // 键含 (clientId, deviceId, role)：role 不匹配 → false（不误判其他角色已配对）
    expect(await hasStoredDeviceTokenFor(client.id, 'admin')).toBe(false)
    // token 失效清除后 → false（回首连 token 路径，重配对）
    await lifecycle.clearStoredToken(plan)
    expect(await hasStoredDeviceTokenFor(client.id, 'operator')).toBe(false)
  })

  it('hasStoredDeviceTokenFor：storage 不可用（null）→ false（无身份降级，走 bootstrap）', async () => {
    expect(await hasStoredDeviceTokenFor(client.id, 'operator', null)).toBe(false)
  })
})
