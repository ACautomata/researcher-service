// 历史业务口：普通产品数据；不依赖 REST、checkpoint 或数据库运行对象。
export interface HistoryContext {
  readonly ownerId: string
  readonly currentSessionId: string
  readonly role: 'leader' | 'teammate' | 'wiki-update' | 'subagent'
  // 稳定主用户请求身份（≠ runId）：跨审批恢复/模型与图重建延续同一额度账本。
  // 缺失而额度已装配 = 无法可靠恢复，业务层停止旧请求增强。
  readonly requestId?: string
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
  beforeInclusive?: HistoryPosition
  upTo?: HistoryPosition
  range?: HistoryRange
  time?: { from?: string; to?: string }
  limitMessages: number
  limitBytes: number
}

export interface HistoryScan {
  messages: HistoryMessageRow[]
  hasMore: boolean
  limited: boolean
}

// 候选会话查询结果：超出冻结上限时 limited=true，业务层必须显式停止而不是报完成。
export interface HistorySessionQuery {
  sessions: HistorySessionMeta[]
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
  sessions(context: HistoryContext, options?: { sessionIds?: readonly string[] }): HistorySessionQuery | Promise<HistorySessionQuery>
  // 授权并读取有界消息切片；after 开区间、before/upTo 闭区间；before 结果仍按升序返回。
  scan(context: HistoryContext, sessionId: string, options: HistoryScanOptions): HistoryScan | Promise<HistoryScan>
  /**
   * 执行槽租约（B11/M8）：一次工具调用独占一条只读执行进程。缺省（进程内直连适配）
   * 不占槽。返回 undefined = 每用户/全平台槽已满，立即 busy，不排队。
   */
  executionLease?(context: HistoryContext, options?: { signal?: AbortSignal; waitBudgetMs?: number }): Promise<HistoryExecutionLease | undefined> | HistoryExecutionLease | undefined
  dispose?(): void | Promise<void>
}

export interface HistoryExecutionLease {
  readonly reader: HistoryReader
  release(): void
}

export interface HistoryRequestLedgerInput {
  readonly kind: 'message' | 'resume' | 'recover'
  readonly runId: string
  readonly ownerId: string
  readonly sessionId: string
  readonly triggerMessageId?: string
  /** resume：被恢复的 runId（内存态快照/checkpoint 推导），用于精确绑定原主请求账本。 */
  readonly resumeOfRunId?: string
}

export interface HistoryBudgetReservation {
  readonly allowed: boolean
  /** 拒绝原因；unrecoverable = 缺失持久账本，停止旧请求增强而不是重新发放额度。 */
  readonly reason?: 'calls' | 'wait' | 'bytes' | 'unrecoverable'
  readonly remainingBytes: number
  readonly remainingWaitMs: number
}

// 主请求额度账本（I2/K 预算）：失败与重试也计入；交付前计量，剩余额度优先于单次上限。
export interface HistoryBudgetRequest {
  readonly ownerId: string
  readonly sessionId: string
  readonly requestId: string
}
export interface HistoryRequestBudgetLimits {
  readonly calls: number
  readonly waitMs: number
  readonly bytes: number
}
export interface HistoryRequestBudgetStore {
  reserve(request: HistoryBudgetRequest, limits: HistoryRequestBudgetLimits): Promise<HistoryBudgetReservation>
  settle(request: HistoryBudgetRequest, usage: { bytes: number; waitedMs: number }): Promise<void>
}

// 协作时限（2 秒）由业务层逐行检查；硬停止（5 秒）由执行进程层真实终止。
export class HistoryCooperativeTimeout extends Error {
  readonly category = 'limit' as const
  readonly code = 'timeout' as const
  constructor() {
    super('history cooperative timeout')
    this.name = 'HistoryCooperativeTimeout'
  }
}

// 独立进程硬终止后返回的稳定错误：不携带子进程 stderr/堆栈/路径。
export class HistoryExecutionTimeout extends Error {
  readonly category = 'limit' as const
  readonly code = 'timeout' as const
  constructor() {
    super('history execution terminated')
    this.name = 'HistoryExecutionTimeout'
  }
}

export class HistoryExecutionUnavailable extends Error {
  readonly category = 'system' as const
  readonly code = 'unavailable' as const
  constructor() {
    super('history execution unavailable')
    this.name = 'HistoryExecutionUnavailable'
  }
}

// 适配层共享映射：SQL 核心与独立执行进程只回稳定代码，SQLite 原文/路径/堆栈不进入响应。
export function mapHistoryErrorCode(code: unknown, denied?: unknown): Error | undefined {
  if (code === 'history_denied') {
    return new HistoryDenied(denied === 'authorization' || denied === 'current_session' ? denied : 'unreadable')
  }
  if (code === 'history_cooperative_timeout') return new HistoryCooperativeTimeout()
  return undefined
}

// Runner 依赖面：历史运行时只暴露业务口，不暴露数据库/执行器对象。
export interface HistoryRuntimePort {
  execute(context: HistoryContext, input: unknown, signal?: AbortSignal): Promise<HistoryResult>
  /** 稳定主请求身份解析（triggerMessageId/账本）；缺省 = 内部切片不计量。 */
  resolveRunRequest?(input: HistoryRequestLedgerInput): Promise<string | undefined>
  /** true = 解析不到稳定身份即关闭历史增强（不重新发放额度）。 */
  readonly requiresRequestIdentity?: boolean
  dispose?(): void | Promise<void>
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
