import { z } from 'zod'
import {
  MODEL_INPUT_MODALITIES,
  PROVIDER_ID_REGEX,
} from '../models/values'
import { PRESET_IDS, RESERVED_PROVIDER_IDS } from '../models/presets'
import { MESSAGE_CONTENT_MAX, REWIND_SCOPES, TITLE_MAX } from '../sessions/values'

// 请求体 schema（zod）。校验失败 → 90002 + flatten().fieldErrors（{field:[errors]}）。
// username 格式：字母/数字/下划线/连字符，3–30 字符（近似 Django UnicodeUsernameValidator，更严）。
export const USERNAME_REGEX = /^[A-Za-z0-9_-]{3,30}$/
// bcryptjs 截断 >72 字节的输入（72 字节后丢弃）。若不对密码设 UTF-8 字节上限，首 72 字节
// 相同而后续不同的两个密码可互登（碰撞面）。共享此校验：login / 建号 / 改密一律拒绝 >72 字节。
// Codex #342 四轮 P2。
const BYTE72_MAX = 72
const BYTE72_ERR = `密码不能超过 ${BYTE72_MAX} 字节`

function max72Bytes(v: string): boolean {
  return Buffer.byteLength(v, 'utf8') <= BYTE72_MAX
}

export const loginSchema = z.object({
  username: z.string().min(1, '不能为空'),
  password: z.string().min(1, '不能为空').refine(max72Bytes, BYTE72_ERR),
})

export const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1, '不能为空').refine(max72Bytes, BYTE72_ERR),
  newPassword: z.string().min(8, '至少 8 个字符').refine(max72Bytes, BYTE72_ERR),
})

// 建账号（admin register / users POST 共用）：用户名格式 + 密码≥8 + 可选 email + 可选配额。
export const userCreateSchema = z.object({
  username: z.string().regex(USERNAME_REGEX, '用户名仅允许字母、数字、下划线、连字符（3-30 位）'),
  password: z.string().min(8, '至少 8 个字符').refine(max72Bytes, BYTE72_ERR),
  email: z.string().email('email 格式非法').optional(),
  maxContainers: z.number().int().optional(),
})

// 改账号（users PATCH）：可改 active / 配额（容器数 + 在飞 run 并发，#800 admin 运营面）。
export const userPatchSchema = z.object({
  isActive: z.boolean().optional(),
  maxContainers: z.number().int().optional(),
  maxConcurrentRuns: z.number().int().optional(),
})

// 容器名 DNS-label（#334 / 平移 NAME_VALIDATOR）：小写字母开头，3–30 位，仅 [a-z0-9-]。
// 防路径分隔符 / .. / 空格 / 大写（docker-name / 会话 id 路径参数注入）。#858 起唯一消费方 =
// files 路由 requireName（lab 面路径参数 <name> = sessionId 的形状校验）；建容器 schema 随
// 容器 CRUD 退役删除。
export const CONTAINER_NAME_REGEX = /^[a-z][a-z0-9-]{2,29}$/

// 建/改 LLM 端点（BYOK，#881 预设制）：preset_id 锁定协议与地址（无自由 baseURL 输入），
// api_key 明文只在写请求出现（POST 缺省/空 = 平台共享 key；PUT 缺省/空 = 保持不变），
// models 至少一条且每条含非空 id。models 条目形状校验（#366 先例）：已知字段类型严格校验
//（name/reasoning/input/cost/contextWindow/maxTokens），未知扩展字段 passthrough 透传。
// provider_id 保留域（'platform'）写侧拒绝——防与平台虚拟条目同 id 歧义。
// 校验失败 → 90002 + 各字段明细。
export const modelProviderWriteSchema = z.object({
  provider_id: z
    .string()
    .regex(PROVIDER_ID_REGEX, 'provider_id 须以小写字母开头，1–64 位，仅含小写字母、数字、连字符')
    .refine((v) => !RESERVED_PROVIDER_IDS.has(v), 'provider_id 为保留 id，不可使用'),
  preset_id: z.enum(PRESET_IDS as [string, ...string[]], {
    errorMap: () => ({ message: `preset_id 须为端点预设之一（${PRESET_IDS.join(' | ')}）` }),
  }),
  // 明文 key 单向流：写请求可带，落库即密文；空串/缺省语义按 POST/PUT 区分（service 层）。
  api_key: z.string().max(4096, 'api_key 过长').optional(),
  models: z
    .array(
      z
        .object({
          id: z.string().min(1, '每条 model 须含非空 id'),
          name: z.string().optional(),
          reasoning: z.boolean().optional(),
          input: z.array(z.enum(MODEL_INPUT_MODALITIES)).optional(),
          cost: z
            .object({
              input: z.number(),
              output: z.number(),
              cacheRead: z.number(),
              cacheWrite: z.number(),
            })
            .optional(),
          contextWindow: z.number().optional(),
          maxTokens: z.number().optional(),
        })
        .passthrough(), // 未知扩展字段透传（前端表单收集的其余字段原样保留）
    )
    .min(1, '须至少一条 model（用于派生默认模型引用）')
    .refine(
      (models) => new Set(models.map((m) => String(m.id))).size === models.length,
      { message: '同 provider 内 model id 须唯一', path: ['models'] },
    ),
})

