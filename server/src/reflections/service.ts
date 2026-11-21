// reflections 业务服务（#1080 · RF-T04）：公共业务口 execute(context, request, signal)。
//
// 本票只开放草稿链路（create/revise/present/read/cancel）。commit 一律 confirmation_required
// ——正式记录与确认授权归 #1081（RF-T05）。草稿永远不会进入 experience 检索。

import {
  evidenceViews,
  matchExcerpt,
  normalizeDraftInput,
  presentationJson,
  sha256,
} from './content'
import type {
  DraftBody,
  DraftRecord,
  EvidenceInput,
  EvidenceRecord,
  PresentationRef,
  ReflectionContext,
  ReflectionError,
  ReflectionResult,
  ReflectionStore,
  ReflectionEvidencePort,
} from './model'
import { ReflectionRecordsSchema, type ReflectionRequest } from './params'
import {
  REFLECTION_CATEGORY_LABELS,
  reflectionBodyRef,
  reflectionDraftRef,
} from './values'

export interface ReflectionServiceOptions {
  clock?: () => number
  events?: { record(event: { ownerId: string; operation: string; category: string; durationMs: number }): void | Promise<void> }
}

function failure(category: ReflectionError['category'], code: ReflectionError['code'], message: string, operation = 'unknown'): ReflectionResult {
  return { outcome: 'failure', progress: 'complete', operation, error: { category, code, message } }
}

function success(operation: string, payload: Record<string, unknown>, guidance?: string): ReflectionResult {
  return { outcome: 'success', progress: 'complete', operation, ...payload, ...(guidance !== undefined ? { guidance } : {}) }
}

const DRAFT_GUIDANCE = '草稿已生成。展示步骤（present）会把完整五部分与实际拟保存版本交给用户；只有用户之后的自然语言确认才能保存。证据 preparing/not_ready 时不可确认。'

export class ReflectionService {
  private readonly clock: () => number

  constructor(
    private readonly store: ReflectionStore,
    private readonly evidence: ReflectionEvidencePort,
    private readonly options: ReflectionServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now
  }

  async execute(context: ReflectionContext, input: unknown, signal?: AbortSignal): Promise<ReflectionResult> {
    const started = this.clock()
    const parsed = ReflectionRecordsSchema.safeParse(input)
    const operation = parsed.success ? parsed.data.operation : 'unknown'
    let result: ReflectionResult
    if (context.role !== 'leader') result = failure('permission', 'leader_only', '反思记录仅供 Leader 使用', operation)
    else if (!parsed.success) result = failure('parameter', 'invalid_parameters', '反思工具参数无效', operation)
    else if (signal?.aborted) result = failure('limit', 'cancelled', '反思操作已取消', operation)
    else {
      try {
        result = await this.run(context, parsed.data, signal)
      } catch (err) {
        result = failure('system', 'system_error', `反思操作失败：${(err as Error).message}`, operation)
      }
    }
    if (signal?.aborted) result = failure('limit', 'cancelled', '反思操作已取消', operation)
    try {
      await this.options.events?.record({
        ownerId: context.ownerId,
        operation,
        category: result.error?.code ?? result.outcome,
        durationMs: Math.max(0, this.clock() - started),
      })
    } catch {
      // 访问日志故障不阻断已授权操作，也不输出正文。
    }
    return result
  }

  private async run(context: ReflectionContext, request: ReflectionRequest, signal?: AbortSignal): Promise<ReflectionResult> {
    switch (request.operation) {
      case 'search': return this.search(context, request)
      case 'read': return this.read(context, request)
      case 'draft': return this.draft(context, request, signal)
      case 'present': return this.present(context, request)
      case 'commit': return this.commit(context, request)
      case 'cancel': return this.cancel(context, request)
      default: return failure('parameter', 'invalid_parameters', '未知反思操作', 'unknown')
    }
  }

