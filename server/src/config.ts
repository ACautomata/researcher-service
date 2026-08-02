import 'dotenv/config'
import path from 'node:path'
import { isQuotaValid, QUOTA_MAX } from './auth/quota'

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

// REDIS_URL / PORT_POOL 等 M2 配置（#334）：dev 友好默认；缺 Redis 时编排队列容错降级。
function readPortRange(key: string, def: number): number {
  const v = Number(process.env[key] ?? def)
  if (!Number.isInteger(v)) {
    throw new Error(`${key} 非法: ${JSON.stringify(process.env[key])}，须为整数`)
  }
  return v
}

// PROVISION_WORKERS（#334）：BullMQ worker 并发，默认 2（规格 §F 锁）。
function readProvisionWorkers(): number {
  const v = Number(process.env.PROVISION_WORKERS ?? 2)
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`PROVISION_WORKERS 非法: ${JSON.stringify(process.env.PROVISION_WORKERS)}，须为 ≥1 整数`)
  }
  return v
}

// GATEWAY_TOKEN_BYTES（#334）：token 熵（spec §5.2 锁 32 字节 = 256 bit）。仅允许正整数。
function readGatewayTokenBytes(): number {
  const v = Number(process.env.GATEWAY_TOKEN_BYTES ?? 32)
  if (!Number.isInteger(v) || v < 16) {
    throw new Error(`GATEWAY_TOKEN_BYTES 非法: ${JSON.stringify(process.env.GATEWAY_TOKEN_BYTES)}，须为 ≥16 整数`)
  }
  return v
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
  // ── M2 容器编排（#334）──
  // codex 七轮 P1：FLEET_ROOT resolve 绝对路径——docker bind 源必须绝对，相对路径（如 .env.example
  // 的 ./fleet）会致每次 create 失败 "invalid bind specification"。
  fleetRoot: path.resolve(process.env.FLEET_ROOT ?? `${process.cwd()}/fleet`), // instances/<name>/ 落盘根
  openclawTemplateDir: process.env.OPENCLAW_TEMPLATE_DIR ?? '', // cp -a 源；空 = 未配（provision 时 fail-fast）
  openclawTemplateJson: process.env.OPENCLAW_TEMPLATE_JSON ?? '', // openclaw.json 模板文件路径
  openclawImage: process.env.OPENCLAW_IMAGE ?? 'ghcr.io/openclaw/openclaw:2026.7.1-browser',
  llmApiKey: process.env.LLM_API_KEY ?? '', // 全面板共享（env 注入容器，不落盘）
  portPoolStart: readPortRange('PORT_POOL_START', 19000),
  portPoolEnd: readPortRange('PORT_POOL_END', 19999),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  provisionWorkers: readProvisionWorkers(),
  gatewayTokenBytes: readGatewayTokenBytes(),
}

// refresh cookie 公共属性（规格 #311 锁）：HttpOnly + Secure(prod) + SameSite=Lax + Path=/api/v1/auth
export const REFRESH_COOKIE = 'refresh_token'
export const REFRESH_COOKIE_PATH = '/api/v1/auth'