// ---------------------------------------------------------------------------
// 会话域（#778 · #747 C 节会话 REST 全件）。幂等 key 的 32-hex 形态校验在路由中间件
// requireMessageKey（header 面）；此处只管 body。
// ---------------------------------------------------------------------------
export const sessionCreateSchema = z.object({
  title: z.string().trim().max(TITLE_MAX, `title 过长（≤${TITLE_MAX} 字符）`).optional(),
})

export const sessionPatchSchema = z.object({
  title: z.string().trim().min(1, 'title 不能为空').max(TITLE_MAX, `title 过长（≤${TITLE_MAX} 字符）`),
})

export const messageSendSchema = z.object({
  content: z
    .string()
    .min(1, 'content 不能为空')
    .max(MESSAGE_CONTENT_MAX, `content 过长（≤${MESSAGE_CONTENT_MAX} 字符）`),
  // #780 附件引用（D6：单消息 ≤4 件，service.linkToMessage 权威校验 + 归属/session 门）。
  // 只存引用不存字节——字节在沙箱 /lab/uploads/<attachmentId>/，本字段是雪花 attachmentId 列表。
  attachmentIds: z.array(z.string()).max(4, '单消息最多 4 个附件').optional(),
})

// resume 决策载荷：#783 审批漏斗接构造，本票机制面直通——decisions 形状校验归 #783（此处
// 只放行可选透传，RunService 命令面 JSON 序列化兼容任意 JSON 值）。
export const sessionResumeSchema = z.object({
  decisions: z.unknown().optional(),
})

// ---------------------------------------------------------------------------
// rewind / fork（#781 · #747 story 16/18 + #782 三态）。锚点一律以消息行表达（产品面 =
// 选历史消息）；checkpoint 解析在 service（resolveRewindAnchor）。branch-switch 机制 #770 已取消。
// scope（#747 UX 恢复菜单三态）：all = 对话+文件同回（缺省）；chat = 只回对话；files = 只回文件。
// ---------------------------------------------------------------------------
export const sessionRewindSchema = z.object({
  messageId: z.string().min(1, 'messageId 不能为空'),
  scope: z.enum(REWIND_SCOPES).optional(),
})

export const sessionRewindPreviewSchema = z.object({
  messageId: z.string().min(1, 'messageId 不能为空'),
})

export const sessionForkSchema = z.object({
  messageId: z.string().min(1).optional(), // 缺省 = 当前活跃头（指针或最新锚点）
  title: z.string().trim().max(TITLE_MAX, `title 过长（≤${TITLE_MAX} 字符）`).optional(),
})

export const sessionApprovalSchema = z.object({
  decision: z.enum(['allow', 'deny']),
  reason: z.string().max(2000).optional(),
})

// ---------------------------------------------------------------------------
// plugins（#788 · #752 R8）：启用位 PUT（{enabled: boolean}；幂等 upsert）。
// pluginId = 目录 id（kebab-case，与 plugins/registry PLUGIN_ID_REGEX 同形）。
// ---------------------------------------------------------------------------
export const PLUGIN_ID_REGEX = /^[a-z][a-z0-9-]*$/

export const pluginEnablementSchema = z.object({
  enabled: z.boolean(),
})

export const pluginCommandCompletionQuerySchema = z.object({
  prefix: z.string().max(1000).default(''),
})

// 插件 LLM 指派写侧（#883 T3）：{provider_id, model_id} 双可空——provider_id null = 跟随
// 默认链；'platform' = 钉平台默认端点；其余须为本人 BYOK 端点 id。model_id null = 该端点
// 默认（首条）模型。语义校验（端点存在性/模型成员资格/含保留键 'judge' 的可指派性）归
// plugins/assignments 服务层（需查库与目录，schema 只锁形状）。
export const pluginLlmAssignmentWriteSchema = z.object({
  provider_id: z.string().min(1).max(64).nullable().default(null),
  model_id: z.string().min(1).max(200).nullable().default(null),
})
