import type { Request, Response, NextFunction } from 'express'
import type { ZodType } from 'zod'
import { fail } from '../envelope'
import { CODE } from '../codes'

// zod 校验：失败收集 flatten().fieldErrors（天然 {field:[errors]} 形状）→ 90002。
// errorCode 可覆盖（Codex #342 ㉒ P2）：契约为用户名等专属码（10042）时，建账号端点传入
// USERNAME_INVALID，避免客户端永远看不到文档化码。默认 90002 不破坏既有语义。
export function validateBody<T>(schema: ZodType<T>, errorCode?: number) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors as Record<string, string[]>
      next(fail(errorCode ?? CODE.VALIDATION_FAILED, undefined, fieldErrors))
      return
    }
    req.body = result.data
    next()
  }
}
