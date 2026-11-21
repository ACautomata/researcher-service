// 历史业务口：普通产品数据；不依赖 REST、checkpoint 或数据库运行对象。
export interface HistoryContext {
  readonly ownerId: string
  readonly currentSessionId: string
  readonly role: 'leader' | 'teammate' | 'wiki-update' | 'subagent'
}

export interface HistoryMessageRow {
  id: string
  turn: number
  role: string
  content: string
  attachmentsJson: string
  createdAt: string
}

export interface HistorySession {
  id: string
  title: string
  createdAt: string
  latestMessageAt: string
  messages: HistoryMessageRow[]
  limited: boolean
}

export interface HistorySnapshot {
  sessions: HistorySession[]
  limited: boolean
}

export interface HistoryReader {
  // 单事务授权并读取有界快照；显式目标也必须在该权限边界内。
  read(context: HistoryContext, sessionIds?: readonly string[], targets?: readonly HistoryReadTarget[]): HistorySnapshot
}

export interface HistoryReadTarget { session_id: string; range?: { from_turn?: number; to_turn?: number } }

export interface HistoryAccessEvent {
  ownerId: string
  currentSessionId: string
  operation: 'search' | 'read' | 'invalid'
  explicitTargets: number
  durationMs: number
  count: number
  category: string
}

export interface HistoryEvents {
  record(event: HistoryAccessEvent): void | Promise<void>
  warn(message: string): void
}

export interface HistoryGroup {
  session_id: string
  title?: string
  created_at?: string
  latest_message_at?: string
  status: 'complete' | 'incomplete'
  error?: { code: string; message: string }
  messages?: HistoryEvidence[]
  missing?: { message_id: string; fields: string[] }[]
}

export interface HistoryEvidence {
  session_id: string
  message_id: string
  turn: number
  role: string
  created_at: string
  content: string
  thinking?: string
  tools?: Record<string, unknown>[]
  media?: Record<string, unknown>[]
  files?: Record<string, unknown>[]
  filesTotal?: number
  hasExec?: boolean
  missing: string[]
  source_truncated: boolean
  matches?: HistoryMatch[]
  context_only?: boolean
  excerpt?: { offset_unit: 'utf16'; start: number; end: number; omitted_before: boolean; omitted_after: boolean }
}

export interface HistoryMatch {
  field: string
  toolCallId?: string
  name?: string
  text: string
  start: number
  end: number
  omitted_before: boolean
  omitted_after: boolean
}

export interface HistoryResult {
  outcome: 'success' | 'partial_success' | 'failure'
  progress: 'complete' | 'stopped'
  groups: HistoryGroup[]
  count: { unit: 'sessions' | 'messages' | 'hits'; value: number }
  error?: { category: 'parameter' | 'limit' | 'system' | 'permission'; code: string; message: string }
  guidance: string
}