  private async search(context: ReflectionContext, request: Extract<ReflectionRequest, { operation: 'search' }>): Promise<ReflectionResult> {
    if (request.purpose === 'experience') {
      // 本票没有正式记录表：草稿不得冒充经验检索结果（父规格 I3/I6）。
      return success('search', {
        purpose: 'experience',
        records: [],
        count: 0,
      }, '尚无可检索的正式反思记录（正式保存与经验检索归后续票）。')
    }
    const drafts = await this.store.listDrafts(context.ownerId, {
      ...(request.state !== undefined ? { state: request.state } : {}),
      limit: 20,
    })
    const query = request.query ? normalizeQuery(request.query) : undefined
    const filtered = drafts.filter((draft) => {
      if (request.category !== undefined && draft.body.category !== request.category) return false
      if (request.scope !== undefined && request.scope.length > 0 && !request.scope.some((label) => draft.body.scope.labels.includes(label))) return false
      if (query && query.words.length > 0) {
        const haystack = normalizeQueryText([
          draft.body.title,
          draft.body.problem,
          ...draft.body.improvements,
          draft.body.scope.conditions,
          draft.body.scope.exclusions,
          ...draft.body.scope.labels,
          draft.body.category,
        ].join('\n'))
        if (!query.words.every((word) => haystack.includes(word))) return false
      }
      return true
    })
    return success('search', {
      purpose: 'management',
      drafts: filtered.map(draftSummary),
      count: filtered.length,
    }, '管理视图只返回草稿；未确认草稿不进入经验匹配。')
  }

  private async read(context: ReflectionContext, request: Extract<ReflectionRequest, { operation: 'read' }>): Promise<ReflectionResult> {
    if (request.purpose === 'experience') {
      return success('read', { purpose: 'experience', drafts: [] }, '尚无正式反思记录；未确认草稿只能以 management 读取。')
    }
    const out: unknown[] = []
    let conflict = false
    for (const target of request.targets) {
      const draft = await this.store.getDraft(context.ownerId, target.draft_id)
      if (!draft) {
        out.push({ draft_id: target.draft_id, status: 'not_found' })
        continue
      }
      if (target.version !== undefined && target.version !== draft.version) {
        conflict = true
        out.push({ draft_id: draft.id, status: 'conflict', expected_version: target.version, actual_version: draft.version })
        continue
      }
      // 正文不落工具输出/checkpoint：只给引用，模型调用边界由解引用适配临时展开。
      out.push({
        draft_id: draft.id,
        version: draft.version,
        status: draft.status,
        action: draft.action,
        title: draft.body.title,
        category: draft.body.category,
        body_ref: reflectionDraftRef(draft.id, draft.version),
        evidence: evidenceViews(draft.evidence).map((e) => ({
          position: e.position,
          status: e.status,
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
        })),
      })
    }
    const base = success('read', { purpose: 'management', drafts: out })
    return conflict ? { ...base, outcome: 'partial_success', error: { category: 'conflict', code: 'conflict', message: '部分目标版本已变化' } } : base
  }

  private async draft(context: ReflectionContext, request: Extract<ReflectionRequest, { operation: 'draft' }>, signal?: AbortSignal): Promise<ReflectionResult> {
    let normalized: ReturnType<typeof normalizeDraftInput>
    try {
      normalized = normalizeDraftInput({
        category: request.category,
        title: request.title,
        problem: request.problem,
        causes: request.causes,
        improvements: request.improvements,
        scope: request.scope,
        evidence: request.evidence as EvidenceInput[],
      })
    } catch (err) {
      return failure('parameter', 'invalid_parameters', (err as Error).message, 'draft')
    }
    if ('error' in normalized) return failure('parameter', 'invalid_parameters', normalized.error, 'draft')

    const evidence: EvidenceRecord[] = []
    for (const [index, item] of normalized.evidence.entries()) {
      if (signal?.aborted) return failure('limit', 'cancelled', '反思操作已取消', 'draft')
      const record = await this.resolveEvidence(context, item, index + 1)
      if ('error' in record) {
        return failure('parameter', record.error.code, record.error.message, 'draft')
      }
      evidence.push(record.record)
    }
    const status = evidence.every((e) => e.status === 'valid') ? 'pending' : 'preparing'
    const created = request.action === 'create'
      ? await this.store.createDraft({
          ownerId: context.ownerId,
          sessionId: context.currentSessionId,
          body: normalized.body,
          evidence,
          status,
          action: 'create',
        })
      : await this.store.reviseDraft({
          ownerId: context.ownerId,
          draftId: request.draft_id!,
          baseVersion: request.base_version!,
          body: normalized.body,
          evidence,
          status,
        })
    if (!created) {
      return request.action === 'revise'
        ? failure('conflict', 'conflict', '草稿版本已变化，请重新读取后形成新草稿', 'draft')
        : failure('system', 'system_error', '草稿创建失败', 'draft')
    }
    return success('draft', {
      draft: {
        draft_id: created.id,
        version: created.version,
        status: created.status,
        action: created.action,
        title: created.body.title,
        category: created.body.category,
        body_ref: reflectionDraftRef(created.id, created.version),
        evidence: evidenceViews(created.evidence).map((e) => ({
          position: e.position,
          status: e.status,
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
        })),
      },
      ...(normalized.redactions > 0 ? { redactions: normalized.redactions } : {}),
      status,
      confirmable: status === 'pending',
    }, DRAFT_GUIDANCE)
  }

