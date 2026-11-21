import { createHash } from 'node:crypto'
import { HistoryCursorStore, type CursorState, type FrozenSearchSession, type ReadTargetProgress, type SearchCursorData } from './cursor'
import { historyEvidence, startSegment, takeEvidencePart, type SegmentOffset } from './evidence'
import { DEFAULT_LITERAL_SEGMENT_CHARS, DEFAULT_REGEX_FIELD_CHARS, literalContains, matchMessage, searchExcerpt, withinTime } from './matcher'
import {
  HistoryCooperativeTimeout,
  HistoryDenied,
  HistoryExecutionTimeout,
  HistoryExecutionUnavailable,
  type HistoryContext,
  type HistoryEvidence,
  type HistoryGroup,
  type HistoryPosition,
  type HistoryReader,
  type HistoryBudgetRequest,
  type HistoryRequestBudgetStore,
  type HistoryResult,
  type HistoryScan,
  type HistoryScanOptions,
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
  /** 单次工具调用协作时限（默认 2s）。 */
  cooperativeMs?: number
  /** 单次工具调用硬停止（默认 5s；执行进程层真实终止）。 */
  hardMs?: number
  /** 主请求持久账本（生产装配；缺省 = 内部验证切片不计量）。 */
  budget?: HistoryRequestBudgetStore
  /** 每主请求调用次数（默认 10，失败与重试计入）。 */
  requestMaxCalls?: number
  /** 每主请求累计等待（默认 30s）。 */
  requestMaxWaitMs?: number
  /** 每主请求累计返回字节（默认 256KiB）。 */
  requestMaxBytes?: number
  /** 书签 TTL 清扫间隔（默认 60s；0 = 关闭定时器）。 */
  cursorSweepMs?: number
}

interface Options extends Required<Omit<SessionHistoryOptions, 'events' | 'budget'>> {
  events?: SessionHistoryOptions['events']
  budget?: HistoryRequestBudgetStore
}
const RESERVE_BYTES = 512
const MIN_RESPONSE_BYTES = 1024

interface CallBudget {
  items: number
  responseBytes: number
  scanMessages: number
  scanBytes: number
  deadEnd: boolean
  timedOut: boolean
  deadline: number
  responseLimit: number
}

interface RunLimits { responseLimit: number; deadline: number }

type Prepared = { state: CursorState; token?: string }

