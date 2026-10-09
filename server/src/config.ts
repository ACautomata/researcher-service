import 'dotenv/config'
import path from 'node:path'
import { isQuotaValid, QUOTA_MAX } from './auth/quota'
import { isFloatingImageRef } from './containers/imageRef'
import { DEFAULT_RECURSION_LIMIT } from './runner/runtime/values'
import { APPROVAL_TIMEOUT_MS } from './runner/approval/values'
import { DEFAULT_WRITE_LOCK_TIMEOUT_MS } from './runner/writelock/registry'
import { PRESET_IDS } from './models/presets'

// 控制面配置：全部来自环境变量，带 dev 友好默认。生产缺关键项时 fail-fast。
// 规格 §A：JWT 密钥 = HS256 对称（平移现状 SECRET_KEY 语义）；access/refresh 寿命平移 simplejwt 默认。

// JWT_SECRET（Codex #342 ⑰ P1）：生产仅挡占位符不够 —— `JWT_SECRET=a` 这类弱值也能签发
// HS256 access token，攻击者离线爆破后伪造 admin token。生产须 ≥32 字符（256 bit HS256 安全
// 惯例，对齐 jose 对称密钥推荐），不足即 fail-fast。dev/test 保持任意非空可用（本地调试）。
function readSecret(): string {
  const v = process.env.JWT_SECRET
  if (v && v !== 'change-me-in-production') {
    if (process.env.NODE_ENV === 'production' && v.length < 32) {
      throw new Error(
        `JWT_SECRET 过弱: ${v.length} 字符 < 32，生产须提供 ≥32 字符强随机密钥（HS256 256bit 安全下限）`,
      )
    }
    return v
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET 必须在生产环境显式提供强随机值')
  }
  // eslint-disable-next-line no-console
  console.warn('[config] JWT_SECRET 未设置，使用 dev 不安全默认。切勿用于生产。')
  return 'dev-insecure-secret-change-in-production'
}

// DEFAULT_MAX_CONTAINERS 默认配额（Codex #342 ⑬ P2）：加载即校验，非法（负/非数/超 Int 上界）
// fail-fast，杜绝 createUser/bootstrap fallback 把 NaN/超界值写库（否则 Prisma 拒写 90000 或存非法配额）。
// 与 userService.assertQuotaValid 共享 isQuotaValid 准据；此处抛 Error（启动期，非请求期 envelope）。
function readDefaultMaxContainers(): number {
  const v = Number(process.env.DEFAULT_MAX_CONTAINERS ?? 3)
  if (!isQuotaValid(v)) {
    throw new Error(
      `DEFAULT_MAX_CONTAINERS 非法: ${JSON.stringify(process.env.DEFAULT_MAX_CONTAINERS)}，须为 [0, ${QUOTA_MAX}] 整数`,
    )
  }
  return v
}

// BCRYPT_COST（Codex #342 ⑯ P2）：规格锁 12（.env.example/README 明文）。时序侧信道防护依赖
// DUMMY_BCRYPT_HASH(cost=12) 与真实 hash 同 cost —— 若允许覆盖为非 12，dummy(12) 与真实 hash
// 的耗时差恢复账号存在性探测。故启动强制 =12，非法 fail-fast（与 JWT_SECRET 生产校验同模式）。
function readBcryptCost(): number {
  const raw = process.env.BCRYPT_COST ?? '12'
  const v = Number(raw)
  if (!Number.isInteger(v) || v !== 12) {
    throw new Error(
      `BCRYPT_COST 非法: ${JSON.stringify(process.env.BCRYPT_COST)}，规格锁 12（时序侧信道依赖固定 cost），不可覆盖`,
    )
  }
  return v
}

// BOOTSTRAP_ADMIN_USERNAME（Codex #342 ㉑ P2）：空串视为缺失 —— Compose 未设置变量替换成空串
// 时 `?? 'admin'` 不触发（空串非 nullish），bootstrap 会建 username="" 的唯一 admin，而
// loginSchema min(1) 拒绝空串 → 永久不可登录、重启又因 users 非空跳过 bootstrap。空串回退默认。
function readBootstrapUsername(): string {
  const v = process.env.BOOTSTRAP_ADMIN_USERNAME
  if (typeof v === 'string' && v.trim() !== '') return v
  return 'admin'
}

