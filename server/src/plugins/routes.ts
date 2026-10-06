// 插件域 REST（#788 · #752 §4.3 R8）：挂 /api/v1/plugins。目录 = 编译期静态清单
//（manifest 字段即目录数据源），启用位 = plugin_enablements per-user 持久行。
// 无行 = 未启用（默认未启用，根决策 Q16 先例）；PUT 幂等 upsert。
// 8xxxx 码段：80040 不存在/越权同码防探测（目录外 id）；90002 承接 body 字段级校验。

import { Router, type Request, type Response } from 'express'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { PLUGIN_ID_REGEX, pluginEnablementSchema } from '../validation/schemas'
import type { PluginManifest } from './api'

export interface PluginsRouterDeps {
  readonly prisma: PluginsRouterPrisma
  /** 编译期目录（server.ts 装配 PLUGIN_MANIFESTS 注入；测试注 fixture 清单） */
  readonly manifests: readonly PluginManifest[]
}

// Prisma 结构子集（本域用到的 delegate 面——测试可注内存 fake）。
export interface PluginsRouterPrisma {
  readonly pluginEnablement: {
    findMany(p: { where: { ownerId: string } }): Promise<Array<{ pluginId: string; enabled: boolean }>>
    upsert(p: {
      where: { ownerId_pluginId: { ownerId: string; pluginId: string } }
      create: { ownerId: string; pluginId: string; enabled: boolean; enabledAt: Date }
      update: { enabled: boolean }
    }): Promise<{ enabled: boolean }>
  }
}

function pathId(req: Request): string {
  return typeof req.params.id === 'string' ? req.params.id : ''
}

export function createPluginsRouter(deps: PluginsRouterDeps): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // GET /api/v1/plugins —— 目录清单 + 当前用户启用位（§4.3 表）
  router.get('/', async (req: Request, res: Response) => {
    const rows = await deps.prisma.pluginEnablement.findMany({ where: { ownerId: req.user!.id } })
    const enabledById = new Map(rows.map((row) => [row.pluginId, row.enabled]))
    ok(res, {
      plugins: deps.manifests.map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        enabled: enabledById.get(manifest.id) === true,
      })),
    })
  })

  // PUT /api/v1/plugins/:id/enablement —— 幂等 upsert（§4.3 表；body {enabled: boolean}）
  router.put('/:id/enablement', validateBody(pluginEnablementSchema), async (req: Request, res: Response) => {
    const pluginId = pathId(req)
    const manifest = deps.manifests.find((m) => m.id === pluginId)
    if (!manifest || !PLUGIN_ID_REGEX.test(pluginId)) {
      // 目录外 id 与形态非法同码（80040 防探测锁式，对齐 figures 70040 先例）
      throw fail(CODE.PLUGIN_NOT_FOUND)
    }
    const { enabled } = req.body as { enabled: boolean }
    await deps.prisma.pluginEnablement.upsert({
      where: { ownerId_pluginId: { ownerId: req.user!.id, pluginId } },
      create: { ownerId: req.user!.id, pluginId, enabled, enabledAt: new Date() },
      update: { enabled },
    })
    ok(res, { id: pluginId, enabled })
  })

  return router
}
