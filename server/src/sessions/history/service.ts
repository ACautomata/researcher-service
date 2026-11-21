import { createHash } from 'node:crypto'
import { HistoryCursorStore, type CursorState, type FrozenSearchSession, type ReadTargetCursor, type SearchCursorData } from './cursor'
import { historyEvidence, startEvidenceCursor, takeEvidencePart, type EvidenceCursor } from './evidence'
import { literalContains, matchMessage, searchExcerpt, withinTime } from './matcher'
import {
  type HistoryContext,
  type HistoryEvidence,
  type HistoryGroup,
  type HistoryPosition,
  type HistoryReader,
  type HistoryResult,
  type HistorySessionMeta,
} from './model'
import { SessionHistorySchema, type HistoryRequest } from './params'

type ReadRequest = Extract<HistoryRequest, { operation: 'read' }>
type SearchRequest = Extract<HistoryRequest, { operation: 'search' }>

export interface SessionHistoryOptions {
  events?: { record(event: import('./model').HistoryAccessEvent): void | Promise<void>; warn(message: string): void }
  clock?: () => number
  maxResponseBytes?: number
  pageItems?: number
  maxTargets?: number
  scanMessages?: number
  scanBytes?: number
  segmentChars?: number
  literalSegmentChars?: number
  regexFieldChars?: number
  cursorTtlMs?: number
  maxCursorsPerUser?: number
  maxCursors?: number
  maxCursorStateBytes?: number
}

interface Options extends Required<Omit<SessionHistoryOptions, 'events'>> { events?: SessionHistoryOptions['events'] }
const RESERVE_BYTES = 512
const MIN_RESPONSE_BYTES = 1024

interface CallBudget {
  items: number
  responseBytes: number
  scanMessages: number
  scanBytes: number
  limited: boolean
  deadEnd: boolean
}

type Prepared = { state: CursorState; token?: string }

export class SessionHistoryService {
  private readonly options: Options
  private readonly cursors: HistoryCursorStore

  constructor(private readonly reader: HistoryReader, options: SessionHistoryOptions = {}) {
    const clock = options.clock ?? Date.now
    this.options = {
      events: options.events,
      clock,
      maxResponseBytes: options.maxResponseBytes ?? 32 * 1024,
      pageItems: Math.min(options.pageItems ?? 20, 50),
      maxTargets: options.maxTargets ?? 20,
      scanMessages: options.scanMessages ?? 1000,
      scanBytes: options.scanBytes ?? 8 * 1024 * 1024,
      segmentChars: options.segmentChars ?? 8 * 1024,
      literalSegmentChars: options.literalSegmentChars ?? 8 * 1024,
      regexFieldChars: options.regexFieldChars ?? 1024 * 1024,
      cursorTtlMs: options.cursorTtlMs ?? 30 * 60 * 1000,
      maxCursorsPerUser: options.maxCursorsPerUser ?? 4,
      maxCursors: options.maxCursors ?? 64,
      maxCursorStateBytes: options.maxCursorStateBytes ?? 256 * 1024,
    }
    this.cursors = new HistoryCursorStore(clock, {
      ttlMs: this.options.cursorTtlMs,
      maxPerUser: this.options.maxCursorsPerUser,
      maxGlobal: this.options.maxCursors,
      maxStateBytes: this.options.maxCursorStateBytes,
    })
  }

