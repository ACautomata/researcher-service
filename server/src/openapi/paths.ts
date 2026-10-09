// 端点全集声明（#761）：每个 REST 端点一条 spec，经 register() 展开为 registry.registerPath。
//
// 漂移防线：
// - 请求体 zod schema 一律 import 自 validation/schemas.ts（运行时校验的单一来源），本文件零复制。
// - wiki 写面已随 #758 Q3 退役（PUT/POST/DELETE /wiki/page 下线，写面收归 agent）——无 wiki
//   写体声明；files 写面已随 T0 #801 退役，同无写体声明。
// - 错误码逐端点照录源码注释；响应 data 为宽松载荷 + 文字描述（响应无 zod 来源可引用）。

import { z } from 'zod'
import { registry, okEnvelope, LooseData, NullData, ErrorEnvelope, bearerAuth } from './components'
import {
  endpointTestSchema,
  loginSchema,
  messageSendSchema,
  modelProviderWriteSchema,
  passwordChangeSchema,
  pluginCommandCompletionQuerySchema,
  pluginEnablementSchema,
  pluginLlmAssignmentWriteSchema,
  sessionApprovalSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionPatchSchema,
  sessionResumeSchema,
  sessionRewindPreviewSchema,
  sessionRewindSchema,
  userCreateSchema,
  userPatchSchema,
} from '../validation/schemas'

interface EndpointSpec {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  path: string // OpenAPI 模板语法（{param}）
  tag: string
  summary: string
  auth: 'public' | 'user' | 'admin'
  errors: string // 可能错误码照录源码注释（错误响应 description）
  dataNote?: string // 成功 data 载荷说明（成功响应 description）
  body?: z.ZodTypeAny // 请求体（zod 单一来源 import；缺省 = 无请求体）
  bodyNote?: string // 手工校验写体的字段说明（body 给宽松 object 时配套）
  query?: z.ZodTypeAny // query 参数（zod object → parameters）
  headers?: z.ZodTypeAny // 必备请求头（zod object → parameters）
  nullData?: boolean // 成功 data 恒 null
  bytes?: string // 成功路径豁免 #312 信封的二进制 mime（figures png / files raw）
  multipart?: string // multipart 表单字段说明（body 给宽松 object + 描述指向源码；与 body 互斥）
}

function register(spec: EndpointSpec): void {
  const { method, path, tag, summary, auth, errors, dataNote, body, bodyNote, query, headers, nullData, bytes, multipart } = spec
  const okDescription = bytes
    ? `成功：原生 ${bytes} 字节直发（豁免 #312 信封，绝不 base64-in-JSON）。${dataNote ?? ''}`.trim()
    : `成功（#312 信封 code=0，HTTP 恒 200）。${dataNote ?? 'data 字段见描述'}`.trim()
  registry.registerPath({
    method,
    path,
    tags: [tag],
    summary,
    ...(auth === 'public' ? {} : { security: [{ [bearerAuth.name]: [] }] }),
    ...(auth === 'admin' ? { description: 'admin 专属：非 admin → 10004 或域内防探测码。' } : {}),
    request: {
      ...(multipart
        ? {
            // ZodMediaTypeObject 无 description 槽——表单字段说明挂 schema describe（UI 渲染为 schema 描述）。
            body: {
              required: true,
              content: {
                'multipart/form-data': {
                  schema: z.record(z.string(), z.unknown()).describe(multipart),
                },
              },
            },
          }
        : {}),
      ...(body || bodyNote
        ? {
            body: {
              required: true,
              content: {
                'application/json': {
                  schema: body ?? LooseData,
                  ...(bodyNote ? { description: bodyNote } : {}),
                },
              },
            },
          }
        : {}),
      ...(query ? { query: query as z.ZodObject<z.ZodRawShape> } : {}),
      ...(headers ? { headers: headers as z.ZodObject<z.ZodRawShape> } : {}),
    },
    responses: {
      200: bytes
        ? {
            description: okDescription,
            content: { [bytes]: { schema: { type: 'string', format: 'binary' } } },
          }
        : {
            description: okDescription,
            content: { 'application/json': { schema: okEnvelope(nullData ? NullData : LooseData) } },
          },
      default: {
        description: `错误（#312 信封，HTTP 恒 200）。可能码：${errors}`,
        content: { 'application/json': { schema: ErrorEnvelope } },
      },
    },
  })
}

