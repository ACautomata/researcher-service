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

// 恒定耗时的 dummy bcrypt(12) 散列：login 短路分支（用户不存在/OIDC-only/inactive）用它
// 垫一次 bcrypt 开销，抹平与「错密跑满 cost-12」的时序差，防账号存在性探测（Codex #342 P2）。
// 公开无害值，仅用于等权计算耗时；不对应任何真实密码。
const DUMMY_BCRYPT_HASH = '$2b$12$lr7QN9p4itcqX4aHbSvHdemwcobKprdkDEiR1gBKYj7GnlAiEa5d2'

// --- R1 旋转 + 重放检测（核心） ---
// 有效（未撤销未过期）→ 旧 token 撤销 + 新 token 落库（replacedByTokenId 指回旧）。
// 已撤销的 token 再现 = 重放 → 撤销该 user 全部有效 refresh（族灭），拒 10003。
// 不存在/过期/user 失效 → 10003。
//
// 并发原子性（Codex #342 P1）：旋转 = 撤销旧 + 建新 必须在同一事务内，且撤销必须
// 条件化（where revokedAt:null）。否则两个并发请求都读到 revokedAt:null → 各自无条件
// 撤销 + create → 旋转链分叉（fork），被盗 token 仍可用。条件 updateMany 在并发已
// 旋转后命中 count=0 → 判定重放。族灭放事务外执行（交互式事务内 throw 会 ROLLBACK，
// 族灭写入必须持久化，故先提交无副作用的事务再用事务外 updateMany 落库）。
// 事务体内核（可测 seam）：条件撤销 + 建新，返回哨兵而非 throw —— 调用方决定族灭时机。
// 并发已被旋转（updateMany 命中 count=0）→ replay:true；user 失效 → replay:true。
// 成功 → replay:false + 新 access + 新 refresh。
export async function rotateInTx(
  tx: Pick<PrismaClient, 'refreshToken' | 'user'>,
  row: { id: string; userId: string },
  now: Date,
): Promise<
  | { replay: true }
  | { replay: false; access: string; refreshCookie: string }
> {
  const revoked = await tx.refreshToken.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: now },
  })
  if (revoked.count === 0) return { replay: true } // 并发已被旋转 → 族灭交由事务外
  const user = await tx.user.findUnique({ where: { id: row.userId } })
  if (!user || !user.isActive) return { replay: true }
  const newTok = generateRefreshToken()
  await tx.refreshToken.create({
    data: {
      userId: row.userId,
      tokenHash: newTok.hash,
      expiresAt: refreshExpiresAt(),
      replacedByTokenId: row.id,
    },
  })
  const access = await signAccessToken(user.id)
  return { replay: false, access, refreshCookie: newTok.token }
}

async function rotateRefresh(
  oldToken: string,
  prisma: PrismaClient,
): Promise<{ access: string; refreshCookie: string }> {
  const oldHash = hashToken(oldToken)
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: oldHash } })
  const now = new Date()
  if (!row) throw fail(CODE.REFRESH_INVALID)
  if (row.revokedAt) {
    // 重放：被旋转过的 token 再次出现 → 族灭该 user 全部有效 refresh（持久化）
    await revokeAllUserRefresh(prisma, row.userId, now)
    throw fail(CODE.REFRESH_INVALID)
  }
  if (row.expiresAt < now) {
    await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: now } })
    throw fail(CODE.REFRESH_INVALID)
  }
  // 原子旋转：撤销+建新同一事务；条件撤销复查 revokedAt（防并发 fork）。
  // 事务内不 throw —— replay 以哨兵返回，族灭在事务外执行保证持久化（否则 ROLLBACK 丢失）。
  const result = await prisma.$transaction(async (tx) => rotateInTx(tx, row, now))
  if (result.replay) {
    // 并发已旋转或 user 失效：族灭该 user 全部有效 refresh（事务外，持久化）
    await revokeAllUserRefresh(prisma, row.userId, now)
    throw fail(CODE.REFRESH_INVALID)
  }
  return { access: result.access, refreshCookie: result.refreshCookie }
}

// --- handlers ---

// login 发 session 事务体内核（可测 seam，Codex #342 五轮 P1 + 自查 Spec 轴 P1）：条件复查已
// 验证的 passwordHash 仍等于旧 hash 且 isActive 仍 true（事务内）。复查必须放在 create 之后：
// 改密/reset 的 revokeAll 扫描不到本事务刚插入的 refresh，若「先查后建」，并发改密 commit 落在
// 查-建之间会让新 refresh 落库且不被撤销（旧凭据存活）。改为「先建后查」：任何在 create 之后
// commit 的并发改密，都会被随后的 findFirst 命中新 hash → 删除刚建的 refresh + ok:false 拒绝
// （Postgres READ COMMITTED 逐语句新快照下亦然闭合；若未来事务内再加写可升 Serializable）。
export async function issueSessionInTx(
  tx: Pick<PrismaClient, 'user' | 'refreshToken'>,
  userId: string,
  verifiedHash: string,
): Promise<
  | { ok: false }
  | { ok: true; refreshHash: string; refreshToken: string; access: string }