  async execute(context: HistoryContext, input: unknown, signal?: AbortSignal): Promise<HistoryResult> {
    const started = this.options.clock()
    const parsed = SessionHistorySchema.safeParse(input)
    let result: HistoryResult
    if (context.role !== 'leader') result = failure('permission', 'leader_only', '历史检索仅供 Leader 使用')
    else if (!parsed.success) result = failure('parameter', 'invalid_parameters', '历史检索参数无效')
    else if (signal?.aborted) result = failure('limit', 'cancelled', '历史检索已取消')
    else if (this.options.maxResponseBytes < MIN_RESPONSE_BYTES) result = failure('limit', 'response_limit', '响应上限过小，尚未交付完整历史')
    else if (parsed.data.operation === 'read' && parsed.data.targets.length > this.options.maxTargets) {
      result = failure('parameter', 'too_many_targets', `单次最多读取 ${this.options.maxTargets} 个目标`)
    } else {
      try {
        result = this.run(context, parsed.data, signal)
      } catch {
        result = failure('system', 'unavailable', '历史检索暂不可用，未能核实读取权限')
      }
    }
    if (signal?.aborted) result = failure('limit', 'cancelled', '历史检索已取消')
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > this.options.maxResponseBytes) {
      result = failure('limit', 'response_limit', '响应超出本次读取上限，尚未交付完整历史')
    }
    try {
      const request = parsed.success ? parsed.data : undefined
      let explicitTargets = 0
      if (request?.operation === 'read') explicitTargets = request.targets.length
      else if (request?.operation === 'search') explicitTargets = request.session_ids?.length ?? 0
      await this.options.events?.record({
        ownerId: context.ownerId, currentSessionId: context.currentSessionId,
        operation: request?.operation ?? 'invalid',
        explicitTargets,
        durationMs: Math.max(0, this.options.clock() - started), count: result.count.value,
        category: result.error?.category ?? result.outcome,
      })
    } catch {
      // 日志故障不阻断已授权读取；不输出异常中的 SQL/路径/正文。
      try { this.options.events?.warn('历史访问日志写入失败') } catch { /* 日志适配器故障 */ }
    }
    return result
  }

  private run(context: HistoryContext, request: HistoryRequest, signal?: AbortSignal): HistoryResult {
    const prepared = this.prepare(context, request, signal)
    if ('result' in prepared) return prepared.result
    const state = prepared.state
    const budget: CallBudget = { items: 0, responseBytes: 0, scanMessages: this.options.scanMessages, scanBytes: this.options.scanBytes, limited: false, deadEnd: false }
    const page = state.operation === 'read'
      ? this.renderRead(context, state, budget)
      : this.renderSearch(context, state, request as SearchRequest, budget)
    if (budget.deadEnd) return failure('limit', 'response_limit', '响应字节上限不足以交付下一片段，尚未交付完整历史')
    const remaining = state.operation === 'read'
      ? state.targets.some(t => t.status === 'pending' || t.status === 'reading')
      : state.search.index < state.search.sessions.length || state.search.started
    const failed = page.groups.some(g => g.status === 'incomplete' && g.error)
    const usable = page.groups.some(g => (g.messages?.length ?? 0) > 0 || (g.status === 'complete' && !g.error))
    const outcome = failed ? (usable ? 'partial_success' : 'failure') : 'success'
    const anyIncomplete = page.groups.some(g => g.status === 'incomplete')
    const progress = remaining ? (budget.limited ? 'stopped' : 'more') : anyIncomplete ? 'stopped' : 'complete'
    let cursor: { token: string; expiresAt: number } | undefined
    let limitError: HistoryResult['error']
    if (remaining && (progress === 'more' || progress === 'stopped')) {
      if (prepared.token) {
        cursor = { token: prepared.token, expiresAt: state.deadline }
      } else if (state.operation === 'read') {
        state.page++
        const put = this.cursors.put({
          ownerId: context.ownerId, currentSessionId: context.currentSessionId, operation: 'read', requestHash: requestHash(request), page: state.page, targets: state.targets,
        })
        if (put.ok) cursor = { token: put.token, expiresAt: put.expiresAt }
        else limitError = { category: 'limit', code: put.reason === 'busy' ? 'busy' : 'state_limit', message: '书签状态已满或过大，请缩小范围后重新查询' }
      } else {
        state.page++
        const put = this.cursors.put({
          ownerId: context.ownerId, currentSessionId: context.currentSessionId, operation: 'search', requestHash: requestHash(request), page: state.page, search: state.search,
        })
        if (put.ok) cursor = { token: put.token, expiresAt: put.expiresAt }
        else limitError = { category: 'limit', code: put.reason === 'busy' ? 'busy' : 'state_limit', message: '书签状态已满或过大，请缩小范围后重新查询' }
      }
    }
    if (!remaining && prepared.token) this.cursors.delete(prepared.token)
    const finalProgress = limitError ? 'stopped' as const : progress
    const result: HistoryResult = {
      outcome: limitError ? (usable ? 'partial_success' : 'failure') : outcome,
      progress: finalProgress,
      groups: page.groups,
      count: page.count,
      ...(cursor ? { cursor: cursor.token, cursor_expires_at: new Date(cursor.expiresAt).toISOString() } : {}),
      ...(limitError ? { error: limitError } : {}),
      guidance: guidance(finalProgress, limitError !== undefined),
    }
    return result
  }

  private prepare(context: HistoryContext, request: HistoryRequest, signal?: AbortSignal): Prepared | { result: HistoryResult } {
    if (request.cursor) {
      const state = this.cursors.get(request.cursor, { ownerId: context.ownerId, currentSessionId: context.currentSessionId, operation: request.operation }, requestHash(request))
      if (!state || state.operation !== request.operation) return { result: failure('parameter', 'invalid_cursor', '书签无效或不适用于本次请求') }
      return { state, token: request.cursor }
    }
    if (signal?.aborted) return { result: failure('limit', 'cancelled', '历史检索已取消') }
    if (request.operation === 'read') {
      const targets = this.initReadTargets(context, request)
      return { state: { ownerId: context.ownerId, currentSessionId: context.currentSessionId, operation: 'read', requestHash: requestHash(request), page: 0, deadline: 0, targets } }
    }
    const metas = this.reader.sessions(context, { sessionIds: request.session_ids })
    const filtered = metas.filter(meta => (!request.title || literalContains(meta.title, request.title, request.case_sensitive)) &&
      !(request.time?.field === 'session_created_at' && !withinTime(meta.createdAt, request.time)))
    const sessions: FrozenSearchSession[] = filtered.map(meta => ({ id: meta.id, version: meta.version, ...(meta.upper ? { upper: meta.upper } : {}) }))
    return { state: { ownerId: context.ownerId, currentSessionId: context.currentSessionId, operation: 'search', requestHash: requestHash(request), page: 0, deadline: 0,
      search: { sessions, index: 0, pendingAfter: 0, started: false } } }
  }

  private initReadTargets(context: HistoryContext, request: ReadRequest): ReadTargetCursor[] {
    const ids = [...new Set(request.targets.map(t => t.session_id))]
    const metas = this.reader.sessions(context, { sessionIds: ids })
    const byId = new Map(metas.map(meta => [meta.id, meta]))
    return request.targets.map(target => {
      if (target.session_id === context.currentSessionId) return { sessionId: target.session_id, status: 'incomplete', version: 0, error: { code: 'current_session', message: '当前会话不属于历史读取范围，请使用当前对话上下文' } }
      const meta = byId.get(target.session_id)
      if (!meta) return { sessionId: target.session_id, status: 'incomplete', version: 0, error: { code: 'unreadable', message: '目标会话不可读取' } }
      return {
        sessionId: target.session_id,
        ...(target.range ? { range: target.range } : {}),
        version: meta.version,
        ...(meta.upper ? { upper: meta.upper } : {}),
        status: meta.upper ? 'pending' : 'complete',
      }
    })
  }

  private renderRead(context: HistoryContext, state: Extract<CursorState, { operation: 'read' }>, budget: CallBudget): Page {
    const groups: HistoryGroup[] = []
    const metas = this.reader.sessions(context, { sessionIds: [...new Set(state.targets.map(t => t.sessionId))] })
    const byId = new Map(metas.map(meta => [meta.id, meta]))
    const processor = new ReadProcessor(this.reader, this.options, context, budget)
    let stop = false
    for (const target of state.targets) {
      const meta = byId.get(target.sessionId)
      if (!meta) {
        target.status = 'incomplete'
        target.error = { code: target.sessionId === context.currentSessionId ? 'current_session' : 'unreadable',
          message: target.sessionId === context.currentSessionId ? '当前会话不属于历史读取范围，请使用当前对话上下文' : '目标会话不可读取' }
        groups.push(groupSkeleton(target, undefined, budget))
        continue
      }
      if (target.status !== 'complete' && !target.error && meta.version !== target.version) {
        target.status = 'incomplete'
        target.error = { code: 'changed', message: '目标会话历史已变化，请重新查询该会话' }
        target.position = undefined
        target.segment = undefined
        groups.push(groupSkeleton(target, meta, budget))
        continue
      }
      if (target.error) {
        target.status = 'incomplete'
        groups.push(groupSkeleton(target, meta, budget))
        continue
      }
      const group = groupSkeleton(target, meta, budget)
      groups.push(group)
      if (target.status === 'complete') continue
      if (stop || budget.items >= this.options.pageItems) { stop = true; continue }
      stop = processor.readTarget(target, group, budget)
      if (group.status !== 'incomplete') group.status = target.status
      if (target.error && !group.error) group.error = target.error
    }
    const count = groups.reduce((n, g) => n + (g.messages?.length ?? 0), 0)
    return { groups, count: { unit: 'messages', value: count } }
  }

  private renderSearch(context: HistoryContext, state: Extract<CursorState, { operation: 'search' }>, request: SearchRequest, budget: CallBudget): Page {
    const data = state.search
    const metas = this.reader.sessions(context, { sessionIds: data.sessions.map(s => s.id) })
    const byId = new Map(metas.map(meta => [meta.id, meta]))
    const groups: HistoryGroup[] = []
    const processor = new SearchProcessor(this.reader, this.options, context, request, budget)
    let hits = 0
    let stop = false
    while (!stop && data.index < data.sessions.length) {
      if (budget.items >= this.options.pageItems) { stop = true; break }
      const frozen = data.sessions[data.index]!
      const meta = byId.get(frozen.id)
      if (!meta) {
        if (data.started) {
          groups.push(budgetGroup(budget, { session_id: frozen.id, status: 'incomplete', error: { code: 'unreadable', message: '目标会话不可读取' } }))
        }
        resetSession(data)
        continue
      }
      if (meta.version !== frozen.version) {
        if (data.started) {
          groups.push(budgetGroup(budget, { session_id: frozen.id, title: meta.title, created_at: meta.createdAt, latest_message_at: meta.latestMessageAt, status: 'incomplete', error: { code: 'changed', message: '目标会话历史已变化，请重新查询该会话' } }))
        }
        resetSession(data)
        continue
      }
      if (request.query && !frozen.upper) { resetSession(data); continue }
      if (!request.query) {
        if (request.time?.field === 'message_created_at') {
          if (budget.scanMessages <= 0 || budget.scanBytes <= 0) { budget.limited = true; stop = true; break }
          const probe = this.scan(context, frozen.id, { ...(frozen.upper ? { upTo: frozen.upper } : {}), time: { ...(request.time.from ? { from: request.time.from } : {}), ...(request.time.to ? { to: request.time.to } : {}) }, limitMessages: 1, limitBytes: budget.scanBytes }, budget)
          if (!probe) { budget.limited = true; stop = true; break }
          if (!probe.messages.length) { resetSession(data); continue }
        }
        const group = budgetGroup(budget, { session_id: meta.id, title: meta.title, created_at: meta.createdAt, latest_message_at: meta.latestMessageAt, status: 'complete' })
        groups.push(group)
        budget.items++
        data.index++
        data.started = false
        data.position = undefined
        data.pendingAfter = 0
        continue
      }
      const outcome = processor.searchSession(data, meta.id, meta)
      if (outcome.group) groups.push(outcome.group)
      hits += outcome.hits
      if (outcome.done) {
        data.index++
        data.started = false
        data.position = undefined
        data.pendingAfter = 0
      } else {
        stop = true
      }
      if (budget.items >= this.options.pageItems || budget.deadEnd) break
    }
    return { groups, count: { unit: request.query ? 'hits' : 'sessions', value: request.query ? hits : groups.filter(g => g.status === 'complete').length } }
  }

  private scan(context: HistoryContext, sessionId: string, options: import('./model').HistoryScanOptions, budget: CallBudget): import('./model').HistoryScan | undefined {
    if (budget.scanMessages <= 0 || budget.scanBytes <= 0) { budget.limited = true; return undefined }
    const scan = this.reader.scan(context, sessionId, { ...options, limitMessages: Math.min(options.limitMessages, budget.scanMessages), limitBytes: Math.min(options.limitBytes, budget.scanBytes) })
    budget.scanMessages -= scan.messages.length
    budget.scanBytes -= scan.messages.reduce((n, row) => n + Buffer.byteLength(row.content, 'utf8') + Buffer.byteLength(row.attachmentsJson, 'utf8'), 0)
    if (scan.limited) budget.limited = true
    return scan
  }
}

