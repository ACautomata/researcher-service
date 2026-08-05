// #375 deviceToken 按 (clientId, deviceId, role) 键 localStorage 持久化（ADR 0006 决定 3/6）。
// 实现官方 `@openclaw/gateway-client/browser` 的 `GatewayBrowserDeviceTokenStore` 接口契约
// （load/store/clear），另加 clearForClient/clearForDevice 批清除，供「token 失效（网关重置）按
// 容器/设备清除、触发重配对」（issue #371 用户故事 5）。
//
// 键格式 `openclaw.device.auth.v1:<clientId>:<deviceId>:<role>`——前缀对齐官方 webchat-ui 的
// `openclaw.device.auth.v1` 命名；每 (clientId, deviceId, role) 一条 localStorage 记录（网关
// per-container，每浏览器设备为其访问的每个容器各持一份 token），读写无整表覆盖竞争。

import type { GatewayBrowserDeviceTokenStore } from '@openclaw/gateway-client/browser'
import { getSafeLocalStorage } from './localStorage'

export const TOKEN_STORAGE_KEY_PREFIX = 'openclaw.device.auth.v1:'

interface StoredToken {
  version: 1
  token: string
  scopes: string[]
  updatedAtMs: number
}

/** 官方 GatewayBrowserDeviceTokenStore + 面板批清除（失效清除路径）。 */
export interface DeviceTokenStore extends GatewayBrowserDeviceTokenStore {
  /** 按容器（clientId）清除该浏览器设备为它持有的全部 role deviceToken（容器删除/网关重置）。 */
  clearForClient(clientId: string): void
  /** 按设备（deviceId）清除全部容器 deviceToken（设备重置）。 */
  clearForDevice(deviceId: string): void
}

function tokenKey(clientId: string, deviceId: string, role: string): string {
  return `${TOKEN_STORAGE_KEY_PREFIX}${clientId}:${deviceId}:${role}`
}

function parseStoredToken(raw: string | null): StoredToken | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredToken
    if (parsed?.version === 1 && typeof parsed.token === 'string') {
      return parsed
    }
  } catch {
    // 损坏记录 → null（不抛，load 降级）
  }
  return null
}

function collectKeys(storage: Storage, match: (key: string) => boolean): string[] {
  const out: string[] = []
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key !== null && match(key)) out.push(key)
  }
  return out
}

export function createDeviceTokenStore(
  storage: Storage | null = getSafeLocalStorage(),
): DeviceTokenStore {
  const load: GatewayBrowserDeviceTokenStore['load'] = ({ clientId, deviceId, role }) => {
    const stored = storage ? parseStoredToken(storage.getItem(tokenKey(clientId, deviceId, role))) : null
    return stored ? { token: stored.token, scopes: stored.scopes } : null
  }
  const store: GatewayBrowserDeviceTokenStore['store'] = ({ clientId, deviceId, role, token, scopes }) => {
    if (!storage) return
    const record: StoredToken = { version: 1, token, scopes, updatedAtMs: Date.now() }
    storage.setItem(tokenKey(clientId, deviceId, role), JSON.stringify(record))
  }
  const clear: GatewayBrowserDeviceTokenStore['clear'] = ({ clientId, deviceId, role }) => {
    storage?.removeItem(tokenKey(clientId, deviceId, role))
  }
  const clearForClient = (clientId: string): void => {
    if (!storage) return
    const prefix = `${TOKEN_STORAGE_KEY_PREFIX}${clientId}:`
    // 先收集再删：localStorage 删除时 key(i) 索引前移，遍历中删会漏删（TDD 红→绿实测）。
    for (const key of collectKeys(storage, (k) => k.startsWith(prefix))) storage.removeItem(key)
  }
  const clearForDevice = (deviceId: string): void => {
    if (!storage) return
    const marker = `:${deviceId}:`
    for (const key of collectKeys(storage, (k) => k.startsWith(TOKEN_STORAGE_KEY_PREFIX) && k.includes(marker))) {
      storage.removeItem(key)
    }
  }
  return { load, store, clear, clearForClient, clearForDevice }
}