  private async resolveEvidence(
    context: ReflectionContext,
    item: EvidenceInput,
    position: number,
  ): Promise<{ record: EvidenceRecord } | { error: { code: 'invalid_evidence' | 'evidence_mismatch'; message: string } }> {
    const sessionId = item.session_id ?? context.currentSessionId
    const display = item.displayExcerpt ?? item.excerpt
    // 可信当前证据端口只读本人当前主线程（#1080 AC / 父规格 I4）——历史证据须走
    // session_history 的读取边界，不在这里放宽成任意会话可读。
    if (sessionId !== context.currentSessionId) {
      return { error: { code: 'invalid_evidence', message: `证据 ${position} 只允许引用当前会话` } }
    }

    if (item.message_id !== undefined) {
      const source = await this.evidence.readRegion(context, sessionId, item.message_id, item.region, item.tool_call_id)
      if (!source) return { error: { code: 'invalid_evidence', message: `证据 ${position} 来源不存在或不可读` } }
      if (!source.regionPresent) {
        return { record: pendingRecord({ item, position, sessionId, runId: null, messageId: source.messageId, status: 'not_ready', reason: 'not_persisted', excerpt: display }) }
      }
      if (source.truncated && item.region === 'tool_result') {
        return { record: pendingRecord({ item, position, sessionId, runId: null, messageId: source.messageId, status: 'not_ready', reason: 'truncated', excerpt: display }) }
      }
      const matched = matchExcerpt(source.regionText, item.excerpt, item.start, item.end)
      if ('error' in matched) {
        // 工具结果保存时截断：摘录找不到可能是截断之外，标 not_ready 而不是伪造核验失败。
        if (source.truncated) return { record: pendingRecord({ item, position, sessionId, runId: null, messageId: source.messageId, status: 'not_ready', reason: 'truncated', excerpt: display }) }
        return { error: { code: 'evidence_mismatch', message: `证据 ${position} 与来源原文不匹配` } }
      }
      return {
        record: {
          position,
          sessionId,
          messageId: source.messageId,
          runId: null,
          toolCallId: item.tool_call_id ?? null,
          region: item.region,
          startCp: matched.start,
          endCp: matched.end,
          excerpt: display,
          regionHash: matched.regionHash,
          contentVersion: source.contentVersion,
          status: 'valid',
        },
      }
    }

    // 未给 message_id：只允许本人当前会话的在飞证据（当前轮 assistant 行尚未落库）。
    if (context.runId === undefined) {
      return { error: { code: 'invalid_evidence', message: `证据 ${position} 无法定位当前轮 run` } }
    }
    if (item.run_id !== undefined && item.run_id !== context.runId) {
      return { error: { code: 'invalid_evidence', message: `证据 ${position} 的 run 与当前主请求不一致` } }
    }
    return {
      record: pendingRecord({ item, position, sessionId, runId: context.runId, messageId: null, status: 'preparing', reason: 'in_flight', excerpt: display }),
    }
  }

