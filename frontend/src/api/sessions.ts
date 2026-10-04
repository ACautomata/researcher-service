import { apiJson } from './client'

export interface SessionSummary { id: string; title: string; createdAt: string; updatedAt: string }
export interface TurnTool { toolCallId: string; name: string; input: string; state: 'running' | 'success' | 'error'; durationMs?: number; details?: string }
export interface TurnContent { content: string; thinking?: string; tools?: TurnTool[]; media?: Array<{ attachmentId: string; fileName: string; mime: string; size: number }> }
export interface SessionMessage extends TurnContent { id: string; turn: number; role: string; anchorCheckpointId: string | null; createdAt: string }
export interface LiveTurn { runId: string; state: 'queued' | 'running'; turn: TurnContent }
export interface TeamMember {
  id: string; name: string; task: string; status: string; messages: SessionMessage[]; inFlight?: LiveTurn
  mailbox: Array<{ id: string; senderTeammateId: string | null; recipientTeammateId: string | null; kind: string; content: string; createdAt: string }>
}
export interface SessionApproval {
  teammateId?: string
  escalation: { id: string; toolName: string; toolCallSummary: string; source: string; judgeReason?: string }
}
export interface SessionProjection { sessionId: string; title: string; messages: SessionMessage[]; teammates?: TeamMember[]; inFlight?: LiveTurn; approvals?: SessionApproval[] }
const path = (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}`
export const listSessions = () => apiJson<SessionSummary[]>('/api/v1/sessions')
export const createSession = () => apiJson<SessionSummary>('/api/v1/sessions', { method: 'POST', body: '{}' })
export const getSessionProjection = (id: string) => apiJson<SessionProjection>(`${path(id)}/messages`)
export const sendSessionMessage = (id: string, content: string, key: string) => apiJson<{ runId: string | null }>(`${path(id)}/messages`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ content }) })
export const abortSession = (id: string) => apiJson(`${path(id)}/abort`, { method: 'POST' })
export const resolveSessionApproval = (id: string, escalationId: string, decision: 'allow' | 'deny') => apiJson(`${path(id)}/approvals/${encodeURIComponent(escalationId)}`, { method: 'POST', body: JSON.stringify({ decision }) })
