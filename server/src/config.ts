import 'dotenv/config'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { isQuotaValid, QUOTA_MAX } from './auth/quota'
import { isFloatingImageRef } from './containers/imageRef'
import { parseEncryptionKeys } from './crypto'
import { DEFAULT_RECURSION_LIMIT } from './runner/runtime/values'
import { APPROVAL_TIMEOUT_MS } from './runner/approval/values'
import { DEFAULT_WRITE_LOCK_TIMEOUT_MS } from './runner/writelock/registry'

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

// OPENCLAW_TEMPLATE_DIR（Codex 第六轮 P2）：生产 home 模板目录漏设/拼错时，旧实现走 ../researcher
// 兜底照常启动，首 POST 才在后台 HomeProvisioner.provision() 的 cp() 失败留 error 行——部署故障被
// 静默掩盖（与 issue #195「卡 creating」同类：漏配只在请求期才暴露）。生产强制绝对/存在/可读目录，
// 非法 fail-fast（与 JWT_SECRET 生产校验同模式）；dev/test 保持兜底（本地模板未就位也能起服务调试）。
function readTemplateDir(): string {
  const raw = process.env.OPENCLAW_TEMPLATE_DIR
  if (process.env.NODE_ENV === 'production') {
    if (!raw) {
      throw new Error('OPENCLAW_TEMPLATE_DIR 必须在生产环境显式提供（home 模板源目录，生产必填）')
    }
    if (!path.isAbsolute(raw)) {
      throw new Error(`OPENCLAW_TEMPLATE_DIR 须为绝对路径（防 cwd 漂移错配）: ${JSON.stringify(raw)}`)
    }
    if (!existsSync(raw)) {
      throw new Error(`OPENCLAW_TEMPLATE_DIR 不存在: ${raw}`)
    }
    if (!statSync(raw).isDirectory()) {
      throw new Error(`OPENCLAW_TEMPLATE_DIR 不是目录: ${raw}`)
    }
    try {
      accessSync(raw, constants.R_OK)
    } catch {
      throw new Error(`OPENCLAW_TEMPLATE_DIR 不可读: ${raw}`)
    }
    return raw
  }
  return raw ?? `${process.cwd()}/../researcher`
}

// OPENCLAW_FLEET_ROOT：instances/<id>/ 落盘根。named volume 拓扑（#590/#592 默认开，ADR 0011）下为
// 容器内工作目录——instanceDir/provision 落容器私有根，OpenClaw 容器不 bind 宿主树（/fleet 绑定已随
// #593/#595 从 prod compose 移除），容器重建即空、create 幂等重建。显式 false 回退旧 bind 模式时
// 该根作 Docker bind source——相对路径时 path.join 保留相对性 → instances/<id>/home source 非绝对
//（Docker bind source 须绝对）→ POST 返 creating、后台 provisioning 失败留 error 行（部署故障静默
// 掩盖，与 OPENCLAW_TEMPLATE_DIR 第六轮同类）。生产强制绝对路径（对齐 readTemplateDir），
// 显式相对 fail-fast；缺省走 cwd/fleet 绝对兜底；dev/test 保持容忍。
function readFleetRoot(): string {
  const raw = process.env.OPENCLAW_FLEET_ROOT
  const fallback = `${process.cwd()}/fleet`
  if (process.env.NODE_ENV === 'production' && raw !== undefined && !path.isAbsolute(raw)) {
    throw new Error(
      `OPENCLAW_FLEET_ROOT 须为绝对路径（Docker bind source 须绝对，否则 POST 返 creating、后台 provisioning 失败）: ${JSON.stringify(raw)}`,
    )
  }
  return raw ?? fallback
}

