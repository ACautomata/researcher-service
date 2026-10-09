// models 域路由（#336 · #857 归属门改挂 ownerId；#881 预设制换形；#882 端点试连）。
//
// /api/v1/models（owner 级，对齐 sessions 扁平挂用户先例；ownerId 直取认证身份 req.user.id
// ——不接收任何客户端 userId 作为授权覆写面）：
//   GET  /presets            —— 端点预设目录（六预设；建端点下拉的单一取值域）
//   GET  /platform           —— 平台默认端点只读视图（env 派生虚拟实体，不落库；永无 key 材料）
//   POST /test               —— 端点试连（#882：不入库、1-token 级、10s 超时、错误文本净化防 key 回显）
//   GET  /providers          —— 本人 BYOK 端点列表（key 只出掩码）
//   POST /providers          —— 建 BYOK 端点（preset_id 锁定协议与地址；api_key 缺省 = 平台共享
//                               key，仅限平台预设端点——非平台预设 90002，防平台 key 外发）
//   GET  /providers/:pid     —— 回读单条；不存在/越权 → 40040（同码防探测）
//   PUT  /providers/:pid     —— 改（api_key 留空 = 保持不变；撞同 owner 既有 pid → 40041）
//   DELETE /providers/:pid   —— 删（引用方下一 run 回落平台默认，在飞快照不变）
//
// 错误映射（#336 + #319 §1.3 + #881）：校验失败（含保留 id 抢注/未知预设）→ 90002 字段级 ·
// provider 不存在/越权 → 40040（同码防探测）· provider_id 冲突 → 40041 · 试连失败 → 90003
//（净化错误文本）。

import { Router, type Request, type Response } from 'express'
import type { z } from 'zod'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { endpointTestSchema, modelProviderWriteSchema } from '../validation/schemas'
import { config } from '../config'
import { ENDPOINT_PRESETS, presetById, protocolToLcProvider, PLATFORM_PROVIDER_ID, platformModels } from './presets'
import {
  ModelProviderService,
  type ModelProviderWriteInput,
} from './service'
import { EndpointProbeService, type EndpointProbeDeps } from './probe'

// 试连带注入缝（测试 fake 工厂 / 短超时；生产缺省 = initChatModel 真工厂 + 10s）
export type ModelsRouterDeps = EndpointProbeDeps

// zod 已解析的 snake_case body → camelCase domain shape（validateBody 中间件前置）。
function toInput(body: z.infer<typeof modelProviderWriteSchema>): ModelProviderWriteInput {
  return {
    providerId: body.provider_id,
    presetId: body.preset_id,
    apiKey: body.api_key,
    models: body.models,
  }
}

export function createModelsRouter(deps: ModelsRouterDeps = {}): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // owner 直取认证身份（#857）：requireAuth 已保证 req.user 非空。
  const ownerId = (req: Request): string => req.user!.id
  const service = (req: Request): ModelProviderService => new ModelProviderService(req.prisma)
  const probe = new EndpointProbeService(deps)

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
      // 指派可选项域 = 写侧同源（platformModels 派生；LLM_MODEL 覆盖时单条）——前端指派
      // 下拉直接消费本字段，不再从预设目录二次推导（#880 review 收敛：域一致 by construction）。
      models: platformModels(config.llm.model, config.llm.preset),
      key_configured: config.llm.apiKey !== '',
    })
  })

  // POST /test —— 端点试连（#882）：按表单态真实试连（不入库、不写日志）；成功回延迟。
  // 失败（key 错/端点错/超时）→ 90003 + 净化错误文本（净化在 probe service 内）。
  router.post('/test', validateBody(endpointTestSchema), async (req: Request, res: Response) => {
    const r = await probe.probe({
      presetId: req.body.preset_id,
      apiKey: req.body.api_key,
      model: req.body.model,
    })
    ok(res, { ok: true, latency_ms: r.latencyMs })
  })

  // GET /providers —— 列表（按 createdAt 升序；key 只出掩码）。
  router.get('/providers', async (req: Request, res: Response) => {
    ok(res, await service(req).list(ownerId(req)))
  })

  // POST /providers —— 新建；唯一(ownerId, providerId) 冲突 → 40041；保留 id/未知预设/
  // 非平台预设无自有 key → 90002。
  router.post('/providers', validateBody(modelProviderWriteSchema), async (req: Request, res: Response) => {
    ok(res, await service(req).create(ownerId(req), toInput(req.body)))
  })

  // GET /providers/:pid/impact —— 本人端点删除影响面；归属门同详情读面。
  router.get('/providers/:pid/impact', async (req: Request, res: Response) => {
    ok(res, await service(req).impact(ownerId(req), req.params.pid as string))
  })

  // GET /providers/:pid —— 回读单条；不存在/越权 → 40040（同码防探测）。
  router.get('/providers/:pid', async (req: Request, res: Response) => {
    ok(res, await service(req).get(ownerId(req), req.params.pid as string))
  })

  // PUT /providers/:pid —— 改（路径 pid 定位，body 可改 provider_id；api_key 留空 = 保持不变）；
  // 撞同 owner 既有 pid → 40041。
  router.put('/providers/:pid', validateBody(modelProviderWriteSchema), async (req: Request, res: Response) => {
    ok(res, await service(req).update(ownerId(req), req.params.pid as string, toInput(req.body)))
  })

  // DELETE /providers/:pid —— 删；不存在/越权 → 40040。
  router.delete('/providers/:pid', async (req: Request, res: Response) => {
    await service(req).remove(ownerId(req), req.params.pid as string)
    ok(res, null)
  })

  return router
}
