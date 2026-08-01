import { Router, type Request, type Response, type NextFunction } from 'express'
import { ok, fail } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { userCreateSchema, userPatchSchema } from '../validation/schemas'
import { createUser, assertQuotaValid, type CreateUserInput } from '../auth/userService'
import { hashPassword, generateTempPassword } from '../auth/password'
import { revokeAllUserRefresh } from '../auth/tokens'

// admin 账号管理 /api/v1/users/* （#328 4 端点）。
// 非 admin 访问 → 10041（与 not-found 同码防探测，区分仅日志）；不存在 id → 10041。

export const usersRouter = Router()

usersRouter.use(requireAuth, mustChangePasswordGate)

// 非 admin → 10041（隐藏 admin 资源存在性；与「目标用户不存在」同码同体）
usersRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.role !== 'admin') {
    // eslint-disable-next-line no-console
    console.warn(`[users] denied: non-admin uid=${req.user?.id} path=${req.baseUrl}${req.path}`)
    return next(fail(CODE.USER_NOT_FOUND))
  }
  next()
})

// GET / —— 列表 + containerCount（acceptance 每行字段）
usersRouter.get('/', async (req: Request, res: Response) => {
  const users = await req.prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { containers: true } } },
  })
  ok(res, {
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      containerCount: u._count.containers,
      quota: { used: u._count.containers, limit: u.maxContainers },
      mustChangePassword: u.mustChangePassword,
      createdAt: u.createdAt,
    })),
  })
})

// POST / —— 建账号（与 register 同语义）
usersRouter.post('/', validateBody(userCreateSchema), async (req, res) => {
  const user = await createUser(req.prisma, req.body as CreateUserInput)
  ok(res, { id: user.id, username: user.username, email: user.email, role: user.role })
})

// PATCH /:id —— active + 配额
usersRouter.patch('/:id', validateBody(userPatchSchema), async (req: Request, res: Response) => {
  const id = req.params.id as string
  const { isActive, maxContainers } = req.body as {
    isActive?: boolean
    maxContainers?: number
  }
  // 配额语义非法（负数或超 Int 上界）→ 10043（区别于 90002 结构校验；与 createUser 共享）
  assertQuotaValid(maxContainers)

  const existing = await req.prisma.user.findUnique({ where: { id } })
  if (!existing) {
    // eslint-disable-next-line no-console
    console.warn(`[users] not_found: id=${id}`)
    throw fail(CODE.USER_NOT_FOUND)
  }
  // 不可禁用自己 → 10044
  if (isActive === false && id === req.user!.id) throw fail(CODE.CANNOT_DISABLE_SELF)

  const updated = await req.prisma.user.update({
    where: { id },
    data: {
      ...(isActive !== undefined ? { isActive } : {}),
      ...(maxContainers !== undefined ? { maxContainers } : {}),
    },
  })
  ok(res, {
    id: updated.id,
    username: updated.username,
    isActive: updated.isActive,
    maxContainers: updated.maxContainers,
  })
})

// POST /:id/reset-password —— 一次性明文回显 + 撤销该 user 全部 refresh + C1
// CAS 对齐（自查 Spec 轴 P2）：reset 是唯一无条件写 passwordHash 的路径（改密用 CAS）。若目标
// 自己的 password/change 在 reset 写 hash 后 commit，会覆盖回显密码 → 破坏「一次性明文回显」。
// 改为条件 updateMany（where isActive:true），与改密 CAS 同语义互斥：count=0（目标正被禁用或
// 并发已改）→ 不覆盖，回显密码保持有效。两 op 同事务原子提交。
usersRouter.post('/:id/reset-password', async (req: Request, res: Response) => {
  const id = req.params.id as string
  const existing = await req.prisma.user.findUnique({ where: { id } })
  if (!existing) {
    // eslint-disable-next-line no-console
    console.warn(`[users] reset not_found: id=${id}`)
    throw fail(CODE.USER_NOT_FOUND)
  }
  const password = generateTempPassword()
  const passwordHash = await hashPassword(password)
  const updated = await req.prisma.$transaction([
    req.prisma.user.updateMany({
      where: { id, isActive: true },
      data: { passwordHash, mustChangePassword: true },
    }),
    revokeAllUserRefresh(req.prisma, id, new Date()),
  ])
  // count=0：目标被禁用或并发已改 → 回显密码未生效，拒绝而非返回「将失效」的密码
  if (updated[0].count === 0) throw fail(CODE.USER_NOT_FOUND)
  ok(res, { password }) // 一次性明文回显（仅此一次，前端弹 modal）
})
