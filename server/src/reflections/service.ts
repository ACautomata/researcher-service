// reflections 业务服务（#1080 · RF-T04）：公共业务口 execute(context, request, signal)。
//
// 本票只开放草稿链路（create/revise/present/read/cancel）。commit 一律 confirmation_required
// ——正式记录与确认授权归 #1081（RF-T05）。草稿永远不会进入 experience 检索。

import {
  blockedDraftExcerpts,
  blockedRecordExcerpts,
  type BodyTextView,
  evidenceViews,
  isSourceInvalidReason,
  matchExcerpt,
  normalizeDraftInput,
  presentationJson,
  sanitizedDraftEvidenceViews,
  sanitizedRecordEvidenceViews,
  scrubBodyJson,
  scrubDraftBody,
  scrubSourceFragment,
  sha256,
} from './content'
import type {
  ConfirmationActionSnapshot,
  ConfirmationCandidate,
  ConfirmationClassifier,
  ConfirmationClassification,
  ConfirmationDecision,
  ConfirmationTurnOutcome,
  DraftBody,
  DraftRecord,
  EvidenceInput,
  EvidenceRecord,
  PresentationRef,
  RecordDetail,
  ReflectionContext,
  ReflectionError,
  ReflectionResult,
  ReflectionStore,
  ReflectionEvidencePort,
} from './model'
import { ReflectionRecordsSchema, type ReflectionRequest } from './params'
import {
  REFLECTION_CATEGORY_LABELS,
  REFLECTION_CONFIRMATION_DECISIONS,
  reflectionBodyRef,
  reflectionDraftRef,
  reflectionRecordRef,
} from './values'

export interface ReflectionServiceOptions {
  clock?: () => number
  events?: { record(event: { ownerId: string; operation: string; category: string; durationMs: number }): void | Promise<void> }
  /** 测试注入确认分类器；缺省用调用方传入的模型适配器。 */
  classifier?: ConfirmationClassifier
  /** 单次识别 5 秒、每主请求最多 2 次（父规格 I5）。 */
  classificationTimeoutMs?: number
  classificationAttempts?: number
  /** 授权绝对到期 10 分钟（不续期）。 */
  grantTtlMs?: number
}

