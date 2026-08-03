import type { Request, Response, NextFunction } from 'express'
import { authenticate } from '../auth/authenticate'
import { fail } from '../envelope'
import { CODE } from '../codes'

// requireAuth：取 Authorization: Bearer → authenticate → 注入 req.user。
// 无 token / 坏 token / user 已禁用 → 10001。
// 幂等：同一请求已过一条认证链（req.user 已置）→ 直接放行。生产下 wiki 挂在 containers router 之后，
// 两 router 各 router.use(requireAuth)（同前缀），不复用该短路会每次请求重复验 JWT + 查用户表
// （codex PR#346）。req.user 仅本函数赋值，短路不会造成未认证放行。
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (req.user) {
    next()
    return
  }
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  if (!token) {
    next(fail(CODE.UNAUTHENTICATED))
    return
  }
  try {
    req.user = await authenticate(token, req.prisma)
    next()
  } catch {
    next(fail(CODE.UNAUTHENTICATED))
  }
}

// requireAdmin：role!=='admin' → 10004（角色不足）。
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(fail(CODE.FORBIDDEN))
    return
  }
  next()
}