// REFRESH_TOKEN_TTL（Codex #342 ㉓ P2）：启动期校验 TTL 格式（与 tokens.parseTtlToMs 同正则），
// 非法 fail-fast —— 否则 `REFRESH_TOKEN_TTL=7days` 这类错值 server 正常起、首个 login 才在
// refreshExpiresAt() 抛 90000，所有会话签发请求都坏而 health 却绿。
function readRefreshTtl(): string {
  const v = process.env.REFRESH_TOKEN_TTL ?? '7d'
  if (!/^(\d+)([smhd])$/.test(v.trim())) {
    throw new Error(
      `REFRESH_TOKEN_TTL 非法: ${JSON.stringify(process.env.REFRESH_TOKEN_TTL)}，须为 <数字><单位>（s/m/h/d，如 7d）`,
    )
  }
  return v
}

// DATA_ROOT（#858 前身 OPENCLAW_FLEET_ROOT）：控制面私有落盘根——现役唯一消费方 = 附件上传
// 临时区 <dataRoot>/attachments（#780；run 首步 ingestion 搬进沙箱后即弃）。生产强制绝对路径
//（对齐模板目录校验先例），显式相对 fail-fast；缺省走 cwd/data 绝对兜底；dev/test 保持容忍。
function readDataRoot(): string {
  const raw = process.env.DATA_ROOT
  const fallback = `${process.cwd()}/data`
  if (process.env.NODE_ENV === 'production' && raw !== undefined && !path.isAbsolute(raw)) {
    throw new Error(
      `DATA_ROOT 须为绝对路径（容器内工作目录，防 cwd 漂移错配）: ${JSON.stringify(raw)}`,
    )
  }
  return raw ?? fallback
}

// 钉版镜像引用读取共用内核（SANDBOX_IMAGE #776 / WIKI_IMAGE #784，同一判定与文案形状——
// 本函数收口防拷贝；#858 起 OPENCLAW_IMAGE 随 fleet 退役）：生产浮动引用 fail-fast，dev/test
// 放行（「生产必拦 / dev 放行」是同一判定的两种门控结果，不是两套实现）。
// versionSource：错误文案里的版本源指引（无独立版本源钉版的镜像——如过渡期 busybox——省略）。
function readPinnedImage(envVar: string, fallback: string, versionSource?: string): string {
  const v = process.env[envVar] ?? fallback
  if (process.env.NODE_ENV === 'production' && isFloatingImageRef(v)) {
    const note = versionSource ? `（版本源见 ${versionSource}）` : ''
    throw new Error(`${envVar} 为浮动镜像引用（无 tag 或 :latest）: ${JSON.stringify(v)}，生产须钉精确版本 tag${note}`)
  }
  return v
}

// WIKI_IMAGE（#784 · #747 E 节 wiki 列）：wiki 容器镜像——busybox 级极简（sh/mkdir/rm/cat
// 基础 applet，无运行时），零初始化（无骨架 COPY，/wiki 属主由创建面 putArchive 预置）。
// 默认 = 本仓库派生镜像 + 精确版本 tag（版本源 = deploy/wiki-image/Dockerfile FROM 基线
// busybox tag，两处明文由 wikiImage.test.ts 交叉断言锁死，CD 随发布构建推送）。可用 WIKI_IMAGE
// 覆盖（生产浮动引用 fail-fast，readPinnedImage 同款判定/同款文案形状）。
function readWikiImage(): string {
  return readPinnedImage(
    'WIKI_IMAGE',
    'ghcr.io/acautomata/researcher-service/wiki:1.36',
    'deploy/wiki-image/Dockerfile FROM 基线',
  )
}

// API_DOCS_ENABLED（#761）：OpenAPI/Swagger 文档面开关（/api/docs）。默认 true —— 文档面 admin-only
//（requireAuth + requireAdmin）且为启动期静态生成，无敏感数据；生产可显式 false 关闭（装配层不注入
// docs deps → 路由未挂载 → 90005）。非法值 fail-fast（对齐 readNamedVolumes 白名单模式）。
function readApiDocsEnabled(): boolean {
  const v = process.env.API_DOCS_ENABLED
  if (v === undefined) return true
  if (v === 'true') return true
  if (v === 'false') return false
  throw new Error(
    `API_DOCS_ENABLED 非法: ${JSON.stringify(v)}，须为 true 或 false（OpenAPI 文档面开关，默认开）`,
  )
}

