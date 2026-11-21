// reflections 业务内层模型（#1080 · RF-T04）：不依赖 Express / Prisma / LangGraph / SQLite 驱动。
//
// 公共业务口 = execute(context, request, signal)。所有身份/预算来自可信 context，模型参数
// 不得覆盖 owner、角色或当前会话。

import {
  REFLECTION_CONFIRMATION_DECISIONS,
  type ReflectionCategory,
  type ReflectionDraftStatus,
  type ReflectionEvidenceStatus,
  type ReflectionPresentationStatus,
  type ReflectionRegion,
} from './values'

export interface ReflectionContext {
  readonly ownerId: string
  readonly currentSessionId: string
  readonly role: 'leader' | 'teammate' | 'wiki-update' | 'subagent'
  /** 当前主请求 run 身份：在飞证据（当前轮 assistant 行尚未落库）临时定位用。 */
  readonly runId?: string
  /** 可信触发用户消息行 id（稳定主请求身份）：确认授权与幂等提交只认这一条。 */
  readonly triggerMessageId?: string
  /** 记录检索主请求额度身份（= 可信 triggerMessageId；缺失即停止增强，不重发额度）。 */
  readonly requestId?: string
  /** 可信用户管理意图（由服务端从真实用户消息判定，不由模型 purpose 参数授予）。 */
  readonly managementIntent?: boolean
}

// ---- 内容（五部分）----

export interface EvidenceInput {
  readonly session_id?: string
  readonly message_id?: string
  readonly run_id?: string
  readonly tool_call_id?: string
  readonly region: ReflectionRegion
  /** Unicode 码点范围（可选；服务端核验，不信任模型自填）。 */
  readonly start?: number
  readonly end?: number
  /** 模型给出的原始摘录：只用于服务端核验，不落库。 */
  readonly excerpt: string
  /** 脱敏后的摘录（展示/持久面）；缺省 = 与 excerpt 相同。 */
  readonly displayExcerpt?: string
}

export interface CauseAnalysis {
  readonly text: string
  /** fact = 有原始证据支持；inference = 推测（展示必须明确区分）。 */
  readonly kind: 'fact' | 'inference'
  /** 关联 evidence 位置（1 起，对应 evidence 数组）。 */
  readonly evidence: number[]
}

export interface DraftScope {
  readonly labels: string[]
  readonly conditions: string
  readonly exclusions: string
}

export interface DraftBody {
  readonly title: string
  readonly category: ReflectionCategory
  readonly problem: string
  readonly causes: CauseAnalysis[]
  readonly improvements: string[]
  readonly scope: DraftScope
}

// ---- 证据（服务端核验后的存储形状）----

export interface EvidenceRecord {
  readonly position: number
  readonly sessionId: string
  readonly messageId: string | null
  readonly runId: string | null
  readonly toolCallId: string | null
  readonly region: ReflectionRegion
  readonly startCp: number | null
  readonly endCp: number | null
  readonly excerpt: string
  readonly regionHash: string | null
  readonly contentVersion: string | null
  readonly status: ReflectionEvidenceStatus
  readonly reason?: string
}

export interface EvidenceSource {
  readonly sessionId: string
  readonly messageId: string
  readonly region: ReflectionRegion
  readonly regionText: string
  readonly contentVersion: string
  readonly truncated: boolean
  readonly visible: boolean
  /** false = 该区域未持久化（如 thinking 未保存 / 工具行缺失）——标 not_ready 而非伪核验。 */
  readonly regionPresent: boolean
}

// ---- 草稿 / 展示 ----

