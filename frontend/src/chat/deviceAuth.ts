// #375 组合层：把面板存储实现接入官方 `GatewayBrowserDeviceAuthLifecycle`（ADR 0006 决定 3/6：协议机/
// deviceToken 生命周期归官方包，面板只供「身份生成 + token 持久化」回调）。
//
// 配对编排切片（#371-2）消费 `createDeviceAuthLifecycle()` 拿官方 lifecycle：
//   - buildPlan：有 deviceToken 用 deviceToken（重连复用）；无（首连）用 bootstrap 凭证
//     （真网关 2026.7.1 实测：须传 token 参数 → auth:{token}，见 hasStoredDeviceTokenFor 下方说明）
//   - acceptHello：hello-ok 下发 deviceToken → tokenStore 持久化
//   - clearStoredToken：token 失效（网关重置 / AUTH_DEVICE_TOKEN_MISMATCH）清除 → 触发重配对
// 另导出 `hasStoredDeviceTokenFor`——gatewayChat 凭证选择「首连 token / 重连 deviceToken」的判断来源。
//
// ADR 0006 决定 3「每浏览器设备 × 每容器」：deviceToken 持久化在浏览器 localStorage，键按
// (container, deviceId, role) 隔离——每浏览器设备（Ed25519 身份 = deviceId）为其访问的每个容器各持一份
// token。多容器（container 维度）+ 多浏览器（deviceId 维度）天然隔离。切换浏览器 = 新 deviceId = 无
// token = 自动走 bootstrap 重新配对（用户故事「匹配不上就重新匹配」）。
//
// 历史：#425 曾把 token 上移服务端 DB（按 containerId 单槽），违背 ADR 0006 行 53 否决（「token 存服务
// 端、浏览器登入取回」被明否），且 clear 为 no-op 致 MISMATCH 自愈失效（切换浏览器反复 MISMATCH 连接即
// 停）。本实现回归 ADR 0006。

import { GatewayBrowserDeviceAuthLifecycle } from '@openclaw/gateway-client/browser'
import { getSafeLocalStorage } from './localStorage'
import { loadDeviceIdentity } from './deviceIdentity'
import { createContainerTokenStore } from './deviceTokenStore'

// 组合层公开面：身份生成/清除（localStorage，签名握手本地）+ storage 工具 + 容器 tokenStore 归原模块。
export { loadDeviceIdentity, clearDeviceIdentity } from './deviceIdentity'
export { getSafeLocalStorage } from './localStorage'
export { createContainerTokenStore } from './deviceTokenStore'

/**
 * 该浏览器设备是否已为该容器持有 deviceToken（重连凭证选择判断，真网关适配）。
 *
 * 真网关 2026.7.1-browser 实测：首连 auth 必须用 `token` 字段（GATEWAY_TOKEN），官方 lifecycle 的
 * `bootstrapToken` 参数输出 `bootstrapToken` 字段被 2026.7.1 当「setup code」拒
 * （AUTH_BOOTSTRAP_TOKEN_INVALID）。故 gatewayChat 的 buildConnectPlan 凭证选择：**有 deviceToken 时交
 * 官方 lifecycle 从 tokenStore 选（重连复用）；无（首连）传 `token` 参数**。
 *
 * identity-aware：读当前浏览器设备身份（deviceId）在该容器（localStorage 键 container:deviceId:role）
 * 下的 token。新浏览器（新 deviceId）无 token → false → 走 bootstrap 首连重新配对。
 *
 * @param storage 测试注入；生产默认全局 localStorage（与 createDeviceAuthLifecycle 同源）。
 */
export async function hasStoredDeviceTokenFor(
  container: string,
  clientId: string,
  role: string,
  storage: Storage | null = getSafeLocalStorage(),
): Promise<boolean> {
  const identity = await loadDeviceIdentity(storage)
  if (!identity) return false
  const stored = createContainerTokenStore(container, storage).load({
    clientId,
    deviceId: identity.deviceId,
    role,
  })
  return stored !== null
}

/**
 * 组装官方设备认证生命周期。token 持久化经浏览器 localStorage（createContainerTokenStore，按
 * container+deviceId 隔离）；设备身份（密钥对）经同一 localStorage（多 tab 共享同一 profile 身份）。
 */
export function createDeviceAuthLifecycle(
  container: string,
  storage: Storage | null = getSafeLocalStorage(),
): GatewayBrowserDeviceAuthLifecycle {
  return new GatewayBrowserDeviceAuthLifecycle({
    loadIdentity: () => loadDeviceIdentity(storage),
    tokenStore: createContainerTokenStore(container, storage),
  })
}