  private async present(context: ReflectionContext, request: Extract<ReflectionRequest, { operation: 'present' }>): Promise<ReflectionResult> {
    const draft = await this.store.getDraft(context.ownerId, request.draft_id)
    if (!draft || draft.sessionId !== context.currentSessionId) {
      return failure('parameter', 'not_found', '草稿不存在或不属于当前会话', 'present')
    }
    if (draft.version !== request.version) return failure('conflict', 'conflict', '草稿版本已变化，请重新展示最新版本', 'present')
    if (draft.status === 'cancelled' || draft.status === 'committed') {
      return failure('conflict', 'not_ready', '草稿已关闭，不能展示', 'present')
    }
    // 展示前复核来源可见性与内容版本（父规格 I4）；失效即回 preparing，不得展示为可确认版本。
    const stale = await this.reverifyEvidence(context, draft)
    if (stale !== null) {
      await this.store.invalidateVersion(context.ownerId, draft.id, draft.version, stale)
      return failure('conflict', 'not_ready', `证据来源已变化（${stale}），请重新起草`, 'present')
    }
    const bodyJson = presentationJson({ body: draft.body, evidence: draft.evidence, version: draft.version, action: draft.action })
    const bodyHash = sha256(bodyJson)
    await this.store.revokePresentations(context.ownerId, draft.id)
    const presentation = await this.store.createPresentation({
      ownerId: context.ownerId,
      sessionId: context.currentSessionId,
      draft,
      body: draft.body,
      evidence: draft.evidence,
      bodyJson,
      bodyHash,
      action: draft.action,
    })
    const ref: PresentationRef = {
      displayId: presentation.displayId,
      draftId: draft.id,
      version: draft.version,
      bodyHash,
      status: draft.status,
      confirmable: draft.status === 'pending',
    }
    return success('present', {
      presentation: {
        ...ref,
        body_ref: reflectionBodyRef(presentation.displayId),
        binding: 'pending_record_turn',
      },
      // 预览门槛：有 preparing/not_ready 证据时明确不可确认（父规格 I5）。
      confirmable: ref.confirmable,
      ...(draft.status !== 'pending'
        ? { not_confirmable_reason: evidenceNotReadyReason(draft.evidence) }
        : {}),
    }, '已生成展示。用户须在聊天中看到该版本后用自然语言确认；展示未绑定终态消息前不可保存。')
  }

  private async commit(context: ReflectionContext, request: Extract<ReflectionRequest, { operation: 'commit' }>): Promise<ReflectionResult> {
    const draft = await this.store.getDraft(context.ownerId, request.draft_id)
    if (!draft || draft.sessionId !== context.currentSessionId) return failure('parameter', 'not_found', '草稿不存在或不属于当前会话', 'commit')
    if (draft.version !== request.version) return failure('conflict', 'conflict', '草稿版本已变化', 'commit')
    if (draft.status !== 'pending') return failure('conflict', 'not_ready', '证据尚未完成持久化核验，草稿不可确认', 'commit')
    // 提交前再次复核来源（I4）：失效即拒绝，不把过期证据当作可确认版本。
    const stale = await this.reverifyEvidence(context, draft)
    if (stale !== null) {
      await this.store.invalidateVersion(context.ownerId, draft.id, draft.version, stale)
      return failure('conflict', 'not_ready', `证据来源已变化（${stale}），请重新起草`, 'commit')
    }
    // 展示前置（父规格 I5 / RF04「没有展示不能 confirm」）：须有本版本展示、已绑定终态 assistant
    // 消息、且浏览器已提交 ack。缺任一项明确 not_ready，要求重新完整展示后确认。
    const presentation = await this.store.latestPresentation(context.ownerId, draft.id)
    if (!presentation || presentation.draftVersion !== draft.version) {
      return failure('conflict', 'not_ready', '草稿尚未完整展示，请先 present 并让用户看到该版本', 'commit')
    }
    if (presentation.messageId === null || presentation.status !== 'acked') {
      return failure('conflict', 'not_ready', '展示尚未绑定终态消息或客户端未完成渲染确认', 'commit')
    }
    // 本票不签发确认授权（RF-T05 归 #1081）；草稿无确认不得进入正式记录。
    return failure('conflict', 'confirmation_required', '需要用户在完整展示后用自然语言确认，才能保存', 'commit')
  }

