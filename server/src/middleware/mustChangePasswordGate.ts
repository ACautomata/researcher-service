import type { Request, Response, NextFunction } from 'express'
import { fail } from '../envelope'
import { CODE } from '../codes'

// mustChangePassword 拦截（#311 C1 + #333 决策：服务端拦截）。
// 必须挂在 requireAuth 之后（依赖 req.user）。放行改密流程相关路径；其余受保护端点 mustChange=true → 10005。
// 用 baseUrl+path 拼全路径，对挂载点稳健（router 内 req.path 仅是后缀）。
// 尾斜杠归一化（Codex #342 ⑱ P2）：Express 默认非严格路由会匹配 `/password/change/`，
// 但精确字符串白名单见不到尾斜杠 → 误拦 10005，客户端沿用 Django 风格尾斜杠无法完成强制改密。
// strip 尾斜杠后再比对，与 Express 实际路由行为对齐。
const ALLOWED_FULL_PATHS = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/password/change',
])

export function mustChangePasswordGate(req: Request, _res: Response, next: NextFunction): void {
  const full = (req.baseUrl + req.path).replace(/\/+$/, '')
  if (req.user?.mustChangePassword && !ALLOWED_FULL_PATHS.has(full)) {
    next(fail(CODE.MUST_CHANGE_PASSWORD))
    return
  }
  next()
}
