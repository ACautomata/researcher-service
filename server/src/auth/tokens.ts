import { SignJWT, jwtVerify } from 'jose'
import { createSecretKey, randomBytes, createHash } from 'node:crypto'
import { config } from '../config'
import type { PrismaClient } from '../generated/prisma/client'

// JWT（jose HS256，显式 algorithms 防算法混淆；规格 §A）。
// access token claim 平移 simplejwt：sub=user_id + jti + exp + iat。
// role/isActive/mustChangePassword 一律以查库为准（authenticate 落地），token 仅携带最小标识。

const ISSUER = 'openclaw-panel'
const AUDIENCE = 'openclaw-panel-users'

function secretKey() {
  return createSecretKey(Buffer.from(config.jwtSecret))
}

export async function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(userId)
    .setExpirationTime(config.accessTtl)
    .setJti(randomBytes(16).toString('hex'))
    .sign(secretKey())
}

export interface VerifiedAccess {
  userId: string
  jti: string
}

export async function verifyAccessToken(token: string): Promise<VerifiedAccess> {
  const { payload } = await jwtVerify(token, secretKey(), {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  })
  if (!payload.sub || !payload.jti) throw new Error('invalid access token')
  return { userId: payload.sub, jti: payload.jti }
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
export function revokeAllUserRefresh(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
) {
  return prisma.refreshToken.updateMany({
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