interface Page { groups: HistoryGroup[]; count: HistoryResult['count'] }

class ReadProcessor {
  constructor(private readonly reader: HistoryReader, private readonly options: Options, private readonly context: HistoryContext, private readonly budget: CallBudget) {}

  // 返回 true 表示本轮页面应停止（预算耗尽）。
  readTarget(target: ReadTargetCursor, group: HistoryGroup, budget: CallBudget): boolean {
    for (;;) {
      const scan = this.scan(target)
      if (!scan) { budget.limited = true; target.status = 'reading'; return true }
      if (!scan.messages.length) {
        if (scan.hasMore) { budget.limited = true; target.status = 'reading'; return true }
        target.status = 'complete'
        return false
      }
      for (const row of scan.messages) {
        const evidence = historyEvidence(target.sessionId, row)
        if (evidence.missing.length) {
          group.status = 'incomplete'
          group.error ??= { code: 'missing_product_fields', message: '部分保存的产品字段缺失，不能保证读取完整' }
          group.missing = [...(group.missing ?? []), { message_id: row.id, fields: evidence.missing }]
        }
        const existing = target.segment && target.segment.messageId === row.id ? target.segment.cursor : undefined
        const cursor = existing ?? startEvidenceCursor(evidence, this.options.segmentChars)
        if (!cursor) {
          if (budget.items >= this.options.pageItems) { target.status = 'reading'; return true }
          if (estimate(evidence) > remainingBytes(budget, this.options)) {
            if (budget.items === 0) budget.deadEnd = true
            target.status = 'reading'
            return true
          }
          emit(group, evidence, budget)
          target.position = positionOf(row)
          target.segment = undefined
          continue
        }
        if (this.emitSegments(evidence, cursor, target, group, budget) !== 'done') { target.status = 'reading'; return true }
        target.position = positionOf(row)
        target.segment = undefined
      }
      if (scan.hasMore || scan.limited) {
        target.status = 'reading'
        if (scan.limited || budget.limited) return true
        continue
      }
      target.status = 'complete'
      return false
    }
  }