export interface DraftRecord {
  readonly id: string
  readonly ownerId: string
  readonly sessionId: string
  readonly version: number
  readonly status: ReflectionDraftStatus
  readonly action: string
  readonly body: DraftBody
  readonly evidence: readonly EvidenceRecord[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PresentationRecord {
  readonly displayId: string
  readonly ownerId: string
  readonly sessionId: string
  readonly draftId: string
  readonly draftVersion: number
  readonly action: string
  readonly body: DraftBody
  readonly evidence: readonly EvidenceRecord[]
  readonly bodyHash: string
  readonly status: ReflectionPresentationStatus
  readonly messageId: string | null
  readonly createdAt: string
}

// 展示引用（TurnSnapshot / attachmentsJson / 前端投影的持久形状——只装引用不装正文）。
export interface PresentationRef {
  readonly displayId: string
  readonly draftId: string
  readonly version: number
  readonly bodyHash: string
  readonly status: ReflectionDraftStatus
  readonly confirmable: boolean
}

// ---- 确认授权（#1081 · RF-T05）----

export type ConfirmationDecision = (typeof REFLECTION_CONFIRMATION_DECISIONS)[number]

// 服务端生成的唯一动作快照（分类器只读它，不接收模型可自填的 approved/grant/token）。
export interface ConfirmationActionSnapshot {
  readonly displayId: string
  readonly draftId: string
  readonly version: number
  readonly bodyHash: string
  readonly action: string
  readonly title: string
  readonly category: string
  readonly evidenceCount: number
}

export interface ConfirmationClassifierInput {
  /** 真实 triggerMessageId 的原文（服务端从库读取，不采用 run 命令副本）。 */
  readonly userText: string
  /** 至多前 2 条真实用户消息（辅助指代；不含触发消息）。 */
  readonly previousUserMessages: readonly string[]
  readonly action: ConfirmationActionSnapshot
}

export interface ConfirmationClassification {
  readonly decision: ConfirmationDecision
  readonly reason?: string
}

export type ConfirmationClassifier = (
  input: ConfirmationClassifierInput,
  signal?: AbortSignal,
) => Promise<ConfirmationClassification>

export interface ConfirmationTurnOutcome {
  readonly status:
    | 'skipped'
    | 'granted'
    | 'ambiguous'
    | 'rejected'
    | 'revise'
    | 'withdrawn'
    | 'unrelated'
    | 'classifier_unavailable'
  readonly decision?: ConfirmationDecision
  readonly grantId?: string
  readonly displayId?: string
  readonly draftId?: string
  readonly version?: number
  readonly reason?: string
}

export interface ReflectionTriggerMessage {
  readonly id: string
  readonly turn: number
  readonly content: string
}

export interface ConfirmationCandidate {
  readonly presentation: PresentationRecord
  readonly draft: DraftRecord
}

export interface GrantRecord {
  readonly id: string
  readonly ownerId: string
  readonly sessionId: string
  readonly confirmationMessageId: string
  readonly displayId: string
  readonly draftId: string
  readonly draftVersion: number
  readonly bodyHash: string
  readonly action: string
  readonly ackSeq: number
  readonly expiresAt: string
  readonly submissions: number
  readonly status: 'active' | 'consumed' | 'revoked' | 'expired'
}

export interface CommitResult {
  readonly recordId: string
  readonly revision: number
  readonly title: string
  readonly category: string
  readonly status: string
  readonly evidenceStatus: string
}

export type CommitOutcome =
  | { readonly result: CommitResult; readonly idempotent: boolean }
  | { readonly error: 'not_found' | 'revoked' | 'expired' | 'limit' | 'conflict' }

// ---- 记录检索（#1082・RF-T06）----

export type ReflectionPurpose = 'experience' | 'management'

export interface RecordSummary {
  readonly record_id: string
  readonly version: number
  readonly title: string
  readonly category: string
  readonly scope_labels: readonly string[]
  readonly status: string
  readonly evidence_status: string
  readonly updated_at: string
}

export interface RecordTargetResult {
  readonly record_id?: string
  readonly draft_id?: string
  readonly status: string
  readonly version?: number
  readonly is_current?: boolean
  readonly title?: string
  readonly category?: string
  readonly scope_labels?: readonly string[]
  readonly record_status?: string
  readonly evidence_status?: string
  readonly updated_at?: string
  readonly body_ref?: string
  readonly expected_version?: number
  readonly actual_version?: number
  readonly evidence?: readonly Record<string, unknown>[]
  readonly evidence_omitted?: boolean
}

// ---- 记录检索端口（#1082・RF-T06；内层只依赖本接口，SQLite/子进程在外层适配）----

export interface RecordSearchCriteria {
  readonly words: readonly string[]
  readonly labels: readonly string[]
  readonly category?: string
  readonly states: readonly string[]
  readonly evidenceStatuses: readonly string[]
  readonly maxRecords: number
}

export interface ReflectionRecordRead {
  readonly record_id: string
  readonly status: 'ok' | 'not_found' | 'unreadable' | 'conflict' | 'deleted'
  readonly expected_version?: number
  readonly actual_version?: number
  readonly version?: number
  readonly is_current?: boolean
  readonly title?: string
  readonly category?: string
  readonly scope_labels?: string[]
  readonly record_status?: string
  readonly evidence_status?: string
  readonly updated_at?: string
  readonly body_json?: string
  readonly body_hash?: string
  readonly evidence?: readonly Record<string, unknown>[]
}

export interface ReflectionQueryLease {
  search(ownerId: string, criteria: RecordSearchCriteria, options?: { signal?: AbortSignal; hardMs?: number }): Promise<{ records: RecordSummary[]; limited: boolean }>
  versions(ownerId: string, ids: readonly string[], options?: { signal?: AbortSignal; hardMs?: number }): Promise<RecordSummary[]>
  read(ownerId: string, targets: readonly { record_id: string; version?: number }[], experience: boolean, options?: { signal?: AbortSignal; hardMs?: number }): Promise<ReflectionRecordRead[]>
  release(): void
}

export interface ReflectionQueryPort {
  lease(ownerId: string): ReflectionQueryLease | undefined
  probeBusy(durationMs: number, options?: { cooperativeMs?: number; hardMs?: number; signal?: AbortSignal }): Promise<void>
  probeReadOnly(): Promise<boolean>
  dispose(): void
}

// 主请求额度（I6）：新记录工具独立 20 次 / 累计等待 10 秒 / 累计返回 256KiB。
export interface ReflectionBudgetRequest {
  readonly ownerId: string
  readonly sessionId: string
  readonly requestId: string
}

export interface ReflectionBudgetLimits {
  readonly calls: number
  readonly waitMs: number
  readonly bytes: number
}

export interface ReflectionBudgetReservation {
  readonly allowed: boolean
  readonly reason?: 'calls' | 'wait' | 'bytes' | 'unrecoverable'
  readonly remainingBytes: number
  readonly remainingWaitMs: number
}

export interface ReflectionBudgetStore {
  reserve(request: ReflectionBudgetRequest, limits: ReflectionBudgetLimits): Promise<ReflectionBudgetReservation>
  settle(request: ReflectionBudgetRequest, usage: { bytes: number; waitedMs: number }): Promise<void>
  /** 正文临时解引用计量：不超上限才计入并展开。 */
  settleBytes(request: ReflectionBudgetRequest, bytes: number, limit: number): Promise<{ allowed: boolean; remaining: number }>
}

// ---- 端口 ----

// 可信当前证据端口：只读本人当前主线程已持久产品投影；在飞目标由 recordTurn 统一补稳定引用。
export interface ReflectionEvidencePort {
  /** 读取一条已持久的产品投影消息（owner 归属 + 可见性复核）。缺失/越权一律 null。 */
  read(context: ReflectionContext, sessionId: string, messageId: string): Promise<EvidenceSource | null>
  /** 读取指定区域（content/thinking/tool_result）；区域未持久化时 regionPresent=false。 */
  readRegion(
    context: ReflectionContext,
    sessionId: string,
    messageId: string,
    region: ReflectionRegion,
    toolCallId?: string,
  ): Promise<EvidenceSource | null>
}

export interface ReflectionStore {
  createDraft(p: {
    ownerId: string
    sessionId: string
    body: DraftBody
    evidence: readonly EvidenceRecord[]
    status: ReflectionDraftStatus
    action: string
  }): Promise<DraftRecord>
  getDraft(ownerId: string, draftId: string): Promise<DraftRecord | null>
  reviseDraft(p: {
    ownerId: string
    draftId: string
    baseVersion: number
    body: DraftBody
    evidence: readonly EvidenceRecord[]
    status: ReflectionDraftStatus
  }): Promise<DraftRecord | null>
  cancelDraft(ownerId: string, draftId: string): Promise<DraftRecord | null>
  listDrafts(ownerId: string, options: { state?: ReflectionDraftStatus; limit: number }): Promise<DraftRecord[]>
  createPresentation(p: {
    ownerId: string
    sessionId: string
    draft: DraftRecord
    body: DraftBody
    evidence: readonly EvidenceRecord[]
    bodyJson: string
    bodyHash: string
    action: string
  }): Promise<PresentationRecord>
  /** 撤销该草稿所有 active 展示（新版本/重新 present 时）。 */
  revokePresentations(ownerId: string, draftId: string): Promise<void>
  /** 来源核验失败：该版本证据全部标 not_ready、草稿回 preparing（展示/提交需重新起草）。 */
  invalidateVersion(ownerId: string, draftId: string, version: number, reason: string): Promise<void>
  getPresentation(ownerId: string, displayId: string): Promise<PresentationRecord | null>
  /** recordTurn 统一接缝：绑定终态 assistant messageId 并解析在飞证据。 */
  bindInFlightEvidence(p: {
    ownerId: string
    sessionId: string
    runId: string
    messageId: string
    displayIds?: readonly string[]
  }): Promise<void>
  ackPresentation(p: {
    ownerId: string
    displayId: string
    version: number
    bodyHash: string
    messageId: string
  }): Promise<{ seq: number; ackedAt: string } | { error: 'not_found' | 'conflict' | 'not_ready' }>

  // ---- 确认授权（#1081 · RF-T05）----

  /** 可信 triggerMessageId 行（本人当前会话、user 角色、未归档）。 */
  getTriggerMessage(ownerId: string, sessionId: string, messageId: string): Promise<ReflectionTriggerMessage | null>
  /** 当前会话内可确认候选（acked、绑定终态 assistant 行、草稿 pending、证据全部 valid）。 */
  confirmationCandidates(ownerId: string, sessionId: string, beforeTurn: number): Promise<ConfirmationCandidate[]>
  /** 确认消息之前的至多 limit 条真实用户消息（时间升序）。 */
  recentUserMessages(ownerId: string, sessionId: string, beforeTurn: number, limit: number): Promise<string[]>
  /**
   * 短事务 CAS 签发授权：确认展示仍未变化、草稿仍 pending、证据全部 valid，
   * 同事务写最小事件；任一不符整体 null（无部分授权）。
   */
  issueGrant(p: {
    ownerId: string
    sessionId: string
    confirmationMessageId: string
    /** 确认消息 turn（服务端单调序：必须晚于展示 ack 时刻）。 */
    confirmationTurn: number
    candidate: ConfirmationCandidate
    expiresAt: Date
  }): Promise<GrantRecord | null>
  /**
   * 一事务消费 grant + 写 record/revision + 最小事件 + 幂等结果。
   * 失败尝试的提交计数随事务提交；事件写失败抛错整笔回滚。
   */
  commitGrant(p: {
    ownerId: string
    confirmationMessageId: string
    draftId: string
    draftVersion: number
    now: Date
  }): Promise<CommitOutcome>
  /**
   * 用户对候选说 reject/revise/withdraw：撤销未消费授权与展示；
   * reject 关闭草稿，revise/withdraw 回 pending（需重新展示后再次确认）。
   */
  applyDecision(p: {
    ownerId: string
    draftId: string
    decision: 'reject' | 'revise' | 'withdraw'
    now: Date
  }): Promise<void>
  /** 证据/版本失效时撤销该草稿的未消费授权（已消费的不动）。 */
  revokeActiveGrants(ownerId: string, draftId: string): Promise<void>
}

// ---- 结果 ----

export type ReflectionErrorCode =
  | 'leader_only'
  | 'invalid_parameters'
  | 'invalid_evidence'
  | 'evidence_mismatch'
  | 'sensitive_content'
  | 'not_found'
  | 'not_ready'
  | 'confirmation_required'
  | 'expired'
  | 'revoked'
  | 'conflict'
  | 'limit'
  | 'busy'
  | 'cursor_stale'
  | 'unreadable'
  | 'cancelled'
  | 'system_error'

export interface ReflectionError {
  readonly category: 'permission' | 'parameter' | 'conflict' | 'limit' | 'system'
  readonly code: ReflectionErrorCode
  readonly message: string
}

export interface ReflectionResult {
  readonly outcome: 'success' | 'partial_success' | 'failure'
  readonly progress: 'complete' | 'more' | 'stopped'
  readonly operation: string
  readonly draft?: unknown
  readonly presentation?: unknown
  readonly drafts?: unknown
  readonly records?: unknown
  readonly record?: unknown
  readonly count?: number
  readonly purpose?: string
  readonly confirmable?: boolean
  readonly not_confirmable_reason?: string
  readonly redactions?: number
  readonly status?: string
  readonly cursor?: string
  readonly cursor_expires_at?: string
  readonly error?: ReflectionError
  readonly guidance?: string
}