// ---- 会话 /api/v1/sessions（#778 写操作全 REST；归属/幂等/门禁在 service 层；50002 = 会话不存在/越权同码防探测）----

register({
  method: 'post',
  path: '/api/v1/sessions',
  tag: 'Sessions',
  summary: '创建会话（扁平挂本人；标题可选）',
  auth: 'user',
  errors: '90002 · 10005。',
  dataNote: 'data: 新会话行（id/title 等）；session.created{source:new} 经 SSE 扇出。',
  body: sessionCreateSchema,
})

register({
  method: 'get',
  path: '/api/v1/sessions',
  tag: 'Sessions',
  summary: '本人会话列表（updatedAt DESC）',
  auth: 'user',
  errors: '10005。',
  dataNote: 'data: 会话行列表。',
})

register({
  method: 'patch',
  path: '/api/v1/sessions/{id}',
  tag: 'Sessions',
  summary: '改标题',
  auth: 'user',
  errors: '50002 · 90002 · 10005。',
  dataNote: 'data: 更新后会话行；session.updated 经 SSE 扇出。',
  body: sessionPatchSchema,
})

register({
  method: 'delete',
  path: '/api/v1/sessions/{id}',
  tag: 'Sessions',
  summary: '删会话（级联删沙箱容器+网络；DB 行级联清 messages/checkpoints/attachments）',
  auth: 'user',
  errors: '50002 · 10005。',
  nullData: true,
})

register({
  method: 'post',
  path: '/api/v1/sessions/{id}/messages',
  tag: 'Sessions',
  summary: '发消息（幂等 + 多端门禁；附件引用 attachmentIds ≤4）',
  auth: 'user',
  errors:
    '50002 · 50005（在飞/排队 run——中断或完成后再发）· 50003（interrupt 未决——先审批决策）· 50007（同 Idempotency-Key 不同内容）· 40043（并发配额）· 90002（缺/坏 Idempotency-Key → data 恒 null；body 字段明细）· 10005。',
  dataNote: 'data: 受理结果（幂等重复 → 原行，零副作用）。',
  body: messageSendSchema,
  headers: z.object({
    'idempotency-key': z.string().describe('32 位小写 hex（MESSAGE_KEY_REGEX）；缺失/非法 → 90002'),
  }),
})

register({
  method: 'post',
  path: '/api/v1/sessions/{id}/abort',
  tag: 'Sessions',
  summary: '中断在飞 run（by:user；run.aborted 经 SSE 扇出）',
  auth: 'user',
  errors: '50002 · 50006（无在飞 run）· 10005。',
  dataNote: 'data: 中断受理结果。',
})

register({
  method: 'post',
  path: '/api/v1/sessions/{id}/resume',
  tag: 'Sessions',
  summary: 'interrupt 恢复（decisions 直通审批漏斗命令面）',
  auth: 'user',
  errors: '50002 · 10005 · 90002。',
  dataNote: 'data: 恢复受理结果。',
  body: sessionResumeSchema,
})

register({
  method: 'get',
  path: '/api/v1/sessions/{id}/messages',
  tag: 'Sessions',
  summary: '历史投影（回放面；与实时流终态零差异）',
  auth: 'user',
  errors: '50002 · 10005。',
  dataNote: 'data: 会话消息投影（reducer 投影）。',
})

