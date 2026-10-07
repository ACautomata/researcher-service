// models 5 路由（#336 · /api/v1/models/providers[/<pid>]；#857 归属门改挂 ownerId）。
// 挂 /api/v1/models（owner 级，对齐 sessions 扁平挂用户先例）；ownerId 直取认证身份
// req.user.id——不接收任何客户端 userId 作为授权覆写面。
//
// #857（退役②）：归属门从容器行解析（getInstanceForUser）改为认证身份直派生，models 域与
// 容器行完全脱钩（为③容器消费面退役清障）。随之移除：
//   - 容器不存在/越权 20040（无容器行可查——越权语义由 provider 级 40040 同码防探测承接，
//     跨用户探测他人 pid 逐字节同「不存在」）；
//   - creating/removing 拒写 20043（路径上无容器即无生命周期可检，纯契约语义随耦合退役）。
// admin 亦只操作本人配置面（owner 级无跨用户覆写面；容器选择器随 ModelView 一并下线）。
//
// 白名单第一层（#775，731 §5.1）：body 校验（zod URL 形态，90002）后，service 事务前再验
// origin ∈ provider_endpoints + DNS 私网/环回拒绝 → 90002 字段级 base_url（不泄露白名单内容）。
//
// 错误映射（#336 + #319 §1.3 + #775 + #857）：校验失败（含白名单未命中）→ 90002 ·
// provider 不存在/越权 → 40040（同码防探测）· provider_id 冲突 → 40041。

import { Router, type Request, type Response } from 'express'
import type { z } from 'zod'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { modelProviderWriteSchema } from '../validation/schemas'
import type { HostLookup } from '../runner/allowlist'
import {
  ModelProviderService,
  type ModelProviderServiceOptions,
  type ModelProviderWriteInput,
} from './service'

// 白名单校验注入缝（#775，731 §5.1）：lookup 测试注 fake 免真 DNS；allowPrivate 覆盖 env 开关。
// 全部可选 —— models 路由零外部资源依赖，app.ts 无条件挂载。
export interface ModelsRouterDeps {
  lookup?: HostLookup
  allowPrivate?: boolean
}

function toInput(body: z.infer<typeof modelProviderWriteSchema>): ModelProviderWriteInput {
  return {
    providerId: body.provider_id,
    api: body.api,
    baseUrl: body.base_url,
    apiKeyEnvId: body.api_key_env_id,
    authHeader: body.auth_header,
    models: body.models,
  }
}

// body 校验（90002 + 字段明细）。#857 后路由层无容器存在性探测面，校验顺序的防探测
// 考量只剩 provider 级（service 内 40040 同码），故 parseBody 在 handler 入口直接跑。
function parseBody(req: Request): ModelProviderWriteInput {
  const result = modelProviderWriteSchema.safeParse(req.body)
  if (!result.success) {
    const fieldErrors = result.error.flatten().fieldErrors as Record<string, string[]>
    throw fail(CODE.VALIDATION_FAILED, undefined, fieldErrors)
  }
  return toInput(result.data)
}

export function createModelsRouter(deps: ModelsRouterDeps = {}): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // owner 直取认证身份（#857）：requireAuth 已保证 req.user 非空。
  const ownerId = (req: Request): string => req.user!.id
  const serviceOpts = (): ModelProviderServiceOptions => ({
    lookup: deps.lookup,
    allowPrivate: deps.allowPrivate,
  })
  const service = (req: Request): ModelProviderService =>
    new ModelProviderService(req.prisma, serviceOpts())

  // GET /providers —— 列表（按 createdAt 升序，对齐 Django ordering）。
  router.get('/providers', async (req: Request, res: Response) => {
    ok(res, await service(req).list(ownerId(req)))
  })

  // POST /providers —— 新建；唯一(ownerId, providerId) 冲突 → 40041（#771 归属上移）；
  // 白名单未命中 → 90002 字段级。
  router.post('/providers', async (req: Request, res: Response) => {
    const input = parseBody(req)
    ok(res, await service(req).create(ownerId(req), input))
  })

  // GET /providers/:pid —— 回读单条；不存在/越权 → 40040（同码防探测）。
  router.get('/providers/:pid', async (req: Request, res: Response) => {
    ok(res, await service(req).get(ownerId(req), req.params.pid as string))
  })

  // PUT /providers/:pid —— 改（路径 pid 定位，body 可改 provider_id）；
  // 撞同 owner 既有 pid → 40041；白名单未命中 → 90002 字段级。
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
