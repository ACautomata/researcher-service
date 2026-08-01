import type { Request, Response, NextFunction } from 'express'
import type { ZodType } from 'zod'
import { fail } from '../envelope'
import { CODE } from '../codes'

// zod 校验：失败收集 flatten().fieldErrors（天然 {field:[errors]} 形状）→ 90002。
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors as Record<string, string[]>
      next(fail(CODE.VALIDATION_FAILED, undefined, fieldErrors))
      return
    }
    req.body = result.data
    next()
  }
}