// RUNNER_MAX_CONCURRENT_RUNS（#775，731 §5.3）：runner 全局在飞 run 上限（进程内信号量）。
// BullMQ 原生 limiter 的 per-user 组限流是 Pro 专属（OSS 3.0 起移除 groupKey），进程内原语即
// 正确边界（#734 Notes：单进程模型）。非法值（非正整数/超上界）fail-fast（对齐 readDefaultMaxContainers
// 加载即校验模式）——否则错值静默按默认走，配额语义错配只在运行期暴露；上界防呆（1–10000，
// #812 打捞）：单位错配/滥值会打穿全局 runaway 最后防线。
function readRunnerMaxConcurrentRuns(): number {
  const v = Number(process.env.RUNNER_MAX_CONCURRENT_RUNS ?? 8)
  if (!Number.isInteger(v) || v <= 0 || v > 10_000) {
    throw new Error(
      `RUNNER_MAX_CONCURRENT_RUNS 非法: ${JSON.stringify(process.env.RUNNER_MAX_CONCURRENT_RUNS)}，须为 1–10000 整数`,
    )
  }
  return v
}

// RUNNER_RECURSION_LIMIT（#777）：图深度护栏（GraphRecursionError → run.failed{recursion_limit}，
// story 10）。默认 500 = #724 PoC 实测值（DEFAULT_RECURSION_LIMIT，values.ts 单一来源——config 层
// 只做 env 覆盖面）。非法值 fail-fast（同上对齐加载即校验）。
function readRunnerRecursionLimit(): number {
  const v = Number(process.env.RUNNER_RECURSION_LIMIT ?? DEFAULT_RECURSION_LIMIT)
  if (!Number.isInteger(v) || v <= 0 || v > 10_000) {
    throw new Error(
      `RUNNER_RECURSION_LIMIT 非法: ${JSON.stringify(process.env.RUNNER_RECURSION_LIMIT)}，须为 1–10000 整数`,
    )
  }
  return v
}

// FILE_JOURNAL_*（#782）共用读面：正整数 fail-fast（对齐 readRunnerMaxConcurrentRuns 加载即校验）。
function readPositiveEnvInt(name: string, fallback: number): number {
  const v = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(v) || v <= 0 || v > 1_000_000_000) {
    throw new Error(`${name} 非法: ${JSON.stringify(process.env[name])}，须为正整数`)
  }
  return v
}

function readPositiveEnvBytes(name: string, fallbackMb: number): number {
  return readPositiveEnvInt(name, fallbackMb) * 1024 * 1024
}

// SANDBOX_IMAGE（#776）：会话沙箱镜像——最小闭环先用 busybox（含 sh/timeout 基础 applet，
// runner backend 超时 kill 机制的镜像前提，values.ts EXEC_DEFAULT_TIMEOUT_MS 注释同源）；完整
// 工具链镜像（bash/git/Python3/Node/rg/curl/jq/…）随 #784 钉版更换默认。生产浮动引用
//（无 tag 或 :latest）→ fail-fast（readPinnedImage 共用内核：沙箱同样要可复现/可 review）；
// 资源 limit 与闲置阈值是规格常数（#747 开放点 8 待实测校准），不走 env——防部署配置漂移
// 出一万个规格分叉（校准是代码变更，须随版锁定）。
function readSandboxImage(): string {
  return readPinnedImage('SANDBOX_IMAGE', 'busybox:1.36')
}

// LLM_PRESET（#881）：平台默认端点预设（六选一，缺省 minimax）——非法值 fail-fast
//（错值静默走缺省 = 平台端点指向与部署方预期不符的服务商）。空串/纯空白 = 未设置
//（对齐 readOptionalEnv 语义）：cd.yml 对未配置的 secret 渲染 `LLM_PRESET=` 空行，经 compose
// env_file 注入空串——`??` 只挡 undefined，不挡空串。
function readLlmPreset(): string {
  const raw = process.env.LLM_PRESET
  const v = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'minimax'
  if (!PRESET_IDS.includes(v)) {
    throw new Error(
      `LLM_PRESET 非法: ${JSON.stringify(v)}，须为六预设之一（${PRESET_IDS.join(' | ')}）`,
    )
  }
  return v
}

