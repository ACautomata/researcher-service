import { SignJWT, jwtVerify } from 'jose'
import { createSecretKey, randomBytes, createHash } from 'node:crypto'
import { config } from '../config'
import type { PrismaClient } from '../generated/prisma/client'

// JWT（jose HS256，显式 algorithms 防算法混淆；规格 §A）。
// access token claim 平移 simplejwt：sub=user_id + jti + exp + iat。
// role/isActive/mustChangePassword 一律以查库为准（authenticate 落地），token 仅携带最小标识。

const ISSUER = 'researcher-panel'
const AUDIENCE = 'researcher-panel-users'
// SSE 流凭证 audience（#726，issue #773）：panel_stream cookie 只读通道专用——与 access
// token 隔离（audience 不匹配即拒），access token 不能当流凭证用、反之亦然。
const STREAM_AUDIENCE = 'researcher-panel-stream'

function secretKey() {
  return createSecretKey(Buffer.from(config.jwtSecret))
}

// HS256 签发：access 与 panel_stream 流凭证共用（仅 audience/TTL 不同——隔离语义见
// STREAM_AUDIENCE 注释；验签侧对称去重见 verifyToken）。
async function signToken(userId: string, audience: string, ttl: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(userId)
    .setExpirationTime(ttl)
    .setJti(randomBytes(16).toString('hex'))
    .sign(secretKey())
}

export async function signAccessToken(userId: string): Promise<string> {
  return signToken(userId, AUDIENCE, config.accessTtl)
}

export interface VerifiedAccess {
  userId: string
  jti: string
}

// HS256 验签 + claim 抽取：access 与 panel_stream 流凭证共用（仅 audience 不同，
// 隔离语义见 STREAM_AUDIENCE 注释）。
async function verifyToken(token: string, audience: string, kind: string): Promise<VerifiedAccess> {
  const { payload } = await jwtVerify(token, secretKey(), {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience,
  })
  if (!payload.sub || !payload.jti) throw new Error(`invalid ${kind} token`)
  return { userId: payload.sub, jti: payload.jti }
}

export async function verifyAccessToken(token: string): Promise<VerifiedAccess> {
  return verifyToken(token, AUDIENCE, 'access')
}

// --- panel_stream 流凭证（issue #773，#726 认证行） ---
// 与 access token 同形（HS256 + sub + jti）但 audience 隔离、寿命 = refreshTtl（流长命于
// access 5m，经 login/refresh Set-Cookie 滑动续期——refresh 旋转即重签）。
// 凭证本身不携带授权状态：吊销/禁用经带内 session.terminated + 存活期 isActive 复查落地。
export async function signPanelStreamToken(userId: string): Promise<string> {
  return signToken(userId, STREAM_AUDIENCE, config.refreshTtl)
}

export async function verifyPanelStreamToken(token: string): Promise<VerifiedAccess> {
  return verifyToken(token, STREAM_AUDIENCE, 'panel stream')
}

// --- refresh token（opaque 随机串，DB 存 sha256 散列；零明文落库）---
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex')
  return { token, hash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// 撤销该 user 全部有效 refresh（R1 重放族灭 / 改密 / 重置密码共用）。
// 返回 PrismaPromise：可独立 await，也可作为元素放进 $transaction([…]) 数组。
// 参数取 RefreshTokenDelegate 类型：独立 client 与交互式事务（tx）都满足，两处可共用。
export function revokeAllUserRefresh(
  db: Pick<PrismaClient, 'refreshToken'>,
  userId: string,
  now: Date = new Date(),
) {
  return db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  })
}

// refresh 过期时间戳（ms），由 REFRESH_TOKEN_TTL 推导
export function refreshExpiresAt(): Date {
  return new Date(Date.now() + parseTtlToMs(config.refreshTtl))
}

function parseTtlToMs(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim())
  if (!m) throw new Error(`invalid TTL: ${ttl}`)
  const n = Number(m[1])
  const unit = m[2]
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return n * mult
}
