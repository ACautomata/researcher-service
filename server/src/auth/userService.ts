import type { PrismaClient, User } from '../generated/prisma/client'
import { config } from '../config'
import { hashPassword } from './password'
import { fail } from '../envelope'
import { CODE } from '../codes'

export interface CreateUserInput {
  username: string
  password: string
  email?: string
  maxContainers?: number
}

// 建账号（register / users POST 共用）。新建账号恒 role=user、mustChangePassword=true（#311 C1）。
// 用户名冲突 → 20041（契约 §2.2；先查 + P2002 兜底竞态）。
export async function createUser(prisma: PrismaClient, input: CreateUserInput): Promise<User> {
  // 配额非法（负数）→ 10043（与 PATCH /users 共用语义；#331 §C）
  if (input.maxContainers !== undefined && input.maxContainers < 0) throw fail(CODE.QUOTA_INVALID)
  const existing = await prisma.user.findUnique({ where: { username: input.username } })
  if (existing) throw fail(CODE.NAME_CONFLICT)
  const passwordHash = await hashPassword(input.password)
  try {
    return await prisma.user.create({
      data: {
        username: input.username,
        passwordHash,
        email: input.email ?? null,
        role: 'user',
        isActive: true,
        mustChangePassword: true,
        maxContainers: input.maxContainers ?? config.defaultMaxContainers,
      },
    })
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw fail(CODE.NAME_CONFLICT)
    throw e
  }
}
