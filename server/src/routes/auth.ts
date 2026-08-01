import { Router, type Request, type Response } from 'express'
import type { PrismaClient } from '../generated/prisma/client'
import { ok, fail } from '../envelope'
import { CODE } from '../codes'
import { config, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from '../config'
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  refreshExpiresAt,
  revokeAllUserRefresh,
} from '../auth/tokens'
import { verifyPassword, hashPassword } from '../auth/password'
import { createUser, type CreateUserInput } from '../auth/userService'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { loginSchema, passwordChangeSchema, userCreateSchema } from '../validation/schemas'

// 认证路由 /api/v1/auth/* （login/refresh/logout/me/register/password-change/oauth）。
// 公开：login / token/refresh / oauth。受保护：me / logout / register(admin) / password/change。

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
  })
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH })
}

// --- R1 旋转 + 重放检测（核心） ---
// 有效（未撤销未过期）→ 旧 token 撤销 + 新 token 落库（replacedByTokenId 指回旧）。
// 已撤销的 token 再现 = 重放 → 撤销该 user 全部有效 refresh（族灭），拒 10003。
// 不存在/过期/user 失效 → 10003。
async function rotateRefresh(
  oldToken: string,
  prisma: PrismaClient,
): Promise<{ access: string; refreshCookie: string }> {
  const oldHash = hashToken(oldToken)
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: oldHash } })
  const now = new Date()
  if (!row) throw fail(CODE.REFRESH_INVALID)
  if (row.revokedAt) {
    // 重放：被旋转过的 token 再次出现 → 族灭该 user 全部有效 refresh
    await revokeAllUserRefresh(prisma, row.userId, now)
    throw fail(CODE.REFRESH_INVALID)
  }
  if (row.expiresAt < now) {
    await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: now } })
    throw fail(CODE.REFRESH_INVALID)
  }
  const user = await prisma.user.findUnique({ where: { id: row.userId } })
  if (!user || !user.isActive) throw fail(CODE.REFRESH_INVALID)
  const newTok = generateRefreshToken()
  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: now } }),
    prisma.refreshToken.create({
      data: {
        userId: row.userId,
        tokenHash: newTok.hash,
        expiresAt: refreshExpiresAt(),
        replacedByTokenId: row.id,
      },
    }),
  ])
  const access = await signAccessToken(user.id)
  return { access, refreshCookie: newTok.token }
}

// --- handlers ---

async function loginHandler(req: Request, res: Response): Promise<void> {
  const { username, password } = req.body as { username: string; password: string }
  const user = await req.prisma.user.findUnique({ where: { username } })
  // 用户不存在/无密码(OIDC-only)/密码错/已禁用 → 同 10002（不区分用户名是否存在，防探测）
  if (
    !user ||
    !user.passwordHash ||
    !user.isActive ||
    !(await verifyPassword(password, user.passwordHash))
  ) {
    throw fail(CODE.LOGIN_FAILED)
  }
  const access = await signAccessToken(user.id)
  const refresh = generateRefreshToken()
  await req.prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: refresh.hash, expiresAt: refreshExpiresAt() },
  })
  setRefreshCookie(res, refresh.token)
  ok(res, { access, mustChangePassword: user.mustChangePassword })
}

async function refreshHandler(req: Request, res: Response): Promise<void> {
  const oldToken = req.cookies?.[REFRESH_COOKIE] as string | undefined
  if (!oldToken) throw fail(CODE.REFRESH_INVALID)
  const { access, refreshCookie } = await rotateRefresh(oldToken, req.prisma)
  setRefreshCookie(res, refreshCookie)
  ok(res, { access })
}

async function logoutHandler(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined
  if (token) {
    await req.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }
  clearRefreshCookie(res)
  ok(res, null)
}

function meHandler(req: Request, res: Response): void {
  const u = req.user!
  ok(res, {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    maxContainers: u.maxContainers,
  })
}

async function passwordChangeHandler(req: Request, res: Response): Promise<void> {
  const { oldPassword, newPassword } = req.body as { oldPassword: string; newPassword: string }
  const user = await req.prisma.user.findUnique({ where: { id: req.user!.id } })
  if (!user || !user.passwordHash || !(await verifyPassword(oldPassword, user.passwordHash))) {
    throw fail(CODE.LOGIN_FAILED) // 旧密错 → 10002（契约 §2.2）
  }
  const newHash = await hashPassword(newPassword)
  // 改密 + 撤销该 user 全部有效 refresh（强制重登）同一事务
  await req.prisma.$transaction([
    req.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash, mustChangePassword: false },
    }),
    revokeAllUserRefresh(req.prisma, user.id, new Date()),
  ])
  clearRefreshCookie(res)
  ok(res, null)
}

async function registerHandler(req: Request, res: Response): Promise<void> {
  const user = await createUser(req.prisma, req.body as CreateUserInput)
  ok(res, { id: user.id, username: user.username, email: user.email, role: user.role })
}

function oauthSkeleton(_req: Request, _res: Response): void {
  throw fail(CODE.OAUTH_NOT_CONFIGURED) // O1 骨架：不接 IdP → 90001
}

export const authRouter = Router()

// 公开
authRouter.post('/login', validateBody(loginSchema), loginHandler)
authRouter.post('/token/refresh', refreshHandler)
authRouter.get('/oauth/:provider/login', oauthSkeleton)
authRouter.get('/oauth/:provider/callback', oauthSkeleton)

// 受保护（requireAuth → mustChangePasswordGate；gate 放行 me/logout/password-change，拦 register）
authRouter.use(requireAuth, mustChangePasswordGate)
authRouter.get('/me', meHandler)
authRouter.post('/logout', logoutHandler)
authRouter.post('/password/change', validateBody(passwordChangeSchema), passwordChangeHandler)
authRouter.post(
  '/register',
  requireAdmin,
  validateBody(userCreateSchema),
  registerHandler,
)
