// reflections 业务内层模型（#1080 · RF-T04）：不依赖 Express / Prisma / LangGraph / SQLite 驱动。
//
// 公共业务口 = execute(context, request, signal)。所有身份/预算来自可信 context，模型参数
// 不得覆盖 owner、角色或当前会话。

import type {
  ReflectionCategory,
  ReflectionDraftStatus,
  ReflectionEvidenceStatus,
  ReflectionPresentationStatus,
  ReflectionRegion,
} from './values'

export interface ReflectionContext {
  readonly ownerId: string
  readonly currentSessionId: string
  readonly role: 'leader' | 'teammate' | 'wiki-update' | 'subagent'
  /** 当前主请求 run 身份：在飞证据（当前轮 assistant 行尚未落库）临时定位用。 */
  readonly runId?: string
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
  /** 该草稿最近一次展示（commit 前置：有展示、已绑定终态消息、已 ack）。 */
  latestPresentation(ownerId: string, draftId: string): Promise<PresentationRecord | null>
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
  | 'conflict'
  | 'limit'
  | 'cancelled'
  | 'system_error'

export interface ReflectionError {
  readonly category: 'permission' | 'parameter' | 'conflict' | 'limit' | 'system'
  readonly code: ReflectionErrorCode
  readonly message: string
}

export interface ReflectionResult {
  readonly outcome: 'success' | 'partial_success' | 'failure'
  readonly progress: 'complete' | 'stopped'
  readonly operation: string
  readonly draft?: unknown
  readonly presentation?: unknown
  readonly drafts?: unknown
  readonly records?: unknown
  readonly count?: number
  readonly purpose?: string
  readonly confirmable?: boolean
  readonly not_confirmable_reason?: string
  readonly redactions?: number
  readonly status?: string
  readonly error?: ReflectionError
  readonly guidance?: string
}
