// provider_endpoints admin REST（#775，731 §3.1——端点白名单管理面，admin-only，面板级）。
//
// /api/v1/provider-endpoints：
//   GET    /            —— 白名单列表（createdAt 升序）
//   POST   /            —— 新建条目（zod + host DNS 私网拒绝 + origin 唯一 + config_meta bump）
//   DELETE /:id         —— 删除条目（version bump；引用该端点的 provider 行不级联——下个
//                           run 实例构造复验未命中 → 40042，双层校验天然兜底）
//
// 中间件：requireAuth → mustChangePasswordGate → requireAdmin（非 admin → 10004——面板级
// 运营资源无存在性敏感面，直用角色码，users 域的 10041 防探测语义不适用）。
//
// 错误面：校验失败（含 http 生产禁用 / DNS 私网）→ 90002 字段级 · origin 冲突 → 40041 ·
// 不存在 → 40040 · 非 admin → 10004。CRUD 同事务 bump config_meta.version（热生效信号，
// 731 §4——白名单变更与 provider 配置变更走同一版本号，runner 下个 run 重载快照）。

import { Router, type Request, type Response } from 'express'
import type { z } from 'zod'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { providerEndpointWriteSchema } from '../validation/schemas'
import { config } from '../config'
import type { PrismaClient, ProviderEndpoint } from '../generated/prisma/client'
import {
  checkHostAllowed,
  defaultHostLookup,
  effectivePort,
  OriginCheckError,
  type HostLookup,
} from '../runner/allowlist'
import { bumpConfigVersion } from './configVersion'

// snake_case wire（对齐 models 域 wire 契约）
export interface ProviderEndpointView {
  id: string
  scheme: string
  host: string
  port: number | null
  note: string
  created_by: string
  created_at: Date
}

function toView(row: ProviderEndpoint): ProviderEndpointView {
  return {
    id: row.id,
    scheme: row.scheme,
    host: row.host,
    port: row.port,
    note: row.note,
    created_by: row.createdBy,
    created_at: row.createdAt,
  }
}

export class ProviderEndpointService {
  private readonly lookup: HostLookup
  private readonly allowPrivate: boolean

  constructor(
    private readonly prisma: PrismaClient,
    opts: { lookup?: HostLookup; allowPrivate?: boolean } = {},
  ) {
    this.lookup = opts.lookup ?? defaultHostLookup
    this.allowPrivate = opts.allowPrivate ?? config.runner.allowPrivateProviderEndpoints
  }

  async list(): Promise<ProviderEndpointView[]> {
    const rows = await this.prisma.providerEndpoint.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map(toView)
  }

  async create(
    input: z.infer<typeof providerEndpointWriteSchema>,
    createdBy: string,
  ): Promise<ProviderEndpointView> {
    // 'http' 限 dev（731 §3.1：生产仅 https）——生产收到 http → 90002 字段级。
    if (input.scheme === 'http' && process.env.NODE_ENV === 'production') {
      throw fail(CODE.VALIDATION_FAILED, undefined, {
        scheme: ['生产环境仅允许 https 端点（http 限开发环境）'],
      })
    }
    // host DNS 私网/环回拒绝（与 ModelProvider CRUD 同一语义同源，731 §5.1；allowPrivate 逃生门）。
    try {
      await checkHostAllowed(input.host, { lookup: this.lookup, allowPrivate: this.allowPrivate })
    } catch (e) {
      if (e instanceof OriginCheckError) {
        throw fail(CODE.VALIDATION_FAILED, undefined, { host: [e.fieldMessage] })
      }
      throw e
    }
    // NULL-port 同语义查重（先查后建，SQLite UNIQUE NULL 不判重的应用层兜底）：
    // 同 scheme+host 且条目 port 与新 origin「有效端口等价」即冲突（effectivePort NULL =
    // scheme 默认端口——与运行时 origin 精确匹配同规则，731 §3.1）。竞态残余（并发同建）
    // 由 unique(scheme, host, port) + P2002 转译 40041 双保险。
    const dupes = await this.prisma.providerEndpoint.findMany({
      where: { scheme: input.scheme, host: input.host },
    })
    if (dupes.some((r) => effectivePort(r.scheme, r.port) === effectivePort(input.scheme, input.port ?? null))) {
      throw fail(CODE.PROVIDER_ID_CONFLICT, '该端点（scheme+host+port）已存在')
    }
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.providerEndpoint.create({
          data: {
            scheme: input.scheme,
            host: input.host,
            port: input.port ?? null,
            note: input.note ?? '',
            createdBy,
          },
        })
        await bumpConfigVersion(tx)
        return created
      })
      return toView(row)
    } catch (e) {
      rethrowEndpointKnown(e)
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.providerEndpoint.delete({ where: { id } })
        await bumpConfigVersion(tx)
      })
    } catch (e) {
      rethrowEndpointKnown(e)
    }
  }
}

// unique(scheme, host, port) 冲突 → 40041；行缺失 → 40040。
// 注意 SQLite UNIQUE 含 NULL port 不判重（#771 注记）——应用层先查后建在 service.create
// 内兜底；并发竞态残余仍可能裸抛 P2002，此处一并转译。
function rethrowEndpointKnown(e: unknown): never {
  const code = (e as { code?: string }).code
  if (code === 'P2002') throw fail(CODE.PROVIDER_ID_CONFLICT, '该端点（scheme+host+port）已存在')
  if (code === 'P2025') throw fail(CODE.PROVIDER_NOT_FOUND, '端点不存在')
  throw e
}

export interface ProviderEndpointsRouterDeps {
  lookup?: HostLookup
  allowPrivate?: boolean
}

export function createProviderEndpointsRouter(deps: ProviderEndpointsRouterDeps = {}): Router {
  const router = Router()
  // 注意：admin 门只许挂在 /provider-endpoints 子路径上（router.use 链会拦所有 /api/v1/* 的
  // 后续挂载路由——非 admin 打 files/wiki/models 会被误拒 10004）。认证面挂子路径、缺路径
  // 直通 next() 让后续路由继续匹配。
  const ep = Router()
  ep.use(requireAuth, mustChangePasswordGate, requireAdmin)
  const service = (req: Request) =>
    new ProviderEndpointService(req.prisma, { lookup: deps.lookup, allowPrivate: deps.allowPrivate })

  ep.get('/', async (req: Request, res: Response) => {
    ok(res, await service(req).list())
  })

  ep.post('/', async (req: Request, res: Response) => {
    const result = providerEndpointWriteSchema.safeParse(req.body)
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors as Record<string, string[]>
      throw fail(CODE.VALIDATION_FAILED, undefined, fieldErrors)
    }
    // 查重与 version bump 全在 service 内（routes 薄分层，对齐 models/routes.ts 先例）
    ok(res, await service(req).create(result.data, req.user!.id))
  })

  ep.delete('/:id', async (req: Request, res: Response) => {
    await service(req).remove(req.params.id as string)
    ok(res, null)
  })

  router.use('/provider-endpoints', ep)
  return router
}
