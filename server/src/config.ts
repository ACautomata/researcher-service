import 'dotenv/config'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { isQuotaValid, QUOTA_MAX } from './auth/quota'
import { parseEncryptionKeys } from './crypto'

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

// 意见⑦[P2]（Codex 第三轮）：端口池环境值未校验 —— Number(env) 接受 NaN/小数/负/超 65535，
// 服务照常启动（PortAllocator 只查 end<start），create 时才异常（误报池耗尽 / 坏端口落 docker）。
// 修复：加载即校验两个端口池值为合法 TCP 端口整数（[1, 65535]）且 end ≥ start，非法 fail-fast。
// 与 PortAllocator 构造期检查解耦（后者仅防御 end<start，不查端口取值范围）。
function readPortPoolValue(raw: string | undefined, fallback: number, field: string): number {
  const v = Number(raw ?? fallback)
  if (!Number.isInteger(v) || v < 1 || v > 65535) {
    throw new Error(
      `${field} 非法: ${JSON.stringify(raw)}，须为 [1, 65535] 的 TCP 端口整数`,
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

// OPENCLAW_FLEET_WS_SCHEME（code review F2）：隧道连容器网关的 URL scheme。平移 Django
// settings.OPENCLAW_FLEET['SCHEME']（deploy 注释：生产在网关开 tls 后切 wss）。默认 ws
//（loopback 明文）；非法值 fail-fast（防 `SCHEME=http` 这类错值静默拼出坏 URL，隧道全 4402）。
function readHealthScheme(): string {
  const v = process.env.OPENCLAW_FLEET_WS_SCHEME ?? 'ws'
  if (v !== 'ws' && v !== 'wss') {
    throw new Error(`OPENCLAW_FLEET_WS_SCHEME 非法: ${JSON.stringify(v)}，须为 ws 或 wss`)
  }
  return v
}

// OPENCLAW_FLEET_ROOT（Codex 第七轮 #4）：相对路径时 path.join 保留相对性 → instances/<id>/home 与
// openclaw.json 作 Docker bind source 非绝对（Docker bind source 须绝对）→ POST 返 creating、后台
// provisioning 失败留 error 行（部署故障静默掩盖，与 OPENCLAW_TEMPLATE_DIR 第六轮同类）。生产强制
// 绝对路径（对齐 readTemplateDir），显式相对 fail-fast；缺省走 cwd/fleet 绝对兜底；dev/test 保持容忍。
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

// PANEL_PUBLIC_ORIGIN（#385 生产 Origin 接线）：面板对外的 origin（浏览器经它访问面板），后端
// 隧道连容器网关时作为 WS Origin header 携带，且须在容器 openclaw.json 的
// gateway.controlUi.allowedOrigins 内（真网关 2026.7.1 实测校验，PR #384）。生产缺省/非法 →
// fail-fast（对齐 readTemplateDir/readSecret 前置校验模式）——缺配时 ChatView 对真网关
// CONTROL_UI_ORIGIN_NOT_ALLOWED 拒连，且容器配置渲染须在 create 前就知道该值。dev 默认
// 127.0.0.1:18789（与网关默认 seed 一致，本地零配置）。URL 规范化：取 new URL().origin
// （去掉 path/query），保证 Origin header 与 allowedOrigins 条目形态一致。
function readPanelOrigin(): string {
  const raw = process.env.PANEL_PUBLIC_ORIGIN
  const fallback = 'http://127.0.0.1:18789'
  const value = raw ?? fallback
  let url: URL
  try {
    url = new URL(value)
  } catch {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `PANEL_PUBLIC_ORIGIN 非法（须为 http(s)://<host>[:<port>] 完整 URL，如 https://panel.example.com）: ${JSON.stringify(raw)}`,
      )
    }
    return fallback
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `PANEL_PUBLIC_ORIGIN 协议非法（须 http/https，WS Origin 语义）: ${JSON.stringify(raw)}`,
      )
    }
    return fallback
  }
  if (process.env.NODE_ENV === 'production' && raw === undefined) {
    throw new Error(
      'PANEL_PUBLIC_ORIGIN 必须在生产环境显式提供（面板对外 origin，如 https://panel.example.com；隧道连网关 + 容器 allowedOrigins 依赖它）',
    )
  }
  return url.origin
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
  // ---- 容器编排（#334 M2；平移 Django settings.OPENCLAW_FLEET / REDIS_URL）----
  fleet: (() => {
    const portStart = readPortPoolValue(process.env.OPENCLAW_PORT_POOL_START, 19000, 'OPENCLAW_PORT_POOL_START')
    const portEnd = readPortPoolValue(process.env.OPENCLAW_PORT_POOL_END, 19999, 'OPENCLAW_PORT_POOL_END')
    // 交叉校验：end < start 须启动期 fail-fast（修前只靠 PortAllocator 运行时检查，create 时才报）。
    if (portEnd < portStart) {
      throw new Error(
        `端口池非法: OPENCLAW_PORT_POOL_END(${portEnd}) < OPENCLAW_PORT_POOL_START(${portStart})`,
      )
    }
    return {
      // instances/<id>/ 落盘根（生产须绝对路径 → readFleetRoot fail-fast；缺省 <cwd>/fleet 绝对）
      root: readFleetRoot(),
      // 共享只读模板（cp -a 预填充源；生产必填绝对路径 → readTemplateDir fail-fast）
      templateDir: readTemplateDir(),
      // openclaw.json 模板文件（配置单一来源）
      templateJson: process.env.OPENCLAW_TEMPLATE_JSON ?? `${process.cwd()}/../deploy/openclaw.json`,
      // OpenClaw 容器镜像：默认本仓库派生镜像（ghcr.io/.../openclaw，ADR 0013：pdftotext +
      // wiki/workspace 骨架，CD 随发布构建推送）；可用 OPENCLAW_IMAGE 覆盖（如官方基线）
      image:
        process.env.OPENCLAW_IMAGE ?? 'ghcr.io/acautomata/researcher-service/openclaw:latest',
      portStart,
      portEnd,
      // 全面板共享 LLM_API_KEY（敏感值）；生产必填（create 时前置校验 → 90003）
      llmApiKey: process.env.LLM_API_KEY ?? '',
      // 容器 gateway 端口宿主侧发布地址（本地 loopback；生产后端容器化后 0.0.0.0）
      publishHost: process.env.OPENCLAW_FLEET_PORT_BIND_HOST ?? '127.0.0.1',
      // 健康探测目标 host（与 WS 配对同源）
      healthHost: process.env.OPENCLAW_FLEET_WS_HOST ?? '127.0.0.1',
      // 面板对外 origin（#385）：隧道连网关的 WS Origin + 容器 allowedOrigins 强制条目（生产必填）
      panelOrigin: readPanelOrigin(),
      // 容器网关 WS 传输 scheme（ws/wss；生产 TLS 后切 wss，readHealthScheme 校验）
      healthScheme: readHealthScheme(),
      // 凭证加密密钥（gateway token 落盘密文；生产 CREDENTIAL_ENCRYPTION_KEYS 必填，dev 固定密钥）
      encryptionKeys: parseEncryptionKeys(process.env.CREDENTIAL_ENCRYPTION_KEYS),
    }
  })(),
  // BullMQ worker 并发上限（默认 2，对齐旧 ThreadPoolExecutor(2)）
  lifecycleWorkerConcurrency: Number(process.env.LIFECYCLE_WORKER_CONCURRENCY ?? 2),
  // BullMQ/Redis 连接（#313 自本切片引入；后台 provisioning 队列）
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
}

// refresh cookie 公共属性（规格 #311 锁）：HttpOnly + Secure(prod) + SameSite=Lax + Path=/api/v1/auth
export const REFRESH_COOKIE = 'refresh_token'
export const REFRESH_COOKIE_PATH = '/api/v1/auth'
