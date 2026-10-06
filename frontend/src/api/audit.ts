// audit API —— admin 全局审计检索面（#800 ↔ 后端 /api/v1/approval-logs + /file-overwrite-logs，
// #783/#785 admin 面）。wire snake_case（对齐后端 auditRoutes 契约）；过滤 null/undefined 不落 URL。
import { apiJson } from '@/api/client'

export interface ApprovalLogRowDTO {
  id: string
  trace_id: string
  run_id: string
  user_id: string
  layer: 'rule' | 'judge' | 'human'
  decision: 'allow' | 'deny'
  tool_name: string
  tool_call: string
  policy_class: string | null
  reason: string | null
  judge_input_hash: string | null
  latency_ms: number | null
  judge_tokens: number | null
  created_at: string
}

export interface FileOverwriteLogRowDTO {
  id: string
  session_id: string
  path: string
  overwriter_thread_id: string
  overwritten_thread_id: string
  run_id: string
  created_at: string
}

export interface PagedResult<T> {
  total: number
  page: number
  pageSize: number
  items: T[]
}

function q(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

const iso = (d: Date | undefined): string | undefined => d?.toISOString()

export function listApprovalLogs(query: {
  userId?: string
  runId?: string
  layer?: 'rule' | 'judge' | 'human'
  decision?: 'allow' | 'deny'
  from?: Date
  to?: Date
  page?: number
  pageSize?: number
}): Promise<PagedResult<ApprovalLogRowDTO>> {
  return apiJson<PagedResult<ApprovalLogRowDTO>>(
    `/api/v1/approval-logs/${q({
      userId: query.userId,
      runId: query.runId,
      layer: query.layer,
      decision: query.decision,
      from: iso(query.from),
      to: iso(query.to),
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    })}`,
  )
}

export function listFileOverwriteLogs(query: {
  sessionId?: string
  path?: string
  from?: Date
  to?: Date
  page?: number
  pageSize?: number
}): Promise<PagedResult<FileOverwriteLogRowDTO>> {
  return apiJson<PagedResult<FileOverwriteLogRowDTO>>(
    `/api/v1/file-overwrite-logs/${q({
      sessionId: query.sessionId,
      path: query.path,
      from: iso(query.from),
      to: iso(query.to),
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    })}`,
  )
}
