import { apiJson } from '@/api/client'

export type TraceStatus = 'success' | 'failed'

export interface TraceLogRowDTO {
  id: string
  traceId: string
  userId: string
  username: string
  ipAddress: string
  containerName: string | null
  sessionKey: string | null
  runId: string | null
  inputText: string
  outputText: string
  outputHash: string
  status: TraceStatus
  createdAt: string
}

export interface TraceLogsListDTO {
  logs: TraceLogRowDTO[]
  page: number
  pageSize: number
  total: number
}

export function listTraceLogs(query: {
  userId?: string
  ip?: string
  content?: string
  status?: TraceStatus | ''
  page?: number
  pageSize?: number
} = {}): Promise<TraceLogsListDTO> {
  const params = new URLSearchParams()
  if (query.userId) params.set('userId', query.userId)
  if (query.ip) params.set('ip', query.ip)
  if (query.content) params.set('content', query.content)
  if (query.status) params.set('status', query.status)
  if (query.page) params.set('page', String(query.page))
  if (query.pageSize) params.set('pageSize', String(query.pageSize))
  const suffix = params.toString() ? `?${params.toString()}` : ''
  return apiJson<TraceLogsListDTO>(`/api/v1/trace-logs/${suffix}`)
}