  private emitSegments(evidence: HistoryEvidence, start: EvidenceCursor, target: ReadTargetCursor, group: HistoryGroup, budget: CallBudget): 'done' | 'stop' {
    let cursor: EvidenceCursor | undefined = start
    while (cursor) {
      if (budget.items >= this.options.pageItems) { target.segment = { messageId: evidence.message_id, cursor }; return 'stop' }
      let allowed = this.options.segmentChars
      let taken = takeEvidencePart(evidence, cursor, allowed)
      while (cursor.region !== 'fields' && estimate(taken.part) > remainingBytes(budget, this.options) && allowed > 1) {
        allowed = Math.max(1, Math.floor(allowed / 2))
        taken = takeEvidencePart(evidence, cursor, allowed)
      }
      if (cursor.region === 'fields' && estimate(taken.part) > remainingBytes(budget, this.options)) {
        if (budget.items > 0) { target.segment = { messageId: evidence.message_id, cursor }; return 'stop' }
        // 空页仍容不下附属性字段：明确标未完成，不伪装完整交付；不得让同一消息永远卡住。
        group.status = 'incomplete'
        group.error ??= { code: 'payload_too_large', message: '消息附属性字段超出本次响应上限' }
        return 'done'
      }
      if (estimate(taken.part) > remainingBytes(budget, this.options)) {
        if (budget.items === 0) budget.deadEnd = true
        target.segment = { messageId: evidence.message_id, cursor }
        return 'stop'
      }
      emit(group, taken.part, budget)
      cursor = taken.next
    }
    return 'done'
  }

