// 统一 fetch 超时（issue #202 问题4）：裸 fetch 无超时，请求可永久悬挂
// （ContainersView 轮询防重入标记随之卡死、apiFetch 无恢复路径）。
// 独立成中立模块而非落 client.ts：client.ts 已依赖 stores/auth.ts，
// auth.ts 反向依赖会成环（与 errors.ts 的中立定位同理）。
export const FETCH_TIMEOUT_MS = 15_000

// 包一层超时：调用方已传 signal 时尊重之，否则挂 15s 自动 abort。
// 超时 reject 走上层既有「瞬态失败」语义（auth.forceRefresh catch 不标耗尽、视图 catch 提示）。
export function fetchWithTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}