export class SessionHistoryService {
  private readonly options: Options
  private readonly cursors: HistoryCursorStore
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly reader: HistoryReader, options: SessionHistoryOptions = {}) {
    const clock = options.clock ?? Date.now
    this.options = {
      events: options.events,
      budget: options.budget,
      clock,
      // 单次输出默认 32KiB、最大 64KiB（I2）；剩余额度另行收紧。
      maxResponseBytes: Math.min(options.maxResponseBytes ?? 32 * 1024, 64 * 1024),
      pageItems: Math.min(options.pageItems ?? 20, 50),
      maxTargets: options.maxTargets ?? 20,
      scanMessages: options.scanMessages ?? 1000,
      scanBytes: options.scanBytes ?? 8 * 1024 * 1024,
      segmentChars: options.segmentChars ?? 8 * 1024,
      literalSegmentChars: options.literalSegmentChars ?? DEFAULT_LITERAL_SEGMENT_CHARS,
      regexFieldChars: options.regexFieldChars ?? DEFAULT_REGEX_FIELD_CHARS,
      cursorTtlMs: options.cursorTtlMs ?? 30 * 60 * 1000,
      maxCursorsPerUser: options.maxCursorsPerUser ?? 4,
      maxCursors: options.maxCursors ?? 64,
      maxCursorStateBytes: options.maxCursorStateBytes ?? 256 * 1024,
      cooperativeMs: options.cooperativeMs ?? 2_000,
      hardMs: options.hardMs ?? 5_000,
      requestMaxCalls: options.requestMaxCalls ?? 10,
      requestMaxWaitMs: options.requestMaxWaitMs ?? 30_000,
      requestMaxBytes: options.requestMaxBytes ?? 256 * 1024,
      cursorSweepMs: options.cursorSweepMs ?? 60_000,
    }
    this.cursors = new HistoryCursorStore(clock, {
      ttlMs: this.options.cursorTtlMs,
      maxPerUser: this.options.maxCursorsPerUser,
      maxGlobal: this.options.maxCursors,
      maxStateBytes: this.options.maxCursorStateBytes,
    })
    // 启动即扫（TTL 清理）+ 每分钟清扫；unref 不阻止进程退出。
    this.cursors.sweep(clock())
    if (this.options.cursorSweepMs > 0) {
      this.sweepTimer = setInterval(() => this.cursors.sweep(clock()), this.options.cursorSweepMs)
      this.sweepTimer.unref?.()
    }
  }

  async execute(context: HistoryContext, input: unknown, signal?: AbortSignal): Promise<HistoryResult> {
    const started = this.options.clock()
    const parsed = SessionHistorySchema.safeParse(input)
    let result: HistoryResult
    let reservedForBudget = false
    let request: HistoryRequest | undefined
    let limits: RunLimits = { responseLimit: this.options.maxResponseBytes, deadline: started + this.options.cooperativeMs }
    let lease: import('./model').HistoryExecutionLease | undefined

    if (context.role !== 'leader') result = failure('permission', 'leader_only', '历史检索仅供 Leader 使用')
    else if (this.options.budget && context.requestId === undefined) {
      // 无法可靠恢复旧主请求额度：停止增强，不重新发放额度。
      result = failure('limit', 'request_unrecoverable', '无法可靠恢复原主请求额度，已停止本次历史检索')
    } else {
      // 额度先于解析：失败与重试也计入主请求调用次数（I2 预算）。
      const cap = await this.reserve(context, signal)
      if ('result' in cap) result = cap.result
      else {
        reservedForBudget = cap.reserved
        try {
          if (!parsed.success) result = failure('parameter', 'invalid_parameters', '历史检索参数无效')
          else if (signal?.aborted) result = failure('limit', 'cancelled', '历史检索已取消')
          else if (parsed.data.operation === 'read' && parsed.data.targets.length > this.options.maxTargets) {
            result = failure('parameter', 'too_many_targets', `单次最多读取 ${this.options.maxTargets} 个目标`)
          } else {
            const responseLimit = Math.min(this.options.maxResponseBytes, Math.max(0, cap.remainingBytes))
            if (responseLimit - RESERVE_BYTES < MIN_RESPONSE_BYTES) {
              result = failure('limit', 'response_limit', '本主请求剩余返回额度不足以交付完整历史')
            } else {
              limits = { responseLimit, deadline: started + Math.min(this.options.cooperativeMs, cap.remainingWaitMs) }
              request = parsed.data
              let busy = false
              if (this.reader.executionLease) {
                lease = await this.reader.executionLease(context, { signal, waitBudgetMs: cap.remainingWaitMs })
                busy = lease === undefined
              }
              if (busy) result = failure('limit', 'busy', '历史检索繁忙，请稍后重试；本次未排队')
              else {
                try {
                  result = await this.run(context, parsed.data, signal, limits, lease?.reader ?? this.reader)
                } catch (error) {
                  result = this.exceptionResult(error)
                }
              }
            }
          }
        } finally {
          // 任何路径都释放执行槽（包括取消/异常），不把槽泄漏给后续请求。
          if (lease) {
            lease.release()
            lease = undefined
          }
        }
      }
    }
    if (signal?.aborted) result = failure('limit', 'cancelled', '历史检索已取消')
    const effectiveLimit = limits.responseLimit
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > effectiveLimit) {
      result = failure('limit', 'response_limit', '响应超出本次读取上限，尚未交付完整历史')
    }

    // 交付前计量：调用次数在 reserve 时已计入；返回字节与等待在交付前写入账本。
    // 计量失败即停止增强（不冒险超额交付）。
    if (this.options.budget && context.requestId && reservedForBudget) {
      try {
        await this.options.budget.settle(
          this.budgetRequestOf(context),
          { bytes: Buffer.byteLength(JSON.stringify(result), 'utf8'), waitedMs: Math.max(0, this.options.clock() - started) },
        )
      } catch {
        result = failure('system', 'budget_unavailable', '历史检索计量暂时不可用，已停止本次交付')
        try { this.options.events?.warn('历史检索额度计量失败') } catch { /* 日志适配器故障 */ }
      }
    }

    try {
      const requestForLog = request ?? (parsed.success ? parsed.data : undefined)
      let explicitTargets = 0
      if (requestForLog?.operation === 'read') explicitTargets = requestForLog.targets.length
      else if (requestForLog?.operation === 'search') explicitTargets = requestForLog.session_ids?.length ?? 0
      await this.options.events?.record({
        ownerId: context.ownerId, currentSessionId: context.currentSessionId,
        operation: requestForLog?.operation ?? 'invalid',
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

  async dispose(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
    this.cursors.clear()
    await this.reader.dispose?.()
  }

  private async reserve(context: HistoryContext, signal?: AbortSignal): Promise<{ remainingBytes: number; remainingWaitMs: number; reserved: boolean } | { result: HistoryResult }> {
    if (!this.options.budget || !context.requestId) {
      return { remainingBytes: Number.POSITIVE_INFINITY, remainingWaitMs: Number.POSITIVE_INFINITY, reserved: false }
    }
    if (signal?.aborted) return { result: failure('limit', 'cancelled', '历史检索已取消') }
    try {
      const reservation = await this.options.budget.reserve(
        this.budgetRequestOf(context),
        { calls: this.options.requestMaxCalls, waitMs: this.options.requestMaxWaitMs, bytes: this.options.requestMaxBytes },
      )
      if (reservation.reason === 'unrecoverable') {
        return { result: failure('limit', 'request_unrecoverable', '无法可靠恢复原主请求额度，已停止本次历史检索') }
      }
      if (!reservation.allowed) {
        const message = reservation.reason === 'calls' ? '本主请求的历史检索次数已用尽'
          : reservation.reason === 'wait' ? '本主请求的累计等待额度已用尽'
          : '本主请求的累计返回额度已用尽'
        return { result: failure('limit', 'request_budget', message) }
      }
      return { remainingBytes: reservation.remainingBytes, remainingWaitMs: reservation.remainingWaitMs, reserved: true }
    } catch {
      return { result: failure('system', 'budget_unavailable', '历史检索计量暂时不可用，已停止本次检索') }
    }
  }

  private budgetRequestOf(context: HistoryContext): HistoryBudgetRequest {
    return { ownerId: context.ownerId, sessionId: context.currentSessionId, requestId: context.requestId! }
  }

  private exceptionResult(error: unknown): HistoryResult {
    if (error instanceof HistoryDenied) {
      // 无法核实调用者身份 = 系统/权限核查故障（拒绝交付），不伪装成可探测的不可读目标。
      if (error.code === 'authorization') return failure('system', 'unavailable', '历史检索暂不可用，未能核实读取权限')
      return failure('permission', error.code === 'current_session' ? 'current_session' : 'unreadable', '目标不在可读的历史范围')
    }
    if (error instanceof HistoryCooperativeTimeout) return failure('limit', 'timeout', '历史检索超过协作时限，已停止；请缩小范围后重试')
    if (error instanceof HistoryExecutionTimeout) return failure('limit', 'timeout', '历史检索超过硬停止时限，执行已终止；请缩小范围后重试')
    if (error instanceof HistoryExecutionUnavailable) return failure('system', 'unavailable', '历史检索执行器暂不可用')
    return failure('system', 'unavailable', '历史检索暂不可用，未能核实读取权限')
  }

  private async run(context: HistoryContext, request: HistoryRequest, signal: AbortSignal | undefined, limits: RunLimits, reader: HistoryReader): Promise<HistoryResult> {
    const prepared = await this.prepare(reader, context, request, signal)
    if ('result' in prepared) return prepared.result
    const state = prepared.state
    const budget: CallBudget = {
      items: 0, responseBytes: 0, scanMessages: this.options.scanMessages, scanBytes: this.options.scanBytes,
      deadEnd: false, timedOut: false, deadline: limits.deadline, responseLimit: limits.responseLimit,
    }
    const page = state.operation === 'read'
      ? await this.renderRead(reader, context, state, budget)
      : await this.renderSearch(reader, context, state, request as SearchRequest, budget)
    if (budget.deadEnd) return failure('limit', 'response_limit', '响应字节上限不足以交付下一片段，尚未交付完整历史')
    const remaining = state.operation === 'read'
      ? state.targets.some(t => t.status === 'pending' || t.status === 'reading')
      : state.search.index < state.search.sessions.length || state.search.started
    const capped = state.operation === 'search' && state.search.limited
    const failed = page.groups.some(g => g.status === 'incomplete' && g.error)
    const usable = page.groups.some(g => (g.messages?.length ?? 0) > 0 || (g.status === 'complete' && !g.error))
    const outcome = failed ? (usable ? 'partial_success' : 'failure') : 'success'
    const anyIncomplete = page.groups.some(g => g.status === 'incomplete')
    let progress: HistoryResult['progress'] = remaining ? 'more' : anyIncomplete || capped ? 'stopped' : 'complete'
    let cursor: { token: string; expiresAt: number } | undefined
    let limitError: HistoryResult['error']
    if (remaining) {
      const issued = this.issueCursor(context, request, state, prepared)
      cursor = issued.cursor
      limitError = issued.error
    } else if (prepared.token) {
      this.cursors.delete(prepared.token)
    }
    if (budget.timedOut) {
      // 协作时限停止：已推进的书签仍可续读；状态必须如实为 stopped，不伪装完成。
      progress = 'stopped'
      if (!limitError) limitError = { category: 'limit', code: 'timeout', message: '本次历史检索达到协作时限，已停止；可用返回书签继续或缩小范围' }
    }
    const finalProgress = limitError ? 'stopped' as const : progress
    const result: HistoryResult = {
      outcome: limitError ? (usable ? 'partial_success' : 'failure') : outcome,
      progress: finalProgress,
      groups: page.groups,
      count: page.count,
      ...(cursor ? { cursor: cursor.token, cursor_expires_at: new Date(cursor.expiresAt).toISOString() } : {}),
      ...(limitError ? { error: limitError } : {}),
      guidance: capped && !remaining ? '候选会话超出冻结上限，本次结果不是完整目录；请缩小 ID、标题或时间范围重新查询。' : guidance(finalProgress, limitError !== undefined),
    }
    return result
  }

  // 续读复用同一不透明书签（绝对到期不续期）；新查询在容量/状态大小上限处显式拒绝。
  private issueCursor(context: HistoryContext, request: HistoryRequest, state: CursorState, prepared: Prepared): { cursor?: { token: string; expiresAt: number }; error?: HistoryResult['error'] } {
    if (prepared.token) return { cursor: { token: prepared.token, expiresAt: state.deadline } }
    state.page++
    const payload = state.operation === 'read'
      ? { operation: 'read' as const, targets: state.targets }
      : { operation: 'search' as const, search: state.search }
    const put = this.cursors.put({ ownerId: context.ownerId, currentSessionId: context.currentSessionId, requestHash: requestHash(request), page: state.page, ...payload })
    return put.ok
      ? { cursor: { token: put.token, expiresAt: put.expiresAt } }
      : { error: { category: 'limit', code: put.reason === 'busy' ? 'busy' : 'state_limit', message: '书签状态已满或过大，请缩小范围后重新查询' } }
  }

  private async prepare(reader: HistoryReader, context: HistoryContext, request: HistoryRequest, signal?: AbortSignal): Promise<Prepared | { result: HistoryResult }> {
    if (request.cursor) {
      const state = this.cursors.get(request.cursor, { ownerId: context.ownerId, currentSessionId: context.currentSessionId, operation: request.operation }, requestHash(request))
      if (!state || state.operation !== request.operation) return { result: failure('parameter', 'invalid_cursor', '书签无效或不适用于本次请求') }
      return { state, token: request.cursor }
    }
    if (signal?.aborted) return { result: failure('limit', 'cancelled', '历史检索已取消') }
    if (request.operation === 'read') {
      const targets = await this.initReadTargets(reader, context, request)
      return { state: { ownerId: context.ownerId, currentSessionId: context.currentSessionId, operation: 'read', requestHash: requestHash(request), page: 0, deadline: 0, targets } }
    }
    const queried = await reader.sessions(context, { sessionIds: request.session_ids })
    const filtered = queried.sessions.filter(meta => (!request.title || literalContains(meta.title, request.title, request.case_sensitive)) &&
      !(request.time?.field === 'session_created_at' && !withinTime(meta.createdAt, request.time)))
    const sessions: FrozenSearchSession[] = filtered.map(meta => ({ id: meta.id, version: meta.version, ...(meta.upper ? { upper: meta.upper } : {}) }))
    return { state: { ownerId: context.ownerId, currentSessionId: context.currentSessionId, operation: 'search', requestHash: requestHash(request), page: 0, deadline: 0,
      search: { sessions, index: 0, pendingAfter: 0, started: false, limited: queried.limited } } }
  }

  private async initReadTargets(reader: HistoryReader, context: HistoryContext, request: ReadRequest): Promise<ReadTargetProgress[]> {
    const ids = [...new Set(request.targets.map(t => t.session_id))]
    const metas = (await reader.sessions(context, { sessionIds: ids })).sessions
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

  private async renderRead(reader: HistoryReader, context: HistoryContext, state: Extract<CursorState, { operation: 'read' }>, budget: CallBudget): Promise<Page> {
    const groups: HistoryGroup[] = []
    const metas = (await reader.sessions(context, { sessionIds: [...new Set(state.targets.map(t => t.sessionId))] })).sessions
    const byId = new Map(metas.map(meta => [meta.id, meta]))
    const processor = new ReadProcessor(this.options, new BudgetedScanner(reader, context, budget, this.options.clock), budget)
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
      if (stop || budget.items >= this.options.pageItems || budget.timedOut) { stop = true; continue }
      stop = await processor.readTarget(target, group)
      if (group.status !== 'incomplete') group.status = target.status
      if (target.error && !group.error) group.error = target.error
    }
    const count = groups.reduce((n, g) => n + (g.messages?.length ?? 0), 0)
    return { groups, count: { unit: 'messages', value: count } }
  }

  private async renderSearch(reader: HistoryReader, context: HistoryContext, state: Extract<CursorState, { operation: 'search' }>, request: SearchRequest, budget: CallBudget): Promise<Page> {
    const data = state.search
    const metas = (await reader.sessions(context, { sessionIds: data.sessions.map(s => s.id) })).sessions
    const byId = new Map(metas.map(meta => [meta.id, meta]))
    const groups: HistoryGroup[] = []
    const scanner = new BudgetedScanner(reader, context, budget, this.options.clock)
    const processor = new SearchProcessor(this.options, scanner, request, budget)
    let hits = 0
    let stop = false
    while (!stop && data.index < data.sessions.length) {
      if (budget.items >= this.options.pageItems || budget.timedOut) { stop = true; break }
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
        groups.push(budgetGroup(budget, { session_id: frozen.id, title: meta.title, created_at: meta.createdAt, latest_message_at: meta.latestMessageAt, status: 'incomplete', error: { code: 'changed', message: '目标会话历史已变化，请重新查询该会话' } }))
        resetSession(data)
        continue
      }
      if (request.query && !frozen.upper) { resetSession(data); continue }
      if (!request.query) {
        if (request.time?.field === 'message_created_at') {
          const probe = await scanner.scan(frozen.id, { ...(frozen.upper ? { upTo: frozen.upper } : {}), time: { ...(request.time.from ? { from: request.time.from } : {}), ...(request.time.to ? { to: request.time.to } : {}) }, limitMessages: 1 })
          if (!probe) { stop = true; break }
          if (!probe.messages.length) { resetSession(data); continue }
        }
        const group = budgetGroup(budget, { session_id: meta.id, title: meta.title, created_at: meta.createdAt, latest_message_at: meta.latestMessageAt, status: 'complete' })
        groups.push(group)
        budget.items++
        resetSession(data)
        continue
      }
      const outcome = await processor.searchSession(data, meta.id, meta)
      if (outcome.group) groups.push(outcome.group)
      hits += outcome.hits
      if (outcome.done) resetSession(data)
      else stop = true
      if (budget.items >= this.options.pageItems || budget.deadEnd || budget.timedOut) break
    }
    return { groups, count: { unit: request.query ? 'hits' : 'sessions', value: request.query ? hits : groups.filter(g => g.status === 'complete').length } }
  }
}

interface Page { groups: HistoryGroup[]; count: HistoryResult['count'] }

class BudgetedScanner {
  constructor(
    private readonly reader: HistoryReader,
    private readonly context: HistoryContext,
    private readonly budget: CallBudget,
    private readonly clock: () => number,
  ) {}

  async scan(sessionId: string, options: Omit<HistoryScanOptions, 'limitBytes'> & { limitMessages: number }): Promise<HistoryScan | undefined> {
    if (this.budget.timedOut) return undefined
    if (this.budget.scanMessages <= 0 || this.budget.scanBytes <= 0) return undefined
    if (this.clock() > this.budget.deadline) { this.budget.timedOut = true; return undefined }
    let scan: HistoryScan
    try {
      scan = await this.reader.scan(this.context, sessionId, {
        ...options,
        limitMessages: Math.min(options.limitMessages, this.budget.scanMessages),
        limitBytes: this.budget.scanBytes,
      })
    } catch (error) {
      if (error instanceof HistoryCooperativeTimeout) {
        this.budget.timedOut = true
        return undefined
      }
      throw error
    }
    this.budget.scanMessages -= scan.messages.length
    this.budget.scanBytes -= scan.messages.reduce((n, row) => n + Buffer.byteLength(row.content, 'utf8') + Buffer.byteLength(row.attachmentsJson, 'utf8'), 0)
    if (this.clock() > this.budget.deadline) this.budget.timedOut = true
    return scan
  }
}

class ReadProcessor {
  constructor(
    private readonly options: Options,
    private readonly scanner: BudgetedScanner,
    private readonly budget: CallBudget,
  ) {}

  // 返回 true 表示本轮页面应停止（预算耗尽）。
  async readTarget(target: ReadTargetProgress, group: HistoryGroup): Promise<boolean> {
    for (;;) {
      const scan = await this.scanner.scan(target.sessionId, {
        ...(target.position ? { after: target.position } : {}),
        ...(target.upper ? { upTo: target.upper } : {}),
        ...(target.range ? { range: target.range } : {}),
        limitMessages: this.options.scanMessages,
      })
      if (!scan) { target.status = 'reading'; return true }
      if (!scan.messages.length) {
        if (scan.hasMore) { target.status = 'reading'; return true }
        target.status = 'complete'
        return false
      }
      for (const row of scan.messages) {
        if (this.budget.timedOut) { target.status = 'reading'; return true }
        const evidence = historyEvidence(target.sessionId, row)
        if (evidence.missing.length) {
          group.status = 'incomplete'
          group.error ??= { code: 'missing_product_fields', message: '部分保存的产品字段缺失，不能保证读取完整' }
          group.missing = [...(group.missing ?? []), { message_id: row.id, fields: evidence.missing }]
        }
        const existing = target.segment && target.segment.messageId === row.id ? target.segment.offset : undefined
        const segment = existing ?? startSegment(evidence, this.options.segmentChars)
        if (!segment) {
          if (this.budget.items >= this.options.pageItems) { target.status = 'reading'; return true }
          if (estimate(evidence) > remainingBytes(this.budget, this.options)) {
            if (this.budget.items === 0) this.budget.deadEnd = true
            target.status = 'reading'
            return true
          }
          emit(group, evidence, this.budget)
          target.position = positionOf(row)
          target.segment = undefined
          continue
        }
        if (this.emitSegments(evidence, segment, target, group) !== 'done') { target.status = 'reading'; return true }
        target.position = positionOf(row)
        target.segment = undefined
      }
      if (scan.hasMore || scan.limited) {
        target.status = 'reading'
        if (scan.limited || this.budget.timedOut) return true
        continue
      }
      target.status = 'complete'
      return false
    }
  }

  private emitSegments(evidence: HistoryEvidence, start: SegmentOffset, target: ReadTargetProgress, group: HistoryGroup): 'done' | 'stop' {
    let offset: SegmentOffset | undefined = start
    while (offset) {
      if (this.budget.timedOut) { target.segment = { messageId: evidence.message_id, offset }; return 'stop' }
      if (this.budget.items >= this.options.pageItems) { target.segment = { messageId: evidence.message_id, offset }; return 'stop' }
      let allowed = this.options.segmentChars
      let taken = takeEvidencePart(evidence, offset, allowed)
      while (offset.region !== 'fields' && estimate(taken.part) > remainingBytes(this.budget, this.options) && allowed > 1) {
        allowed = Math.max(1, Math.floor(allowed / 2))
        taken = takeEvidencePart(evidence, offset, allowed)
      }
      if (offset.region === 'fields' && estimate(taken.part) > remainingBytes(this.budget, this.options)) {
        if (this.budget.items > 0) { target.segment = { messageId: evidence.message_id, offset }; return 'stop' }
        // 空页仍容不下附属性字段：明确标未完成，不伪装完整交付；不得让同一消息永远卡住。
        group.status = 'incomplete'
        group.error ??= { code: 'payload_too_large', message: '消息附属性字段超出本次响应上限' }
        return 'done'
      }
      if (estimate(taken.part) > remainingBytes(this.budget, this.options)) {
        if (this.budget.items === 0) this.budget.deadEnd = true
        target.segment = { messageId: evidence.message_id, offset }
        return 'stop'
      }
      emit(group, taken.part, this.budget)
      offset = taken.next
    }
    return 'done'
  }
}

class SearchProcessor {
  constructor(
    private readonly options: Options,
    private readonly scanner: BudgetedScanner,
    private readonly request: SearchRequest,
    private readonly budget: CallBudget,
  ) {}

  async searchSession(data: SearchCursorData, sessionId: string, meta: HistorySessionMeta): Promise<{ group?: HistoryGroup; hits: number; done: boolean }> {
    const before = this.request.context?.before ?? 1
    const after = this.request.context?.after ?? 1
    const output = new Map<string, { pos: HistoryPosition; evidence: HistoryEvidence; hit: boolean }>()
    const tail: { pos: HistoryPosition; evidence: HistoryEvidence }[] = []
    let groupError: HistoryGroup['error']
    let damaged = false
    data.started = true
    if (data.position && before > 0) {
      // 取游标水位（含最后已扫描消息）之前的尾部窗口；必须 DESC 后反转，不能按 ASC 从头取。
      const scan = await this.scanner.scan(sessionId, { beforeInclusive: data.position, limitMessages: before })
      if (!scan) return { hits: 0, done: false }
      for (const row of scan.messages) tail.push({ pos: positionOf(row), evidence: historyEvidence(sessionId, row) })
    }
    let exhausted = false
    let stopped = false
    while (!stopped) {
      const frozen = data.sessions[data.index]!
      const scan = await this.scanner.scan(sessionId, {
        ...(data.position ? { after: data.position } : {}),
        ...(frozen.upper ? { upTo: frozen.upper } : {}),
        ...(this.request.time?.field !== 'session_created_at' && this.request.time
          ? { time: { ...(this.request.time.from ? { from: this.request.time.from } : {}), ...(this.request.time.to ? { to: this.request.time.to } : {}) } }
          : {}),
        limitMessages: this.options.scanMessages,
      })
      if (!scan) { stopped = true; break }
      if (!scan.messages.length) {
        if (scan.hasMore) { stopped = true; break }
        exhausted = true
        data.pendingAfter = 0
        break
      }
      for (const row of scan.messages) {
        if (this.budget.timedOut) { stopped = true; break }
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

        stopped = scan.limited
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
    if (this.budget.timedOut) group.status = groupError ? 'incomplete' : 'reading'
    else if (exhausted && data.pendingAfter === 0) group.status = groupError ? 'incomplete' : 'complete'
    else if (!exhausted) group.status = groupError ? 'incomplete' : 'reading'
    // 未交付的条目下次从头重扫（允许上下文重叠再现，稳定引用不变）。
    if (stopped && lastEmitted !== undefined) data.position = lastEmitted
    const hasGroup = (group.messages?.length ?? 0) > 0 || group.status !== 'complete' || group.error !== undefined
    return { group: hasGroup ? group : undefined, hits: emittedHits, done: exhausted && data.pendingAfter === 0 && group.status !== 'reading' }
  }
}

function groupSkeleton(target: ReadTargetProgress, meta: HistorySessionMeta | undefined, budget: CallBudget): HistoryGroup {
  return budgetGroup(budget, {
    session_id: target.sessionId,
    status: target.status,
    messages: [],
    ...(meta ? { title: meta.title, created_at: meta.createdAt, latest_message_at: meta.latestMessageAt } : {}),
    ...(target.error ? { error: target.error } : {}),
  })
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
  return Math.min(options.maxResponseBytes, budget.responseLimit) - RESERVE_BYTES - budget.responseBytes
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
