// 读侧聚合（平移 backend/containers/fleet/read_model.py，#334）。
// list：DB 记账 + runtime 实时状态 + gateway 健康探测聚合；并发健康探测（Promise.all，bound 总延迟）。
// reconcileCreating：list 读路径上的 lazy-repair 对账（崩溃中断的 creating 行按 runtime 实况收敛）。
// running/stopped 由 runtime 实况动态推导（DB 只持久化 creating/removing/error + 创建成功后 running）。

import type { PrismaClient, Container } from '../generated/prisma/client'
import {
  HEALTH_HEALTHY,
  HEALTH_PENDING,
  HEALTH_REMOVING,
  HEALTH_STOPPED,
  HEALTH_UNHEALTHY,
} from './values'
import type { FleetDeps } from './deps'

// ContainerSummary（契约 §2.3）：{name, port, status, health, image, container_id, created_at}
export interface ContainerSummary {
  name: string
  port: number
  status: string
  health: string
  image: string
  container_id: string
  created_at: Date
}

export class FleetReadModel {
  constructor(
    private readonly deps: FleetDeps,
    private readonly prisma: PrismaClient,
    // 重新入队 delete 回调（Codex C6）：reconcileRemoving 对「removing 行 + runtime 仍驻留容器」
    // 经此回调重新入队 delete 继续清理。Orchestrator 注入 cmd.submitDelete；不直接依赖 FleetCommand。
    private readonly requeueDelete?: (name: string) => Promise<void>,
  ) {}

  private item(inst: Container, status: string, health: string): ContainerSummary {
    return {
      name: inst.name,
      port: inst.port,
      status,
      health,
      image: inst.image,
      container_id: inst.containerId,
      created_at: inst.createdAt,
    }
  }

  private async buildItem(inst: Container): Promise<ContainerSummary> {
    // creating/removing/error 瞬态透传（不探健康，避免暴露错误生命周期）。
    if (inst.status === 'creating') return this.item(inst, 'creating', HEALTH_PENDING)
    if (inst.status === 'removing') return this.item(inst, 'removing', HEALTH_REMOVING)
    if (inst.status === 'error') return this.item(inst, 'error', HEALTH_STOPPED)
    // runtime.get 可能因 daemon 不可用抛异常——单项抖动降级透传，不隐藏其它正常容器。
    let info
    try {
      info = await this.deps.runtime.get(inst.name)
    } catch {
      return this.item(inst, 'running', HEALTH_STOPPED)
    }
    const running = Boolean(info && info.running)
    if (!running) return this.item(inst, 'stopped', HEALTH_STOPPED)
    const health = (await this.deps.health.isReachable(inst.port)) ? HEALTH_HEALTHY : HEALTH_UNHEALTHY
    return this.item(inst, 'running', health)
  }

  // 主流程对账 creating 行：非活动持有（崩溃中断）者按 runtime 实况收敛，不再永久 pending 占名/占端口。
  // 活动持有判定经进程内 lock.isHeld（取代旧 Redis 锁探测）：本进程 create 在飞 → 跳过。
  private async reconcileCreating(insts: Container[]): Promise<void> {
    for (const inst of insts) {
      if (inst.status !== 'creating') continue
      // 有在飞 create（本进程持锁）→ 跳过对账；崩溃中断（无持有）→ 进入收敛。
      if (this.deps.lock.isHeld(inst.name)) continue
      let info
      try {
        info = await this.deps.runtime.get(inst.name)
      } catch {
        // daemon 临时不可用 → 逐行降级（保持 creating/pending，下次 list 再对账）。
        continue
      }
      // label guard：仅 openclaw.instance label 匹配本行名的容器才被采纳为本行拥有（防误采纳外来同名容器）。
      let next: { status: Container['status']; containerId?: string }
      if (info && info.running && info.instanceName === inst.name) {
        next = { status: 'running', containerId: info.containerId || undefined }
      } else if (info && info.instanceName === inst.name) {
        next = { status: 'stopped', containerId: info.containerId || undefined }
      } else {
        next = { status: 'error' }
      }
      try {
        await this.prisma.container.update({
          where: { id: inst.id },
          data: { status: next.status, ...(next.containerId ? { containerId: next.containerId } : {}) },
        })
        inst.status = next.status
        if (next.containerId) inst.containerId = next.containerId
      } catch {
        // 落盘失败不阻断本次出参（内存对象已收敛，下次 list 再对账）
      }
    }
  }

  // removing 行对账（Codex C6）：进程重启后 BullMQ worker 的 tasks map 丢失，stalled/queued job
  // 经 processor 时 if(!task) return 被当成功移除但 lifecycle 操作未执行 → delete 中断的行卡 removing
  // 永不收敛（reconcileCreating 只处理 creating）。镜像 reconcileCreating 的 lazy-repair：
  // - 有在飞 create（本进程持锁）→ 跳过（不该此时删）。
  // - runtime 仍驻留容器（delete 未跑完）→ 经 requeueDelete 重新入队继续清理（串行幂等）。
  // - runtime 无容器（delete 已 stop+remove，仅删行没跑到）→ 删行收敛，不进 list 结果。
  // - daemon 不可达 → 保持 removing，下次 list 再对账。
  private async reconcileRemoving(insts: Container[]): Promise<Container[]> {
    const survivors: Container[] = []
    for (const inst of insts) {
      if (inst.status !== 'removing') {
        survivors.push(inst)
        continue
      }
      if (this.deps.lock.isHeld(inst.name)) {
        survivors.push(inst)
        continue
      }
      let info
      try {
        info = await this.deps.runtime.get(inst.name)
      } catch {
        // daemon 临时不可用 → 保持 removing，下次 list 再对账。
        survivors.push(inst)
        continue
      }
      if (info && info.instanceName === inst.name) {
        // 容器仍驻留 → delete 未跑完 → 重新入队继续清理（仍显示 removing）。
        await this.requeueDelete?.(inst.name)
        survivors.push(inst)
      } else {
        // 容器已不在 → 行残留（删行没跑到）→ 删行收敛，不进 list 结果。
        await this.prisma.container.delete({ where: { id: inst.id } }).catch(() => {})
      }
    }
    return survivors
  }

  // 聚合 DB 记账 + runtime 实时状态 + gateway 健康探测。ownerId 过滤由路由层注入（隔离）。
  async list(where: { ownerId?: string } = {}): Promise<ContainerSummary[]> {
    const insts = await this.prisma.container.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    })
    if (insts.length === 0) return []
    await this.reconcileCreating(insts)
    const survivors = await this.reconcileRemoving(insts)
    // 并发健康探测（Promise.all，bound 总延迟而非 N×timeout 串行）。
    return Promise.all(survivors.map((inst) => this.buildItem(inst)))
  }

  // 由刚预占的 Container 构造 POST 响应（creating 态快照；不做二次 runtime 查询）。
  createdItem(inst: Container): ContainerSummary {
    return this.item(inst, inst.status, HEALTH_PENDING)
  }
}
