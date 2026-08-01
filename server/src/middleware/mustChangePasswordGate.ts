import type { Request, Response, NextFunction } from 'express'
import { fail } from '../envelope'
import { CODE } from '../codes'

// mustChangePassword 拦截（#311 C1 + #333 决策：服务端拦截）。
// 必须挂在 requireAuth 之后（依赖 req.user）。放行改密流程相关路径；其余受保护端点 mustChange=true → 10005。
// 用 baseUrl+path 拼全路径，对挂载点稳健（router 内 req.path 仅是后缀）。
const ALLOWED_FULL_PATHS = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/password/change',
])

export function mustChangePasswordGate(req: Request, _res: Response, next: NextFunction): void {
  const full = req.baseUrl + req.path
  if (req.user?.mustChangePassword && !ALLOWED_FULL_PATHS.has(full)) {
    next(fail(CODE.MUST_CHANGE_PASSWORD))
    return
  }
  next()
}