register({
  method: 'post',
  path: '/api/v1/sessions/{id}/rewind',
  tag: 'Sessions',
  summary: '回退重开（#782 三态：指针换锚 + 放弃路线软删 + 文件逆放）',
  auth: 'user',
  errors: '50002 · 50005（在飞 run）· 90002（锚点无更早可回退 state / checkpoint 缺失或已归档）· 10005。',
  dataNote: 'data: 回退结果；scope=all 缺省（chat=只回对话；files=只回文件）。',
  body: sessionRewindSchema,
})

register({
  method: 'post',
  path: '/api/v1/sessions/{id}/rewind/preview',
  tag: 'Sessions',
  summary: '回退预览（#782 D8；逆放集摘要 + exec 跨越清单，只读）',
  auth: 'user',
  errors: '50002 · 50005 · 90002（锚点非法，同 rewind）· 10005。',
  dataNote: 'data: 预览摘要（只读，零副作用）。',
  body: sessionRewindPreviewSchema,
})

register({
  method: 'post',
  path: '/api/v1/sessions/{id}/fork',
  tag: 'Sessions',
  summary: '复制出新会话（state/沙箱/journal/attachments 全件；#768 D7）',
  auth: 'user',
  errors: '50002 · 50005（在飞 run）· 40043（沙箱配额）· 90002（切点非法）· 90000（沙箱/数据复制失败——已回滚）· 10005。',
  dataNote: 'data: 新会话行；session.created{source:fork} 经 SSE 扇出。',
  body: sessionForkSchema,
})

register({ method: 'post', path: '/api/v1/sessions/{id}/approvals/{escalationId}', tag: 'Sessions', summary: 'Resolve a leader or teammate approval', auth: 'user', body: sessionApprovalSchema, nullData: true, errors: '50002 session_not_found; 50004 approval_not_found; 50001 already_resumed; 40043 quota exceeded; 90002 validation', dataNote: 'Acknowledges queued resume; only the checkpoint thread owning this escalation resumes.' })

// plugins（#788 · #752 §4.3 R8）：目录清单 + per-user 启用位（8xxxx 段）。
register({ method: 'get', path: '/api/v1/plugins', tag: 'Plugins', summary: 'List plugin catalog with the caller enablement bits', auth: 'user', errors: '90002 validation', dataNote: '{plugins:[{id,name,description,version,enabled}]} —— 目录 = 编译期静态清单；enabled 无行 = false（默认未启用）。' })
register({ method: 'put', path: '/api/v1/plugins/{id}/enablement', tag: 'Plugins', summary: 'Enable or disable a plugin for the caller', auth: 'user', body: pluginEnablementSchema, nullData: false, errors: '80040 plugin_not_found（目录外 id，同码防探测）; 90002 validation', dataNote: '{id, enabled} —— 幂等 upsert（plugin_enablements per-user 行）。' })

// 插件 LLM 指派（#883 T3）：per-user per-plugin 端点/模型指派（Model 页插件指派区数据源）。
register({ method: 'get', path: '/api/v1/plugins/llm-assignments', tag: 'Plugins', summary: 'List assignable plugin LLM targets and the caller assignments', auth: 'user', errors: '90002 validation', dataNote: '{targets:[{plugin_id, description, default_model?}]}（声明 llm 的插件 ∪ 保留键 judge）, {assignments:[{plugin_id, provider_id(null=跟随默认链), model_id(null=端点默认), updated_at}]}。' })
register({ method: 'put', path: '/api/v1/plugins/{id}/llm-assignment', tag: 'Plugins', summary: 'Assign an endpoint and model to a plugin for the caller', auth: 'user', body: pluginLlmAssignmentWriteSchema, nullData: false, errors: '80040 plugin_not_found（未声明 llm / 目录外 / 非 judge，同码防探测）; 90002 validation（端点 ∈ 本人端点集 ∪ platform；模型属该端点模型集）', dataNote: '{plugin_id, provider_id, model_id, updated_at} —— 幂等 upsert；事务内 bump 配置版本（下一 run 生效，在飞 run 不受影响）。' })
register({ method: 'delete', path: '/api/v1/plugins/{id}/llm-assignment', tag: 'Plugins', summary: 'Clear a plugin LLM assignment (back to default chain)', auth: 'user', nullData: true, errors: '80040 plugin_not_found（同码防探测）', dataNote: 'null —— 删行回默认链；无行幂等（不 bump 版本）。' })
register({ method: 'get', path: '/api/v1/plugins/{id}/commands/{name}/completions', tag: 'Plugins', summary: '命令参数只读补全（#797；启用位与当前用户同源，不执行 command handler）', auth: 'user', errors: '80040 plugin_not_found（目录外/未启用，同码防探测）· 90002 validation', dataNote: 'data: { completions: [...] }（截断 50 条）。', query: pluginCommandCompletionQuerySchema })

