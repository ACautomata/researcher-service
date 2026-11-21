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

// 证据状态：preparing（在飞待落行）| valid（服务端已核验）| not_ready（截断外/摘要/未解析）。
export const REFLECTION_EVIDENCE_STATUSES = ['preparing', 'valid', 'not_ready'] as const
export type ReflectionEvidenceStatus = (typeof REFLECTION_EVIDENCE_STATUSES)[number]

// 展示状态（父规格 I5/I7）：active 待 ack | acked 已完整渲染 | revoked 被新版本替代 |
// expired 过窗 | deleted 专属正文已清理（只留占位）。
export const REFLECTION_PRESENTATION_STATUSES = ['active', 'acked', 'revoked', 'expired', 'deleted'] as const
export type ReflectionPresentationStatus = (typeof REFLECTION_PRESENTATION_STATUSES)[number]

export const REFLECTION_REGIONS = ['content', 'thinking', 'tool_result'] as const
export type ReflectionRegion = (typeof REFLECTION_REGIONS)[number]

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
