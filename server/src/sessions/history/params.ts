import { z } from 'zod'
import { validHistoryRegex } from './regex'

const id = z.string().min(1).max(256)
const text = z.string().refine(v => v.trim().length > 0 && [...v].length <= 1024, '需要非空文本（最多1024码点）')
const timePoint = z.string().datetime({ offset: true })
const time = z.object({
  field: z.enum(['message_created_at', 'session_created_at']).default('message_created_at'),
  from: timePoint.optional(), to: timePoint.optional(),
}).strict().refine(v => v.from !== undefined || v.to !== undefined, '至少指定一个时间边界')
  .refine(v => !v.from || !v.to || Date.parse(v.from) < Date.parse(v.to), 'from 必须早于 to')
const range = z.object({ from_turn: z.number().int().min(1).optional(), to_turn: z.number().int().min(1).optional() })
  .strict().refine(v => v.from_turn !== undefined || v.to_turn !== undefined, '至少指定一个消息边界')
  .refine(v => v.from_turn === undefined || v.to_turn === undefined || v.from_turn <= v.to_turn, '消息范围倒置')

export const HISTORY_FIELDS = ['user_content', 'assistant_content', 'tool_name', 'tool_input', 'tool_result', 'thinking'] as const
export const HistorySearchSchema = z.object({
  operation: z.literal('search'),
  session_ids: z.array(id).min(1).max(20).optional(),
  title: text.optional(), time: time.optional(),
  query: z.object({ text, mode: z.enum(['literal', 'regex']).default('literal') }).strict().optional(),
  case_sensitive: z.boolean().default(false),
  fields: z.array(z.enum(HISTORY_FIELDS)).min(1).optional(),
  context: z.object({ before: z.number().int().min(0).max(5).default(1), after: z.number().int().min(0).max(5).default(1) }).strict().optional(),
  cursor: z.string().min(1).optional(),
}).strict()
export const HistoryReadSchema = z.object({
  operation: z.literal('read'),
  targets: z.array(z.object({ session_id: id, range: range.optional() }).strict()).min(1).max(20),
  cursor: z.string().min(1).optional(),
}).strict()
export const SessionHistorySchema = z.discriminatedUnion('operation', [HistorySearchSchema, HistoryReadSchema])
  .superRefine((v, ctx) => {
    if (v.operation === 'search' && !v.query && (v.fields !== undefined || v.context !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '目录搜索不接受 fields/context' })
    }
    if (v.operation === 'search' && v.query?.mode === 'regex' && !validHistoryRegex(v.query.text)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '不支持的正则语法或超出正则长度限制' })
    }
  })
export type HistoryRequest = z.infer<typeof SessionHistorySchema>
