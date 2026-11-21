// reflections 窄协议 REST（#1080 · RF-T04）：
//   GET  /api/v1/reflections/displays/:displayId        —— 聊天块渲染读取完整展示正文
//   POST /api/v1/reflections/displays/:displayId/ack    —— 浏览器完整渲染后回执（不是写授权）
// 无记录 CRUD；草稿/正式记录的操作只经 Leader 工具。归属与状态复核在 service/store。

import { Router, type Request } from 'express'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { reflectionAckSchema } from '../validation/schemas'
import type { ReflectionService } from './service'

export interface ReflectionsRouterDeps {
  readonly service: Pick<ReflectionService, 'getDisplay' | 'ackDisplay'>
}

function displayId(req: Request): string {
  return typeof req.params.displayId === 'string' ? req.params.displayId : ''
}

export function createReflectionsRouter(deps: ReflectionsRouterDeps): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  router.get('/displays/:displayId', async (req, res) => {
    const display = await deps.service.getDisplay(req.user!.id, displayId(req))
    if (!display) throw fail(CODE.REFLECTION_DISPLAY_NOT_FOUND)
    ok(res, display)
  })

  router.post('/displays/:displayId/ack', validateBody(reflectionAckSchema), async (req, res) => {
    const result = await deps.service.ackDisplay(req.user!.id, displayId(req), req.body as { version: number; hash: string; messageId: string })
    if ('error' in result) {
      if (result.error === 'not_found') throw fail(CODE.REFLECTION_DISPLAY_NOT_FOUND)
      if (result.error === 'not_ready') throw fail(CODE.REFLECTION_NOT_READY)
      throw fail(CODE.REFLECTION_DISPLAY_CONFLICT)
    }
    ok(res, result)
  })

  return router
}
