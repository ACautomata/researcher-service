import type { PrismaClient } from '../generated/prisma/client'
import { config } from '../config'
import { hashPassword, generateTempPassword } from './password'

// B1 惰性首启（#311）：空 users 表 → 生成 admin（随机临时密码），bcrypt、mustChangePassword=true，
// 明文密码 console.log 恰好一次。幂等（仅 count()==0 时执行）。
// C1 强制改密由 mustChangePasswordGate 落地（服务端拦截，#333 决策）。
export async function bootstrap(prisma: PrismaClient): Promise<void> {
  const count = await prisma.user.count()
  if (count > 0) return

  const username = config.bootstrapAdminUsername
  const password = generateTempPassword()
  const passwordHash = await hashPassword(password)
  await prisma.user.create({
    data: {
      username,
      passwordHash,
      role: 'admin',
      isActive: true,
      mustChangePassword: true,
      maxContainers: config.defaultMaxContainers,
    },
  })
  // 明文密码仅此一次输出到 log（#311 B1）；后续只存 bcrypt 散列。
  // eslint-disable-next-line no-console
  console.log(
    `[bootstrap] 初始管理员已生成（仅显示一次）。用户名: ${username} 临时密码: ${password}`,
  )
}