  private async cancel(context: ReflectionContext, request: Extract<ReflectionRequest, { operation: 'cancel' }>): Promise<ReflectionResult> {
    const draft = await this.store.getDraft(context.ownerId, request.draft_id)
    if (!draft || draft.sessionId !== context.currentSessionId) return failure('parameter', 'not_found', '草稿不存在或不属于当前会话', 'cancel')
    if (request.version !== undefined && request.version !== draft.version) return failure('conflict', 'conflict', '草稿版本已变化', 'cancel')
    if (draft.status === 'committed') return failure('conflict', 'conflict', '已保存记录不能按草稿撤回', 'cancel')
    const closed = await this.store.cancelDraft(context.ownerId, draft.id)
    if (!closed) return failure('conflict', 'conflict', '草稿已关闭', 'cancel')
    return success('cancel', { draft: { id: closed.id, status: closed.status } }, '未提交草稿已关闭并撤销展示。')
  }

  // ---- 展示读取 / ack（窄协议端点；ack 仅证明客户端已呈现版本，不是写授权）----

  async getDisplay(ownerId: string, displayId: string): Promise<PresentationDisplay | null> {
    const p = await this.store.getPresentation(ownerId, displayId)
    if (!p) return null
    const deleted = p.status === 'deleted'
    const draft = deleted ? null : await this.store.getDraft(ownerId, p.draftId)
    // confirmable 每次读实时计算（展示 ref 里冻结的值会在 recordTurn 核验后过期）。
    const confirmable = !deleted && p.messageId !== null &&
      (p.status === 'active' || p.status === 'acked') &&
      draft !== null && draft.version === p.draftVersion && draft.status === 'pending'
    return {
      displayId: p.displayId,
      draftId: p.draftId,
      version: p.draftVersion,
      action: p.action,
      bodyHash: p.bodyHash,
      status: p.status,
      body: deleted ? null : p.body,
      categoryLabel: REFLECTION_CATEGORY_LABELS[p.body.category] ?? p.body.category,
      evidence: deleted ? [] : evidenceViews(p.evidence),
      messageId: p.messageId,
      createdAt: p.createdAt,
      confirmable,
      ...(confirmable ? {} : { notConfirmableReason: deleted ? 'deleted' : draft === null || draft.version !== p.draftVersion ? 'version_changed' : draft.status !== 'pending' ? 'evidence_not_ready' : 'not_bound' }),
      ...(deleted ? { deleted: true } : {}),
    }
  }

  // 来源复核（I4）：展示/提交前逐条重读已核验证据的来源，内容版本变化或不可读即失效。
  private async reverifyEvidence(context: ReflectionContext, draft: DraftRecord): Promise<string | null> {
    for (const e of draft.evidence) {
      if (e.status !== 'valid') continue
      if (e.messageId === null) return 'in_flight_unbound'
      if (e.sessionId !== context.currentSessionId) return 'cross_session'
      const source = await this.evidence.readRegion(context, e.sessionId, e.messageId, e.region, e.toolCallId ?? undefined)
      if (!source || !source.regionPresent) return 'source_unavailable'
      if (source.contentVersion !== e.contentVersion) return 'content_changed'
    }
    return null
  }

  async ackDisplay(ownerId: string, displayId: string, input: { version: number; hash: string; messageId: string }): Promise<AckResult> {
    return this.store.ackPresentation({
      ownerId,
      displayId,
      version: input.version,
      bodyHash: input.hash,
      messageId: input.messageId,
    })
  }

  /** 模型输入解引用：把展示引用临时展开为完整五部分文本（只在本次 invoke/stream 的内存克隆中）。 */
  async displayBodyText(ownerId: string, displayId: string): Promise<string | null> {
    const display = await this.getDisplay(ownerId, displayId)
    if (!display || display.deleted || display.body === null) return null
    return formatDraftBody(display.body, display.evidence, display.version)
  }