// ---- 系统 ----

register({
  method: 'get',
  path: '/api/health',
  tag: '系统',
  summary: '健康探针（公开）',
  auth: 'public',
  errors: '无业务错误码。',
  dataNote: 'data: { status: \'ok\' }。compose/BaoTa healthcheck 用。',
})

register({
  method: 'get',
  path: '/api/v1/trace-logs',
  tag: '系统',
  summary: '文本追踪日志检索（admin）',
  auth: 'admin',
  errors: '10001（未认证）· 10041（非 admin 防探测同码）· 10005（mustChangePassword）。',
  dataNote: 'data: { logs, total, page, pageSize }（listTextTraceLogs 形状）。',
  query: z.object({
    userId: z.string().optional(),
    ip: z.string().optional(),
    content: z.string().optional(),
    status: z.enum(['success', 'failed']).optional(),
    page: z.string().optional().describe('正整数页码'),
    pageSize: z.string().optional().describe('正整数每页条数'),
  }),
})

// ---- 审计 / 核算（admin 全量面；非 admin → 10004 直拒——面板级运营资源无存在性敏感面）----

register({
  method: 'get',
  path: '/api/v1/approval-logs',
  tag: '审计',
  summary: '审批审计检索（tool_approval_logs；#783 ADR 0015）',
  auth: 'admin',
  errors: '10001 · 10004 · 10005。',
  dataNote: 'data: { total, page, pageSize, items }（createdAt DESC；行 = 一次 tool 审批决策全字段）。',
  query: z.object({
    userId: z.string().optional(),
    runId: z.string().optional(),
    layer: z.enum(['rule', 'judge', 'human']).optional(),
    decision: z.enum(['allow', 'deny']).optional(),
    from: z.string().optional().describe('ISO 时间下限（含）'),
    to: z.string().optional().describe('ISO 时间上限（不含）'),
    page: z.string().optional().describe('正整数页码'),
    pageSize: z.string().optional().describe('正整数每页条数（≤200）'),
  }),
})

register({
  method: 'get',
  path: '/api/v1/file-overwrite-logs',
  tag: '审计',
  summary: '文件覆盖审计检索（file_overwrite_logs；#785 写锁方案覆盖审计）',
  auth: 'admin',
  errors: '10001 · 10004 · 10005。',
  dataNote: 'data: { total, page, pageSize, items }（snake_case 行：一次 write-after-write 覆盖，含覆盖者/被覆盖者 thread 与触发 run）。',
  query: z.object({
    sessionId: z.string().optional(),
    path: z.string().optional(),
    from: z.string().optional().describe('ISO 时间下限（含）'),
    to: z.string().optional().describe('ISO 时间上限（不含）'),
    page: z.string().optional().describe('正整数页码'),
    pageSize: z.string().optional().describe('正整数每页条数'),
  }),
})

