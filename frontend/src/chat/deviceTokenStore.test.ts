// seam: chat/deviceTokenStore —— deviceToken 按 (clientId, deviceId, role) 键 localStorage 持久化（#375）。
// 实现官方 `GatewayBrowserDeviceTokenStore` 接口契约（load/store/clear），另加 clearForClient/clearForDevice
// 供「token 失效按容器/设备清除」的批处理。只测外部可观察行为（键格式/读写/隔离/清除），不依赖真实网关。

import { describe, expect, it, beforeEach } from 'vitest'
import { createDeviceTokenStore, TOKEN_STORAGE_KEY_PREFIX } from './deviceTokenStore'

describe('deviceTokenStore（#375 deviceToken (clientId,deviceId,role) 持久化）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('store → load 正确读写（返回 {token, scopes}）', async () => {
    const s = createDeviceTokenStore()
    await s.store({
      clientId: 'openclaw-control-ui',
      deviceId: 'dev-1',
      role: 'operator',
      token: 'tok-1',
      scopes: ['operator.read'],
    })
    const rec = await s.load({ clientId: 'openclaw-control-ui', deviceId: 'dev-1', role: 'operator' })
    expect(rec).toEqual({ token: 'tok-1', scopes: ['operator.read'] })
  })

  it('localStorage 键含 (clientId, deviceId, role)，值含 version:1', async () => {
    const s = createDeviceTokenStore()
    await s.store({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator', token: 'tok', scopes: [] })
    const key = `${TOKEN_STORAGE_KEY_PREFIX}alpha:dev-1:operator`
    const raw = localStorage.getItem(key)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.version).toBe(1)
    expect(parsed.token).toBe('tok')
    expect(parsed.scopes).toEqual([])
  })

  it('不同 clientId/deviceId/role 互不串扰（同一设备多容器、同一容器多角色各自独立）', async () => {
    const s = createDeviceTokenStore()
    const store = async (c: string, d: string, r: string, t: string) =>
      s.store({ clientId: c, deviceId: d, role: r, token: t, scopes: [] })
    await store('alpha', 'dev-1', 'operator', 't1')
    await store('alpha', 'dev-2', 'operator', 't2')
    await store('beta', 'dev-1', 'operator', 't3')
    await store('alpha', 'dev-1', 'readonly', 't4')
    const load = async (c: string, d: string, r: string) => (await s.load({ clientId: c, deviceId: d, role: r }))!.token
    expect(await load('alpha', 'dev-1', 'operator')).toBe('t1')
    expect(await load('alpha', 'dev-2', 'operator')).toBe('t2')
    expect(await load('beta', 'dev-1', 'operator')).toBe('t3')
    expect(await load('alpha', 'dev-1', 'readonly')).toBe('t4')
  })

  it('clear 删除对应键，其余 token 保留', async () => {
    const s = createDeviceTokenStore()
    await s.store({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator', token: 't1', scopes: [] })
    await s.store({ clientId: 'alpha', deviceId: 'dev-2', role: 'operator', token: 't2', scopes: [] })
    await s.clear({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator' })
    expect(await s.load({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator' })).toBeNull()
    expect(await s.load({ clientId: 'alpha', deviceId: 'dev-2', role: 'operator' })).toEqual({ token: 't2', scopes: [] })
  })

  it('clearForClient（按容器清除）：只清该 clientId 全部 device/role，其他容器保留', async () => {
    const s = createDeviceTokenStore()
    await s.store({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator', token: 't1', scopes: [] })
    await s.store({ clientId: 'alpha', deviceId: 'dev-2', role: 'operator', token: 't2', scopes: [] })
    await s.store({ clientId: 'beta', deviceId: 'dev-1', role: 'operator', token: 't3', scopes: [] })
    s.clearForClient('alpha')
    expect(await s.load({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator' })).toBeNull()
    expect(await s.load({ clientId: 'alpha', deviceId: 'dev-2', role: 'operator' })).toBeNull()
    expect(await s.load({ clientId: 'beta', deviceId: 'dev-1', role: 'operator' })).toEqual({ token: 't3', scopes: [] })
  })

  it('clearForDevice（按设备清除）：只清该 deviceId 全部 client/role，其他设备保留', async () => {
    const s = createDeviceTokenStore()
    await s.store({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator', token: 't1', scopes: [] })
    await s.store({ clientId: 'alpha', deviceId: 'dev-2', role: 'operator', token: 't2', scopes: [] })
    await s.store({ clientId: 'beta', deviceId: 'dev-1', role: 'operator', token: 't3', scopes: [] })
    s.clearForDevice('dev-1')
    expect(await s.load({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator' })).toBeNull()
    expect(await s.load({ clientId: 'beta', deviceId: 'dev-1', role: 'operator' })).toBeNull()
    expect(await s.load({ clientId: 'alpha', deviceId: 'dev-2', role: 'operator' })).toEqual({ token: 't2', scopes: [] })
  })

  it('多 tab 共享：两个 store 实例（共享 localStorage）读写一致', async () => {
    const tabA = createDeviceTokenStore()
    const tabB = createDeviceTokenStore()
    await tabA.store({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator', token: 'tok', scopes: ['x'] })
    expect(await tabB.load({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator' })).toEqual({ token: 'tok', scopes: ['x'] })
    await tabB.clear({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator' })
    expect(await tabA.load({ clientId: 'alpha', deviceId: 'dev-1', role: 'operator' })).toBeNull()
  })

  it('缺失键 load → null；损坏 JSON load → null（不抛）', async () => {
    const s = createDeviceTokenStore()
    expect(await s.load({ clientId: 'x', deviceId: 'y', role: 'operator' })).toBeNull()
    localStorage.setItem(`${TOKEN_STORAGE_KEY_PREFIX}x:y:operator`, 'garbage{{{')
    expect(await s.load({ clientId: 'x', deviceId: 'y', role: 'operator' })).toBeNull()
  })

  it('storage 不可用（null）→ load null、store/clear 静默不抛（隐私模式降级）', async () => {
    const s = createDeviceTokenStore(null)
    expect(await s.load({ clientId: 'x', deviceId: 'y', role: 'operator' })).toBeNull()
    // store 同步返回 void（官方 GatewayBrowserDeviceTokenStore.store 为 MaybePromise，同步值合法）
    expect(() =>
      s.store({ clientId: 'x', deviceId: 'y', role: 'operator', token: 't', scopes: [] }),
    ).not.toThrow()
    expect(() => s.clear({ clientId: 'x', deviceId: 'y', role: 'operator' })).not.toThrow()
    expect(() => s.clearForClient('x')).not.toThrow()
    expect(() => s.clearForDevice('y')).not.toThrow()
  })
})
