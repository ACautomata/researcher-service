// #375 组合层：把面板 localStorage 存储实现接入官方 `GatewayBrowserDeviceAuthLifecycle`（ADR 0006
// 决定 3/6：协议机/deviceToken 生命周期归官方包，面板只供「身份生成 + token 持久化」回调）。
//
// 配对编排切片（#371-2）消费本模块的 `createDeviceAuthLifecycle()` 拿官方 lifecycle：
//   - buildPlan：有 deviceToken 用 deviceToken（重连复用）；无（首连）用 bootstrap token
//   - acceptHello：hello-ok 下发 deviceToken → tokenStore 持久化
//   - clearStoredToken：token 失效（网关重置）清除 → 触发重配对
// 存储层细节（身份 key 格式 / token 键格式 / 失效清除）归 deviceIdentity / deviceTokenStore。

import { GatewayBrowserDeviceAuthLifecycle } from '@openclaw/gateway-client/browser'
import { getSafeLocalStorage } from './localStorage'
import { loadDeviceIdentity } from './deviceIdentity'
import { createDeviceTokenStore } from './deviceTokenStore'

// 组合层公开面：配对编排切片（#371-2）消费的行为函数；常量/底层工具（身份 key、token 键前缀、
// signDevicePayload）归原模块，需要时从 deviceIdentity / deviceTokenStore 直接取（避免投机性重导出）。
export { loadDeviceIdentity, clearDeviceIdentity } from './deviceIdentity'
export { createDeviceTokenStore, type DeviceTokenStore } from './deviceTokenStore'
export { getSafeLocalStorage } from './localStorage'

/**
 * 组装官方设备认证生命周期。storage 注入便于测试（多 tab 共享同一 localStorage = 同 profile 多 tab
 * 共享同一设备身份与 token，issue #371 用户故事 4）；缺省用安全 localStorage。storage 不可用（隐私
 * 模式）→ loadIdentity 返回 null → 纯 bootstrap token 降级连接（无配对身份）。
 */
export function createDeviceAuthLifecycle(
  storage: Storage | null = getSafeLocalStorage(),
): GatewayBrowserDeviceAuthLifecycle {
  return new GatewayBrowserDeviceAuthLifecycle({
    loadIdentity: () => loadDeviceIdentity(storage),
    tokenStore: createDeviceTokenStore(storage),
  })
}