register({
  method: 'get',
  path: '/api/v1/usage/aggregate',
  tag: '核算',
  summary: 'LLM 用量聚合（#800 admin 核算页数据源；llm_usage_records 聚合）',
  auth: 'admin',
  errors: '10001 · 10004 · 10005。',
  dataNote: 'data: { items: [user_id, username, provider_id, lc_provider, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens] }（snake_case）。',
  query: z.object({
    userId: z.string().optional(),
    from: z.string().optional().describe('ISO 时间下限（含）'),
    to: z.string().optional().describe('ISO 时间上限（不含）——[from, to) 半开区间，相邻核算窗拼接不双计边界行'),
  }),
})

// ---- 认证 /api/v1/auth ----

register({
  method: 'post',
  path: '/api/v1/auth/login',
  tag: '认证',
  summary: '登录（用户名+密码）',
  auth: 'public',
  errors: '10002（用户不存在/密码错/已禁用，同码防探测+恒定耗时）· 90002（字段明细）。',
  dataNote:
    'data: { access, mustChangePassword }；refresh_token 经 HttpOnly/SameSite=Lax/Path=/api/v1/auth cookie 下发。',
  body: loginSchema,
})

register({
  method: 'post',
  path: '/api/v1/auth/token/refresh',
  tag: '认证',
  summary: '刷新 access token（R1 旋转）',
  auth: 'public',
  errors: '10003（refresh 缺失/无效/已撤销/过期/重放——重放族灭该 user 全部 refresh）。',
  dataNote: 'data: { access }；新 refresh 经同名 cookie 旋转下发。无需 Bearer。',
})

register({
  method: 'get',
  path: '/api/v1/auth/oauth/{provider}/login',
  tag: '认证',
  summary: 'OIDC 登录跳转（骨架）',
  auth: 'public',
  errors: '90001（provider 未配置——O1 骨架不接 IdP）。',
})

register({
  method: 'get',
  path: '/api/v1/auth/oauth/{provider}/callback',
  tag: '认证',
  summary: 'OIDC 回调（骨架）',
  auth: 'public',
  errors: '90001（provider 未配置——O1 骨架不接 IdP）。',
})

register({
  method: 'get',
  path: '/api/v1/auth/me',
  tag: '认证',
  summary: '当前用户',
  auth: 'user',
  errors: '10001 · 10005（mustChangePassword）。',
  dataNote: 'data: { id, username, email, role, mustChangePassword, maxContainers }。',
})

register({
  method: 'post',
  path: '/api/v1/auth/logout',
  tag: '认证',
  summary: '登出（撤销 refresh cookie）',
  auth: 'user',
  errors: '10001。',
  nullData: true,
  dataNote: 'data 恒 null；refresh cookie 清除。',
})

register({
  method: 'post',
  path: '/api/v1/auth/password/change',
  tag: '认证',
  summary: '改密（C1；成功后全端强制重登）',
  auth: 'user',
  errors: '10002（旧密错）· 90002（字段明细）。',
  dataNote: 'data 恒 null；全量撤销该 user refresh 并清 refresh cookie。',
  body: passwordChangeSchema,
})

register({
  method: 'post',
  path: '/api/v1/auth/register',
  tag: '认证',
  summary: '自助建号（admin）',
  auth: 'admin',
  errors: '10001 · 10005 · 10042（用户名格式）· 10043（配额非法）· 90002。',
  dataNote: 'data: { id, username, email, role }。',
  body: userCreateSchema,
})

// ---- 账号管理 /api/v1/users（admin；非 admin → 10041 防探测）----

register({
  method: 'get',
  path: '/api/v1/users',
  tag: '账号管理',
  summary: '用户列表',
  auth: 'admin',
  errors: '10001 · 10041（非 admin 同码防探测）· 10005。',
  dataNote: 'data: { users: [{ id, username, email, role, isActive, maxContainers, maxConcurrentRuns, mustChangePassword, createdAt }] }（#858：containerCount/quota 随容器行表退役移除）。', 
})

