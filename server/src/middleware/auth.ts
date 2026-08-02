import type { Request, Response, NextFunction } from 'express'
import { authenticate } from '../auth/authenticate'
import { fail } from '../envelope'
import { CODE } from '../codes'

// requireAuth：取 Authorization: Bearer → authenticate → 注入 req.user。
// 无 token / 坏 token / user 已禁用 → 10001。
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
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
