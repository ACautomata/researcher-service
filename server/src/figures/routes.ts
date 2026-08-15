// AutoFigure 域路由（T01，docs/autofigure/tickets/T01-authenticated-figure-creation.md）。
// 只交付最小入口：认证用户经 POST /api/v1/figures 原子创建 Figure + 其 1:1 queued GenerationJob，
// 返回 #312 成功信封。幂等（T02）/ runner（T03）/ 读路径（T05）均不在本文件范围。
// 装配：AppDeps.figures 注入则挂载（flag 门在装配层 server.ts，flag 关不注入 → 路由不装配 → 90005）。

import { Router, type Request, type Response } from 'express'
import type { z } from 'zod'
import { ok } from '../envelope'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { figureCreateSchema } from '../validation/schemas'
import { createFigureWithJobInTx } from './service'

export interface FiguresRouterDeps {
  // T01 无注入项（路由只依赖 req.prisma + 认证身份）；存在即装配（对齐 models/files 条件挂载先例）。
  // T02 幂等 / T03 runner 的依赖将在此扩展，本票不预埋字段。
}

export function createFiguresRouter(_deps: FiguresRouterDeps): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // POST / —— 原子创建 Figure + 其 1:1 queued GenerationJob（T01 AC3-AC8）。
  // ownerId 只取认证身份 req.user.id；请求体 userId（若有）经 zod strip 丢弃，绝不作为归属来源。
  router.post('/', validateBody(figureCreateSchema), async (req: Request, res: Response) => {
    const prompt = (req.body as z.infer<typeof figureCreateSchema>).prompt
    const { figureId, jobId, status } = await req.prisma.$transaction((tx) =>
      createFigureWithJobInTx(tx, { ownerId: req.user!.id, prompt }),
    )
    // 语义等价 202，不引入 HTTP 202 特例（#312 信封不变量）；status 为 DB 行回读值
    ok(res, { figureId, jobId, status })
  })

  return router
}
