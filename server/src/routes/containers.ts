// 容器列表/创建/删除（#334 M2 · /api/v1/containers/*）。
// 隔离（#312）：user 仅见自己、admin 跨用户全部；归属前置 getInstanceForUser 越权 20040 同码防探测。
// 并发（#313）：create/delete 按 name 串行入队、进程内互斥、端口入队前分配、delete 异步 + 取消标志。

import { Router, type Request, type Response } from 'express'
import { ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { containerCreateSchema, CONTAINER_NAME_REGEX } from '../validation/schemas'
import { fail } from '../envelope'
import { getInstanceForUser, type Orchestrator } from '../containers/orchestrator'
import type { ContainerSummary } from '../containers/readModel'
import type { Container } from '../generated/prisma/client'

// Pairing 状态快照（契约 §2.4）。M2 pairing 表无写入方 → 恒 unpaired 默认；
// M4 配对切片落库后经批量预取替换（本函数签名已按预取设计，避免 list N+1）。
interface PairingStatusView {
  status: string
  device_id: string
  scopes: string[]
  pairing_request_id: string
}
function defaultPairing(): PairingStatusView {
  return { status: 'unpaired', device_id: '', scopes: [], pairing_request_id: '' }
}

type SummaryWithPairing = ContainerSummary & { pairing: PairingStatusView }

export function createContainersRouter(orch: Orchestrator): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // GET / —— user 自己 / admin 全部；ContainerSummary + pairing 预取。
  router.get('/', async (req: Request, res: Response) => {
    const user = req.user!
    const where = user.role === 'admin' ? {} : { ownerId: user.id }
    const items = await orch.list(where)
    // pairing 批量预取（M2 恒空 → default；M4 落库后注入真实快照）。
    const pairings = await req.prisma.pairing.findMany({
      where: { container: { name: { in: items.map((i) => i.name) } } },
      select: { containerId: true, status: true, deviceId: true, scopesJson: true, pairingRequestId: true, container: { select: { name: true } } },
    })
    const byName = new Map(pairings.map((p) => [p.container.name, p]))
    const data: SummaryWithPairing[] = items.map((i) => {
      const p = byName.get(i.name)
      return {
        ...i,
        pairing: p
          ? {
              status: p.status,
              device_id: p.deviceId,
              scopes: JSON.parse(p.scopesJson || '[]') as string[],
              pairing_request_id: p.pairingRequestId,
            }
          : defaultPairing(),
      }
    })
    ok(res, data)
  })

  // POST / —— 同步返 creating 快照；端口入队前分配；配额/撞名/残留目录/端口耗尽前置。
  router.post('/', validateBody(containerCreateSchema), async (req: Request, res: Response) => {
    const user = req.user!
    const { name } = req.body as { name: string }
    // 配额：当前容器数 ≥ maxContainers → 20042（按 user 计数；admin 亦受其配额约束）。
    const count = await req.prisma.container.count({ where: { ownerId: user.id } })
    if (count >= user.maxContainers) throw fail(CODE.QUOTA_EXCEEDED)
    const inst = await orch.createReserve(name, user.id)
    // 先构造 creating 快照（不做二次 runtime 查询），再入队后台 provisioning。
    // inline 队列（测试）同步跑完——await 使 creating→running 在响应前完成；
    // BullMQ（生产）提交后立即返回，provisioning 在 worker 后台续跑、list 轮询见 creating→running。
    const item: SummaryWithPairing = { ...orch.createdItem(inst), pairing: defaultPairing() }
    await orch.submitCreate(inst).catch(() => {
      // 后台失败已由 createComplete 标 ERROR 行；路由层不传播（客户端经 list 感知）。
    })
    ok(res, item)
  })

  // DELETE /<name> —— 异步信封（已入队）；遇在飞 create 置取消标志；归属前置 20040 同码。
  router.delete('/:name', async (req: Request, res: Response) => {
    const name = req.params.name as string
    // 路径参数 name 非法 → 90002 + data.name（区别于「合法但不存在/越权 → 20040」，两码不可混）。
    if (!CONTAINER_NAME_REGEX.test(name)) {
      throw fail(CODE.VALIDATION_FAILED, undefined, { name: ['name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'] })
    }
    // 归属前置：admin 全放行 / user 仅本人；不存在 vs 越权同码 20040。
    await getInstanceForUser(req.prisma, req.user!, name)
    await orch.deleteReserve(name) // 置取消标志 + 标 removing + 入队
    // 入队后台 delete（按 name 串行）。inline 队列（测试）同步跑完——await 使删除在响应前完成；
    // BullMQ（生产）提交后立即返回，删除在 worker 后台续跑、list 轮询见 removing→消失。
    // 失败已由 delete 标 REMOVING 行（可重试），catch 吞掉不向客户端传播（客户端经 list 感知）。
    await orch.submitDelete(name).catch(() => {})
    ok(res, { status: 'removing' })
  })

  return router
}

// 类型占位（防未使用告警）：Container 仅供将来衔接使用。
export type { Container }
