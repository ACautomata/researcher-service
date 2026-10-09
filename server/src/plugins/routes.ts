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
import { PLUGIN_ID_REGEX, pluginEnablementSchema, pluginCommandCompletionQuerySchema, pluginLlmAssignmentWriteSchema } from '../validation/schemas'
import type { PluginManifest } from './api'
import { PluginLlmAssignmentService } from './assignments'

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

  // 插件 LLM 指派服务（#883 T3）：目录（manifests）注入即取值域——声明 llm 插件 ∪ 'judge'；
  // prisma 按 req 注入（对齐本路由 pluginEnablement 面）。
  const assignmentService = (req: Request): PluginLlmAssignmentService =>
    new PluginLlmAssignmentService({ prisma: req.prisma, manifests: deps.manifests })

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
        commands: (manifest.commands ?? []).map(({ name, description, getArgumentCompletions }) => ({
          name, description: description ?? '',
          ...(getArgumentCompletions ? { hasArgumentCompletions: true } : {}),
        })),
        enabled: enabledById.get(manifest.id) === true,
      })),
    })
  })

  // ---- 插件 LLM 指派（#883 T3）：挂 /llm-assignments 与 /:id/llm-assignment ----
  // GET：targets（声明 llm 插件 ∪ judge）+ 本人现行指派——指派区一屏的单读面。
  // 注意注册序：字面路径 /llm-assignments 须先于任何 GET /:id/... 形（本路由 GET /:id 无
  // 短形式，无吞噬面；显式前置防未来路由漂移）。
  router.get('/llm-assignments', async (req: Request, res: Response) => {
    ok(res, await assignmentService(req).list(req.user!.id))
  })

  // PUT：幂等 upsert（body {provider_id, model_id} 双可空）；未声明插件/目录外 → 80040；
  // 引用校验（端点 ∈ 本人端点集 ∪ platform、模型属端点模型集）→ 90002 字段级；
  // 事务内 bump 配置版本（热生效——下一 run 重建快照）。
  router.put('/:id/llm-assignment', validateBody(pluginLlmAssignmentWriteSchema), async (req: Request, res: Response) => {
    const pluginId = pathId(req)
    if (!PLUGIN_ID_REGEX.test(pluginId)) throw fail(CODE.PLUGIN_NOT_FOUND)
    ok(res, await assignmentService(req).upsert(req.user!.id, pluginId, {
      provider_id: req.body.provider_id,
      model_id: req.body.model_id,
    }))
  })

  // DELETE：撤指派回默认链（删行 + bump；无行幂等不 bump）。
  router.delete('/:id/llm-assignment', async (req: Request, res: Response) => {
    const pluginId = pathId(req)
    if (!PLUGIN_ID_REGEX.test(pluginId)) throw fail(CODE.PLUGIN_NOT_FOUND)
    await assignmentService(req).remove(req.user!.id, pluginId)
    ok(res, null)
  })

  // #797：只读参数补全，启用位与当前用户同源；不执行 command handler。
  router.get('/:id/commands/:name/completions', async (req: Request, res: Response) => {
    const parsed = pluginCommandCompletionQuerySchema.safeParse(req.query)
    if (!parsed.success) throw fail(CODE.VALIDATION_FAILED, undefined, parsed.error.flatten().fieldErrors)
    const manifest = deps.manifests.find(m => m.id === pathId(req))
    const command = manifest?.commands?.find(c => c.name === req.params.name)
    const rows = await deps.prisma.pluginEnablement.findMany({ where: { ownerId: req.user!.id } })
    if (!manifest || !command || !rows.some(row => row.pluginId === manifest.id && row.enabled)) {
      throw fail(CODE.PLUGIN_NOT_FOUND)
    }
    const completions = await command.getArgumentCompletions?.(parsed.data.prefix) ?? []
    ok(res, { completions: completions.slice(0, 50) })
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