> {
  const refresh = generateRefreshToken()
  await tx.refreshToken.create({
    data: { userId, tokenHash: refresh.hash, expiresAt: refreshExpiresAt() },
  })
  const user = await tx.user.findFirst({
    where: { id: userId, passwordHash: verifiedHash, isActive: true },
  })
  if (!user) {
    // 并发改密/reset 已 commit 或账号被禁用 → 删掉刚建的 refresh（避免未被 revokeAll 扫到的残留）
    await tx.refreshToken.delete({ where: { tokenHash: refresh.hash } })
    return { ok: false }
  }
  const access = await signAccessToken(user.id)
  return { ok: true, refreshHash: refresh.hash, refreshToken: refresh.token, access }
}

async function loginHandler(req: Request, res: Response): Promise<void> {
  const { username, password } = req.body as { username: string; password: string }
  const user = await req.prisma.user.findUnique({ where: { username } })
  // 用户不存在/无密码(OIDC-only)/密码错/已禁用 → 同 10002（不区分用户名是否存在，防探测）。
  // 时序侧信道防护（Codex #342 P2）：短路分支（不存在/OIDC-only/inactive）直接 throw 会
  // 跳过 bcrypt，错密则跑满 cost-12 → 时序差暴露账号存在。故短路前先对固定 dummy hash
  // 跑一次 verifyPassword 垫恒定耗时（公开无害值，仅等权 bcrypt 开销）。
  if (!user || !user.passwordHash || !user.isActive) {
    await verifyPassword(password, DUMMY_BCRYPT_HASH)
    throw fail(CODE.LOGIN_FAILED)
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw fail(CODE.LOGIN_FAILED)
  }
  // 发 session 原子化：事务内条件复查 passwordHash + isActive（防 verify 后被并发改密/reset
  // 导致旧凭据存活）。复查失败 → 拒绝 10002。
  const issued = await req.prisma.$transaction(async (tx) =>
    issueSessionInTx(tx, user.id, user.passwordHash!),
  )
  if (!issued.ok) throw fail(CODE.LOGIN_FAILED)
  setRefreshCookie(res, issued.refreshToken)
  ok(res, { access: issued.access, mustChangePassword: user.mustChangePassword })
}

async function refreshHandler(req: Request, res: Response): Promise<void> {
  const oldToken = req.cookies?.[REFRESH_COOKIE]
  // cookie-parser 对 j: 前缀 JSON cookie 解析为对象 → hashToken 会抛 TypeError → 90000。
  // 拒绝任何非 string cookie（Codex #342 四轮 P2）。
  if (typeof oldToken !== 'string') throw fail(CODE.REFRESH_INVALID)
  const { access, refreshCookie } = await rotateRefresh(oldToken, req.prisma)
  setRefreshCookie(res, refreshCookie)
  ok(res, { access })
}

async function logoutHandler(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE]
  if (typeof token === 'string') {
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

// 改密事务体内核（可测 seam，Codex #342 二轮 P1 + 三轮 P1）：条件更新复查 passwordHash 仍等于
// 已校验的旧 hash 且账号仍激活（isActive:true），count=0（并发已被重置 / 用户被禁用）→
// ok:false，不覆盖 reset hash、不清 mustChangePassword。成功时同步撤销该 user 全部有效
// refresh（强制重登，与改密同事务持久化）。
export async function changePasswordInTx(
  tx: Pick<PrismaClient, 'user' | 'refreshToken'>,
  userId: string,
  oldHash: string,
  newHash: string,
  now: Date,
): Promise<{ ok: boolean }> {
  const updated = await tx.user.updateMany({
    where: { id: userId, passwordHash: oldHash, isActive: true },
    data: { passwordHash: newHash, mustChangePassword: false },
  })
  if (updated.count === 0) return { ok: false } // 并发已被重置 / 账号已禁用 → 拒绝，不覆盖
  await revokeAllUserRefresh(tx, userId, now) // 族灭 refresh（正常提交，持久化）
  return { ok: true }
}

async function passwordChangeHandler(req: Request, res: Response): Promise<void> {
  const { oldPassword, newPassword } = req.body as { oldPassword: string; newPassword: string }
  const user = await req.prisma.user.findUnique({ where: { id: req.user!.id } })
  if (!user || !user.passwordHash || !(await verifyPassword(oldPassword, user.passwordHash))) {
    throw fail(CODE.LOGIN_FAILED) // 旧密错 → 10002（契约 §2.2）
  }
  // 校验与更新原子化：条件更新复查 hash（防 verify 后被 admin 重置的竞态覆盖）
  const newHash = await hashPassword(newPassword)
  const result = await req.prisma.$transaction(async (tx) =>
    changePasswordInTx(tx, user.id, user.passwordHash!, newHash, new Date()),
  )
  if (!result.ok) {
    // 竞态：hash 已被重置 → 拒绝（不覆盖 reset hash），并撤销全部 refresh
    await revokeAllUserRefresh(req.prisma, user.id, new Date())
    throw fail(CODE.LOGIN_FAILED)
  }
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
  // Codex #342 ㉒ P2：建账号用户名格式非法返 10042（契约 #328 码段），非通用 90002
  validateBody(userCreateSchema, CODE.USERNAME_INVALID),
  registerHandler,
)
