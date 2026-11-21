// 历史业务口：普通产品数据；不依赖 REST、checkpoint 或数据库运行对象。
export interface HistoryContext {
  readonly ownerId: string
  readonly currentSessionId: string
  readonly role: 'leader' | 'teammate' | 'wiki-update' | 'subagent'
}

export interface HistoryPosition {
  turn: number
  createdAt: string
  id: string
}

export interface HistoryRange {
  from_turn?: number
  to_turn?: number
}

export interface HistoryMessageRow {
  id: string
  turn: number
  role: string
  content: string
  attachmentsJson: string
  createdAt: string
}

export interface HistorySessionMeta {
  id: string
  title: string
  createdAt: string
  latestMessageAt: string
  version: number
  upper?: HistoryPosition
}

export interface HistoryScanOptions {
  after?: HistoryPosition
  before?: HistoryPosition
  upTo?: HistoryPosition
  range?: HistoryRange
  time?: { from?: string; to?: string }
  limitMessages: number
  limitBytes: number
}

export interface HistoryScan {
  messages: HistoryMessageRow[]
  next?: HistoryPosition
  hasMore: boolean
  limited: boolean
}

export type HistoryDeniedCode = 'authorization' | 'unreadable' | 'current_session'

// 只读适配器的拒绝语义：authorization = 无法核实调用者身份（fail closed）；
// unreadable = 目标不在可读集合；current_session = 显式当前会话。
export class HistoryDenied extends Error {
  constructor(readonly code: HistoryDeniedCode) {
    super(code)
    this.name = 'HistoryDenied'
  }
}

export interface HistoryReader {
  // 授权并返回冻结候选：可读会话按边界内最新消息时间降序、ID 兜底。
  sessions(context: HistoryContext, options?: { sessionIds?: readonly string[] }): HistorySessionMeta[]
  // 授权并读取有界消息切片；after 开区间、before/upTo 闭区间；before 结果仍按升序返回。
  scan(context: HistoryContext, sessionId: string, options: HistoryScanOptions): HistoryScan
}

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

export type HistoryGroupStatus = 'pending' | 'reading' | 'complete' | 'incomplete'

export interface HistoryGroup {
  session_id: string
  title?: string
  created_at?: string
  latest_message_at?: string
  status: HistoryGroupStatus
  error?: { code: string; message: string }
  messages?: HistoryEvidence[]
  missing?: { message_id: string; fields: string[] }[]
}

export interface HistorySegment {
  region: 'content' | 'thinking'
  index: number
  start: number
  end: number
  total: number
  next: boolean
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
  // 长区域分段：同一 message_id 的各段按 index 连续拼接；region=content 的段可重组正文。
  segment?: HistorySegment
  // 附属于消息的非文本字段（tools/media/files 等）单独成段时标记，便于消费方区分正文分段。
  attached_fields?: boolean
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
  progress: 'complete' | 'more' | 'stopped'
  groups: HistoryGroup[]
  count: { unit: 'sessions' | 'messages' | 'hits'; value: number }
  cursor?: string
  cursor_expires_at?: string
  error?: { category: 'parameter' | 'limit' | 'system' | 'permission'; code: string; message: string }
  guidance: string
}
