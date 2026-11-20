// Skill 市场域 REST（#1056 · #1054 D1/D5）：挂 /api/v1/skills。#312 信封 + requireAuth +
// mustChangePasswordGate（wiki/sessions 先例）。权限矩阵（D1）：上传/启用/可见 = 所有登录
// 用户；删除 = 作者本人或 admin。下载成功路径豁免信封——原生 zip 字节（figures PNG 先例），
// 错误面走信封。multer memoryStorage：包 ≤1MB（D3），字节即解析输入（A 票管线）。

import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { ok, fail } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { skillEnablementSchema } from '../validation/schemas'
import type { SkillMarketService } from './service'
import { SKILL_PACKAGE_MAX_BYTES } from './values'

export interface SkillsRouterDeps {
  readonly service: SkillMarketService
}

// Express 5 params 可为 string | string[]；:id 单段路径恒 string。
function pathId(req: Request): string {
  return typeof req.params.id === 'string' ? req.params.id : ''
}

export function createSkillsRouter(deps: SkillsRouterDeps): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // multer memoryStorage：包 ≤1MB（D3 上限），字节直进 A 票管线（无磁盘临时区需求）。
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SKILL_PACKAGE_MAX_BYTES } })

  // POST / —— 上传（multipart field 'file' 收 zip）。A 票管线结构化拒收 → 80002
  // data.reasons[]（前端逐条展示）；成功 → {id, name, category}（published，D1 直发）。
  router.post('/', upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) throw fail(CODE.VALIDATION_FAILED, '缺少文件字段 file')
    ok(res, await deps.service.createPackage(req.user!, { zip: req.file.buffer }))
  }, (err: unknown, _req: Request, _res: Response, next: (e?: unknown) => void) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      next(fail(CODE.SKILL_PACKAGE_INVALID, 'Skill 包过大（≤1MB）', { reasons: ['整包过大（≤1MB）'] }))
      return
    }
    next(err)
  })

  // GET / —— 市场列表（category/q 0 信任防护；非枚举 category → 空列表即降级，不 90002——
  // 筛选是消费面不是写面）。
  router.get('/', async (req: Request, res: Response) => {
    const category = typeof req.query.category === 'string' ? req.query.category.slice(0, 32) : undefined
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined
    ok(res, await deps.service.listPackages({
      ...(category !== undefined ? { category } : {}),
      ...(q !== undefined ? { q } : {}),
      viewerId: req.user!.id,
    }))
  })

  // GET /:id —— 包详情（文件清单 + 元数据；80041 不存在同码防探测）。
  router.get('/:id', async (req: Request, res: Response) => {
    ok(res, await deps.service.getPackage(pathId(req), req.user!.id))
  })

  // GET /:id/download —— 原生 zip 字节（成功豁免信封；Content-Disposition 带包名）。
  router.get('/:id/download', async (req: Request, res: Response) => {
    const { name, buf } = await deps.service.downloadPackage(pathId(req))
    res.set('Content-Type', 'application/zip')
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}.zip"`)
    res.send(buf)
  })

  // DELETE /:id —— 作者本人或 admin（服务层判定；80041 不存在/越权同码防探测）。
  router.delete('/:id', async (req: Request, res: Response) => {
    await deps.service.deletePackage(req.user!, pathId(req))
    ok(res, null)
  })

  // PUT /:id/enablement —— per-user 幂等启用位（body {enabled}；80041 同码防探测）。
  router.put('/:id/enablement', validateBody(skillEnablementSchema), async (req: Request, res: Response) => {
    const { enabled } = req.body as { enabled: boolean }
    ok(res, await deps.service.setEnablement(req.user!, pathId(req), enabled))
  })

  return router
}