  private scan(target: ReadTargetCursor) {
    const remaining = this.budget
    if (remaining.scanMessages <= 0 || remaining.scanBytes <= 0) { remaining.limited = true; return undefined }
    const scan = this.reader.scan(this.context, target.sessionId, {
      ...(target.position ? { after: target.position } : {}),
      ...(target.upper ? { upTo: target.upper } : {}),
      ...(target.range ? { range: target.range } : {}),
      limitMessages: Math.min(remaining.scanMessages, this.options.scanMessages),
      limitBytes: Math.min(remaining.scanBytes, this.options.scanBytes),
    })
    remaining.scanMessages -= scan.messages.length
    remaining.scanBytes -= scan.messages.reduce((n, row) => n + Buffer.byteLength(row.content, 'utf8') + Buffer.byteLength(row.attachmentsJson, 'utf8'), 0)
    if (scan.limited) remaining.limited = true
    return scan
  }
}

class SearchProcessor {
  constructor(
    private readonly reader: HistoryReader,
    private readonly options: Options,
    private readonly context: HistoryContext,
    private readonly request: SearchRequest,
    private readonly budget: CallBudget,
  ) {}

  searchSession(data: SearchCursorData, sessionId: string, meta: HistorySessionMeta): { group?: HistoryGroup; hits: number; done: boolean } {
    const before = this.request.context?.before ?? 1
    const after = this.request.context?.after ?? 1
    const output = new Map<string, { pos: HistoryPosition; evidence: HistoryEvidence; hit: boolean }>()
    const tail: { pos: HistoryPosition; evidence: HistoryEvidence }[] = []
    let groupError: HistoryGroup['error']
    let damaged = false
    data.started = true
    if (data.position && before > 0) {
      const scan = this.scan(sessionId, { upTo: data.position, limitMessages: before })
      if (!scan) return { hits: 0, done: false }
      for (const row of scan.messages) tail.push({ pos: positionOf(row), evidence: historyEvidence(sessionId, row) })
    }
    let exhausted = false
    let stopped = false
    while (!stopped) {
      if (this.budget.scanMessages <= 0 || this.budget.scanBytes <= 0) { this.budget.limited = true; stopped = true; break }
      const frozen = data.sessions[data.index]!
      const scan = this.scan(sessionId, {
        ...(data.position ? { after: data.position } : {}),
        ...(frozen.upper ? { upTo: frozen.upper } : {}),
        ...(this.request.time?.field !== 'session_created_at' && this.request.time
          ? { time: { ...(this.request.time.from ? { from: this.request.time.from } : {}), ...(this.request.time.to ? { to: this.request.time.to } : {}) } }
          : {}),
        limitMessages: Math.min(this.budget.scanMessages, this.options.scanMessages),
      })
      if (!scan) { stopped = true; break }
      if (!scan.messages.length) {
        if (scan.hasMore) { this.budget.limited = true; stopped = true; break }
        exhausted = true
        data.pendingAfter = 0
        break
      }
      for (const row of scan.messages) {
        const pos = positionOf(row)
        const evidence = historyEvidence(sessionId, row)
        if (evidence.missing.length) damaged = true
        const matched = matchMessage(evidence, this.request, { literalSegmentChars: this.options.literalSegmentChars, regexFieldChars: this.options.regexFieldChars })
        if (matched.limitedFields.length) groupError ??= { code: 'field_limit', message: '字段超出正则单字段上限，未完成匹配' }
        const isHit = matched.matches.length > 0
        if (isHit) {
          evidence.matches = matched.matches
          output.set(row.id, { pos, evidence, hit: true })
          for (const tailEntry of tail) output.set(tailEntry.evidence.message_id, { pos: tailEntry.pos, evidence: tailEntry.evidence, hit: output.get(tailEntry.evidence.message_id)?.hit ?? false })
          data.pendingAfter = after
        } else if (data.pendingAfter > 0) {
          output.set(row.id, { pos, evidence, hit: false })
          data.pendingAfter--
        }
        tail.push({ pos, evidence })
        if (tail.length > before) tail.shift()
        data.position = pos
        if (output.size >= this.options.pageItems && data.pendingAfter === 0) { stopped = true; break }
      }
      if (stopped) break
      if (scan.hasMore || scan.limited) {
        if (scan.limited) this.budget.limited = true
        stopped = scan.limited || this.budget.limited
        if (!stopped) continue
        break
      }
      exhausted = true
      data.pendingAfter = 0
      break
    }
    const entries = [...output.values()].sort((a, b) => comparePosition(a.pos, b.pos))
    const group: HistoryGroup = { session_id: sessionId, title: meta.title, created_at: meta.createdAt, latest_message_at: meta.latestMessageAt, status: 'reading' }
    this.budget.responseBytes += estimate(group)
    let emittedHits = 0
    let lastEmitted: HistoryPosition | undefined
    for (const entry of entries) {
      const evidence = entry.hit ? searchExcerpt(entry.evidence, entry.evidence.matches ?? []) : searchExcerpt(entry.evidence, [])
      const size = estimate(evidence)
      if (this.budget.items >= this.options.pageItems) { stopped = true; break }
      if (size > remainingBytes(this.budget, this.options)) {
        if (this.budget.items === 0) this.budget.deadEnd = true
        stopped = true
        break
      }
      group.messages = [...(group.messages ?? []), evidence]
      this.budget.items++
      this.budget.responseBytes += size
      lastEmitted = entry.pos
      if (entry.hit) emittedHits++
    }
    if (group.messages?.some(message => message.missing.length)) damaged = true
    if (damaged) groupError ??= { code: 'missing_product_fields', message: '部分保存的产品字段缺失，不能保证搜索完整' }
    if (groupError) { group.error = groupError; group.status = 'incomplete' }
    if (exhausted && data.pendingAfter === 0) group.status = groupError ? 'incomplete' : 'complete'
    else if (!exhausted) group.status = groupError ? 'incomplete' : 'reading'
    // 未交付的条目下次从头重扫（允许上下文重叠再现，稳定引用不变）。
    if (stopped && lastEmitted !== undefined) data.position = lastEmitted
    const hasGroup = (group.messages?.length ?? 0) > 0 || group.status !== 'complete' || group.error !== undefined
    return { group: hasGroup ? group : undefined, hits: emittedHits, done: exhausted && data.pendingAfter === 0 && group.status !== 'reading' }
  }

