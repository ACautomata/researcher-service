// #375 组合层：把面板 localStorage 存储实现接入官方 `GatewayBrowserDeviceAuthLifecycle`（ADR 0006
// 决定 3/6：协议机/deviceToken 生命周期归官方包，面板只供「身份生成 + token 持久化」回调）。
//
// 配对编排切片（#371-2）消费本模块的 `createDeviceAuthLifecycle()` 拿官方 lifecycle：
//   - buildPlan：有 deviceToken 用 deviceToken（重连复用）；无（首连）用 bootstrap 凭证
//     （真网关 2026.7.1 实测：须传 token 参数 → auth:{token}，见 hasStoredDeviceTokenFor 下方说明）
//   - acceptHello：hello-ok 下发 deviceToken → tokenStore 持久化
//   - clearStoredToken：token 失效（网关重置）清除 → 触发重配对
// 另导出 `hasStoredDeviceTokenFor`——gatewayChat 凭证选择「首连 token / 重连 deviceToken」的判断来源。
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
 * 该浏览器设备是否已为 (clientId, role) 持有 deviceToken（重连凭证选择判断，真网关适配）。
 *
 * 真网关 2026.7.1-browser 实测：首连 auth 必须用 `token` 字段（GATEWAY_TOKEN），官方 lifecycle 的
 * `bootstrapToken` 参数输出 `bootstrapToken` 字段被 2026.7.1 当「setup code」拒
 * （AUTH_BOOTSTRAP_TOKEN_INVALID）。故 gatewayChat 的 buildConnectPlan 凭证选择：**有 deviceToken
 * 时交官方 lifecycle 从 tokenStore 选（重连复用）；无（首连）传 `token` 参数**。官方 lifecycle 不暴露
 * tokenStore，本函数供 gatewayChat 判断「已有 deviceToken」（与 createDeviceAuthLifecycle 同一 storage，
 * 身份/token 读取同源）。多 tab 共享同一 localStorage → 判断一致（issue #371 用户故事 4）。
 */
export async function hasStoredDeviceTokenFor(
  clientId: string,
  role: string,
  storage: Storage | null = getSafeLocalStorage(),
): Promise<boolean> {
  const identity = await loadDeviceIdentity(storage)
  if (!identity) return false // 无设备身份（隐私模式降级）→ 视为未配对，走 bootstrap token
  return createDeviceTokenStore(storage).load({ clientId, deviceId: identity.deviceId, role }) !== null
}

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
