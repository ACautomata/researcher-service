// 请求超时 —— 中立无依赖模块（同 errors.ts 的定位：stores/auth.ts 与 api/client.ts
// 均可用，避免 auth ↔ client 成环）。
// #202 问题4：全部 fetch 统一 15s 超时。悬挂请求（网络中断/后端不响应）到期自动 abort，
// 按瞬态失败语义处理（forceRefresh catch 不标耗尽 / apiFetch 抛错保留重试），
// 不会永久悬挂卡死轮询防重入等恢复路径。
export const REQUEST_TIMEOUT_MS = 15_000

// 生成到期自动 abort 的信号；调用方已自带 signal 时优先沿用（见 api/client.ts 合并逻辑）。
export function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS)
}
