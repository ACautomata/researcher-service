// 端点全集声明（#761）：每个 REST 端点一条 spec，经 register() 展开为 registry.registerPath。
//
// 漂移防线：
// - 请求体 zod schema 一律 import 自 validation/schemas.ts（运行时校验的单一来源），本文件零复制。
// - wiki/files 写体是手工校验（parseWikiWriteBody/parseFileWriteBody，非 zod），不给伪精确 schema ——
//   宽松 object + 描述指向源码；其校验规则的单一来源是 wiki/files/paths.ts。
// - 错误码逐端点照录源码注释；响应 data 为宽松载荷 + 文字描述（响应无 zod 来源可引用）。

import { z } from 'zod'
import { registry, okEnvelope, LooseData, NullData, ErrorEnvelope, bearerAuth } from './components'
import {
  containerCreateSchema,
  figureCreateSchema,
  loginSchema,
  modelProviderWriteSchema,
  passwordChangeSchema,
  providerEndpointWriteSchema,
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

const FILE_WRITE_BODY_NOTE =
  'JSON 对象；字段校验为服务端手写（单一来源 files/paths.ts），非法 → 90002 + data 字段明细。写面 root 仅 wiki（lab/workspace 只读 → 90002 data.root）。'

const CONTAINER_PATH_NOTE = '容器名（DNS-label：小写字母开头，3–30 位，仅 [a-z0-9-]）；非法 → 90002(data.name)。'

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
  summary: '用户列表（含 containerCount/quota）',
  auth: 'admin',
  errors: '10001 · 10041（非 admin 同码防探测）· 10005。',
  dataNote: 'data: { users: [{ id, username, email, role, isActive, containerCount, quota, mustChangePassword, createdAt }] }。',
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

// ---- 容器 /api/v1/containers（归属前置：越权/不存在 → 20040 同码防探测）----

register({
  method: 'get',
  path: '/api/v1/containers',
  tag: '容器',
  summary: '容器列表（user 仅本人，admin 全部）',
  auth: 'user',
  errors: '10001 · 10005。',
  dataNote: 'data: { containers: [summary + pairing] }（ContainerSummary + 配对状态快照）。',
})

register({
  method: 'post',
  path: '/api/v1/containers',
  tag: '容器',
  summary: '新建容器（同步返 creating 快照，后台 provisioning）',
  auth: 'user',
  errors: '90002 · 20041（撞名）· 20042（配额超限）· 20044（残留 orphan 目录）· 90004（端口池耗尽）· 90003（LLM key 未配置）。',
  dataNote: 'data: creating 快照（含 name/port/status/pairing）。',
  body: containerCreateSchema,
})

register({
  method: 'delete',
  path: '/api/v1/containers/{name}',
  tag: '容器',
  summary: '删除容器（异步：同步返 removing，后台清理）',
  auth: 'user',
  errors: `90002（${CONTAINER_PATH_NOTE}）· 20040 · 20043（在飞 provisioning，置取消标志）· 20045（目录清理失败，可重试）。`,
  dataNote: 'data: { status: \'removing\' }。',
})

register({
  method: 'post',
  path: '/api/v1/containers/{name}/upgrade',
  tag: '容器',
  summary: '升级容器镜像（#699 异步编排）',
  auth: 'user',
  errors: `90002（${CONTAINER_PATH_NOTE}）· 20040 · 20043（upgrading/creating/removing/upgrade_failed；bind 模式 → 请删重建）。`,
  dataNote: 'data: 升级中快照（createdItem 形状）。',
})

register({
  method: 'post',
  path: '/api/v1/containers/{name}/bootstrap-token',
  tag: '容器',
  summary: '取容器 bootstrap token（协议机首连用，仅 running）',
  auth: 'user',
  errors: `90002（${CONTAINER_PATH_NOTE}）· 20040 · 20046（非 running——防 4402 退避循环）。`,
  dataNote: 'data: { bootstrapToken }（真值只下发属主浏览器，不落日志）。',
})

register({
  method: 'post',
  path: '/api/v1/containers/{name}/pairing/approve/{requestId}',
  tag: '容器',
  summary: 'approve 设备配对请求（容器内 openclaw devices approve）',
  auth: 'user',
  errors:
    `90002（${CONTAINER_PATH_NOTE}requestId 仅 [A-Za-z0-9_.~-]）· 20040 · 20046（非 running）· 90000（approve 执行失败：requestId 失效/网关不可达）。`,
  dataNote: 'data: { status: \'paired\' }；幂等（同 requestId 已 paired → ok 不重复 exec）。无 deviceToken 字段。',
})

// ---- Wiki /api/v1/containers/{name}/wiki（归属前置 20040；页不存在 30040；页已存在 30041）----

register({
  method: 'get',
  path: '/api/v1/containers/{name}/wiki/tree',
  tag: 'Wiki',
  summary: 'wiki 文件树',
  auth: 'user',
  errors: `90002（${CONTAINER_PATH_NOTE}）· 20040 · 10005。`,
  dataNote: 'data: 树形结构（开放目录分组，不收顶层散落页）。',
})

register({
  method: 'get',
  path: '/api/v1/containers/{name}/wiki/page',
  tag: 'Wiki',
  summary: '读一页原文全文',
  auth: 'user',
  errors: `90002（name/path 非法 → data.name|data.path）· 20040 · 30040 · 10005。`,
  dataNote: 'data: 页内容载荷（service.readPage 形状）。',
  query: z.object({ path: z.string().describe('wiki 内相对路径') }),
})

register({
  method: 'put',
  path: '/api/v1/containers/{name}/wiki/page',
  tag: 'Wiki',
  summary: '覆写已存在页（byte-exact；不触发 compile）',
  auth: 'user',
  errors: `90002（data.name|data.path|data.content 明细）· 20040 · 30040 · 10005。`,
  dataNote: 'data: { path }。',
  bodyNote: `${USER_WRITE_BODY_NOTE}字段：path（相对路径，穿越/managed 拒）、content（string，含未配对代理字符拒）。`,
})

register({
  method: 'post',
  path: '/api/v1/containers/{name}/wiki/page',
  tag: 'Wiki',
  summary: '新建页（触发 5s 去抖 recompile）',
  auth: 'user',
  errors: `90002（字段明细）· 20040 · 30041（已存在）· 10005。`,
  dataNote: 'data: { path }。',
  bodyNote: `${USER_WRITE_BODY_NOTE}字段：path、content（同 PUT）。`,
})

register({
  method: 'delete',
  path: '/api/v1/containers/{name}/wiki/page',
  tag: 'Wiki',
  summary: '删页（触发 5s 去抖 recompile）',
  auth: 'user',
  errors: `90002（data.name|data.path）· 20040 · 30040 · 10005。`,
  nullData: true,
  query: z.object({ path: z.string().describe('wiki 内相对路径') }),
})

register({
  method: 'get',
  path: '/api/v1/containers/{name}/wiki/graph',
  tag: 'Wiki',
  summary: '全库图谱（nodes + edges）',
  auth: 'user',
  errors: `90002（${CONTAINER_PATH_NOTE}）· 20040 · 10005。`,
  dataNote: 'data: { nodes, edges }（obsidian 风格；边不 dedup，不可解析 → ghost 节点）。',
})

register({
  method: 'get',
  path: '/api/v1/containers/{name}/wiki/categories',
  tag: 'Wiki',
  summary: '按 category: 标记聚合',
  auth: 'user',
  errors: `90002（${CONTAINER_PATH_NOTE}）· 20040 · 10005。`,
  dataNote: 'data: 分类聚合（开放词表；收顶层散落页）。',
})

// ---- Models /api/v1/containers/{name}/models/providers（写操作拒 creating/removing → 20043；
//      #775 事务 = mutation + config_meta version bump + 白名单第一层校验）----

register({
  method: 'get',
  path: '/api/v1/containers/{name}/models/providers',
  tag: 'Models',
  summary: 'provider 列表（createdAt 升序）',
  auth: 'user',
  errors: `90002（${CONTAINER_PATH_NOTE}）· 20040 · 10005。`,
  dataNote: 'data: provider 列表（service.list 形状）。',
})

register({
  method: 'post',
  path: '/api/v1/containers/{name}/models/providers',
  tag: 'Models',
  summary: '新建 provider（唯一(ownerId, providerId)，#771 归属上移）',
  auth: 'user',
  errors: `90002（字段明细含 base_url 白名单未命中/DNS 私网拒绝，body 校验在容器/越权之后）· 20040 · 20043 · 40041（pid 冲突）。`,
  dataNote: 'data: 新建 provider（service.create 形状；事务内 config_meta version bump = 热生效信号）。',
  body: modelProviderWriteSchema,
})

register({
  method: 'get',
  path: '/api/v1/containers/{name}/models/providers/{pid}',
  tag: 'Models',
  summary: '回读单条 provider',
  auth: 'user',
  errors: `90002（${CONTAINER_PATH_NOTE}）· 20040 · 40040（不存在/越权同码防探测）· 10005。`,
  dataNote: 'data: provider（service.get 形状）。',
})

register({
  method: 'put',
  path: '/api/v1/containers/{name}/models/providers/{pid}',
  tag: 'Models',
  summary: '改 provider（路径 pid 定位，body 可改 provider_id）',
  auth: 'user',
  errors: `90002（含 base_url 白名单未命中）· 20040 · 20043 · 40040 · 40041（撞同 owner 既有 pid）。`,
  dataNote: 'data: 更新后 provider。',
  body: modelProviderWriteSchema,
})

register({
  method: 'delete',
  path: '/api/v1/containers/{name}/models/providers/{pid}',
  tag: 'Models',
  summary: '删 provider（version bump 热生效）',
  auth: 'user',
  errors: `90002 · 20040 · 20043 · 40040。`,
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

// ---- 文件 /api/v1/containers/{name}/files（ADR 0012 统一文件 CRUD；#776 root=lab 换轨）----

register({
  method: 'get',
  path: '/api/v1/containers/{name}/files',
  tag: '文件',
  summary: '列目录 / 读文件（stopped 容器可读）',
  auth: 'user',
  errors: `90002（data.name|data.root|data.path）· 20040（容器面：容器不存在/越权）· 50002（lab 面：会话不存在/越权）· 60040（文件不存在）· 10005。`,
  dataNote:
    'root=wiki：path 指目录 → { files: [{ path, type, size, modified }] }；指文件 → { path, content, size, modified }。' +
    'root=workspace：legacy 只读消费值（现存前端 fileTabs；#793 迁 lab 后退役）。' +
    'root=lab（#776）：同形读面指向会话沙箱 /lab，{name} 为 sessionId；只读 GET，不触发沙箱创建。',
  query: z.object({
    root: z.enum(['wiki', 'workspace', 'lab']),
    path: z.string().optional().describe('相对路径；空 = 树根'),
    recursive: z.enum(['true', 'false']).optional().describe('仅字面 true 递归'),
  }),
})

register({
  method: 'get',
  path: '/api/v1/containers/{name}/files/raw',
  tag: '文件',
  summary: 'workspace 图片字节（WebChat 媒体白名单；legacy 通道，T0 随 legacy 退役 #801）',
  auth: 'user',
  errors: `90002（非 workspace 前缀/穿越/非白名单扩展名 → data.path）· 20040 · 60040。`,
  dataNote: '错误面走信封；白名单 png/jpg/jpeg/webp/gif。注意：本端点是 legacy 容器媒体通道——「workspace」仅在此遗留通道内出现，root 契约（#776）为 wiki|lab。',
  query: z.object({ path: z.string().describe('legacy 容器 workspace 树内绝对路径') }),
  bytes: 'image/png, image/jpeg 或 image/webp/gif（按扩展名）',
})

register({
  method: 'put',
  path: '/api/v1/containers/{name}/files',
  tag: '文件',
  summary: '覆写已存在文本文件',
  auth: 'user',
  errors: `90002（data.name|data.root|data.path|data.content 明细）· 20040 · 60040 · 10005。`,
  dataNote: 'data: { path }。',
  bodyNote: `${FILE_WRITE_BODY_NOTE}字段：root、path（非空，穿越拒）、content（string）。`,
})

register({
  method: 'post',
  path: '/api/v1/containers/{name}/files',
  tag: '文件',
  summary: '新建文本文件（已存在 → 60041）',
  auth: 'user',
  errors: `90002 · 20040 · 60041（冲突）· 10005。`,
  dataNote: 'data: { path }。',
  bodyNote: `${FILE_WRITE_BODY_NOTE}字段同 PUT。`,
})

register({
  method: 'delete',
  path: '/api/v1/containers/{name}/files',
  tag: '文件',
  summary: '删文件（目录 → 90002；stopped 先 start 再 rm；写面收敛：root=lab/workspace → 90002 data.root）',
  auth: 'user',
  errors: `90002（data.name|data.root|data.path）· 20040 · 60040 · 10005。`,
  nullData: true,
  query: z.object({
    root: z.enum(['wiki', 'workspace', 'lab']),
    path: z.string().describe('相对路径（非空）'),
  }),
})

// ---- Figures /api/v1/figures（AutoFigure 域开关；未启用时整树 90005）----

register({
  method: 'post',
  path: '/api/v1/figures',
  tag: 'Figures',
  summary: '幂等创建 Figure + 1:1 GenerationJob（T01/T02）',
  auth: 'user',
  errors:
    '90002（缺/超长 Idempotency-Key 头（data null）或字段明细）· 70041（同 key 不同输入，幂等冲突）· 10005。',
  dataNote: 'data: { figure, job } 当前应用级状态；同 key 同输入 → 零写入重放。',
  headers: z.object({ 'Idempotency-Key': z.string().describe('必填幂等键') }),
  body: figureCreateSchema,
})

register({
  method: 'get',
  path: '/api/v1/figures',
  tag: 'Figures',
  summary: 'Figure 历史（本人；admin 全部）',
  auth: 'user',
  errors: '10001 · 10005。',
  dataNote: 'data: Figure 列表（createdAt DESC + id DESC；无分页）。',
})

register({
  method: 'get',
  path: '/api/v1/figures/{id}',
  tag: 'Figures',
  summary: 'Figure metadata + 状态（T05）',
  auth: 'user',
  errors: '70040（不存在/越权同码防枚举）· 10005。',
  dataNote: 'data: metadata + 应用级状态 + 非敏感失败原因。',
})

register({
  method: 'get',
  path: '/api/v1/figures/{id}/png',
  tag: 'Figures',
  summary: '下载 PNG 字节（T06；成功豁免信封）',
  auth: 'user',
  errors: '70040 · 70042（queued/running 未就绪）· 70043（failed/产物缺失）。',
  bytes: 'image/png',
})
