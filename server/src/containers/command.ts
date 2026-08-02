// 写侧编排（平移 backend/containers/fleet/command.py，#334）——容器生命周期状态机核心。
//
// 与旧实现的两个刻意差异（均 #313 决议）：
//  1. Redis 分布式锁 → 进程内 NameLeaseMap（锁不依赖 Redis，即使 Redis 挂也防双创建/双删除）。
//  2. delete 遇在飞 create：旧「拒删 409（InstanceBusy）」→ 新「置取消标志 + 异步 delete」。
//     取消标志 = 进程内 Map<name,true>；provisioning 在 await 检查点检出即统一回滚后终止，
//     delete 在同 name 串行队列后接手清理（用户立即删、不干等 docker pull / 半建容器）。
//
// 状态机（5 态，DB 持久化 creating/removing/error + 创建成功后 running）：
//   creating → running ⇄ stopped → removing(终) + error（残留）。running/stopped 由读侧 runtime 实况推导。

import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient, Container } from '../generated/prisma/client'
import { TOKEN_URLSAFE_BYTES, MAX_PORT_RETRIES, HOME_BIND } from './constants'
import { CODE } from '../codes'
import { fail } from '../envelope'
import {
  ConfigurationError,
  InstanceBusy,
  InstanceCleanupError,
  InstanceDirExists,
  InstanceExists,
  PortAllocationError,
  PortPoolExhausted,
  QuotaExceeded,
} from './errors'
import type { FleetDeps } from './deps'
import type { ContainerSpec } from './runtime'
import { ConfigRenderer } from './configRenderer'