// OPENCLAW_IMAGE（#695 钉版纪律；T0 #801 起 openclaw-image 派生镜像构建退役——镜像引用仍钉版，
// 存量 GHCR 镜像可继续拉取）：容器 fleet 的目标镜像。生产浮动引用（无 tag 或 :latest）→ 启动
// fail-fast：浮动 tag 让创建行为不可复现/不可 review。dev/test 容忍浮动（本地调试可覆盖回官方
// :latest）。**无 dev 旁路分支**（父 spec #693 §2.1「dev 不旁路检测机制」= 不为 dev 另写一条路径）：
// dev/prod 共用本函数与同一准据 isFloatingImageRef，仅按 NODE_ENV 决定是否抛错——「生产必拦 /
// dev 放行」是同一判定的两种门控结果，不是两套实现。
// 钉版镜像引用读取三处共用内核（OPENCLAW_IMAGE #695 / SANDBOX_IMAGE #776 / WIKI_IMAGE #784，
// 同一判定与文案形状——本函数收口防第四处拷贝）：生产浮动引用 fail-fast，dev/test 放行
//（「生产必拦 / dev 放行」是同一判定的两种门控结果，不是两套实现）。
// versionSource：错误文案里的版本源指引（无独立版本源钉版的镜像——如过渡期 busybox——省略）。
function readPinnedImage(envVar: string, fallback: string, versionSource?: string): string {
  const v = process.env[envVar] ?? fallback
  if (process.env.NODE_ENV === 'production' && isFloatingImageRef(v)) {
    const note = versionSource ? `（版本源见 ${versionSource}）` : ''
    throw new Error(`${envVar} 为浮动镜像引用（无 tag 或 :latest）: ${JSON.stringify(v)}，生产须钉精确版本 tag${note}`)
  }
  return v
}

function readFleetImage(): string {
  return readPinnedImage(
    'OPENCLAW_IMAGE',
    'ghcr.io/acautomata/researcher-service/openclaw:2026.9.4-browser',
  )
}

// WIKI_IMAGE（#784 · #747 E 节 wiki 列）：wiki 容器镜像——busybox 级极简（sh/mkdir/rm/cat
// 基础 applet，无运行时），零初始化（无骨架 COPY，/wiki 属主由创建面 putArchive 预置）。
// 默认 = 本仓库派生镜像 + 精确版本 tag（版本源 = deploy/wiki-image/Dockerfile FROM 基线
// busybox tag，两处明文由 wikiImage.test.ts 交叉断言锁死，CD 随发布构建推送）。可用 WIKI_IMAGE
// 覆盖（生产浮动引用 fail-fast，readFleetImage 同款判定/同款文案形状）。
function readWikiImage(): string {
  return readPinnedImage(
    'WIKI_IMAGE',
    'ghcr.io/acautomata/researcher-service/wiki:1.36',
    'deploy/wiki-image/Dockerfile FROM 基线',
  )
}

// OPENCLAW_NAMED_VOLUMES（#590/#592，ADR 0011）：容器持久化是否用 named volume 拓扑——
// openclaw-wiki/workspace/home-<id> 三卷（按代系 id 派生）替代宿主 bind-mount home。
// 默认 true = named volume 拓扑（#592 编排默认：新容器走三卷，旧 host bind
// 路径退场）；显式 false 回退旧 bind 模式。默认对本地/CI/生产同效（deploy 不设该变量）。
// 非 true/false 值 fail-fast——否则 `TRUE`/`1` 这类错值
// 静默按默认 true 走，flag 关了却没生效。
function readNamedVolumes(): boolean {
  const v = process.env.OPENCLAW_NAMED_VOLUMES
  if (v === undefined) return true
  if (v === 'true') return true
  if (v === 'false') return false
  throw new Error(
    `OPENCLAW_NAMED_VOLUMES 非法: ${JSON.stringify(v)}，须为 true 或 false（named volume 拓扑开关，ADR 0011）`,
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
//（无 tag 或 :latest）→ fail-fast（对齐 readFleetImage：沙箱同样要可复现/可 review）；
// 资源 limit 与闲置阈值是规格常数（#747 开放点 8 待实测校准），不走 env——防部署配置漂移
// 出一万个规格分叉（校准是代码变更，须随版锁定）。
function readSandboxImage(): string {
  return readPinnedImage('SANDBOX_IMAGE', 'busybox:1.36')
}

// ALLOW_PRIVATE_PROVIDER_ENDPOINTS（#775，731 §5.1）：CRUD 层 DNS 私网/环回拒绝的逃生开关。
// 默认 false —— 用户配 baseUrl 时解析到私网/环回/链路本地一律拒（防借白名单条目做内网探测 +
// prompt injection 外送 key）；自建私网端点（dev vLLM 等）显式 true 放行。生产 fail-fast 禁开
// （对齐根决策「生产仅 https + 公网端点」；dev/test 容忍 true）。
function readAllowPrivateProviderEndpoints(): boolean {
  const v = process.env.ALLOW_PRIVATE_PROVIDER_ENDPOINTS
  if (v === undefined) return false
  if (v === 'true') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ALLOW_PRIVATE_PROVIDER_ENDPOINTS 生产禁开（端点白名单 DNS 私网校验的逃生开关仅限 dev）')
    }
    return true
  }
  if (v === 'false') return false
  throw new Error(
    `ALLOW_PRIVATE_PROVIDER_ENDPOINTS 非法: ${JSON.stringify(v)}，须为 true 或 false（私网端点放行开关，默认关）`,
  )
}

