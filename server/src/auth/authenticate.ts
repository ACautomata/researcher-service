import type { PrismaClient, User } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { verifyAccessToken } from './tokens'

// 共享验签（规格 M0：authenticate() 可被 REST requireAuth 与 M4 WS upgrade 复用）。
// 签名验证后查库确认 user 存在且 active——禁用/删 user 下次 verify 立即拒（#321 同源）。
// 不依赖 Express req/res → WS 握手可直接调用同一函数。

export function toAuthUser(u: User): AuthUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    maxContainers: u.maxContainers,
  }
}

export async function authenticate(token: string, prisma: PrismaClient): Promise<AuthUser> {
  const { userId } = await verifyAccessToken(token)
  const u = await prisma.user.findUnique({ where: { id: userId } })
  // user 不存在或已禁用 → 视同未认证（token 持有者已无权限）
  if (!u || !u.isActive) throw new Error('user not found or inactive')
  return toAuthUser(u)
}