  /** 模型输入解引用：management read 的草稿正文引用临时展开（版本须仍匹配）。 */
  async draftBodyText(ownerId: string, draftId: string, version: number): Promise<string | null> {
    const draft = await this.store.getDraft(ownerId, draftId)
    if (!draft || draft.version !== version) return null
    if (draft.status === 'cancelled' || draft.status === 'committed') return null
    return formatDraftBody(draft.body, evidenceViews(draft.evidence), draft.version)
  }
}

export interface PresentationDisplay {
  readonly displayId: string
  readonly draftId: string
  readonly version: number
  readonly action: string
  readonly bodyHash: string
  readonly status: string
  readonly body: DraftBody | null
  readonly categoryLabel: string
  readonly evidence: ReturnType<typeof evidenceViews>
  readonly messageId: string | null
  readonly createdAt: string
  readonly confirmable: boolean
  readonly notConfirmableReason?: string
  readonly deleted?: boolean
}

export type AckResult = { seq: number; ackedAt: string } | { error: 'not_found' | 'conflict' | 'not_ready' }

function pendingRecord(p: {
  item: EvidenceInput
  position: number
  sessionId: string
  runId: string | null
  messageId: string | null
  status: 'preparing' | 'not_ready'
  reason: string
  excerpt: string
}): EvidenceRecord {
  return {
    position: p.position,
    sessionId: p.sessionId,
    messageId: p.messageId,
    runId: p.runId,
    toolCallId: p.item.tool_call_id ?? null,
    region: p.item.region,
    startCp: p.item.start ?? null,
    endCp: p.item.end ?? null,
    excerpt: p.excerpt,
    regionHash: null,
    contentVersion: null,
    status: p.status,
    reason: p.reason,
  }
}

function draftSummary(draft: DraftRecord): Record<string, unknown> {
  return {
    draft_id: draft.id,
    version: draft.version,
    status: draft.status,
    title: draft.body.title,
    category: draft.body.category,
    updated_at: draft.updatedAt,
  }
}

function evidenceNotReadyReason(evidence: readonly EvidenceRecord[]): string {
  const pending = evidence.find((e) => e.status !== 'valid')
  if (!pending) return '展示尚未绑定终态消息'
  return pending.status === 'preparing'
    ? '同轮在飞证据尚未在 recordTurn 完成持久化核验'
    : `证据 ${pending.position} 不可核验（${pending.reason ?? 'not_ready'}）`
}

function normalizeQuery(query: string): { words: string[] } {
  const normalized = normalizeQueryText(query)
  return { words: normalized.split(/\s+/).filter(Boolean).slice(0, 8) }
}

function normalizeQueryText(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

export function formatDraftBody(body: DraftBody, evidence: ReturnType<typeof evidenceViews>, version: number): string {  const lines = [
    `【反思草稿 v${version}】${body.title}`,
    `类别：${body.category}`,
    `一、问题与影响\n${body.problem}`,
    `二、原始证据\n${evidence.map((e) => `[${e.position}] ${e.sessionId}${e.messageId ? `#${e.messageId}` : '（当前轮在飞）'} ${e.region} ${e.start ?? ''}-${e.end ?? ''}：${e.excerpt}（${e.status}${e.reason ? `/${e.reason}` : ''}）`).join('\n')}`,
    `三、原因分析\n${body.causes.map((c) => `- [${c.kind === 'fact' ? '事实' : '推测'}]${c.evidence.length ? ` 证据 ${c.evidence.join(',')}` : ''} ${c.text}`).join('\n')}`,
    `四、可执行改进建议\n${body.improvements.map((s) => `- ${s}`).join('\n')}`,
    `五、适用范围\n标签：${body.scope.labels.join('、') || '（无）'}\n条件：${body.scope.conditions || '（无）'}\n排除：${body.scope.exclusions || '（无）'}`,
  ]
  return lines.join('\n')
}
