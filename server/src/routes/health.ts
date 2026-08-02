import { Router } from 'express'
import { ok } from '../envelope'

// GET /api/health —— 公开健康探针（BaoTa/compose healthcheck）。信封内 {status:'ok'}。
export const healthRouter = Router()

healthRouter.get('/health', (_req, res) => {
  ok(res, { status: 'ok' })
})