// LLM_CREDENTIAL_SECRET（#881）：BYOK 凭证 AES-256-GCM 加密密钥。显式提供即用（dev 任意
// 非空）；生产须 ≥32 字符（对齐 JWT_SECRET 生产强度惯例——它是全部用户 BYOK key 的解密根，
// 弱值即凭证面失守）；未提供时生产 fail-fast、dev 弱默认 + warn（本地调试零配置）。
function readLlmCredentialSecret(): string {
  const v = process.env.LLM_CREDENTIAL_SECRET
  if (v !== undefined && v !== '') {
    if (process.env.NODE_ENV === 'production' && v.length < 32) {
      throw new Error(
        `LLM_CREDENTIAL_SECRET 过弱: ${v.length} 字符 < 32，生产须提供 ≥32 字符强随机密钥`,
      )
    }
    return v
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('LLM_CREDENTIAL_SECRET 必须在生产环境显式提供（BYOK 凭证加密密钥）')
  }
  // eslint-disable-next-line no-console
  console.warn('[config] LLM_CREDENTIAL_SECRET 未设置，使用 dev 不安全默认。切勿用于生产。')
  return 'dev-insecure-credential-secret'
}

// LLM_API_KEY 单一读取点：平台默认端点共享 key（#775 runner 侧解析；#881 起消费面 =
// 平台虚拟条目 + credentialCipher=NULL 的 BYOK 行）。
//（#858 fleet.llmApiKey 容器 env 注入面随 fleet 编排退役。）
const LLM_API_KEY_RAW = process.env.LLM_API_KEY ?? ''

function readOptionalEnv(name: string): string {
  const v = process.env[name]
  return typeof v === 'string' ? v.trim() : ''
}

// 审批升级超时（#783 · 729 §3.3；默认值单一来源 = approval/values.ts 的 APPROVAL_TIMEOUT_MS）
function readApprovalTimeoutMs(): number {
  const raw = process.env.RUNNER_APPROVAL_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return APPROVAL_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return APPROVAL_TIMEOUT_MS
  return Math.floor(n)
}

// 写锁有界等待（#785 · #769 锁方案「等待有界，超时向 agent 报错」；默认值单一来源 =
// writelock/registry.ts 的 DEFAULT_WRITE_LOCK_TIMEOUT_MS）。坏值回退默认（approval 超时同风格）。
function readWriteLockTimeoutMs(): number {
  const raw = process.env.RUNNER_WRITE_LOCK_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_WRITE_LOCK_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WRITE_LOCK_TIMEOUT_MS
  return Math.floor(n)
}

