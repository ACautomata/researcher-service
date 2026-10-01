// models 5 路由（#336 · /api/v1/containers/<name>/models/providers[/<pid>]）。
// 挂 /api/v1/containers，路由路径 `/:name/models/providers/...`（Express 5 不把 app.use 挂载路径的
// :name 合并进 req.params，故 :name 在 router 内部声明，对齐 containers/wiki 同款挂载方式）。
// 路由层不加 name 正则（校验在 handler 内做，保「非法 → 90002」而非 Express 默认 404）。
//
// 隔离（#312）：经 getInstanceForUser 归属前置 —— admin 全放行 / user 仅本人，越权 20040 同码防探测。
// 写操作（POST/PUT/DELETE）拒 creating/removing 行（20043）——生命周期忙拒写。#775 写盘链退役后
// 该门的原始竞态理由（putArchive 与删容器 rmtree 竞态）消失，检查保留（REST 契约稳定语义）。
// GET 只读无副作用，不检查。
//
// 错误映射（#336 + #319 §1.3 + #775）：name 非法 → 90002(data.name) · 容器不存在/越权 → 20040 ·
// creating/removing 写 → 20043 · 校验失败（含 base_url 非法/白名单未命中/DNS 私网——白名单
// 第一层）→ 90002 · provider 不存在/越权 → 40040 · provider_id 冲突 → 40041。
// （#775 写盘退役：90003 不再出自 models CRUD；运行时白名单第二层未命中 → 40042，见 runner/
// providerRegistry。）
// 顺序（对齐 Django _get_instance 先于 Serializer）：name → 容器归属(20040) → creating 拒写(20043)
// → body 校验(90002) —— 非法 body 撞不存在/越权容器一律 20040，不泄露容器存在性（防探测）。

import { Router, type Request, type Response } from 'express'
import type { z } from 'zod'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { CONTAINER_NAME_REGEX, modelProviderWriteSchema } from '../validation/schemas'
import { getInstanceForUser } from '../containers/orchestrator'
import { ModelProviderService, type ModelProviderWriteInput } from './service'
import type { DnsLookup } from './endpointAllowlist'

export interface ModelsRouterDeps {
  // DNS 解析 Port（#775 白名单第一层的私网拒绝；S1 接缝：测试注入 fake）。
  // 缺省 = nodeDnsLookup（node:dns/promises lookup all）。
  resolveDns?: DnsLookup
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

// body 校验（90002 + 字段明细）—— 在容器/越权校验之后跑（对齐 Django _get_instance 先于
// Serializer；wiki 同款顺序陷阱 #335）：非法 body 撞「不存在/越权」容器一律 20040，不泄露容器存在性。
// 不用 validateBody 中间件（它在归属前置之前执行，顺序相反）。
function parseBody(req: Request): ModelProviderWriteInput {
  const result = modelProviderWriteSchema.safeParse(req.body)
  if (!result.success) {
    const fieldErrors = result.error.flatten().fieldErrors as Record<string, string[]>
    throw fail(CODE.VALIDATION_FAILED, undefined, fieldErrors)
  }
  return toInput(result.data)
}

export function createModelsRouter(deps: ModelsRouterDeps): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // 公共前置（对齐 Django _get_instance）：name 校验（90002）→ 查容器 + owner 判定（20040）。
  const resolveInstance = async (req: Request, name: string | string[]) => {
    if (typeof name !== 'string' || !CONTAINER_NAME_REGEX.test(name)) {
      throw fail(CODE.VALIDATION_FAILED, undefined, {
        name: ['name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'],
      })
    }
    return getInstanceForUser(req.prisma, req.user!, name)
  }
  // 写前置：归属校验后再拒 creating/removing（防 lost update + 防与删除竞态；只读 GET 不查）。
  // creating：CREATING 期间 create 的 base render 可能覆盖 rewrite（lost update，对齐 Django）。
  // removing（#366 codex P2）：删除后台清容器/目录期间放行写 → putArchive 与删容器竞态（容器已删则
  // 写盘失败、未删则写盘落孤儿容器）；removing 与 creating 同属「生命周期忙」拒写。
  const resolveWrite = async (req: Request, name: string | string[]) => {
    const inst = await resolveInstance(req, name)
    if (inst.status === 'creating') {
      throw fail(CODE.CONTAINER_BUSY, '容器正在创建中，暂不能配置模型，请稍候')
    }
    if (inst.status === 'removing') {
      throw fail(CODE.CONTAINER_BUSY, '容器正在删除中，暂不能配置模型，请稍候')
    }
    return inst
  }
  const service = (req: Request): ModelProviderService =>
    new ModelProviderService(req.prisma, deps.resolveDns)

  // GET /:name/models/providers —— 列表（按 createdAt 升序，对齐 Django ordering）。
  router.get('/:name/models/providers', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    ok(res, await service(req).list(inst))
  })

  // POST /:name/models/providers —— 新建；唯一(ownerId, providerId) 冲突 → 40041（#771 归属上移）；
  // base_url 白名单未命中/DNS 私网 → 90002（白名单第一层）。body 校验在容器/越权之后。
  router.post('/:name/models/providers', async (req: Request, res: Response) => {
    const inst = await resolveWrite(req, req.params.name)
    const input = parseBody(req)
    ok(res, await service(req).create(inst, input))
  })

  // GET /:name/models/providers/:pid —— 回读单条；不存在 → 40040（防探测）。
  router.get('/:name/models/providers/:pid', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    ok(res, await service(req).get(inst, req.params.pid as string))
  })

  // PUT /:name/models/providers/:pid —— 改（路径 pid 定位，body 可改 provider_id）；
  // 撞同 owner 既有 pid → 40041；白名单未命中 → 90002。body 校验在容器/越权之后。
  router.put('/:name/models/providers/:pid', async (req: Request, res: Response) => {
    const inst = await resolveWrite(req, req.params.name)
    const input = parseBody(req)
    ok(res, await service(req).update(inst, req.params.pid as string, input))
  })

  // DELETE /:name/models/providers/:pid —— 删（同事务 version bump，热生效）。
  router.delete('/:name/models/providers/:pid', async (req: Request, res: Response) => {
    const inst = await resolveWrite(req, req.params.name)
    await service(req).remove(inst, req.params.pid as string)
    ok(res, null)
  })

  return router
}