// LLM_API_KEY 单一读取点：fleet.llmApiKey（容器 env 注入面）与 runner.llmApiKey（#775
// runner 侧 credentialEnvId 解析面）共享同值——读两处则轮换时可能漂移；字段名两侧各自保留
// 以维持既有消费面。
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
  // ---- 容器编排（#334 M2；平移 Django settings.OPENCLAW_FLEET / REDIS_URL；T0 #801 清退：
  // 端口池/隧道寻址/健康探针/openclaw.json 模板配置随 legacy 组件退役）----
  fleet: (() => {
    return {
      // instances/<id>/ 落盘根（生产须绝对路径 → readFleetRoot fail-fast；缺省 <cwd>/fleet 绝对）
      root: readFleetRoot(),
      // 共享只读模板（cp -a 预填充源 + named volume 模式 seedWorkspace 灌卷源；
      // 生产必填绝对路径 → readTemplateDir fail-fast）
      templateDir: readTemplateDir(),
      // OpenClaw 容器镜像：默认钉版 ghcr 派生镜像（T0 起 openclaw-image 构建退役，存量镜像可拉；
      // 生产禁浮动 tag → readFleetImage fail-fast）
      image: readFleetImage(),
      // 全面板共享 LLM_API_KEY（敏感值）；生产必填（create 时前置校验 → 90003）
      //（单一读取点 LLM_API_KEY_RAW，runner.llmApiKey 同源）
      llmApiKey: LLM_API_KEY_RAW,
      // #590/#592 named volume 拓扑开关（默认开 = 三卷拓扑；显式 false 回退旧 bind，ADR 0011）
      namedVolumes: readNamedVolumes(),
      // 凭证加密密钥（gateway token 落盘密文；生产 CREDENTIAL_ENCRYPTION_KEYS 必填，dev 固定密钥）
      encryptionKeys: parseEncryptionKeys(process.env.CREDENTIAL_ENCRYPTION_KEYS),
    }
  })(),
  // BullMQ worker 并发上限（默认 2，对齐旧 ThreadPoolExecutor(2)）
  lifecycleWorkerConcurrency: Number(process.env.LIFECYCLE_WORKER_CONCURRENCY ?? 2),
  // BullMQ/Redis 连接（#313 自本切片引入；后台 provisioning 队列）
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
      // CRUD 层 DNS 私网校验逃生开关（默认关；生产禁开）
      allowPrivateProviderEndpoints: readAllowPrivateProviderEndpoints(),
      // 共享 LLM key 解析源：credentialEnvId='LLM_API_KEY' 的 provider 行经此取值
      //（单一读取点 LLM_API_KEY_RAW，与 fleet.llmApiKey 同源——#731 §1.3「runner 直接持有凭证」）
      llmApiKey: LLM_API_KEY_RAW,
      // 审批三层漏斗 judge 模型（#783 · 729 §2.5「独立小模型，与主模型解耦」）：部署级配置
      //（RUNNER_JUDGE_MODEL + RUNNER_JUDGE_BASE_URL，key 复用 LLM_API_KEY；lcProvider 二值，
      // 默认 openai 兼容面）。二者任缺 → judge 未启用（灰区一律升级人工——fail-closed，
      // 729 §2.3 校验再败同语义）。judge 出口不走 provider_endpoints 白名单：env 是 admin
      // 信任面（与 LLM_API_KEY 同级），白名单治理的是用户可配的 provider 面。
      judge: {
        model: readOptionalEnv('RUNNER_JUDGE_MODEL'),
        baseUrl: readOptionalEnv('RUNNER_JUDGE_BASE_URL'),
        lcProvider: (readOptionalEnv('RUNNER_JUDGE_LC_PROVIDER') === 'anthropic'
          ? 'anthropic'
          : 'openai') as 'openai' | 'anthropic',
      },
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