register({
  method: 'post',
  path: '/api/v1/users',
  tag: '账号管理',
  summary: '建账号',
  auth: 'admin',
  errors: '10041 · 10042（用户名格式 → data.username）· 10043（配额）· 90002。',
  dataNote: 'data: { id, username, email, role }。',
  body: userCreateSchema,
})

register({
  method: 'patch',
  path: '/api/v1/users/{id}',
  tag: '账号管理',
  summary: '改账号（active/配额）',
  auth: 'admin',
  errors: '10041（不存在/越权同码）· 10043（配额非法）· 10044（不可自禁）· 90002。',
  dataNote: 'data: { id, username, isActive, maxContainers }。',
  body: userPatchSchema,
})

register({
  method: 'post',
  path: '/api/v1/users/{id}/reset-password',
  tag: '账号管理',
  summary: '重置密码（一次性明文回显 + C1 + 撤全部 refresh）',
  auth: 'admin',
  errors: '10041（不存在/已禁用/并发已重置，同码防探测）。',
  dataNote: 'data: { password } 一次性明文（仅此一次回显）；目标 mustChangePassword=true。',
})

// ---- Wiki /api/v1/wiki（owner 级，#856 归属门直挂认证身份；页不存在 30040；写面已随 #758 Q3 退役）----

register({
  method: 'get',
  path: '/api/v1/wiki/tree',
  tag: 'Wiki',
  summary: 'wiki 文件树（本人 wiki）',
  auth: 'user',
  errors: `10005。`,
  dataNote: 'data: 树形结构（开放目录分组，不收顶层散落页）。',
})

register({
  method: 'get',
  path: '/api/v1/wiki/page',
  tag: 'Wiki',
  summary: '读一页原文全文',
  auth: 'user',
  errors: `90002（path 非法 → data.path）· 30040 · 10005。`,
  dataNote: 'data: 页内容载荷（service.readPage 形状）。',
  query: z.object({ path: z.string().describe('wiki 内相对路径') }),
})

// 写面退役（#758 Q3）：PUT/POST/DELETE /api/v1/wiki/page 文档面注册随端点一并下线
//（wiki 只剩读面，写面收归 agent——参照 figuresHistory 创建端点退役先例）。

register({
  method: 'get',
  path: '/api/v1/wiki/graph',
  tag: 'Wiki',
  summary: '全库图谱（nodes + edges）',
  auth: 'user',
  errors: `10005。`,
  dataNote: 'data: { nodes, edges }（obsidian 风格；边不 dedup，不可解析 → ghost 节点）。',
})

register({
  method: 'get',
  path: '/api/v1/wiki/claims',
  tag: 'Wiki',
  summary: '页 claims 旁车只读面（#789：论断 → 源文件行锚 evidence + 页级漂移状态）',
  auth: 'user',
  errors: `90002（path 非法 → data.path）· 30040（页不存在，同码防探测）· 10005。`,
  dataNote: 'data: { claims, drift }；旁车缺失/畸形 → 200 + drift null + 空 claims（「无证据面板」语义，不报错）。',
  query: z.object({ path: z.string().describe('wiki 内相对路径') }),
})

register({
  method: 'post',
  path: '/api/v1/wiki/update',
  tag: 'Wiki',
  summary: '全量更新独立 run 触发面（#790 三通道③；进度经 SSE wiki_run.* 五类事件扇出）',
  auth: 'user',
  errors: `30042（在飞互斥）· 90005（update 装配缺失）· 10005。`,
  dataNote: 'data: { runId }；ensure wiki 容器后即返，事件即焚不落盘。',
})

// ---- Models /api/v1/models（owner 级，#857 归属门直挂认证身份；#881 预设制换形）----

register({
  method: 'get',
  path: '/api/v1/models/presets',
  tag: 'Models',
  summary: '端点预设目录（六预设；建 BYOK 端点的唯一取值域，#881）',
  auth: 'user',
  errors: `10005（mustChangePassword）。`,
  dataNote: 'data: [{ id, name, protocol, base_url, default_models }]（协议/地址随预设锁定，无自由 baseURL）。',
})

