import { Router, type Request, type Response, type NextFunction } from 'express'
import { ok, fail } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { listTextTraceLogs } from '../traceLogs/service'
import type { TextTraceStatus } from '../generated/prisma/client'

export const traceLogsRouter = Router()

traceLogsRouter.use(requireAuth, mustChangePasswordGate)

traceLogsRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.role !== 'admin') {
    // eslint-disable-next-line no-console
    console.warn(`[trace-logs] denied: non-admin uid=${req.user?.id} path=${req.baseUrl}${req.path}`)
    return next(fail(CODE.USER_NOT_FOUND))
  }
  next()
})

function textParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function intParam(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const n = Number(value)
  return Number.isInteger(n) ? n : undefined
}

function statusParam(value: unknown): TextTraceStatus | undefined {
  return value === 'success' || value === 'failed' ? value : undefined
}

traceLogsRouter.get('/', async (req: Request, res: Response) => {
  const data = await listTextTraceLogs(req.prisma, {
    userId: textParam(req.query.userId),
    ip: textParam(req.query.ip),
    content: textParam(req.query.content),
    status: statusParam(req.query.status),
    page: intParam(req.query.page),
    pageSize: intParam(req.query.pageSize),
  })
  ok(res, data)
})
