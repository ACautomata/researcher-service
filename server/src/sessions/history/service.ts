import { historyEvidence } from './evidence'
import { literalContains, matchMessage, searchExcerpt, withinTime } from './matcher'
import type { HistoryContext, HistoryEvents, HistoryGroup, HistoryReader, HistoryReadTarget, HistoryResult, HistorySession } from './model'
import { SessionHistorySchema, type HistoryRequest } from './params'

export class SessionHistoryService {
  constructor(private readonly reader: HistoryReader, private readonly options: {
    events?: HistoryEvents
    clock?: () => number
    maxResponseBytes?: number
  } = {}) {}

  async execute(context: HistoryContext, input: unknown, signal?: AbortSignal): Promise<HistoryResult> {
    const started = (this.options.clock ?? Date.now)()
    const parsed = SessionHistorySchema.safeParse(input)
    let result: HistoryResult
    if (context.role !== 'leader') result = failure('permission', 'leader_only', '历史检索仅供 Leader 使用')
    else if (!parsed.success) result = failure('parameter', 'invalid_parameters', '历史检索参数无效')
    else if (signal?.aborted) result = failure('limit', 'cancelled', '历史检索已取消')
    else {
      try { result = this.query(context, parsed.data) }
      catch { result = failure('system', 'unavailable', '历史检索暂不可用，未能核实读取权限') }
    }
    if (signal?.aborted) result = failure('limit', 'cancelled', '历史检索已取消')
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > (this.options.maxResponseBytes ?? 32 * 1024)) {
      result = failure('limit', 'response_limit', '响应超出本次读取上限，尚未交付完整历史')
    }
    const request = parsed.success ? parsed.data : undefined
    try {
      await this.options.events?.record({ ownerId: context.ownerId, currentSessionId: context.currentSessionId,
        operation: request?.operation ?? 'invalid', explicitTargets: request?.operation === 'read' ? request.targets.length : request?.session_ids?.length ?? 0,
        durationMs: Math.max(0, (this.options.clock ?? Date.now)() - started), count: result.count.value,
        category: result.error?.category ?? result.outcome,
      })
    } catch {
      // 日志故障不阻断已授权读取；不输出异常中的 SQL/路径/正文。
      try { this.options.events?.warn('历史访问日志写入失败') } catch { /* 日志适配器故障 */ }
    }
    return result
  }

  private query(context: HistoryContext, request: HistoryRequest): HistoryResult {
    if (request.cursor) return failure('parameter', 'invalid_cursor', '书签无效或不适用于本次请求')
    const ids = request.operation === 'read' ? request.targets.map(t => t.session_id) : request.session_ids
    const snapshot = this.reader.read(context, ids, request.operation === 'read' ? request.targets : undefined)
    const byId = new Map(snapshot.sessions.map(s => [s.id, s]))
    const groups: HistoryGroup[] = []
    // search 保持快照排序（session_ids 是过滤集合）；只有 read 按 targets 输入顺序。
    const targets: HistoryReadTarget[] = request.operation === 'read' ? request.targets
      : [...snapshot.sessions.map(s => s.id), ...new Set((ids ?? []).filter(id => !byId.has(id)))].map(session_id => ({ session_id }))
    for (const target of targets) {
      const session = byId.get(target.session_id)
      if (!session) {
        groups.push({ session_id: target.session_id, status: 'incomplete', error: target.session_id === context.currentSessionId
          ? { code: 'current_session', message: '当前会话不属于历史读取范围，请使用当前对话上下文' }
          : { code: 'unreadable', message: '目标会话不可读取' } })
        continue
      }
      const group = request.operation === 'search' ? searchGroup(session, request) : readGroup(session, target.range)
      if (group) groups.push(group)
    }
    const failed = groups.filter(g => g.status === 'incomplete').length
    const unit = request.operation === 'read' ? 'messages' : request.query ? 'hits' : 'sessions'
    const count = unit === 'sessions' ? groups.filter(g => !g.error).length : groups.reduce((n, g) => n + (g.messages ?? []).filter(m => unit === 'messages' || !m.context_only).length, 0)
    return {
      outcome: failed ? groups.some(g => g.status === 'complete' || g.messages?.length) ? 'partial_success' : 'failure' : 'success',
      progress: failed || snapshot.limited ? 'stopped' : 'complete', groups, count: { unit, value: count },
      ...(snapshot.limited ? { error: { category: 'limit' as const, code: 'scan_limit', message: '扫描上限已到，仍有未读取范围' } } : {}),
      guidance: failed || snapshot.limited ? '读取未完成；请缩小会话或消息范围后重试。源缺失和保存时截断不能通过重试恢复。'
        : '结果仅覆盖已保存产品数据；节选请按 session_id 和 turn 范围 read，附件引用不代表访问授权。',
    }
  }
}

function baseGroup(session: HistorySession): HistoryGroup {
  return { session_id: session.id, title: session.title, created_at: session.createdAt, latest_message_at: session.latestMessageAt, status: session.limited ? 'incomplete' : 'complete' }
}

function readGroup(session: HistorySession, range: HistoryReadTarget['range']): HistoryGroup {
  const messages = session.messages.filter(m => (range?.from_turn === undefined || m.turn >= range.from_turn) && (range?.to_turn === undefined || m.turn <= range.to_turn)).map(m => historyEvidence(session.id, m))
  return { ...baseGroup(session), messages, ...(messages.some(m => m.missing.length) ? { status: 'incomplete' } : {}) }
}

function searchGroup(session: HistorySession, request: Extract<HistoryRequest, { operation: 'search' }>): HistoryGroup | undefined {
  if (request.title && !literalContains(session.title, request.title, request.case_sensitive)) return undefined
  if (request.time?.field === 'session_created_at' && !withinTime(session.createdAt, request.time)) return undefined
  const messageTime = request.time?.field === 'message_created_at' ? request.time : undefined
  if (!request.query) {
    if (messageTime && !session.messages.some(m => withinTime(m.createdAt, messageTime))) return session.limited ? { ...baseGroup(session), status: 'incomplete' } : undefined
    return baseGroup(session)
  }
  const evidence = session.messages.map(m => historyEvidence(session.id, m))
  const matches = evidence.map(m => withinTime(m.created_at, messageTime) ? matchMessage(m, request) : [])
  const selected = new Set<number>()
  matches.forEach((hits, index) => {
    if (!hits.length) return
    for (let i = Math.max(0, index - (request.context?.before ?? 1)); i <= Math.min(evidence.length - 1, index + (request.context?.after ?? 1)); i++) selected.add(i)
  })
  const damaged = evidence.some(m => m.missing.length > 0)
  if (!selected.size && !damaged && !session.limited) return undefined
  return { ...baseGroup(session), messages: [...selected].sort((a, b) => a - b).map(i => searchExcerpt(evidence[i]!, matches[i]!)),
    ...(damaged ? { missing: evidence.filter(m => m.missing.length).map(m => ({ message_id: m.message_id, fields: m.missing })) } : {}),
    ...(damaged ? { status: 'incomplete' as const, error: { code: 'missing_product_fields', message: '部分保存的产品字段缺失，不能保证搜索完整' } } : {}),
  }
}

function failure(category: NonNullable<HistoryResult['error']>['category'], code: string, message: string): HistoryResult {
  return { outcome: 'failure', progress: 'stopped', groups: [], count: { unit: 'sessions', value: 0 }, error: { category, code, message }, guidance: '请检查范围或缩小范围后重试；不能将失败解释为无历史。' }
}