  private scan(sessionId: string, options: Omit<import('./model').HistoryScanOptions, 'limitBytes'>) {
    const budget = this.budget
    if (budget.scanMessages <= 0 || budget.scanBytes <= 0) { budget.limited = true; return undefined }
    const scan = this.reader.scan(this.context, sessionId, { ...options, limitMessages: Math.min(options.limitMessages, budget.scanMessages), limitBytes: budget.scanBytes })
    budget.scanMessages -= scan.messages.length
    budget.scanBytes -= scan.messages.reduce((n, row) => n + Buffer.byteLength(row.content, 'utf8') + Buffer.byteLength(row.attachmentsJson, 'utf8'), 0)
    if (scan.limited) budget.limited = true
    return scan
  }
}

function groupSkeleton(target: ReadTargetCursor, meta: HistorySessionMeta | undefined, budget: CallBudget): HistoryGroup {
  const skeleton: HistoryGroup = {
    session_id: target.sessionId,
    status: target.status,
    messages: [],
    ...(meta ? { title: meta.title, created_at: meta.createdAt, latest_message_at: meta.latestMessageAt } : {}),
    ...(target.error ? { error: target.error } : {}),
  }
  budget.responseBytes += estimate(skeleton)
  return skeleton
}

function budgetGroup(budget: CallBudget, skeleton: HistoryGroup): HistoryGroup {
  budget.responseBytes += estimate(skeleton)
  return skeleton
}