register({
  method: 'get',
  path: '/api/v1/models/platform',
  tag: 'Models',
  summary: '平台默认端点只读视图（env 派生虚拟实体，不落库，#881）',
  auth: 'user',
  errors: `10005（mustChangePassword）· 90003（LLM_PRESET 配置非法——config 启动校验兜底）。`,
  dataNote: 'data: { provider_id, preset_id, protocol, lc_provider, base_url, default_model, key_configured }（永无 key 材料）。',
})

register({
  method: 'post',
  path: '/api/v1/models/test',
  tag: 'Models',
  summary: '端点试连（#882：按表单态[预设+key+模型]最小代价真实试连——不入库、不写日志、1-token 级、10s 超时）',
  auth: 'user',
  errors: `90002（字段明细）· 90003（试连失败——净化错误文本，不含 key；超时同码）· 10005。`,
  dataNote: 'data: { ok: true, latency_ms }（延迟毫秒）。',
  body: endpointTestSchema,
})

register({
  method: 'get',
  path: '/api/v1/models/providers',
  tag: 'Models',
  summary: '本人 BYOK 端点列表（createdAt 升序；key 只出掩码，#881）',
  auth: 'user',
  errors: `10005（mustChangePassword）。`,
  dataNote: 'data: [{ id, provider_id, preset_id, protocol, base_url, api_key_masked(null=平台共享或解密失败), key_error, models, created_at }]。',
})

register({
  method: 'post',
  path: '/api/v1/models/providers',
  tag: 'Models',
  summary: '建 BYOK 端点（preset_id 锁定协议与地址；api_key 落库即密文；唯一(ownerId, providerId)，#881）',
  auth: 'user',
  errors: `90002（字段明细：保留 id 抢注/未知预设/models 形状）· 40041（pid 冲突）· 10005。`,
  dataNote: 'data: 新建端点（api_key_masked 掩码；事务内 config_meta version bump = 热生效信号）。',
  body: modelProviderWriteSchema,
})

register({
  method: 'get',
  path: '/api/v1/models/providers/{pid}',
  tag: 'Models',
  summary: '回读单条 BYOK 端点',
  auth: 'user',
  errors: `40040（不存在/越权同码防探测）· 10005。`,
  dataNote: 'data: 端点（api_key_masked 掩码）。',
})

register({
  method: 'get',
  path: '/api/v1/models/providers/{pid}/impact',
  tag: 'Models',
  summary: 'BYOK 端点删除影响计数',
  auth: 'user',
  errors: '40040（不存在/越权同码防探测）· 10005。',
  dataNote: 'data: { sessions, plugins, judge, teammates, total }；仅本人未归档引用，teammate 内部会话不重复计入 sessions。',
})

register({
  method: 'put',
  path: '/api/v1/models/providers/{pid}',
  tag: 'Models',
  summary: '改 BYOK 端点（路径 pid 定位；api_key 留空 = 保持不变，#881）',
  auth: 'user',
  errors: `90002 · 40040 · 40041（撞同 owner 既有 pid）· 10005。`,
  dataNote: 'data: 更新后端点。',
  body: modelProviderWriteSchema,
})

register({
  method: 'delete',
  path: '/api/v1/models/providers/{pid}',
  tag: 'Models',
  summary: '删 BYOK 端点（下一 run 引用回落平台默认；在飞快照不变）',
  auth: 'user',
  errors: `40040 · 10005。`,
  nullData: true,
})

// ---- 文件 /api/v1/containers/{name}/files（T0 #801 只读化 + #858 容器 CRUD 退役后本前缀
// 唯一残余端点：唯一现役读面 root=lab——{name} 为 sessionId，50002 归属门；wiki/workspace 根
// 退役 → 60042，写面端点整体移除）----