const DEFAULT_CLASSIFICATION_TIMEOUT_MS = 5_000
const DEFAULT_CLASSIFICATION_ATTEMPTS = 2
const DEFAULT_GRANT_TTL_MS = 10 * 60_000

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
    const query = request.query ? normalizeQuery(request.query) : undefined
    // 正式记录：experience 只返回 active + evidenceStatus=valid（失效即退出主动使用）；
    // management 返回全部状态（待复核结论仍可查看）。匹配/摘要前先按封锁摘录清理正文，
    // 失效来源文字不能通过标题或命中与否泄露（父规格 I4）。
    const records = await this.store.listRecords(context.ownerId, { purpose: request.purpose, limit: 50 })
    const matchedRecords = records
      .map((record) => {
        const blocked = blockedRecordExcerpts(record.evidence)
        return { record, blocked, body: scrubDraftBody(record.body, blocked) }
      })
      .filter(({ body }) => matchesBody(body, query, request.category, request.scope))

    if (request.purpose === 'experience') {
      return success('search', {
        purpose: 'experience',
        records: matchedRecords.map(({ record, body }) => recordSummary(record, body)),
        count: matchedRecords.length,
      }, '经验检索仅含已确认且证据有效的记录；来源失效记录已退出主动使用，可在 management 查看待复核状态。')
    }

    const drafts = await this.store.listDrafts(context.ownerId, {
      ...(request.state !== undefined ? { state: request.state } : {}),
      limit: 20,
    })
    const filtered = drafts
      .map((draft) => {
        const blocked = blockedDraftExcerpts(draft.evidence)
        return { draft, blocked, body: scrubDraftBody(draft.body, blocked) }
      })
      .filter(({ body }) => matchesBody(body, query, request.category, request.scope))
    return success('search', {
      purpose: 'management',
      records: matchedRecords.map(({ record, body }) => recordSummary(record, body)),
      drafts: filtered.map(({ draft, body }) => draftSummary(draft, body)),
      count: matchedRecords.length + filtered.length,
    }, '管理视图同时返回草稿与正式记录（含 review_required 待复核）；未确认草稿不进入经验匹配。')
  }

  private async read(context: ReflectionContext, request: Extract<ReflectionRequest, { operation: 'read' }>): Promise<ReflectionResult> {
    const recordsOut: unknown[] = []
    const draftsOut: unknown[] = []
    let conflict = false
    for (const target of request.targets) {
      if ('record_id' in target) {
        const record = await this.store.getRecord(context.ownerId, target.record_id, target.version)
        // 不存在与越权同形；experience 下失效/停用记录不交付（即使同 owner）。
        const unavailable = !record || (request.purpose === 'experience' && (record.status !== 'active' || record.evidenceStatus !== 'valid'))
        if (unavailable) {
          recordsOut.push({ record_id: target.record_id, status: 'not_found' })
          continue
        }
        if (target.version !== undefined && target.version !== (effectiveVersion(record))) {
          conflict = true
          recordsOut.push({
            record_id: record.recordId,
            status: 'conflict',
            expected_version: target.version,
            actual_version: effectiveVersion(record),
          })
          continue
        }
        // 读门同步封锁：来源失效摘录与正文中逐字复制的来源片段都不返回（等 outbox 清理是纵深）。
        // 正文只给引用（I7：工具输出/checkpoint 不存完整反思正文），模型边界由解引用临时展开。
        const blocked = blockedRecordExcerpts(record.evidence)
        const body = scrubDraftBody(record.body, blocked)
        recordsOut.push({
          record_id: record.recordId,
          version: effectiveVersion(record),
          status: record.status,
          evidence_status: record.evidenceStatus,
          title: body.title,
          category: body.category,
          body_ref: reflectionRecordRef(record.recordId, effectiveVersion(record)),
          evidence: sanitizedRecordEvidenceViews(record.evidence),
          ...(blocked.length > 0 ? { redacted_fragments: blocked.length } : {}),
        })
        continue
      }

      const draft = await this.store.getDraft(context.ownerId, target.draft_id)
      // 未确认草稿永不进入 experience 匹配/读取（父规格 I3/I6）；按目标顺序逐项返回结果，
      // 不存在/越权/experience 一律同形 not_found（I6 防探测）。
      if (!draft || request.purpose === 'experience') {
        draftsOut.push({ draft_id: target.draft_id, status: 'not_found' })
        continue
      }
      if (target.version !== undefined && target.version !== draft.version) {
        conflict = true
        draftsOut.push({ draft_id: draft.id, status: 'conflict', expected_version: target.version, actual_version: draft.version })
        continue
      }
      // 正文不落工具输出/checkpoint：只给引用，模型调用边界由解引用适配临时展开。
      const blocked = blockedDraftExcerpts(draft.evidence)
      draftsOut.push({
        draft_id: draft.id,
        version: draft.version,
        status: draft.status,
        action: draft.action,
        title: scrubSourceFragment(draft.body.title, blocked),
        category: draft.body.category,
        body_ref: reflectionDraftRef(draft.id, draft.version),
        evidence: sanitizedDraftEvidenceViews(draft.evidence).map((e) => ({
          position: e.position,
          status: e.status,
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
        })),
        ...(blocked.length > 0 ? { evidence_blocked: true } : {}),
      })
    }
    const base = success('read', {
      purpose: request.purpose,
      records: recordsOut,
      drafts: draftsOut,
    })
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
    // 跨会话：本人草稿可在新会话重新调出展示（展示归属当前会话，授权绑定当前确认消息）。
    if (!draft) return failure('parameter', 'not_found', '草稿不存在', 'present')
    if (draft.version !== request.version) return failure('conflict', 'conflict', '草稿版本已变化，请重新展示最新版本', 'present')
    if (draft.status === 'cancelled' || draft.status === 'committed' || draft.status === 'rejected') {
      return failure('conflict', 'not_ready', '草稿已关闭，不能展示', 'present')
    }
    // 展示前复核来源可见性与内容版本（父规格 I4）；失效即回 preparing，不得展示为可确认版本。
    const stale = await this.reverifyEvidence(context, draft)
    if (stale !== null) {
      await this.store.invalidateVersion(context.ownerId, draft.id, draft.version, stale)
      return failure('conflict', 'not_ready', `证据来源已变化（${stale}），请重新起草`, 'present')
    }
    // #1084：即使仍有其它 preparing 证据可 preview，也不把已封锁的来源片段写进展示副本。
    const blocked = blockedDraftExcerpts(draft.evidence)
    const shownBody = scrubDraftBody(draft.body, blocked)
    const bodyJson = scrubBodyJson(
      presentationJson({ body: draft.body, evidence: draft.evidence, version: draft.version, action: draft.action }),
      blocked,
    )
    const bodyHash = sha256(bodyJson)
    await this.store.revokePresentations(context.ownerId, draft.id)
    const presentation = await this.store.createPresentation({
      ownerId: context.ownerId,
      sessionId: context.currentSessionId,
      draft,
      body: shownBody,
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
    if (!draft) return failure('parameter', 'not_found', '草稿不存在', 'commit')
    if (draft.version !== request.version) return failure('conflict', 'conflict', '草稿版本已变化', 'commit')
    // 正式保存只认「真实确认消息」对应的内部授权；模型参数没有 approved/grant/token。
    if (context.triggerMessageId === undefined) {
      return failure('conflict', 'confirmation_required', '需要用户在完整展示后用自然语言确认，才能保存', 'commit')
    }
    // 确认消息活跃性、展示绑定、授权状态与幂等结果均在 commitGrant 事务内 CAS 复核：
    // 已提交的幂等重试先命中幂等结果（即使确认消息后来被撤回/回退也返回原结果）。
    // 提交前再次复核来源（I4）：失效即拒绝，不把过期证据当作可确认版本。
    const stale = await this.reverifyEvidence(context, draft)
    if (stale !== null) {
      await this.store.invalidateVersion(context.ownerId, draft.id, draft.version, stale)
      await this.store.revokeActiveGrants(context.ownerId, draft.id)
      return failure('conflict', 'not_ready', `证据来源已变化（${stale}），请重新起草`, 'commit')
    }
    const outcome = await this.store.commitGrant({
      ownerId: context.ownerId,
      confirmationMessageId: context.triggerMessageId,
      draftId: draft.id,
      draftVersion: draft.version,
      now: new Date(this.clock()),
    })
    if ('error' in outcome) {
      switch (outcome.error) {
        case 'expired':
          return failure('conflict', 'expired', '确认授权已过窗，请重新展示最新版本并再次确认', 'commit')
        case 'revoked':
          return failure('conflict', 'revoked', '确认授权已撤回，不能保存', 'commit')
        case 'limit':
          return failure('limit', 'limit', '提交次数已达上限，请重新展示并确认', 'commit')
        case 'conflict':
          return failure('conflict', 'conflict', '草稿或证据已变化，请重新展示并确认', 'commit')
        default:
          return failure('conflict', 'confirmation_required', '需要用户在完整展示后用自然语言确认，才能保存', 'commit')
      }
    }
    return success('commit', {
      record: {
        record_id: outcome.result.recordId,
        revision: outcome.result.revision,
        title: outcome.result.title,
        category: outcome.result.category,
        status: outcome.result.status,
        evidence_status: outcome.result.evidenceStatus,
      },
      ...(outcome.idempotent ? { idempotent: true } : {}),
    }, '正式反思记录已保存。后续经验检索归后续票；本票不开放主动检索。')
  }

  private async cancel(context: ReflectionContext, request: Extract<ReflectionRequest, { operation: 'cancel' }>): Promise<ReflectionResult> {
    const draft = await this.store.getDraft(context.ownerId, request.draft_id)
    if (!draft) return failure('parameter', 'not_found', '草稿不存在', 'cancel')
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
    // #1084：来源失效后读门同步封锁——无效摘录换占位、正文中逐字复制的来源片段换占位；
    // outbox 之后清理持久副本，读门不依赖清理任务完成。展示与草稿证据取并集：两次读之间
    // 若有并发失效提交，任一侧的封锁态都足以阻止交付（二次复核语义）。
    const evidenceForGate = draft ? [...p.evidence, ...draft.evidence] : p.evidence
    const blocked = deleted ? [] : blockedDraftExcerpts(evidenceForGate)
    const invalidated = !deleted && (blocked.length > 0 || evidenceForGate.some((e) => e.status !== 'valid' && isSourceInvalidReason(e.reason)))
    // confirmable 每次读实时计算（展示 ref 里冻结的值会在 recordTurn 核验后过期）。
    const confirmable = !deleted && !invalidated && p.messageId !== null &&
      (p.status === 'active' || p.status === 'acked') &&
      draft !== null && draft.version === p.draftVersion && draft.status === 'pending'
    return {
      displayId: p.displayId,
      draftId: p.draftId,
      version: p.draftVersion,
      action: p.action,
      bodyHash: p.bodyHash,
      status: p.status,
      body: deleted ? null : scrubDraftBody(p.body, blocked),
      categoryLabel: REFLECTION_CATEGORY_LABELS[p.body.category] ?? p.body.category,
      evidence: deleted ? [] : sanitizedDraftEvidenceViews(p.evidence),
      messageId: p.messageId,
      createdAt: p.createdAt,
      confirmable,
      ...(confirmable ? {} : { notConfirmableReason: deleted ? 'deleted' : invalidated ? 'evidence_changed' : draft === null || draft.version !== p.draftVersion ? 'version_changed' : draft.status !== 'pending' ? 'evidence_not_ready' : 'not_bound' }),
      ...(deleted ? { deleted: true } : {}),
      ...(invalidated ? { invalidated: true } : {}),
    }
  }

  // 来源复核（I4）：展示/提交前逐条重读已核验证据的来源，内容版本变化或不可读即失效。
  // #1084：已被触发器同步封锁（not_ready + source_invalid 原因）的证据同样视为失效——
  // 不能因为状态已不是 valid 就跳过复核把封锁版本当成可确认。
  private async reverifyEvidence(context: ReflectionContext, draft: DraftRecord): Promise<string | null> {
    for (const e of draft.evidence) {
      if (e.status !== 'valid') {
        if (isSourceInvalidReason(e.reason)) return e.reason ?? 'source_changed'
        continue
      }
      if (e.messageId === null) return 'in_flight_unbound'
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

  // ---- 自然语言确认授权（#1081 · RF-T05，父规格 I5）----
  //
  // 在用户消息入队后、主 Leader 图执行前调用：分类器只读真实确认消息原文与服务端唯一动作快照。
  // 分类结果不等于授权——签发前服务端复核 ack 先后、版本/hash/来源/候选唯一，再短事务 CAS。
  async confirmTurn(context: ReflectionContext, fallback: ConfirmationClassifier): Promise<ConfirmationTurnOutcome> {
    const started = this.clock()
    const outcome = await this.confirmTurnInner(context, fallback)
    try {
      // 确认日志字段白名单：只记分类结果/耗时，不记原文或正文。
      await this.options.events?.record({
        ownerId: context.ownerId,
        operation: 'confirm',
        category: outcome.status,
        durationMs: Math.max(0, this.clock() - started),
      })
    } catch {
      // 访问日志故障告警但可继续已授权操作（RF18）；不记录原文/正文。
      console.warn(`[reflections] confirmation access log failed: owner=${context.ownerId} status=${outcome.status}`)
    }
    return outcome
  }

  private async confirmTurnInner(context: ReflectionContext, fallback: ConfirmationClassifier): Promise<ConfirmationTurnOutcome> {
    const skipped = (reason: string): ConfirmationTurnOutcome => ({ status: 'skipped', reason })
    if (context.role !== 'leader') return skipped('not_leader')
    if (context.triggerMessageId === undefined) return skipped('no_trigger')
    const trigger = await this.store.getTriggerMessage(context.ownerId, context.currentSessionId, context.triggerMessageId)
    if (!trigger) return skipped('trigger_missing')

    const candidates = await this.store.confirmationCandidates(context.ownerId, context.currentSessionId, trigger.turn)
    // 多候选无明确目标 = 歧义；一条消息只确认一个完整动作。
    if (candidates.length > 1) return { status: 'ambiguous', reason: 'multiple_candidates' }
    if (candidates.length === 0) return skipped('no_candidate')
    const candidate = candidates[0]

    const previousUserMessages = await this.store.recentUserMessages(
      context.ownerId,
      context.currentSessionId,
      trigger.turn,
      2,
    )
    const classifier = this.options.classifier ?? fallback
    let classification: ConfirmationClassification
    try {
      classification = await this.classifyConfirmation(classifier, {
        userText: trigger.content,
        previousUserMessages,
        action: confirmationSnapshot(candidate),
      })
    } catch {
      // 识别故障/超时没有授权，原任务可继续（不把失败伪装成确认或不确认）。
      return { status: 'classifier_unavailable', reason: 'classifier_failed' }
    }

    if (classification.decision !== 'confirm') {
      const effect = NON_CONFIRM_EFFECTS[classification.decision]
      if (effect.storage !== undefined) {
        // 未提交就撤授权；revise/withdraw 保留草稿但必须重新展示确认，reject 直接关闭草稿。
        await this.store.applyDecision({
          ownerId: context.ownerId,
          draftId: candidate.draft.id,
          decision: effect.storage,
          now: new Date(this.clock()),
        })
      }
      return {
        status: effect.status,
        decision: classification.decision,
        ...(classification.reason !== undefined ? { reason: classification.reason } : {}),
      }
    }

    // 来源复核在事务外（只读），事务内只做 CAS + 事件 + 授权写入（LLM 永不进事务）。
    const stale = await this.reverifyEvidence(context, candidate.draft)
    if (stale !== null) {
      await this.store.invalidateVersion(context.ownerId, candidate.draft.id, candidate.draft.version, stale)
      return skipped('evidence_changed')
    }
    const ttl = this.options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS
    const grant = await this.store.issueGrant({
      ownerId: context.ownerId,
      sessionId: context.currentSessionId,
      confirmationMessageId: trigger.id,
      confirmationTurn: trigger.turn,
      candidate,
      expiresAt: new Date(this.clock() + ttl),
    })
    if (!grant) return skipped('not_eligible')
    return {
      status: 'granted',
      grantId: grant.id,
      displayId: grant.displayId,
      draftId: grant.draftId,
      version: grant.draftVersion,
    }
  }

  private async classifyConfirmation(
    classifier: ConfirmationClassifier,
    input: Parameters<ConfirmationClassifier>[0],
  ): Promise<ConfirmationClassification> {
    const attempts = this.options.classificationAttempts ?? DEFAULT_CLASSIFICATION_ATTEMPTS
    const timeoutMs = this.options.classificationTimeoutMs ?? DEFAULT_CLASSIFICATION_TIMEOUT_MS
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await withTimeout(
          classifier(input, AbortSignal.timeout(timeoutMs)),
          timeoutMs,
        )
        if (REFLECTION_CONFIRMATION_DECISIONS.includes(result.decision)) return result
        lastError = new Error('invalid classification')
      } catch (err) {
        lastError = err
      }
    }
    throw lastError instanceof Error ? lastError : new Error('classification failed')
  }

  /** 模型输入解引用：把展示引用临时展开为完整五部分文本（只在本次 invoke/stream 的内存克隆中）。 */
  async displayBodyText(ownerId: string, displayId: string): Promise<string | null> {
    const display = await this.getDisplay(ownerId, displayId)
    if (!display || display.deleted || display.body === null) return null
    return formatDraftBody(display.body, display.evidence, display.version)
  }

  /** 模型输入解引用：正式记录正文引用临时展开（#1084；读门已按失效摘录清理）。 */
  async recordBodyText(ownerId: string, recordId: string, version: number): Promise<string | null> {
    const record = await this.store.getRecord(ownerId, recordId, version)
    if (!record) return null
    if (record.status === 'deleted' || record.evidenceStatus === 'invalid') return null
    const blocked = blockedRecordExcerpts(record.evidence)
    return formatDraftBody(
      scrubDraftBody(record.body, blocked),
      sanitizedRecordEvidenceViews(record.evidence),
      version,
    )
  }

  /** 模型输入解引用：management read 的草稿正文引用临时展开（版本须仍匹配）。 */
  async draftBodyText(ownerId: string, draftId: string, version: number): Promise<string | null> {
    const draft = await this.store.getDraft(ownerId, draftId)
    if (!draft || draft.version !== version) return null
    if (draft.status === 'cancelled' || draft.status === 'committed') return null
    const blocked = blockedDraftExcerpts(draft.evidence)
    return formatDraftBody(
      scrubDraftBody(draft.body, blocked),
      sanitizedDraftEvidenceViews(draft.evidence),
      draft.version,
    )
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
  /** #1084：来源变化/删除/失权导致证据失效——读门已封锁摘录，需重新起草/复核。 */
  readonly invalidated?: boolean
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

function effectiveVersion(record: RecordDetail): number {
  return record.revision?.version ?? record.currentRevision
}

function draftSummary(draft: DraftRecord, body: DraftBody): Record<string, unknown> {
  return {
    draft_id: draft.id,
    version: draft.version,
    status: draft.status,
    title: body.title,
    category: draft.body.category,
    updated_at: draft.updatedAt,
  }
}

function recordSummary(record: RecordDetail, body: DraftBody): Record<string, unknown> {
  return {
    record_id: record.recordId,
    version: effectiveVersion(record),
    status: record.status,
    evidence_status: record.evidenceStatus,
    title: body.title,
    category: record.category,
    updated_at: record.updatedAt,
  }
}

function matchesBody(
  body: DraftBody,
  query: { words: string[] } | undefined,
  category: string | undefined,
  scope: readonly string[] | undefined,
): boolean {
  if (category !== undefined && body.category !== category) return false
  if (scope !== undefined && scope.length > 0 && !scope.some((label) => body.scope.labels.includes(label))) return false
  if (query && query.words.length > 0) {
    const haystack = normalizeQueryText([
      body.title,
      body.problem,
      ...body.improvements,
      body.scope.conditions,
      body.scope.exclusions,
      ...body.scope.labels,
      body.category,
    ].join('\n'))
    if (!query.words.every((word) => haystack.includes(word))) return false
  }
  return true
}

const NON_CONFIRM_EFFECTS: Record<
  Exclude<ConfirmationDecision, 'confirm'>,
  { status: ConfirmationTurnOutcome['status']; storage?: 'reject' | 'revise' | 'withdraw' }
> = {
  reject: { status: 'rejected', storage: 'reject' },
  revise: { status: 'revise', storage: 'revise' },
  withdraw: { status: 'withdrawn', storage: 'withdraw' },
  unrelated: { status: 'unrelated' },
  ambiguous: { status: 'ambiguous' },
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('classification timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function confirmationSnapshot(candidate: ConfirmationCandidate): ConfirmationActionSnapshot {
  return {
    displayId: candidate.presentation.displayId,
    draftId: candidate.draft.id,
    version: candidate.draft.version,
    bodyHash: candidate.presentation.bodyHash,
    action: candidate.presentation.action,
    title: candidate.draft.body.title,
    category: candidate.draft.body.category,
    evidenceCount: candidate.draft.evidence.length,
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

export function formatDraftBody(body: DraftBody, evidence: readonly BodyTextView[], version: number): string {  const lines = [
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