function emit(group: HistoryGroup, evidence: HistoryEvidence, budget: CallBudget): void {
  group.messages = [...(group.messages ?? []), evidence]
  budget.items++
  budget.responseBytes += estimate(evidence)
}

function resetSession(data: SearchCursorData): void {
  data.index++
  data.started = false
  data.position = undefined
  data.pendingAfter = 0
}

function positionOf(row: { id: string; turn: number; createdAt: string }): HistoryPosition {
  return { id: row.id, turn: row.turn, createdAt: row.createdAt }
}

function comparePosition(a: HistoryPosition, b: HistoryPosition): number {
  if (a.turn !== b.turn) return a.turn - b.turn
  const at = Date.parse(a.createdAt); const bt = Date.parse(b.createdAt)
  if (at !== bt) return at - bt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function estimate(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function remainingBytes(budget: CallBudget, options: Options): number {
  return options.maxResponseBytes - RESERVE_BYTES - budget.responseBytes
}

function requestHash(request: HistoryRequest): string {
  const { cursor: _cursor, ...rest } = request
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

function guidance(progress: HistoryResult['progress'], limited: boolean): string {
  if (limited) return '读取在限额或状态容量处停止；已交付部分不是完整历史。请缩小范围重新查询。'
  if (progress === 'more') return '本页已到交付上限，使用返回书签继续同一请求；不得把本页当作完整历史。'
  if (progress === 'stopped') return '读取未完成；已交付部分不是完整历史。可继续或缩小范围后重试；源缺失和保存时截断不能通过重试恢复。'
  return '结果仅覆盖已保存产品数据；节选请按 session_id 和 turn 范围 read，附件引用不代表访问授权。'
}

function failure(category: NonNullable<HistoryResult['error']>['category'], code: string, message: string): HistoryResult {
  return { outcome: 'failure', progress: 'stopped', groups: [], count: { unit: 'sessions', value: 0 }, error: { category, code, message }, guidance: '请检查范围或缩小范围后重试；不能将失败解释为无历史。' }
}
