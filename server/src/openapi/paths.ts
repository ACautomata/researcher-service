// 端点全集声明（#761）：每个 REST 端点一条 spec，经 register() 展开为 registry.registerPath。
//
// 漂移防线：
// - 请求体 zod schema 一律 import 自 validation/schemas.ts（运行时校验的单一来源），本文件零复制。
// - wiki 写体是手工校验（parseWikiWriteBody，非 zod），不给伪精确 schema ——
//   宽松 object + 描述指向源码；其校验规则的单一来源是 wiki/paths.ts。
//   （files 写面已随 T0 #801 退役，无写体声明。）
// - 错误码逐端点照录源码注释；响应 data 为宽松载荷 + 文字描述（响应无 zod 来源可引用）。

import { z } from 'zod'
import { registry, okEnvelope, LooseData, NullData, ErrorEnvelope, bearerAuth } from './components'
import {
  loginSchema,
  modelProviderWriteSchema,
  passwordChangeSchema,
  pluginEnablementSchema,
  providerEndpointWriteSchema,
  sessionApprovalSchema,
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
}

function register(spec: EndpointSpec): void {
  const { method, path, tag, summary, auth, errors, dataNote, body, bodyNote, query, headers, nullData, bytes } = spec
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

const USER_WRITE_BODY_NOTE =
  'JSON 对象；字段校验为服务端手写（单一来源 wiki/paths.ts），非法 → 90002 + data 字段明细。'

register({ method: 'post', path: '/api/v1/sessions/{id}/approvals/{escalationId}', tag: 'Sessions', summary: 'Resolve a leader or teammate approval', auth: 'user', body: sessionApprovalSchema, nullData: true, errors: '50002 session_not_found; 50004 approval_not_found; 50001 already_resumed; 40043 quota exceeded; 90002 validation', dataNote: 'Acknowledges queued resume; only the checkpoint thread owning this escalation resumes.' })

// plugins（#788 · #752 §4.3 R8）：目录清单 + per-user 启用位（8xxxx 段）。
register({ method: 'get', path: '/api/v1/plugins', tag: 'Plugins', summary: 'List plugin catalog with the caller enablement bits', auth: 'user', errors: '90002 validation', dataNote: '{plugins:[{id,name,description,version,enabled}]} —— 目录 = 编译期静态清单；enabled 无行 = false（默认未启用）。' })
register({ method: 'put', path: '/api/v1/plugins/{id}/enablement', tag: 'Plugins', summary: 'Enable or disable a plugin for the caller', auth: 'user', body: pluginEnablementSchema, nullData: false, errors: '80040 plugin_not_found（目录外 id，同码防探测）; 90002 validation', dataNote: '{id, enabled} —— 幂等 upsert（plugin_enablements per-user 行）。' })

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

// ---- Wiki /api/v1/wiki（owner 级，#856 归属门直挂认证身份；页不存在 30040；页已存在 30041）----

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

register({
  method: 'put',
  path: '/api/v1/wiki/page',
  tag: 'Wiki',
  summary: '覆写已存在页（byte-exact 保留空白）',
  auth: 'user',
  errors: `90002（data.path|data.content 明细）· 30040 · 10005。`,
  dataNote: 'data: { path }。',
  bodyNote: `${USER_WRITE_BODY_NOTE}字段：path（相对路径，穿越/managed 拒）、content（string，含未配对代理字符拒）。`,
})

register({
  method: 'post',
  path: '/api/v1/wiki/page',
  tag: 'Wiki',
  summary: '新建页',
  auth: 'user',
  errors: `90002（字段明细）· 30041（已存在）· 10005。`,
  dataNote: 'data: { path }。',
  bodyNote: `${USER_WRITE_BODY_NOTE}字段：path、content（同 PUT）。`,
})

register({
  method: 'delete',
  path: '/api/v1/wiki/page',
  tag: 'Wiki',
  summary: '删页',
  auth: 'user',
  errors: `90002（data.path）· 30040 · 10005。`,
  nullData: true,
  query: z.object({ path: z.string().describe('wiki 内相对路径') }),
})

register({
  method: 'get',
  path: '/api/v1/wiki/graph',
  tag: 'Wiki',
  summary: '全库图谱（nodes + edges）',
  auth: 'user',
  errors: `10005。`,
  dataNote: 'data: { nodes, edges }（obsidian 风格；边不 dedup，不可解析 → ghost 节点）。',
})

// ---- Models /api/v1/models/providers（owner 级，#857 归属门直挂认证身份；#775 事务 =
//      mutation + config_meta version bump + 白名单第一层校验）----

register({
  method: 'get',
  path: '/api/v1/models/providers',
  tag: 'Models',
  summary: 'provider 列表（createdAt 升序；owner 直取认证身份，#857）',
  auth: 'user',
  errors: `10005（mustChangePassword）。`,
  dataNote: 'data: 本人 provider 列表（service.list 形状）。',
})

register({
  method: 'post',
  path: '/api/v1/models/providers',
  tag: 'Models',
  summary: '新建 provider（唯一(ownerId, providerId)，#771 归属上移）',
  auth: 'user',
  errors: `90002（字段明细含 base_url 白名单未命中/DNS 私网拒绝）· 40041（pid 冲突）· 10005。`,
  dataNote: 'data: 新建 provider（service.create 形状；事务内 config_meta version bump = 热生效信号）。',
  body: modelProviderWriteSchema,
})

register({
  method: 'get',
  path: '/api/v1/models/providers/{pid}',
  tag: 'Models',
  summary: '回读单条 provider',
  auth: 'user',
  errors: `40040（不存在/越权同码防探测）· 10005。`,
  dataNote: 'data: provider（service.get 形状）。',
})

register({
  method: 'put',
  path: '/api/v1/models/providers/{pid}',
  tag: 'Models',
  summary: '改 provider（路径 pid 定位，body 可改 provider_id）',
  auth: 'user',
  errors: `90002（含 base_url 白名单未命中）· 40040 · 40041（撞同 owner 既有 pid）· 10005。`,
  dataNote: 'data: 更新后 provider。',
  body: modelProviderWriteSchema,
})

register({
  method: 'delete',
  path: '/api/v1/models/providers/{pid}',
  tag: 'Models',
  summary: '删 provider（version bump 热生效）',
  auth: 'user',
  errors: `40040 · 10005。`,
  nullData: true,
})

// ---- Provider endpoints /api/v1/provider-endpoints（#775 · 731 §3.1 端点白名单 admin 管理面）----

register({
  method: 'get',
  path: '/api/v1/provider-endpoints',
  tag: 'Models',
  summary: '端点白名单列表（admin，createdAt 升序）',
  auth: 'admin',
  errors: `10001 · 10004（非 admin）· 10005。`,
  dataNote: 'data: [{ id, scheme, host, port(null=scheme 默认端口), note, created_by, created_at }]。',
})

register({
  method: 'post',
  path: '/api/v1/provider-endpoints',
  tag: 'Models',
  summary: '新建白名单端点（origin 精确匹配；事务内 version bump）',
  auth: 'admin',
  errors: `10001 · 10004（非 admin）· 10005 · 90002（host 格式/DNS 私网拒绝、http 限开发环境）· 40041（origin 冲突，含 NULL-port 等价语义）。`,
  dataNote: 'data: 新建端点条目。',
  body: providerEndpointWriteSchema,
})

register({
  method: 'delete',
  path: '/api/v1/provider-endpoints/{id}',
  tag: 'Models',
  summary: '删白名单端点（不级联 provider 行——运行时复验 40042 兜底）',
  auth: 'admin',
  errors: `10001 · 10004（非 admin）· 10005 · 40040（不存在）。`,
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
