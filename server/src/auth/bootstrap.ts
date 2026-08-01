import type { PrismaClient } from '../generated/prisma/client'
import { config } from '../config'
import { hashPassword, generateTempPassword } from './password'

// B1 惰性首启（#311）：空 users 表 → 生成 admin（随机临时密码），bcrypt、mustChangePassword=true，
// 明文密码 console.log 恰好一次。幂等（仅 count()==0 时执行）。
// C1 强制改密由 mustChangePasswordGate 落地（服务端拦截，#333 决策）。
// 并发安全（Codex #342 二轮 P2）：count()==0 检查与 create 非原子，两进程同对空库双创建 →
// 一个 P2002 撞 username 唯一冲突。此处把 P2002 视为并发创建成功（幂等），不 abort 启动、
// 不重复 log 明文（另一进程已生成密码）。
export async function bootstrap(prisma: PrismaClient): Promise<void> {
  const count = await prisma.user.count()
  if (count > 0) return

  const username = config.bootstrapAdminUsername
  const password = generateTempPassword()
  const passwordHash = await hashPassword(password)
  try {
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
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      // 并发另一进程已创建 bootstrap admin → 幂等成功，不重复 log
      return
    }
    throw e
  }
  // 明文密码仅此一次输出到 log（#311 B1）；后续只存 bcrypt 散列。
  // eslint-disable-next-line no-console
  console.log(
    `[bootstrap] 初始管理员已生成（仅显示一次）。用户名: ${username} 临时密码: ${password}`,
  )
}
