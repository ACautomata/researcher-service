// 容器生命周期编排 facade（平移 backend/containers/fleet/orchestrator.py，#334）。
// 薄组合根：读侧委托 FleetReadModel（list/createdItem + creating 对账），写侧委托 FleetCommand
// （create/delete + 取消标志），共享依赖经 FleetDeps 单点注入。取消注册表读写共享（delete 置标志、
// create 检查点检出）。

import type { PrismaClient, Container } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { fail } from '../envelope'
import { CODE } from '../codes'
import type { FleetDeps } from './deps'
import { FleetCommand, CancelRegistry, type DeleteOutcome } from './command'
import { FleetReadModel, type ContainerSummary } from './readModel'

export class Orchestrator {
  private readonly cmd: FleetCommand
  private readonly read: FleetReadModel

  constructor(
    deps: FleetDeps,
    prisma: PrismaClient,
    cancel: CancelRegistry = new CancelRegistry(),
  ) {
    this.cmd = new FleetCommand(deps, prisma, cancel)
    // requeueDelete 回调（Codex C6）：reconcileRemoving 对「removing 行 + runtime 仍驻留容器」经此
    // 重新入队 delete 继续清理。箭头延迟求值 this.cmd（此时已构造）；submitDelete 串行幂等，
    // catch 防 list 读路径抛错。
    this.read = new FleetReadModel(deps, prisma, async (name) => {
      await this.cmd.submitDelete(name).catch(() => {})
    })
  }

  // 写侧
  createReserve(name: string, ownerId: string, maxContainers?: number): Promise<Container> {
    return this.cmd.createReserve(name, ownerId, maxContainers)
  }
  submitCreate(inst: Container): Promise<void> {
    return this.cmd.submitCreate(inst)
  }
  create(name: string, ownerId: string): Promise<Container> {
    return this.cmd.create(name, ownerId)
  }
  createComplete(inst: Container, preserveErrorRow: boolean): Promise<Container> {
    return this.cmd.createComplete(inst, preserveErrorRow)
  }
  deleteReserve(name: string): Promise<'enqueued'> {
    return this.cmd.deleteReserve(name)
  }
  submitDelete(name: string): Promise<DeleteOutcome> {
    return this.cmd.submitDelete(name)
  }
  delete(name: string): Promise<DeleteOutcome> {
    return this.cmd.delete(name)
  }

  // 读侧
  list(where: { ownerId?: string } = {}): Promise<ContainerSummary[]> {
    return this.read.list(where)
  }
  createdItem(inst: Container): ContainerSummary {
    return this.read.createdItem(inst)
  }
}

// 单点归属前置（#312⑤ / #334：供 WIKI/models/chat/pairing 各域复用）。
// 按 name 查容器后追加 owner 判定：admin 全放行 / user 仅本人。
// 「不存在 vs 越权」同码 20040 防探测——对外逐字节一致，区分仅进服务端日志（owner_mismatch vs not_found）。
export async function getInstanceForUser(
  prisma: PrismaClient,
  user: AuthUser,
  name: string,
): Promise<Container> {
  const inst = await prisma.container.findUnique({ where: { name } })
  if (!inst) {
    // eslint-disable-next-line no-console
    console.warn(`[containers] not_found: name=${name} uid=${user.id}`)
    throw fail(CODE.CONTAINER_NOT_FOUND)
  }
  if (user.role !== 'admin' && inst.ownerId !== user.id) {
    // eslint-disable-next-line no-console
    console.warn(`[containers] owner_mismatch: name=${name} uid=${user.id} owner=${inst.ownerId}`)
    throw fail(CODE.CONTAINER_NOT_FOUND)
  }
  return inst
}
