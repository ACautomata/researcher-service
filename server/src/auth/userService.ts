import type { PrismaClient, User } from '../generated/prisma/client'
import { config } from '../config'
import { hashPassword } from './password'
import { fail } from '../envelope'
import { CODE } from '../codes'
import { isQuotaValid } from './quota'

export interface CreateUserInput {
  username: string
  password: string
  email?: string
  maxContainers?: number
}

// 配额范围校验（Codex #342 五轮 P2）：maxContainers 须在 [0, 2^31-1]。
// 超 Int 上界在严格 Int 的 DB（非 SQLite）会被 Prisma 拒写 → 90000；此处统一抛 10043
// （与负数同语义「配额非法」）。createUser 与 PATCH /users 共享。isQuotaValid 与 config
// 加载期校验共用（quota.ts 单一准据）。
export function assertQuotaValid(maxContainers: number | undefined): void {
  if (maxContainers === undefined) return
  if (!isQuotaValid(maxContainers)) throw fail(CODE.QUOTA_INVALID)
}

// 建账号（register / users POST 共用）。新建账号恒 role=user、mustChangePassword=true（#311 C1）。
// 用户名冲突 → 20041（契约 §2.2；先查 + P2002 兜底竞态）。
export async function createUser(prisma: PrismaClient, input: CreateUserInput): Promise<User> {
  // 配额非法（负数或超 Int 上界）→ 10043（与 PATCH /users 共用语义；#331 §C + #342 五轮）
  assertQuotaValid(input.maxContainers)
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
