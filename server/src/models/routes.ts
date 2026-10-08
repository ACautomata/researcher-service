// models 域路由（#336 · #857 归属门改挂 ownerId；#881 预设制换形）。
//
// /api/v1/models（owner 级，对齐 sessions 扁平挂用户先例；ownerId 直取认证身份 req.user.id
// ——不接收任何客户端 userId 作为授权覆写面）：
//   GET  /presets            —— 端点预设目录（六预设；建端点下拉的单一取值域）
//   GET  /platform           —— 平台默认端点只读视图（env 派生虚拟实体，不落库；永无 key 材料）
//   GET  /providers          —— 本人 BYOK 端点列表（key 只出掩码）
//   POST /providers          —— 建 BYOK 端点（preset_id 锁定协议与地址；api_key 缺省 = 平台共享 key）
//   GET  /providers/:pid     —— 回读单条；不存在/越权 → 40040（同码防探测）
//   PUT  /providers/:pid     —— 改（api_key 留空 = 保持不变；撞同 owner 既有 pid → 40041）
//   DELETE /providers/:pid   —— 删（引用方回落语义归 #885；本票行为 = 直接删除 + 热生效）
//
// 错误映射（#336 + #319 §1.3 + #881）：校验失败（含保留 id 抢注/未知预设）→ 90002 字段级 ·
// provider 不存在/越权 → 40040（同码防探测）· provider_id 冲突 → 40041。

import { Router, type Request, type Response } from 'express'
import type { z } from 'zod'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { modelProviderWriteSchema } from '../validation/schemas'
import { config } from '../config'
import { ENDPOINT_PRESETS, presetById, protocolToLcProvider, PLATFORM_PROVIDER_ID } from './presets'
import {
  ModelProviderService,
  type ModelProviderWriteInput,
} from './service'

function toInput(body: z.infer<typeof modelProviderWriteSchema>): ModelProviderWriteInput {
  return {
    providerId: body.provider_id,
    presetId: body.preset_id,
    apiKey: body.api_key,
    models: body.models,
  }
}

// body 校验（90002 + 字段明细）。parseBody 在 handler 入口直接跑（路由层无存在性探测面，
// provider 级防探测在 service 内 40040 同码）。
function parseBody(req: Request): ModelProviderWriteInput {
  const result = modelProviderWriteSchema.safeParse(req.body)
  if (!result.success) {
    const fieldErrors = result.error.flatten().fieldErrors as Record<string, string[]>
    throw fail(CODE.VALIDATION_FAILED, undefined, fieldErrors)
  }
  return toInput(result.data)
}

export function createModelsRouter(): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // owner 直取认证身份（#857）：requireAuth 已保证 req.user 非空。
  const ownerId = (req: Request): string => req.user!.id
  const service = (req: Request): ModelProviderService => new ModelProviderService(req.prisma)

  // GET /presets —— 端点预设目录（六预设；协议/地址/默认模型；无敏感面，认证用户可读）。
  router.get('/presets', (_req: Request, res: Response) => {
    ok(
      res,
      ENDPOINT_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        base_url: p.baseUrl,
        default_models: p.defaultModels,
      })),
    )
  })

  // GET /platform —— 平台默认端点只读视图（env 派生虚拟实体；任何响应无 key 材料——
  // key_configured 布尔即全部凭证信息面）。
  router.get('/platform', (_req: Request, res: Response) => {
    const preset = presetById(config.llm.preset)
    if (!preset) {
      // config 启动校验已挡非法预设；防御坏值（部署中途清单收缩）→ 90003 明确配置错误
      throw fail(CODE.LLM_NOT_CONFIGURED, '平台预设配置非法（LLM_PRESET）')
    }
    const defaultModel = config.llm.model !== '' ? config.llm.model : preset.defaultModels[0]?.id ?? null
    ok(res, {
      provider_id: PLATFORM_PROVIDER_ID,
      preset_id: preset.id,
      protocol: preset.protocol,
      lc_provider: protocolToLcProvider(preset.protocol),
      base_url: preset.baseUrl,
      default_model: defaultModel,
      key_configured: config.llm.apiKey !== '',
    })
  })

  // GET /providers —— 列表（按 createdAt 升序；key 只出掩码）。
  router.get('/providers', async (req: Request, res: Response) => {
    ok(res, await service(req).list(ownerId(req)))
  })

  // POST /providers —— 新建；唯一(ownerId, providerId) 冲突 → 40041；保留 id/未知预设 → 90002。
  router.post('/providers', async (req: Request, res: Response) => {
    const input = parseBody(req)
    ok(res, await service(req).create(ownerId(req), input))
  })

  // GET /providers/:pid —— 回读单条；不存在/越权 → 40040（同码防探测）。
  router.get('/providers/:pid', async (req: Request, res: Response) => {
    ok(res, await service(req).get(ownerId(req), req.params.pid as string))
  })

  // PUT /providers/:pid —— 改（路径 pid 定位，body 可改 provider_id；api_key 留空 = 保持不变）；
  // 撞同 owner 既有 pid → 40041。
  router.put('/providers/:pid', async (req: Request, res: Response) => {
    const input = parseBody(req)
    ok(res, await service(req).update(ownerId(req), req.params.pid as string, input))
  })

  // DELETE /providers/:pid —— 删；不存在/越权 → 40040。
  router.delete('/providers/:pid', async (req: Request, res: Response) => {
    await service(req).remove(ownerId(req), req.params.pid as string)
    ok(res, null)
  })

  return router
}
