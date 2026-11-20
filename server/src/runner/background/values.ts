export const EXEC_FOREGROUND_MS = 600_000
export const EXEC_HARD_TIMEOUT_MS = 86_400_000
export const EXEC_LOG_BYTES = 20 * 1024 * 1024
export const EXEC_MAX_ACTIVE = 4
export const EXEC_POLL_MS = 2_000
export const EXEC_RESULT_CHARS = 50_000
export const EXEC_QUERY_TOOL = 'background_exec_status'
export const activeStates = ['starting', 'running']

export interface ExecSettings {
  foregroundMs: number
  hardTimeoutMs: number
  logBytes: number
  maxActive: number
  pollMs: number
}
