import type { PrismaClient, User } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { verifyAccessToken } from './tokens'

// 认证失败错误（code review F1）：token 无效/过期、user 不存在或已禁用——调用方应视同未认证
// （REST 10001 / WS 4401）。与 DB/内部故障区分（那些错误保持原始类型传播，tunnel 映射 WS 1011，
// 避免 DB 瞬断被误判为凭证过期触发前端 forceRefresh 风暴）。
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthenticationError'
  }
}

// 共享验签（规格 M0：authenticate() 可被 REST requireAuth 与 M4 WS upgrade 复用）。
// 签名验证后查库确认 user 存在且 active——禁用/删 user 下次 verify 立即拒（#321 同源）。
// 不依赖 Express req/res → WS 握手可直接调用同一函数。
// 错误契约：认证失败抛 AuthenticationError；DB/传输异常原样传播（非认证失败，调用方按内部故障处理）。

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
  let userId: string
  try {
    ({ userId } = await verifyAccessToken(token))
  } catch {
    throw new AuthenticationError('invalid access token')
  }
  const u = await prisma.user.findUnique({ where: { id: userId } })
  // user 不存在或已禁用 → 视同未认证（token 持有者已无权限）
  if (!u || !u.isActive) throw new AuthenticationError('user not found or inactive')
  return toAuthUser(u)
}
