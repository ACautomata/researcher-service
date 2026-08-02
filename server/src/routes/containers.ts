import { Router, type Request, type Response } from 'express'
import type { PrismaClient, Container } from '../generated/prisma/client'
import { ok, fail } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import type { AuthUser } from '../types'
import type { Orchestrator } from '../orchestrator/orchestrator'
import { NAME_REGEX } from '../orchestrator/ports'
import { containerCreateSchema } from '../validation/schemas'

// 容器路由 /api/v1/containers/*（#334 M2 · #312 隔离）。
// 归属前置 _get_instance：admin 全放行 / user 仅本人；「不存在 vs 越权」同码 20040
// 防探测（区分仅进服务端日志）。create 同步返 creating 快照、delete 异步返信封。

export interface ContainerRouterDeps {
  prisma: PrismaClient
  orchestrator: Orchestrator
}

// 单点归属前置（#312⑤）：chat/wiki/models/containers 全部经此传导。
async function getInstance(
  prisma: PrismaClient,
  name: string,
  user: AuthUser,
): Promise<Container> {
  const row = await prisma.container.findUnique({ where: { name } })
  if (!row) {
    console.warn(`[containers] not_found: name=${name}`)
    throw fail(CODE.CONTAINER_NOT_FOUND)
  }
  if (user.role !== 'admin' && row.ownerId !== user.id) {
    console.warn(`[containers] owner_mismatch: name=${name} uid=${user.id}`)
    throw fail(CODE.CONTAINER_NOT_FOUND)
  }
  return row
}

// ContainerSummary（契约 §2.3）：pairing 批量预取 + health 由 status 派生
function toSummary(
  row: Container & { pairing?: { status: string } | null },
): Record<string, unknown> {
  return {
    name: row.name,
    port: row.port,
    status: row.status,
    health: row.status === 'running' ? 'healthy' : row.status === 'creating' ? 'pending' : row.status,
    image: row.image,
    container_id: row.containerId,
    created_at: row.createdAt,
    pairing: row.pairing
      ? { status: row.pairing.status }
      : { status: 'unpaired' },
  }
}

export function createContainersRouter(deps: ContainerRouterDeps): Router {
  const { prisma, orchestrator } = deps
  const router = Router()

  router.use(requireAuth, mustChangePasswordGate)

  // GET / —— user 仅见自己、admin 跨用户全部（#312 隔离）
  router.get('/', async (req: Request, res: Response) => {
    const user = req.user!
    const where = user.role === 'admin' ? {} : { ownerId: user.id }
    const rows = await prisma.container.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: { pairing: { select: { status: true } } },
    })
    ok(res, rows.map(toSummary))
  })

  // POST / —— 同步返 creating 快照（#313：端口入队前分配 + 入队串行）
  router.post('/', validateBody(containerCreateSchema), async (req: Request, res: Response) => {
    const user = req.user!
    const { name } = req.body as { name: string }
    const row = await orchestrator.createReserve(name, user.id, user.maxContainers)
    const full = await prisma.container.findUnique({
      where: { id: row.id },
      include: { pairing: { select: { status: true } } },
    })
    ok(res, full ? toSummary(full) : toSummary(row))
  })

  // DELETE /<name> —— 异步：返信封立即，list 轮询观察 removing（#313）
  router.delete('/:name', async (req: Request, res: Response) => {
    const user = req.user!
    const name = req.params.name as string
    if (!NAME_REGEX.test(name)) throw fail(CODE.VALIDATION_FAILED, undefined, { name: ['名称不合法'] })
    await getInstance(prisma, name, user) // 归属校验（越权/不存在同码 20040）
    await orchestrator.deleteEnqueue(name, user.id)
    ok(res, null) // 已入队（list 轮询 observing removing）
  })

  return router
}
