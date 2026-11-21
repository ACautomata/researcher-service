// reflection_records 工具 schema（#1080 · RF-T04）。白名单字段 + strict（未知字段拒绝）。
// 身份/角色/会话/预算只来自执行上下文，schema 不接收任何可覆盖身份的字段。

import { z } from 'zod'
import {
  REFLECTION_CATEGORIES,
  REFLECTION_DRAFT_STATUSES,
  REFLECTION_LIMITS,
  REFLECTION_REGIONS,
} from './values'

const id = z.string().min(1).max(128)
const text = z.string().min(1).max(REFLECTION_LIMITS.bodyBytes)

const evidence = z.object({
  session_id: id.optional(),
  message_id: id.optional(),
  run_id: z.string().min(1).max(128).optional(),
  tool_call_id: z.string().min(1).max(256).optional(),
  region: z.enum(REFLECTION_REGIONS),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional(),
  excerpt: z.string().min(1),
}).strict().superRefine((v, ctx) => {
  if (v.start !== undefined && v.end !== undefined && v.end < v.start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '证据范围倒置' })
  }
  if (v.region === 'tool_result' && v.tool_call_id === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool_result 证据必须带 tool_call_id' })
  }
  if (v.message_id === undefined && v.run_id === undefined && v.session_id === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '证据缺少来源定位（message_id/run_id/session_id）' })
  }
})

const cause = z.object({
  text,
  kind: z.enum(['fact', 'inference']).default('inference'),
  evidence: z.array(z.number().int().min(1).max(REFLECTION_LIMITS.evidencePerDraft)).max(REFLECTION_LIMITS.evidencePerDraft).default([]),
}).strict()

const scope = z.object({
  labels: z.array(z.string().min(1).max(REFLECTION_LIMITS.scopeLabelCodePoints)).max(REFLECTION_LIMITS.scopeLabels).default([]),
  conditions: z.string().max(REFLECTION_LIMITS.bodyBytes).default(''),
  exclusions: z.string().max(REFLECTION_LIMITS.bodyBytes).default(''),
}).strict()

const DraftContent = {
  category: z.enum(REFLECTION_CATEGORIES),
  title: z.string().min(1).max(REFLECTION_LIMITS.titleCodePoints),
  problem: text,
  causes: z.array(cause).min(1).max(REFLECTION_LIMITS.causesPerDraft),
  improvements: z.array(text).min(1).max(REFLECTION_LIMITS.improvementsPerDraft),
  scope,
  evidence: z.array(evidence).min(1).max(REFLECTION_LIMITS.evidencePerDraft),
}

export const ReflectionSearchSchema = z.object({
  operation: z.literal('search'),
  purpose: z.enum(['experience', 'management']).default('experience'),
  query: z.string().max(256).optional(),
  category: z.enum(REFLECTION_CATEGORIES).optional(),
  scope: z.array(z.string().min(1).max(REFLECTION_LIMITS.scopeLabelCodePoints)).max(REFLECTION_LIMITS.scopeLabels).optional(),
  state: z.enum(REFLECTION_DRAFT_STATUSES).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.query !== undefined && v.query.trim() === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '空白 query 不是目录查询' })
  }
  if (v.purpose === 'experience' && v.state !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'experience 检索不接受草稿状态' })
  }
})

const readTarget = z.union([
  z.object({ draft_id: id, version: z.number().int().min(1).optional() }).strict(),
  // #1084（RF-T08）：正式记录管理读取（待复核结论与有效来源仍可查看）。
  z.object({ record_id: id, version: z.number().int().min(1).optional() }).strict(),
])

export const ReflectionReadSchema = z.object({
  operation: z.literal('read'),
  purpose: z.enum(['experience', 'management']).default('experience'),
  targets: z.array(readTarget).min(1).max(5),
}).strict()

export const ReflectionDraftSchema = z.object({
  operation: z.literal('draft'),
  action: z.enum(['create', 'revise']),
  draft_id: id.optional(),
  base_version: z.number().int().min(1).optional(),
  ...DraftContent,
}).strict().superRefine((v, ctx) => {
  if (v.action === 'create' && v.draft_id !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'create 不接受 draft_id' })
  }
  if (v.action === 'revise' && (v.draft_id === undefined || v.base_version === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'revise 需要 draft_id 与 base_version' })
  }
})

export const ReflectionPresentSchema = z.object({
  operation: z.literal('present'),
  draft_id: id,
  version: z.number().int().min(1),
}).strict()

export const ReflectionCommitSchema = z.object({
  operation: z.literal('commit'),
  draft_id: id,
  version: z.number().int().min(1),
}).strict()

export const ReflectionCancelSchema = z.object({
  operation: z.literal('cancel'),
  draft_id: id,
  version: z.number().int().min(1).optional(),
}).strict()

// 成员含 superRefine（ZodEffects），故用 z.union 而非 discriminatedUnion（后者只收 ZodObject）；
// service 内按 operation 分派并保证互斥。
export const ReflectionRecordsSchema = z.union([
  ReflectionSearchSchema,
  ReflectionReadSchema,
  ReflectionDraftSchema,
  ReflectionPresentSchema,
  ReflectionCommitSchema,
  ReflectionCancelSchema,
])

export type ReflectionRequest = z.infer<typeof ReflectionRecordsSchema>

// 展示 ack / 读取 REST 请求体（窄协议端点；#312 信封 + zod 单一来源）。
export const reflectionAckSchema = z.object({
  version: z.number().int().min(1),
  hash: z.string().min(16).max(128),
  messageId: z.string().min(1).max(128),
}).strict()