export const config = {
  jwtSecret: readSecret(),
  accessTtl: process.env.ACCESS_TOKEN_TTL ?? '5m',
  refreshTtl: readRefreshTtl(),
  bcryptCost: readBcryptCost(),
  bootstrapAdminUsername: readBootstrapUsername(),
  defaultMaxContainers: readDefaultMaxContainers(),
  port: Number(process.env.PORT ?? 8001),
  // 非 production（含 test）关闭 cookie Secure，便于本地 http 调试；规格锁 SameSite=Lax/HttpOnly/Path。
  cookieSecure: process.env.NODE_ENV === 'production',
  databaseUrl: process.env.DATABASE_URL ?? 'file:./prisma/panel.db',
  isTest: process.env.NODE_ENV === 'test',
  // ---- 控制面落盘根（#858 前身 fleet.root；现役唯一消费方 = 附件上传临时区）----
  // <dataRoot>/attachments（#780）：生产须绝对路径 → readDataRoot fail-fast；缺省 <cwd>/data 绝对。
  dataRoot: readDataRoot(),
  // BullMQ/Redis 连接（#777 runner run 队列；#858 起 fleet 生命周期队列退役，唯一消费方 = runner）
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
  // ---- 会话沙箱（#776 · #747 E 节沙箱列 + story 58/59）----
  sandbox: (() => {
    return {
      // 沙箱镜像（生产禁浮动 tag → readSandboxImage fail-fast；默认 busybox 最小闭环——
      // 本票 AC 不含镜像。E 节「完整工具链」镜像的拆票落点待确认（#784/#777 票面均无此项，
      // 勿挂靠不存在的承接票），确认前以 SANDBOX_IMAGE env 钉版过渡）
      image: readSandboxImage(),
    }
  })(),
  // ---- wiki 容器（#784 · #747 E 节 wiki 列：每用户一台、永久、零出网文件仓库）----
  wikiContainers: (() => {
    return {
      // wiki 容器镜像（生产禁浮动 tag → readWikiImage fail-fast；默认本仓库派生镜像 + 精确
      // 版本 tag——busybox 级极简、零初始化，版本源 deploy/wiki-image/Dockerfile FROM 基线）
      image: readWikiImage(),
    }
  })(),
  // ---- runner（#775，#747 F 节 · 731 §5）----
  runner: (() => {
    return {
      // 全局在飞 run 上限（进程内信号量；per-user 上限走 users.maxConcurrentRuns 列）
      maxConcurrentRuns: readRunnerMaxConcurrentRuns(),
      // 图深度护栏（GraphRecursionError → run.failed{recursion_limit}；默认 500 = PoC 实测值）
      recursionLimit: readRunnerRecursionLimit(),
      // 审批升级超时（729 §3.3 默认 48h；装配层注入 RunService）
      approvalTimeoutMs: readApprovalTimeoutMs(),
      // 文件 rewind 机制（#782 · #766 D8）：attic per-session 配额（对称 100MB checkpoint
      // 护栏纪律）/ 逆放深度上限（超限降级「对话照回退、文件保持现状」）/ 稳态写围栏有界等待。
      fileJournal: {
        quotaBytes: readPositiveEnvBytes('FILE_JOURNAL_ATTIC_QUOTA_MB', 100),
        depthLimit: readPositiveEnvInt('FILE_JOURNAL_REPLAY_DEPTH_LIMIT', 1000),
        fenceTimeoutMs: readPositiveEnvInt('FILE_JOURNAL_FENCE_TIMEOUT_MS', 30_000),
      },
      // #785 写锁有界等待（默认 10s；装配层注入 RunService；env RUNNER_WRITE_LOCK_TIMEOUT_MS）
      writeLockTimeoutMs: readWriteLockTimeoutMs(),
    }
  })(),
  // ---- LLM 端点域（#881）：平台默认端点 env 派生 + BYOK 凭证加密密钥 ----
  llm: (() => {
    return {
      // 平台共享 key（平台虚拟条目 / cipher=NULL 的 BYOK 行解析源；生产必填 fail-fast 归
      // runner/assembly 的 assertLlmApiKey——listen 前崩溃，健康门拦截）
      apiKey: LLM_API_KEY_RAW,
      // 平台默认端点预设（六选一；缺省 minimax）
      preset: readLlmPreset(),
      // 平台默认端点单模型覆盖（缺省 = 预设 defaultModels 全集）
      model: readOptionalEnv('LLM_MODEL'),
      // BYOK 凭证 AES-256-GCM 加密密钥（生产必填 ≥32 字符；dev 弱默认 + warn）
      credentialSecret: readLlmCredentialSecret(),
    }
  })(),
  // ---- OpenAPI 文档面（#761）----
  apiDocs: (() => {
    return {
      // 域开关：flag 关 → 装配层 server.ts 不注入 docs deps → /api/docs 未挂载（90005）。
      // flag 只在装配层消费（app.ts 不读 config，只认 deps 注入，对齐 models/files 先例）。
      enabled: readApiDocsEnabled(),
    }
  })(),
  // AutoFigure 生成配置经插件 configSchema 声明接线；figures 读面常驻。
  //（#792 · plugins/autofigure/manifest.ts 单一声明处，resolvePluginConfig 注入 ctx.config）：
  //   AUTOFIGURE_IMAGE_MODEL / AUTOFIGURE_IMAGE_API_KEY / AUTOFIGURE_IMAGE_BASE_URL(可选) /
  //   FAL_KEY / AUTOFIGURE_SVG_MODEL(可选，缺省 owner 默认链 primary)。
  // 启动期完备性校验走 assertPluginEnv（R7 生产 fail-fast / dev 警告），本文件不重复读取。
}

// refresh cookie 公共属性（规格 #311 锁）：HttpOnly + Secure(prod) + SameSite=Lax + Path=/api/v1/auth
export const REFRESH_COOKIE = 'refresh_token'
export const REFRESH_COOKIE_PATH = '/api/v1/auth'

// panel_stream cookie（SSE 只读流通道，#726 认证行 · issue #773）：HttpOnly + Secure(prod) +
// SameSite=Strict + Path=/api/v1/events（浏览器只把它发给流端点，写面零 CSRF 暴露——REST Bearer
// 全不动）。login/refresh Set-Cookie 滑动续期，logout 清除。
export const PANEL_STREAM_COOKIE = 'panel_stream'
export const PANEL_STREAM_COOKIE_PATH = '/api/v1/events'
