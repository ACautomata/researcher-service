// AutoFigure 域路由（T01 + T02，docs/autofigure/tickets/T01-authenticated-figure-creation.md /
// T02-idempotent-figure-creation.md）。
// T01 交付最小入口：认证用户经 POST /api/v1/figures 原子创建 Figure + 其 1:1 queued GenerationJob。
// T02 在其上强制 Idempotency-Key（缺失 → 90002，不建任何行）并做 check-or-create 幂等：
//   同用户 + 同 key + 同输入 → 返回既有 Figure/Job 及当前应用级状态（零写入）；
//   同用户 + 同 key + 不同输入 → 稳定幂等冲突 70041（零写入）；不同用户同 key 独立作用域。
// runner（T03）/ 读路径（T05）均不在本文件范围。
// 装配：AppDeps.figures 注入则挂载（flag 门在装配层 server.ts，flag 关不注入 → 路由不装配 → 90005）。

import { Router, type Request, type Response, type NextFunction } from 'express'
import type { z } from 'zod'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { figureCreateSchema } from '../validation/schemas'
import { createFigureWithJobInTx, createOrReplayFigure, IDEMPOTENCY_KEY_MAX_LENGTH } from './service'

export interface FiguresRouterDeps {
  // T01/T02 无注入项（路由只依赖 req.prisma + 认证身份）；存在即装配（对齐 models/files 条件挂载先例）。
  // T03 runner 的依赖将在此扩展，本票不预埋字段。
}

// Idempotency-Key 头校验（F1/F3 code-review）：放 validateBody 之前 → 缺 key/超长是确定性
// 90002（data null），不被 body 校验的 90002（data={field:[errors]}）掩盖、也不与它共享形状。
// 校验通过后经 res.locals 传给 handler（头在 body 之前不可知，故不走 body schema——0-trust 由
// 本中间件承接）。HTTP 头名大小写不敏感（Express req.get 归一化）。
function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
  const key = (req.get('Idempotency-Key') ?? '').trim()
  if (!key) {
    next(fail(CODE.VALIDATION_FAILED, '缺少 Idempotency-Key 请求头'))
    return
  }
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    next(fail(CODE.VALIDATION_FAILED, `Idempotency-Key 过长（≤${IDEMPOTENCY_KEY_MAX_LENGTH} 字符）`))
    return
  }
  res.locals.idempotencyKey = key
  next()
}

export function createFiguresRouter(_deps: FiguresRouterDeps): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // POST / —— 幂等原子创建 Figure + 其 1:1 queued GenerationJob（T01 AC3-AC8 · T02 AC1-AC8）。
  // ownerId 只取认证身份 req.user.id；请求体 userId（若有）经 zod strip 丢弃，绝不作为归属来源。
  // 中间件顺序：requireIdempotencyKey（缺/超长 → 90002，零行）→ validateBody（body → 90002）→ handler。
  router.post(
    '/',
    requireIdempotencyKey,
    validateBody(figureCreateSchema),
    async (req: Request, res: Response) => {
      const idempotencyKey = res.locals.idempotencyKey as string
      const prompt = (req.body as z.infer<typeof figureCreateSchema>).prompt
      const result = await createOrReplayFigure(
        {
          findByIdempotencyKey: (ownerId, key) =>
            req.prisma.figure.findFirst({
              where: { ownerId, idempotencyKey: key },
              include: { job: true },
            }),
          createInTransaction: (input) =>
            req.prisma.$transaction((tx) => createFigureWithJobInTx(tx, input)),
        },
        { ownerId: req.user!.id, prompt, idempotencyKey },
      )
      // 语义等价 202（首建）或 200（重放），统一 #312 信封（HTTP 200，不引入 202/409 特例）；
      // status 恒为 DB 行回读值——首建 queued / 重放 Job 当前状态（约束：不硬编码 queued）。
      ok(res, result)
    },
  )

  return router
}
