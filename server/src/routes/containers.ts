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
import { AesGcmCrypto } from '../crypto'
import { config } from '../config'

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

// 防御解码持久化 scopesJson（Codex 第六轮 P2）：迁移/半写入的坏 JSON 让裸 JSON.parse 抛错、整个
// container-list 请求 500；合法 JSON 但非 string[]（含数字/null 等元素）也违反 string[] 响应契约。
// 仅当「全为字符串的数组」才放行，其余一律回退 []。
function decodeScopes(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]')
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v
  } catch {
    // 坏 JSON → 回退 []
  }
  return []
}

type SummaryWithPairing = ContainerSummary & { pairing: PairingStatusView }

// 路径参数 name 非法 → 90002 + data.name（区别于「合法但不存在/越权 → 20040」，两码不可混）。
// DELETE 与 bootstrap-token 共用（#369）。
function assertValidContainerName(name: string): void {
  if (!CONTAINER_NAME_REGEX.test(name)) {
    throw fail(CODE.VALIDATION_FAILED, undefined, { name: ['name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'] })
  }
}

export function createContainersRouter(orch: Orchestrator): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // GET / —— user 自己 / admin 全部；ContainerSummary + pairing 预取。
  router.get('/', async (req: Request, res: Response) => {
    const user = req.user!
    const where = user.role === 'admin' ? {} : { ownerId: user.id }
    const { items, ids } = await orch.listWithIds(where)
    // pairing 批量预取（M2 恒空 → default；M4 落库后注入真实快照）。
    // 按 containerId 代系 join（Codex 第五轮③[P2]）：仅按 name join 时，删除后同名 recreate 的
    // 竞态窗口会把新 owner 的 pairing 附到旧行摘要——containerId 唯一跨代系，name 可复用。
    const pairings = await req.prisma.pairing.findMany({
      where: { containerId: { in: [...ids.values()] } },
      select: { containerId: true, status: true, deviceId: true, scopesJson: true, pairingRequestId: true },
    })
    const byContainerId = new Map(pairings.map((p) => [p.containerId, p]))
    const data: SummaryWithPairing[] = items.map((i) => {
      const id = ids.get(i.name) // list 内 name 唯一；对应行 ID（代系）
      const p = id !== undefined ? byContainerId.get(id) : undefined
      return {
        ...i,
        pairing: p
          ? {
              status: p.status,
              device_id: p.deviceId,
              scopes: decodeScopes(p.scopesJson),
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
    // 配额检查内化进 createReserve（按 owner 串行 count+reserve，消除并发不同名绕过——Codex C4）。
    const inst = await orch.createReserve(name, user.id, user.maxContainers)
    // 先构造 creating 快照（不做二次 runtime 查询），再入队后台 provisioning。
    const item: SummaryWithPairing = { ...orch.createdItem(inst), pairing: defaultPairing() }
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

  // POST /<name>/bootstrap-token —— ADR 0006 D1（#369 接线前置）：所有权门控发放容器 bootstrap token。
  // 协议机首连须 bootstrap auth（ADR 事实 2：无 token 首连在配对前即失败）；token 真值只下发属主浏览器
  // （bootstrap 后可经网关配对换 deviceToken，真值仍不落前端以外的盘/日志）。
  router.post('/:name/bootstrap-token', async (req: Request, res: Response) => {
    const name = req.params.name as string
    // 路径参数 name 非法 → 90002 + data.name（区别于「合法但不存在/越权 → 20040」，与 DELETE 同款）。
    assertValidContainerName(name)
    // 归属前置（admin 全放行 / user 仅本人）：越权/不存在同码 20040 防探测。
    const inst = await getInstanceForUser(req.prisma, req.user!, name)
    // #13（第四轮）：仅 running 容器下发 token——隧道侧对非 running（creating/stopped/removing）恒 4402，
    // 端点盲目发 token 会让用户陷入 4402 退避循环。非 running 返 CONTAINER_NOT_RUNNING，前端显示
    // 「容器未运行」而非通用连接失败。
    if (inst.status !== 'running') throw fail(CODE.CONTAINER_NOT_RUNNING)
    // 容器 GATEWAY_TOKEN 存密文（DB 不落明文），用时解密（command.ts 同款模式）；tokenEncrypted=false
    // 为遗留明文行直接透传。
    const bootstrapToken = inst.tokenEncrypted
      ? new AesGcmCrypto(config.fleet.encryptionKeys).decrypt(inst.token)
      : inst.token
    ok(res, { bootstrapToken })
  })

  return router
}
