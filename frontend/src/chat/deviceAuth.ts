// #375 组合层：把面板存储实现接入官方 `GatewayBrowserDeviceAuthLifecycle`（ADR 0006 决定 3/6：协议机/
// deviceToken 生命周期归官方包，面板只供「身份生成 + token 持久化」回调）。
//
// 配对编排切片（#371-2）消费本模块的 `createDeviceAuthLifecycle()` 拿官方 lifecycle：
//   - buildPlan：有 deviceToken 用 deviceToken（重连复用）；无（首连）用 bootstrap 凭证
//     （真网关 2026.7.1 实测：须传 token 参数 → auth:{token}，见 hasStoredDeviceTokenFor 下方说明）
//   - acceptHello：hello-ok 下发 deviceToken → tokenStore 持久化
//   - clearStoredToken：token 失效（网关重置）清除 → 触发重配对
// 另导出 `hasStoredDeviceTokenFor`——gatewayChat 凭证选择「首连 token / 重连 deviceToken」的判断来源。
//
// 多容器配对 bug 修复（用户定案）：deviceToken 持久化**上移服务端 DB**（Pairing.deviceToken 密文列，
// 按 containerId 一对一），替代原 localStorage——原 localStorage 键 (clientId='webchat-ui', deviceId,
// role) 不含容器名，跨容器共用一条 token，容器 2 复用容器 1 的 token → 网关 AUTH_DEVICE_TOKEN_MISMATCH →
// 连接即停。REST 实现按 URL 容器名解析作用域，clientId 恒定也无妨（根因消除）。Ed25519 设备身份
//（密钥对）仍留 localStorage——签名握手须在本地，不随 token 上移。

import { GatewayBrowserDeviceAuthLifecycle } from '@openclaw/gateway-client/browser'
import type { GatewayBrowserDeviceTokenStore } from '@openclaw/gateway-client/browser'
import { getSafeLocalStorage } from './localStorage'
import { loadDeviceIdentity } from './deviceIdentity'
import { getDeviceToken, putDeviceToken } from '@/api/chat'

// 组合层公开面：身份生成/清除（localStorage，签名握手本地）+ storage 工具归原模块。
export { loadDeviceIdentity, clearDeviceIdentity } from './deviceIdentity'
export { getSafeLocalStorage } from './localStorage'

/**
 * 面板 REST deviceTokenStore——官方 `GatewayBrowserDeviceTokenStore` 接口的服务端 DB 实现。
 *
 * 官方接口契约 load/store/clear 以 (clientId, deviceId, role) 为键；面板按「每容器一份 token」语义
 * 把这些键忽略、只按容器名读写服务端（Pairing.deviceToken 按 containerId 一对一）。同容器所有浏览器
 * 设备共享一份 token（用户定案「最简」），跨容器天然隔离。
 *
 * @param container 容器名（Pairing 归属门按它解析作用域）
 */
export function createPanelTokenStore(container: string): GatewayBrowserDeviceTokenStore {
  return {
    // 读该容器 token；未配对/异常 → null（官方 lifecycle 据此回退 bootstrap 首连）。
    // 键参数（clientId/deviceId/role）被忽略——面板按容器名解析作用域（多容器修复核心）。
    load: async (_key) => {
      try {
        const token = await getDeviceToken(container)
        // 官方 selectGatewayConnectAuth 仅消费 token 值；scopes 由 hello-ok 下发、面板不持久化（从简）。
        return token ? { token, scopes: [] } : null
      } catch {
        return null // 网络/归属异常：降级 bootstrap 首连（不阻断配对流程）
      }
    },
    // hello-ok 下发 token 后回传落库（密文）。失败静默（token 不持久化 → 下次重新配对自愈）。
    store: async ({ token }) => {
      try {
        await putDeviceToken(container, token)
      } catch {
        // 静默降级：不阻断连接（acceptHello 失败语义对齐官方「catch 吞 rejection」）
      }
    },
    // token 失效（网关重置）：面板「每容器一份」语义下无单独清除入口——重新配对后 store 覆盖写即收敛。
    // 官方 lifecycle 在 token mismatch 重配对路径调 clear；此处 no-op（旧 token 由下次 PUT 覆盖）。
    clear: async () => {},
  }
}

/**
 * 该浏览器设备是否已为该容器持有 deviceToken（重连凭证选择判断，真网关适配）。
 *
 * 真网关 2026.7.1-browser 实测：首连 auth 必须用 `token` 字段（GATEWAY_TOKEN），官方 lifecycle 的
 * `bootstrapToken` 参数输出 `bootstrapToken` 字段被 2026.7.1 当「setup code」拒
 * （AUTH_BOOTSTRAP_TOKEN_INVALID）。故 gatewayChat 的 buildConnectPlan 凭证选择：**有 deviceToken
 * 时交官方 lifecycle 从 tokenStore 选（重连复用）；无（首连）传 `token` 参数**。
 *
 * 修复后：判断来源 = 服务端该容器是否有已配对 token（按容器名），不再读跨容器共享的 localStorage。
 */
export async function hasStoredDeviceTokenFor(
  container: string,
  _clientId: string,
  _role: string,
): Promise<boolean> {
  // 键参数仅满足官方 load 接口签名（面板实现忽略，按容器名读）
  return (await createPanelTokenStore(container).load({ clientId: _clientId, deviceId: '', role: _role })) !== null
}

/**
 * 组装官方设备认证生命周期。token 持久化经服务端 DB（createPanelTokenStore）；设备身份（密钥对）经
 * localStorage（多 tab 共享同一 profile 身份，issue #371 用户故事 4）。storage 注入仅供身份生成
 * 测试；token 不再读 localStorage。
 */
export function createDeviceAuthLifecycle(
  container: string,
  storage: Storage | null = getSafeLocalStorage(),
): GatewayBrowserDeviceAuthLifecycle {
  return new GatewayBrowserDeviceAuthLifecycle({
    loadIdentity: () => loadDeviceIdentity(storage),
    tokenStore: createPanelTokenStore(container),
  })
}
