import 'dotenv/config'

// 控制面配置：全部来自环境变量，带 dev 友好默认。生产缺关键项时 fail-fast。
// 规格 §A：JWT 密钥 = HS256 对称（平移现状 SECRET_KEY 语义）；access/refresh 寿命平移 simplejwt 默认。

function readSecret(): string {
  const v = process.env.JWT_SECRET
  if (v && v !== 'change-me-in-production') return v
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET 必须在生产环境显式提供强随机值')
  }
  // eslint-disable-next-line no-console
  console.warn('[config] JWT_SECRET 未设置，使用 dev 不安全默认。切勿用于生产。')
  return 'dev-insecure-secret-change-in-production'
}

export const config = {
  jwtSecret: readSecret(),
  accessTtl: process.env.ACCESS_TOKEN_TTL ?? '5m',
  refreshTtl: process.env.REFRESH_TOKEN_TTL ?? '7d',
  bcryptCost: Number(process.env.BCRYPT_COST ?? 12),
  bootstrapAdminUsername: process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
  defaultMaxContainers: Number(process.env.DEFAULT_MAX_CONTAINERS ?? 3),
  port: Number(process.env.PORT ?? 8001),
  // 非 production（含 test）关闭 cookie Secure，便于本地 http 调试；规格锁 SameSite=Lax/HttpOnly/Path。
  cookieSecure: process.env.NODE_ENV === 'production',
  databaseUrl: process.env.DATABASE_URL ?? 'file:./prisma/panel.db',
  isTest: process.env.NODE_ENV === 'test',
}

// refresh cookie 公共属性（规格 #311 锁）：HttpOnly + Secure(prod) + SameSite=Lax + Path=/api/v1/auth
export const REFRESH_COOKIE = 'refresh_token'
export const REFRESH_COOKIE_PATH = '/api/v1/auth'
