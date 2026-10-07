// 容器列表/创建/删除（#334 M2 · /api/v1/containers/*；T0 #801 legacy 清退：pairing/bootstrap-token/
// upgrade 端点与 pairing 表整组退役——对话走控制面 runner + SSE，浏览器不再直连容器网关）。
// 隔离（#312）：user 仅见自己、admin 跨用户全部；归属前置 getInstanceForUser 越权 20040 同码防探测。
// 并发（#313）：create/delete 按 name 串行入队、进程内互斥、delete 异步 + 取消标志。

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

// 路径参数 name 非法 → 90002 + data.name（区别于「合法但不存在/越权 → 20040」，两码不可混）。
function assertValidContainerName(name: string): void {
  if (!CONTAINER_NAME_REGEX.test(name)) {
    throw fail(CODE.VALIDATION_FAILED, undefined, { name: ['name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'] })
  }
}

export function createContainersRouter(orch: Orchestrator): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // GET / —— user 自己 / admin 全部；ContainerSummary。
  router.get('/', async (req: Request, res: Response) => {
    const user = req.user!
    const where = user.role === 'admin' ? {} : { ownerId: user.id }
    ok(res, await orch.list(where))
  })

  // POST / —— 同步返 creating 快照；配额/撞名/残留目录前置。
  router.post('/', validateBody(containerCreateSchema), async (req: Request, res: Response) => {
    const user = req.user!
    const { name } = req.body as { name: string }
    // 配额检查内化进 createReserve（按 owner 串行 count+reserve，消除并发不同名绕过——Codex C4）。
    const inst = await orch.createReserve(name, user.id, user.maxContainers)
    // 先构造 creating 快照（不做二次 runtime 查询），再入队后台 provisioning。
    const item: ContainerSummary = orch.createdItem(inst)
    // detach 后台 provisioning（Codex C2）：POST 立即返 creating 快照，不等 docker pull/run 完成——
    // BullMQ 生产下 await 会阻塞到 worker 完成才响应（慢 pull/Redis 故障致请求超时 + 客户端重试冲突）。
    // 后台失败已由 createComplete 标 ERROR 行；catch 防 unhandled rejection，客户端经 list 轮询感知。
    void orch.submitCreate(inst).catch(() => {})
    ok(res, item)
  })

  // DELETE /<name> —— 异步信封（已入队）；遇在飞 create 置取消标志；归属前置 20040 同码。
  router.delete('/:name', async (req: Request, res: Response) => {
    const name = req.params.name as string
    // 路径参数 name 非法 → 90002 + data.name（区别于「合法但不存在/越权 → 20040」，两码不可混）。
    assertValidContainerName(name)
    // 归属前置：admin 全放行 / user 仅本人；不存在 vs 越权同码 20040。
    await getInstanceForUser(req.prisma, req.user!, name)
    await orch.deleteReserve(name) // 置取消标志 + 标 removing + 入队
    // detach 后台 delete（Codex C2，同 POST 理由）：DELETE 立即返 removing 信封，不等后台清理完成。
    // 失败已由 delete 标 REMOVING 行（可重试），catch 防 unhandled rejection，客户端经 list 轮询感知。
    void orch.submitDelete(name).catch(() => {})
    ok(res, { status: 'removing' })
  })

  return router
}