register({
  method: 'get',
  path: '/api/v1/containers/{name}/files',
  tag: '文件',
  summary: '列目录 / 读文件（root=lab：会话沙箱只读面，stopped 可读；不触发沙箱创建）',
  auth: 'user',
  errors: `90002（data.name|data.root|data.path）· 50002（lab 面：会话不存在/越权，同码防探测）· 60040（文件不存在）· 60042（root=wiki/workspace 已退役）· 10005。`,
  dataNote:
    'root=lab：path 指目录 → { files: [{ path, type, size, modified }] }（recursive=true 递归 walk）；指文件 → { path, content, size, modified, binary, oversized }。' +
    'root=wiki/workspace：合法值但退役（60042，wiki 读走 wiki 域 REST；#858 起无容器行归属前置，name 形状校验后即拒）；缺省 root 按退役处理。',
  query: z.object({
    root: z.enum(['lab', 'wiki', 'workspace']).describe('lab=唯一现役读面；wiki/workspace=退役根（60042）'),
    path: z.string().optional().describe('相对路径；空 = 树根'),
    recursive: z.enum(['true', 'false']).optional().describe('仅字面 true 递归'),
  }),
})

// ---- Figures /api/v1/figures（#791 · #744 v2 读面：常驻资产面，无 flag 门）----

register({
  method: 'get',
  path: '/api/v1/figures',
  tag: 'Figures',
  summary: 'Figure 资产列表（本人；admin 全部）',
  auth: 'user',
  errors: '10001 · 10005。',
  dataNote: 'data: Figure 列表（createdAt DESC + id DESC；无分页）。',
})

register({
  method: 'get',
  path: '/api/v1/figures/{id}',
  tag: 'Figures',
  summary: 'Figure 元数据 + 预览可用性',
  auth: 'user',
  errors: '70040（不存在/越权同码防枚举）· 10005。',
  dataNote: 'data: metadata（prompt/sessionId/createdAt）+ previewReady + updatedAt。',
})

register({
  method: 'get',
  path: '/api/v1/figures/{id}/png',
  tag: 'Figures',
  summary: '下载预览 PNG 字节（成功豁免信封）',
  auth: 'user',
  errors: '70040 · 70043（产物缺失）。',
  bytes: 'image/png',
})

register({
  method: 'get',
  path: '/api/v1/figures/{id}/svg',
  tag: 'Figures',
  summary: 'final SVG 文本（?download=1 → attachment；成功豁免信封）',
  auth: 'user',
  errors: '70040 · 70043（产物缺失）。',
  bytes: 'image/svg+xml',
  query: z.object({ download: z.string().optional().describe('download=1/true 触发下载') }),
})

// ---- 附件 /api/v1（#780：POST 与 sessions 共根；字节在沙箱 /lab/uploads/<id>/，REST 不落业务库）----

register({
  method: 'post',
  path: '/api/v1/sessions/{id}/attachments',
  tag: '附件',
  summary: '上传附件（multipart；落控制面临时区，run 首步 ingestion 进沙箱）',
  auth: 'user',
  errors: '50002（会话不存在/越权同码防探测）· 90002（缺 file 字段 / 超 ≤100MB）。',
  dataNote: 'data: 附件元数据（id/fileName/mimeType/size/sha256/path——AttachmentMeta）。',
  multipart: 'multipart/form-data：file（字节字段，≤100MB）+ 表单字段 fileName、mimeType（可缺省）。',
})

register({
  method: 'get',
  path: '/api/v1/attachments/{id}/download',
  tag: '附件',
  summary: '下载附件字节（成功豁免信封；owner 门，admin 全放行）',
  auth: 'user',
  errors: '50002（不存在/越权同码防枚举）。',
  bytes: 'application/octet-stream',
  dataNote: '字节体 = 沙箱 /lab/uploads/<attachmentId>/<fileName>；Content-Type 按附件声明 mime 透传（Content-Disposition inline）。',
})