// 识别 docker 发布端口时的宿主 bind 冲突异常（归一化匹配两种来源措辞）：
// OS 层 bind 失败 "address already in use"；libnetwork portallocator "... port is already allocated"。
function isBindConflict(exc: unknown): boolean {
  const message = exc instanceof Error ? exc.message : String(exc)
  return message.includes('address already in use') || message.includes('already allocated')
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// 取消注册表（进程内）：delete 对在飞 create 的取消信号。provisioning 检查点检出。
export class CancelRegistry {
  private readonly flagged = new Set<string>()
  flag(name: string): void {
    this.flagged.add(name)
  }
  isCancelled(name: string): boolean {
    return this.flagged.has(name)
  }
  clear(name: string): void {
    this.flagged.delete(name)
  }
}

export type DeleteOutcome = 'removed' | 'not-found'

export class FleetCommand {
  private renderer: ConfigRenderer | null = null
  // create_reserve 取得的租约句柄登记表（跨阶段传递到 create_complete finally 释放）。
  private readonly leases = new Map<string, { release(): void }>()

  constructor(
    private readonly deps: FleetDeps,
    private readonly prisma: PrismaClient,
    private readonly cancel: CancelRegistry = new CancelRegistry(),
  ) {}

  // ---- create 阶段一：同步预占（确定性工作，请求线程安全）----
  // LLM key 缺失 → 90003；双创建/撞名 → 20041；残留目录 → 20044；端口耗尽 → 90004；超配额 → 20042。
  // ownerId 由路由层（归属已校验）传入；maxContainers 提供时按 owner 串行 count+create 收紧配额竞态。
  async createReserve(name: string, ownerId: string, maxContainers?: number): Promise<Container> {
    const doReserve = async (): Promise<Container> => {
      if (!this.deps.config.llmApiKey) throw new ConfigurationError('LLM_API_KEY')
      // recreate（删后同名重建）须先清上一轮 delete 可能残留的取消标志，否则本 create 在检查点误中止。
      this.cancel.clear(name)
      // 双创建防护：进程内租约（已被持有 = 并发/在飞 create）→ 快速失败 20041
      const lease = this.deps.lock.tryAcquire(name)
      if (lease === null) throw new InstanceExists(name)
      this.leases.set(name, lease)
      try {
        const inst = await this.reserveRow(name, ownerId)
        // 残留目录预检（DB 无行的 orphan 目录）→ 20044：同步暴露而非留到后台 mkdir 才失败
        const instanceDir = path.join(this.deps.config.root, 'instances', name)
        if (await pathExists(instanceDir)) {
          await this.prisma.container.delete({ where: { id: inst.id } })
          throw new InstanceDirExists(name, instanceDir)
        }
        await this.ensureRenderer() // 模板损坏 fail-fast（确定性配置错误同步暴露）
        return inst
        // 成功路径不释放租约：租约跨到后台 create_complete，finally 释放（覆盖 provisioning 全程）。
      } catch (e) {
        this.releaseLease(name)
        throw e
      }
    }
    if (maxContainers === undefined) return doReserve()
    // 配额 check-then-act 收紧（Codex C4）：按 owner 串行 count + reserve，单进程内消除并发不同名
    // 双双绕过 count、双创建超配额的窗口。串行段只覆盖 reserve（DB count + create），不含后台
    // provisioning（POST 不阻塞——provisioning 在 submitCreate 后台续跑）。
    return this.deps.quotaSerializer.enqueue(ownerId, async () => {
      const count = await this.prisma.container.count({ where: { ownerId } })
      if (count >= maxContainers) throw new QuotaExceeded(name)
      return doReserve()
    })
  }

  // ---- create 阶段三提交：入队后台完成（按 name 串行 + 队列并发上限）----
  // 返回的 Promise 在 provisioning 完成时 settle（供测试/同步语义 await）；路由层不 await（异步）。
  submitCreate(inst: Container): Promise<void> {
    return this.deps.serializer.enqueue(inst.name, async () => {
      try {
        await this.deps.queue.submit(() => this.runCreateComplete(inst))
      } catch (e) {
        // 队列不可达补偿（Codex C8）：queue.add reject 时 createComplete 从不执行，其 finally 不会
        // 释放 name lease → 路由 detach 的 catch 吞掉唯一失败信号后，lease 永久持有、行卡 creating，
        // recreate 被 InstanceExists(20041) 锁死。补偿：释放 lease + 标 error 行（均幂等）。
        this.releaseLease(inst.name)
        await this.markError(inst)
        throw e
      }
    })
  }

  // 同步语义封装（reserve + complete），供需要同步结果的调用方/测试。
  async create(name: string, ownerId: string): Promise<Container> {
    const inst = await this.createReserve(name, ownerId)
    return this.createComplete(inst, false)
  }

  // 事务预占 creating 行：name/port 冲突由 DB 唯一约束仲裁。
  // port 冲突（并发选同 port）→ 重试下一空闲 port；name 冲突 → InstanceExists（20041，不重试）。
  private async reserveRow(name: string, ownerId: string, extraUsed?: Set<number>): Promise<Container> {
    const home = path.join(this.deps.config.root, 'instances', name, 'home')
    // gateway token 真值不落盘（AGENTS.md §5.2 / Codex C1）：DB 存 AES-GCM 密文，
    // createComplete 用时 decrypt 供 spec.gatewayToken（docker env 注入明文）。
    const token = this.deps.crypto.encrypt(randomBytes(TOKEN_URLSAFE_BYTES).toString('base64url'))
    for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt += 1) {
      const port = this.deps.allocator.nextFree(await this.usedPorts(extraUsed))
      try {
        return await this.prisma.container.create({
          data: {
            name,
            port,
            token,
            tokenEncrypted: true,
            homeDir: home,
            containerId: '',
            status: 'creating',
            image: this.deps.config.image,
            ownerId,
          },
        })
      } catch (e) {
        if (this.isUniqueViolation(e)) {
          const nameTaken = await this.prisma.container.findUnique({ where: { name } })
          if (nameTaken) throw new InstanceExists(name)
          continue // 否则 port 冲突 → 重试下一 port
        }
        throw e
      }
    }
    throw new PortAllocationError(name)
  }

  private isUniqueViolation(e: unknown): boolean {
    return (e as { code?: string }).code === 'P2002'
  }

  // 已用端口 = DB 记账 ∪ daemon fleet label 端口 ∪ daemon 宿主发布端口 ∪ 宿主 bind 实测 ∪ extra（学习集）。
  private async usedPorts(extraUsed?: Set<number>): Promise<Set<number>> {
    const used = new Set<number>(
      (await this.prisma.container.findMany({ select: { port: true } })).map((r) => r.port),
    )
    if (extraUsed) for (const p of extraUsed) used.add(p)
    try {
      for (const info of await this.deps.runtime.listFleet()) {
        if (typeof info.port === 'number') used.add(info.port)
      }
    } catch {
      // daemon 不可达不阻断分配：DB 记账 + 宿主实测仍可给出候选
    }
    try {
      for (const p of await this.deps.runtime.hostPublishedPorts()) used.add(p)
    } catch {
      // 同上
    }
    for (let port = this.deps.config.portStart; port <= this.deps.config.portEnd; port += 1) {
      if (!used.has(port) && (await this.deps.portInUse(port))) used.add(port)
    }
    return used
  }

  // ---- create 阶段二：后台/同步完成 provisioning（mkdir + cp -a + 原子写 config + docker run）----
  // bind 端口冲突就地换端口重试（预算 = 池大小）；取消标志检查点检出即统一回滚后终止。
  async createComplete(inst: Container, preserveErrorRow: boolean): Promise<Container> {
    const name = inst.name
    const instanceDir = path.join(this.deps.config.root, 'instances', name)
    const home = path.join(instanceDir, 'home')
    const configPath = path.join(instanceDir, 'openclaw.json')
    // bind 冲突重试预算 = 端口池候选数（非 MAX_PORT_RETRIES——那是 DB 并发冲突预算）。
    const poolSize = this.deps.config.portEnd - this.deps.config.portStart + 1
    const learnedConflicts = new Set<number>()
    let directoryCreated = false
    let runAttempted = false
    let preexisting = false
    let current = inst
    try {
      for (let i = 0; i < poolSize; i += 1) {
        // 取消检查点：delete 已置取消标志 → 统一回滚后终止（不干等）。
        if (this.cancel.isCancelled(name)) {
          await this.finalizeFailedCreate(name, instanceDir, current, runAttempted, preexisting, directoryCreated, preserveErrorRow, new InstanceBusy(name))
        }
        try {
          preexisting = (await this.deps.runtime.get(name)) !== null
          if (!directoryCreated) {
            // Node mkdir 对已存在目录不抛错（区别于 Python exist_ok=False）——须显式预检，
            // 否则把「上次崩溃/外部残留的 orphan 目录」当作本次新建，误删既有数据。
            if (await pathExists(instanceDir)) {
              // 目录已存在但 reserve 成功（DB 无行）= orphan 残留。回滚 creating 行保持一致。
              await this.prisma.container.delete({ where: { id: current.id } }).catch(() => {})
              throw new InstanceDirExists(name, instanceDir)
            }
            // 先确保父目录 instances/ 存在，再非递归建叶子（对齐 Python parents=True + exist_ok=False）：
            // 叶子已存在已由上面 pathExists 拦截；此处只对新建路径建目录。
            await mkdir(path.dirname(instanceDir), { recursive: true })
            await mkdir(instanceDir, { recursive: false })
            directoryCreated = true
            // provision 只在目录首次创建时执行（bind 冲突重试复用已 provision 的 home）
            await this.deps.provisioner.provision(home)
          }
          // config 原子写（tmp + chmod 0644 + rename），create 无 torn/partial 风险
          await this.deps.configStore.write(name, (await this.ensureRenderer()).render())
          // 取消检查点（render 后、run 前——覆盖随后 docker run / image pull 阻塞 IO 前的最后窗口）
          if (this.cancel.isCancelled(name)) {
            await this.finalizeFailedCreate(name, instanceDir, current, runAttempted, preexisting, directoryCreated, preserveErrorRow, new InstanceBusy(name))
          }
          runAttempted = true
          const spec: ContainerSpec = {
            name,
            image: this.deps.config.image,
            hostPort: current.port,
            // DB 存密文，docker env 须注入明文 gatewayToken——用时 decrypt（Codex C1）。
            gatewayToken: this.deps.crypto.decrypt(current.token),
            homeDir: home,
            configPath,
            llmApiKey: this.deps.config.llmApiKey,
          }
          const containerId = await this.deps.runtime.run(spec)
          current = await this.prisma.container.update({
            where: { id: current.id },
            data: { containerId, status: 'running' },
          })
          return current
        } catch (exc) {
          if (isBindConflict(exc)) {
            // docker run bind 冲突 → 就地更新行端口、继续循环重试下一端口。
            learnedConflicts.add(current.port)
            // 残留容器清理不能吞：残留让下一轮撞 name 冲突。不清目录（行/目录/配置保留复用）。
            if (runAttempted && !preexisting) {
              try {
                const created = await this.deps.runtime.get(name)
                if (created?.containerId) {
                  await this.prisma.container.update({
                    where: { id: current.id },
                    data: { containerId: created.containerId },
                  })
                }
                await this.deps.runtime.remove(name)
                await this.prisma.container.update({
                  where: { id: current.id },
                  data: { containerId: '' },
                })
              } catch {
                await this.markError(current)
                throw new InstanceCleanupError(name, instanceDir)
              }
            }
            let nextPort: number
            try {
              nextPort = this.deps.allocator.nextFree(await this.usedPorts(learnedConflicts))
            } catch (poolErr) {
              if (poolErr instanceof PortPoolExhausted) {
                await this.finalizeFailedCreate(name, instanceDir, current, runAttempted, preexisting, directoryCreated, preserveErrorRow, new PortAllocationError(name))
              }
              throw poolErr
            }
            current = await this.prisma.container.update({
              where: { id: current.id },
              data: { port: nextPort },
            })
            continue
          }
          // 非 bind 冲突 → 统一失败终态
          await this.finalizeFailedCreate(name, instanceDir, current, runAttempted, preexisting, directoryCreated, preserveErrorRow, exc)
        }
      }
      throw new PortAllocationError(name)
    } finally {
      // 租约随 createReserve 持有至此；统一在此释放（成功/回滚/重试耗尽/取消都释放）。
      this.releaseLease(name)
    }
  }

  // 后台入口：provisioning 失败仅记日志不传播（行已标 ERROR 供 list+delete 感知/重试）。
  private async runCreateComplete(inst: Container): Promise<void> {
    try {
      await this.createComplete(inst, true)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[fleet] background create failed for ${inst.name}`, e)
    }
  }

  // create_complete 失败的统一收尾（非 bind 分支 + bind 池耗尽 + 取消检出共用）。总以 throw 结尾。
  // 清残留容器 → 清目录（失败保留 ERROR 行 + raise InstanceCleanupError）→ 落失败终态 → raise 原异常。
  private async finalizeFailedCreate(
    name: string,
    instanceDir: string,
    inst: Container,
    runAttempted: boolean,
    preexisting: boolean,
    directoryCreated: boolean,
    preserveErrorRow: boolean,
    exc: unknown,
  ): Promise<never> {
    if (runAttempted && !preexisting) {
      try {
        const created = await this.deps.runtime.get(name)
        if (created?.containerId) {
          await this.prisma.container.update({
            where: { id: inst.id },
            data: { containerId: created.containerId },
          })
        }
        await this.deps.runtime.remove(name)
        await this.prisma.container.update({ where: { id: inst.id }, data: { containerId: '' } })
      } catch {
        // 清容器失败：保留观测到的 id，供 ERROR 行后续 delete 证明所有权
      }
    }
    if (directoryCreated) {
      try {
        await this.deps.dirRemover(instanceDir)
      } catch {
        await this.markError(inst)
        throw new InstanceCleanupError(name, instanceDir)
      }
    }
    if (preserveErrorRow) {
      // 后台：POST 已返 creating 快照、行对客户端可见——失败保留 ERROR 行供 list+delete 感知。
      await this.markError(inst)
    } else {
      // 同步 create()：历史契约——失败删行回滚，调用方感知异常。
      await this.prisma.container.delete({ where: { id: inst.id } }).catch(() => {})
    }
    throw exc
  }

  private async markError(inst: Container): Promise<void> {
    await this.prisma.container
      .update({ where: { id: inst.id }, data: { status: 'error' } })
      .catch(() => {})
  }

  private releaseLease(name: string): void {
    this.leases.get(name)?.release()
    this.leases.delete(name)
  }

  // ---- delete：异步化（按 name 串行入队）----
  // 同步段：查行（归属已在路由层校验）；遇在飞 create 置取消标志；标 removing；入队后台清理。
  // 清理失败 → InstanceCleanupError（行留 REMOVING 可重试），由后台入口记日志。
  async deleteReserve(name: string): Promise<'enqueued'> {
    const inst = await this.prisma.container.findUnique({ where: { name } })
    // 不应到达（路由层归属前置已 20040）；防御分支沿用同码（20040 = 不存在），非 20043 busy。
    if (!inst) throw fail(CODE.CONTAINER_NOT_FOUND)
    // 在飞 create：置取消标志（provisioning 检查点检出即统一回滚），不干等。
    this.cancel.flag(name)
    // 标 removing（终态前奏），list 轮询可见。
    await this.prisma.container.update({ where: { id: inst.id }, data: { status: 'removing' } })
    return 'enqueued'
  }

  // delete 后台执行（按 name 串行——排在同 name 在飞 create 之后）。完成时 settle 供测试 await。
  submitDelete(name: string): Promise<DeleteOutcome> {
    return this.deps.serializer.enqueue(name, async () => this.delete0(name))
  }

  // 经队列跑 delete 本体并取回结果（inline 队列直接返回；BullMQ 经共享 Promise）。
  private async delete0(name: string): Promise<DeleteOutcome> {
    let outcome: DeleteOutcome = 'removed'
    await this.deps.queue.submit(async () => {
      outcome = await this.delete(name)
    })
    return outcome
  }

  // delete 本体：容器 + 连数据删。home 清理失败不吞——保留行 + 标 REMOVING + raise（可重试）。
  async delete(name: string): Promise<DeleteOutcome> {
    const inst = await this.prisma.container.findUnique({ where: { name } })
    if (!inst) {
      this.cancel.clear(name)
      return 'not-found'
    }
    // container_id 是本行拥有 runtime 容器的正向证据。先验证再 stop/remove（防误删外来同名容器）。
    if (inst.containerId) {
      const live = await this.deps.runtime.get(name)
      if (!live || live.containerId !== inst.containerId) {
        await this.prisma.container
          .update({ where: { id: inst.id }, data: { containerId: '' } })
          .catch(() => {})
      } else {
        // 容器以 root 跑，bind-mount home 内文件属主为 root，host 非 root 删会权限错。
        // 容器还在（root 权限）时同步 chown home 给 host uid。best-effort——失败不阻断。
        await this.deps.runtime
          .execSync(name, ['chown', '-R', String(process.getuid?.() ?? 0), HOME_BIND])
          .catch(() => {})
        await this.deps.runtime.stop(name)
        await this.deps.runtime.remove(name)
      }
    }
    // 优先由 DB home_dir 派生 instance_dir（创建时固化的绝对路径）；防御占位/篡改回退当前 root。
    const recorded = path.dirname(inst.homeDir)
    const instanceDir =
      path.basename(recorded) === name && path.basename(path.dirname(recorded)) === 'instances'
        ? recorded
        : path.join(this.deps.config.root, 'instances', name)
    // rmtree 前重查行身份：行已被并发 delete 删除或 recreate 替换 → 跳过目录清理（资源不属本行）。
    const current = await this.prisma.container.findUnique({ where: { name } })
    if (!current || current.id !== inst.id) {
      await this.prisma.container.delete({ where: { id: inst.id } }).catch(() => {})
      this.cancel.clear(name)
      return 'removed'
    }
    // 目录已不存在（外部清理/建行前崩溃）视为清理成功——否则行卡 REMOVING 重试永远撞同一路径。
    if (await pathExists(instanceDir)) {
      try {
        await this.deps.dirRemover(instanceDir)
      } catch {
        await this.prisma.container
          .update({ where: { id: inst.id }, data: { status: 'removing' } })
          .catch(() => {})
        throw new InstanceCleanupError(name, instanceDir)
      }
    }
    await this.prisma.container.delete({ where: { id: inst.id } })
    this.cancel.clear(name)
    // delete 完成后触发 chat pool 逐出（ADR 0006 下为空挂点；供桥接切片对接）。
    await this.deps.onEvict({ name: inst.name, port: inst.port })
    return 'removed'
  }

  // 惰性构造 renderer：模板 JSON 仅供 create 使用，list/delete 不应因其损坏而失败。
  private async ensureRenderer(): Promise<ConfigRenderer> {
    if (this.renderer === null) {
      const templateText = await readFile(this.deps.config.templateJson, 'utf8')
      this.renderer = new ConfigRenderer(templateText)
    }
    return this.renderer
  }
}
