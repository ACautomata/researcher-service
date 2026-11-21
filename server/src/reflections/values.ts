// reflections 域常量（#1080 · RF-T04）。单一来源：zod schema、内容校验、服务与适配器共用。
//
// 父规格 I3/I4/I5/I6/I7 的固定值在此钉死；任何调整须维持行为与门禁不变。

export const REFLECTION_TOOL_NAME = 'reflection_records'

export const REFLECTION_CATEGORIES = [
  'understanding',
  'planning',
  'tool_use',
  'verification',
  'efficiency',
  'information_access',
  'other',
] as const
export type ReflectionCategory = (typeof REFLECTION_CATEGORIES)[number]

// 五部分展示用的中文类别标签（其他文案由前端呈现，服务端只给机器值 + 标签）。
export const REFLECTION_CATEGORY_LABELS: Record<ReflectionCategory, string> = {
  understanding: '需求理解',
  planning: '计划',
  tool_use: '工具使用',
  verification: '验证',
  efficiency: '效率',
  information_access: '信息获取',
  other: '其他',
}

// 草稿状态机（父规格 I3；本票只写出 preparing / pending / cancelled，其余归 #1081+）。
export const REFLECTION_DRAFT_STATUSES = [
  'preparing',
  'pending',
  'confirmed_pending_save',
  'committed',
  'rejected',
  'expired',
  'cancelled',
] as const
export type ReflectionDraftStatus = (typeof REFLECTION_DRAFT_STATUSES)[number]

// 证据状态：preparing（在飞待落行）| valid（服务端已核验）| not_ready（截断外/摘要/未解析/
// 来源变化或删除）。#1084：来源失效原因进入 not_ready，读门据此封锁摘录。
export const REFLECTION_EVIDENCE_STATUSES = ['preparing', 'valid', 'not_ready'] as const
export type ReflectionEvidenceStatus = (typeof REFLECTION_EVIDENCE_STATUSES)[number]

// #1084（RF-T08）：来源失效原因——业务写入/读门与 prisma/reflection-triggers.sql 中的
// 字面值保持同步（触发器 SQL 无法引用 TS 常量，改动须两处一致）。这些原因的证据摘录与
// 正文中逐字复制的来源片段都不得再交付（读门同步封锁，outbox 负责物理清理）。
export const REFLECTION_SOURCE_INVALID_REASONS = [
  'source_changed',
  'source_deleted',
  'source_unavailable',
] as const
export type ReflectionSourceInvalidReason = (typeof REFLECTION_SOURCE_INVALID_REASONS)[number]

export const REFLECTION_INVALID_EXCERPT_PLACEHOLDER = '[来源已失效，待复核]'
export const REFLECTION_INVALID_FRAGMENT_PLACEHOLDER = '[来源已失效]'

// #1084：来源失效清理器的启动/周期参数（父规格：TTL/清理每分钟）。
export const REFLECTION_CLEANUP_INTERVAL_MS = 60_000
export const REFLECTION_CLEANUP_BATCH_SIZE = 50

// 展示状态（父规格 I5/I7）：active 待 ack | acked 已完整渲染 | revoked 被新版本替代 |
// expired 过窗 | deleted 专属正文已清理（只留占位）。
export const REFLECTION_PRESENTATION_STATUSES = ['active', 'acked', 'revoked', 'expired', 'deleted'] as const
export type ReflectionPresentationStatus = (typeof REFLECTION_PRESENTATION_STATUSES)[number]

export const REFLECTION_REGIONS = ['content', 'thinking', 'tool_result'] as const
export type ReflectionRegion = (typeof REFLECTION_REGIONS)[number]

// 正式记录生命周期（I3）：主动使用仅 active+valid；management 可读其余状态。
export const REFLECTION_RECORD_STATUSES = ['active', 'inactive', 'superseded', 'deleted'] as const
export type ReflectionRecordStatus = (typeof REFLECTION_RECORD_STATUSES)[number]

export const REFLECTION_EVIDENCE_STATES = ['valid', 'review_required'] as const
export type ReflectionEvidenceState = (typeof REFLECTION_EVIDENCE_STATES)[number]

// 记录检索固定上限（父规格 I6 / RF-T06）。
export const REFLECTION_RETRIEVAL = {
  pageDefault: 20,
  pageMax: 50,
  queryCodePoints: 256,
  queryWords: 8,
  readTargets: 5,
  cursorTtlMs: 10 * 60_000,
  cursorsPerUser: 4,
  cursorsGlobal: 64,
  cursorStateBytes: 256 * 1024,
  budgetCalls: 20,
  budgetWaitMs: 10_000,
  budgetBytes: 256 * 1024,
  cooperativeMs: 2_000,
  callBytes: 64 * 1024,
  evidenceVerificationsPerCall: 128,
  // 固定快照上限：超出即 stopped 并指引缩小查询，不静默让后半永不可读。
  snapshotRecords: 2000,
} as const

// 自然语言确认的 6 类结构化结果（#1081 · RF-T05）：分类器、schema 与业务共用单一来源。
export const REFLECTION_CONFIRMATION_DECISIONS = [
  'confirm',
  'reject',
  'revise',
  'withdraw',
  'unrelated',
  'ambiguous',
] as const
export type ReflectionConfirmationDecision = (typeof REFLECTION_CONFIRMATION_DECISIONS)[number]

export const REFLECTION_LIMITS = {
  titleCodePoints: 256,
  bodyBytes: 32 * 1024,
  evidencePerDraft: 8,
  excerptBytes: 1024,
  causesPerDraft: 16,
  improvementsPerDraft: 16,
  scopeLabels: 8,
  scopeLabelCodePoints: 64,
  // 展示正文可达 32KiB（不依赖工具 details 的 4KiB 截断）。
} as const

// 展示引用标记：工具输出/checkpoint 只存引用；模型调用边界按该标记临时解引用正文。
export const REFLECTION_BODY_REF_PREFIX = 'reflection_display:'
export const reflectionBodyRef = (displayId: string): string => `${REFLECTION_BODY_REF_PREFIX}${displayId}`
export const REFLECTION_BODY_REF_RE = /reflection_display:([A-Za-z0-9_-]{6,64})/g
// 草稿正文引用（management read）：同样只存引用，模型调用边界临时展开。
export const REFLECTION_DRAFT_REF_PREFIX = 'reflection_draft:'
export const reflectionDraftRef = (draftId: string, version: number): string => `${REFLECTION_DRAFT_REF_PREFIX}${draftId}:${version}`
export const REFLECTION_DRAFT_REF_RE = /reflection_draft:([A-Za-z0-9_-]{6,64}):(\d{1,9})/g
// 正式记录正文引用（#1084 management/experience read）：工具输出不落完整正文，边界处临时展开。
export const REFLECTION_RECORD_REF_PREFIX = 'reflection_record:'
export const reflectionRecordRef = (recordId: string, version: number): string => `${REFLECTION_RECORD_REF_PREFIX}${recordId}:${version}`
export const REFLECTION_RECORD_REF_RE = /reflection_record:([A-Za-z0-9_-]{6,64}):(\d{1,9})/g

// 常见凭证/token 形态（父规格 I7：疑似敏感不入正文；未知秘密不宣称 100% 识别）。
export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*[^\s"'`]{8,}/gi,
] as const

export const SENSITIVE_PLACEHOLDER = '[已脱敏：疑似凭证]'
