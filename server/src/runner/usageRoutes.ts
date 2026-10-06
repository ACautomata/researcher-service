// usage 核算 REST（#800 admin 核算页数据源；#775 采数 + aggregateUsage 查询已备，本文件仅
// REST 接线面）。
//
// GET /api/v1/usage/aggregate：
//   过滤 userId / from / to(ISO)；时间窗半开区间 [from, to)（与 aggregateUsage 同契约，
//   相邻核算窗拼接不双计边界行）。wire snake_case（对齐 auditRoutes 契约）。
//
// 中间件与 auditRoutes 同款：requireAuth → mustChangePasswordGate → admin 门（非 admin →
// 10004——面板级运营资源无存在性敏感面，直用角色码）。数据行为 auditRoutes 的只读同族。

import { Router, type Request, type Response, type NextFunction } from 'express'
import { ok } from '../envelope'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { aggregateUsage } from './usage'

export const usageRouter = Router()

usageRouter.use(requireAuth, mustChangePasswordGate, requireAdmin)

function textParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function dateParam(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

usageRouter.get('/aggregate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await aggregateUsage(req.prisma, {
      userId: textParam(req.query.userId),
      from: dateParam(req.query.from),
      to: dateParam(req.query.to),
    })
    ok(res, {
      items: rows.map((r) => ({
        user_id: r.userId,
        username: r.username,
        provider_id: r.providerId,
        lc_provider: r.lcProvider,
        model: r.model,
        calls: r.calls,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        cache_read_tokens: r.cacheReadTokens,
        cache_write_tokens: r.cacheWriteTokens,
      })),
    })
  } catch (e) {
    next(e)
  }
})
