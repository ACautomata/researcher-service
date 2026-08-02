import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import path from 'node:path'
import type { PrismaClient, Container } from '../generated/prisma/client'
import { fail, EnvelopeError } from '../envelope'
import { CODE } from '../codes'
import {
  ContainerNameLeases,
  HOME_BIND,
  PoolAllocator,
  PortPoolExhausted,
  generateGatewayToken,
  isBindConflict,
  NAME_REGEX,
} from './ports'
import type { ContainerRuntime, ContainerSpec } from './dockerRuntime'
import { renderGatewayConfig } from '../provisioning/renderer'
import type { TokenCrypto } from './tokenCrypto'

// 编排器 Port（#334 M2 · 接缝 5）：容器生命周期核心。依赖注入 runtime + 队列，
// 测试注入假 docker + 内存假 BullMQ。全部编排语义在此；路由层只做薄 HTTP 适配。
// 并发模型（#313/#334）：进程内 Map<name,租约> 互斥 + BullMQ 按 name 入队串行 +
// 端口入队前分配（SQLite port @unique 仲裁）+ 5 态机 + 取消标志 + 补偿。

// DB CAS 租约 TTL（codex 二轮 P1 跨 worker 串行）：provisionCreate/Delete 抢占 leaseExpiresAt
// 的持有时长。须 > 单次 docker run（镜像 pull + start < 2min），并 > BullMQ stalled 窗口（30s），
// 使崩溃 worker 的租约在 stalled 重指派后仍有效（重指派等待而非误抢）。codex 三轮 P1：租约被
// 持有 → 抛 retryable（BullMQ 重试而非 no-op），lease 过期后下个重试可抢占。
const LEASE_TTL_MS = 5 * 60 * 1000 // 5min：覆盖 docker run，stalled 重指派（30s）安全

// 租约被另一 worker 持有（codex 三轮 P1 #1）：抛此错让 BullMQ 重试（带 backoff），
// lease 过期后下个重试可抢占——而非 no-op（否则 BullMQ 移除 job，行永远 creating）。
export class LeaseContentionError extends Error {
  constructor(name: string) {
    super(`lease held for ${name}, retry after expiry`)
    this.name = 'LeaseContentionError'
  }
}

export interface ProvisionJobQueue {
  enqueueCreate(name: string, ownerId: string, configText: string): Promise<void>
  enqueueDelete(name: string, ownerId: string, rowId: string): Promise<void>
  close(): Promise<void>
}

export interface OrchestratorConfig {
  fleetRoot: string
  templateDir: string // cp -a 源（空 = 未配置 → provision fail-fast）
  templateJsonPath: string // openclaw.json 模板文件路径
  image: string
  llmApiKey: string
  portPoolStart: number
  portPoolEnd: number
  gatewayTokenBytes: number
  tokenCrypto: TokenCrypto // GATEWAY_TOKEN 落库加密（DB 存密文，真值不落盘）
  portInUse?: (port: number) => Promise<boolean> // 宿主端口占用探测（默认 socket bind）
  dirRemover?: (dir: string) => Promise<void> // 目录删除器（默认 rm -rf；测试注入失败可测 REMOVING）
}

// 宿主端口占用探测：net.Server listen 失败（EADDRINUSE）→ 占用。异步事件，Promise 化。
function defaultPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv: Server = createServer()
    srv.unref()
    srv.once('error', () => resolve(true))
    srv.once('listening', () => srv.close(() => resolve(false)))
    srv.listen(port, '127.0.0.1')
  })
}

export class Orchestrator {
  private readonly allocator: PoolAllocator
  private readonly leases: ContainerNameLeases
  private readonly portInUse: (port: number) => Promise<boolean>
  private readonly dirRemover: (dir: string) => Promise<void>

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runtime: ContainerRuntime,
    private readonly queue: ProvisionJobQueue,
    private readonly cfg: OrchestratorConfig,
  ) {
    this.allocator = new PoolAllocator(cfg.portPoolStart, cfg.portPoolEnd)
    this.leases = new ContainerNameLeases()
    this.portInUse = cfg.portInUse ?? defaultPortInUse
    this.dirRemover = cfg.dirRemover ?? ((dir) => rm(dir, { recursive: true, force: true }))
  }

  // ── 端口池（#313 四来源已用集）──
  async usedPorts(extra: ReadonlySet<number> = new Set()): Promise<Set<number>> {    const used = new Set<number>(extra)
    // 来源 1：DB 记账
    const rows = await this.prisma.container.findMany({ select: { port: true } })
    for (const r of rows) used.add(r.port)
    // 来源 2：daemon fleet label 端口（未跟踪的 fleet 容器）
    try {
      const fleet = await this.runtime.listFleet()
      for (const info of fleet) if (info.port != null) used.add(info.port)
    } catch {
      // daemon 不可达不阻断分配
    }
    // 来源 3：daemon 宿主发布端口（未跟踪容器）
    try {
      const published = await this.runtime.hostPublishedPorts()
      for (const p of published) used.add(p)
    } catch {
      // 同上
    }
    // 来源 4：池内宿主实测占用（跳过已并集来源，避免重复 bind 探测）
    for (let p = this.cfg.portPoolStart; p <= this.cfg.portPoolEnd; p++) {
      if (!used.has(p) && (await this.portInUse(p))) used.add(p)
    }
    return used
  }

  private homeDirFor(name: string): string {
    return path.join(this.cfg.fleetRoot, 'instances', name, 'home')
  }

  // codex 三轮 P1（GET / 探活）：查询容器运行时真实状态——DB status 只记编排态，须对账 runtime
  // 判容器是否真在跑。返回 null 表示 daemon 不可达（降级保持 DB status，不误报）。
  // health 语义对齐旧 Django read_model：running+runtime 容器在跑 → healthy；否则按 DB status。
  async runtimeInfo(name: string): Promise<{ running: boolean } | null> {
    try {
      const live = await this.runtime.get(name)
      if (!live) return { running: false } // DB 有行但容器已不在（崩溃/手动删）
      return { running: live.running }
    } catch {
      return null // daemon 抖动 → 降级（不 500）
    }
  }

  private async deleteRowQuietly(id: string): Promise<void> {
    try {
      await this.prisma.container.delete({ where: { id } })
    } catch {
      // 行已不在（并发清理）→ 幂等
    }
  }

  // ── create 阶段一（同步预占 creating 行 + 端口入队前分配 + 入队）──
  // 错误语义：撞名 20041（不分占用者）/ 超配额 20042 / 端口池耗尽 90004 / LLM key 缺失 90003。
  async createReserve(name: string, ownerId: string, quotaLimit: number): Promise<Container> {
    if (!NAME_REGEX.test(name)) throw fail(CODE.VALIDATION_FAILED, undefined, { name: ['名称不合法'] })
    // LLM_API_KEY fail-fast（codex R6：空 key 建外表 healthy 但永远无法调 LLM 的容器）
    if (!this.cfg.llmApiKey) throw fail(CODE.LLM_KEY_MISSING)
    // 进程内 Map 互斥（#313：双创建护栏，锁不依赖 Redis；在飞 create 期间保持持有）
    if (!this.leases.tryAcquire(name)) throw fail(CODE.NAME_CONFLICT)
    try {
      // codex 四轮 P1 #3：残留 orphan 目录同步拒绝（对齐旧 Django create_reserve InstanceDirExists）。
      // DB 无行但 instances/<name> 残留（崩溃中断/手动清 DB）→ 若拖到 worker 才拒，POST 已返 202
      // 落 ERROR 行且无「先清理」提示。此处同步暴露 20044，客户端先删/清理再重试。
      const instanceDir = path.join(this.cfg.fleetRoot, 'instances', name)
      try {
        const stat = await import('node:fs/promises').then((f) => f.stat(instanceDir))
        if (stat.isDirectory()) {
          throw fail(CODE.ORPHAN_DIR, '存在残留数据目录，请先删除同名实例或手动清理后重试')
        }
      } catch (e) {
        if (e instanceof EnvelopeError) throw e
        // ENOENT（目录不存在）→ 正常新建
      }
      // 端口入队前分配 + creating 行插入（#313；SQLite port @unique 仲裁）
      // codex #5（P2）：配额 count+insert 原子化——count 与 create 同一事务，防并发不同名
      // 同时读到 count<quotaLimit 各插一行（check-then-insert 竞态）。事务内先复查配额再插入。
      const row = await this.insertCreatingRow(name, ownerId, quotaLimit)
      // 模板 render fail-fast（确定性配置错误同步暴露，不留给后台线程）
      let configText: string
      try {
        configText = renderGatewayConfig(this.cfg.templateJsonPath)
      } catch {
        await this.deleteRowQuietly(row.id)
        throw fail(CODE.LLM_KEY_MISSING, 'openclaw.json 模板缺失或损坏')
      }
      // 入队失败（Redis 挂）→ 删行回滚（释放端口/配额/name）+ 租约由 catch 释放
      try {
        await this.queue.enqueueCreate(name, ownerId, configText)
      } catch (e) {
        await this.deleteRowQuietly(row.id)
        throw e instanceof EnvelopeError ? e : fail(CODE.PORT_POOL_EXHAUSTED)
      }
      // codex 五轮 P1 #1：enqueue 成功后释放进程内 lease——多进程下 create job 可能交付给另一进程 B，
      // 若 A 仍持有进程内 lease，A 后续 DELETE 只设 cancelRequested（即使容器已 running、无 create worker
      // 观察标志）。worker 串行已由 DB lease 保证，请求侧 lease 在 enqueue 后即完成使命。
      this.leases.release(name)
      return row
    } catch (e) {
      this.leases.release(name)
      throw e
    }
  }

  // 端口分配 + creating 行插入；port 唯一冲突保存点内重试下一空闲端口，name 冲突 → 20041。
  // 配额复查在事务内（codex #5 P2）：`count` 与 `create` 同事务，杜绝并发不同名绕过 quotaLimit。
  private async insertCreatingRow(
    name: string,
    ownerId: string,
    quotaLimit: number,
  ): Promise<Container> {
    const learned = new Set<number>()
    for (let i = 0; i < this.allocator.poolSize; i++) {
      const used = await this.usedPorts(learned)
      let port: number
      try {
        port = this.allocator.nextFree(used)
      } catch (e) {
        if (e instanceof PortPoolExhausted) throw fail(CODE.PORT_POOL_EXHAUSTED)
        throw e
      }
      const token = generateGatewayToken(this.cfg.gatewayTokenBytes)
      try {
        // 事务内：配额复查 + 行插入（SQLite 串行化写事务，count+create 原子）
        return await this.prisma.$transaction(async (tx) => {
          const count = await tx.container.count({ where: { ownerId } })
          if (count >= quotaLimit) throw fail(CODE.QUOTA_EXCEEDED)
          return tx.container.create({
            data: {
              name,
              port,
              ownerId,
              token: this.cfg.tokenCrypto.encrypt(token), // 密文落库（真值不落盘）
              tokenEncrypted: true,
              homeDir: this.homeDirFor(name),
              image: this.cfg.image,
              status: 'creating',
            },
          })
        })
      } catch (e) {
        if (e instanceof EnvelopeError) throw e // 配额 20042 直接上抛（非端口冲突）
        if ((e as { code?: string }).code === 'P2002') {
          const existing = await this.prisma.container.findUnique({ where: { name } })
          if (existing) throw fail(CODE.NAME_CONFLICT) // 撞名（不分占用者）
          learned.add(port) // port 并发冲突 → 学习 + 下一空闲
          continue
        }
        throw e
      }
    }
    throw fail(CODE.PORT_POOL_EXHAUSTED)
  }

  // ── create 阶段二（后台 provisioning：creating→running + 取消标志 + bind 重试 + 补偿）──
  // 由 BullMQ worker 调用（payload 携带 reserve 阶段渲染的 configText，避免重复读模板）。
  // 不可恢复失败 → 保留 ERROR 行（补偿全平移），不向 worker 抛（行状态即对外契约）。
  //
  // codex 二轮 P1（跨 worker 串行）：PerNameChain 仅进程内互斥，多 worker / stalled 重指派下
  // 同名 create/delete 可并发。此处用 DB CAS 租约（leaseExpiresAt）实现跨进程互斥——条件
  // updateMany 原子抢占（where leaseExpiresAt null 或已过期），抢不到即另一 worker 在飞 → no-op。
  // Redis 挂也不影响（锁在 SQLite，spec §F「SQLite 持状态」）。
  async provisionCreate(name: string, configText: string): Promise<void> {
    const row = await this.prisma.container.findUnique({ where: { name } })
    if (!row || row.status !== 'creating') return // 已清理/已收敛 → no-op
    // DB CAS 抢占租约（跨进程）：where leaseExpiresAt 空闲，update 置 leaseExpiresAt=now+TTL
    const now = new Date()
    const claimed = await this.prisma.container.updateMany({
      where: {
        name,
        status: 'creating',
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS) },
    })
    if (claimed.count === 0) {
      // codex 三轮 P1 #1：另一 worker 持有 lease（崩溃/在飞）。抛 retryable 让 BullMQ 重试
      // （非 no-op——no-op 会让 BullMQ 移除 job，lease 过期后无 job 重跑 → 行永远 creating）。
      throw new LeaseContentionError(name)
    }
    const instanceDir = path.join(this.cfg.fleetRoot, 'instances', name)
    const homeDir = path.join(instanceDir, 'home')
    let runAttempted = false
    let dirCreated = false
    try {
      // 检查点 1：enqueue 后、任何 IO 前 —— 取消即终止（不建目录）
      if (row.cancelRequested) {
        await this.deleteRowQuietly(row.id)
        return
      }
      // codex 六轮 P1 #4：worker 在 run() 后、存 containerId 前崩溃 → 行 creating + 空 id 但容器已
      // 在跑（labeled）。stalled 重试时从 fleet label 恢复容器身份——否则 delete 因 containerId 空
      // 跳过清理，容器永久孤儿。listFleet 按 openclaw.instance label 匹配本行。
      if (!row.containerId) {
        try {
          const fleet = await this.runtime.listFleet()
          const mine = fleet.find((c) => c.instanceName === name)
          if (mine?.containerId) {
            await this.prisma.container.update({
              where: { id: row.id },
              data: { containerId: mine.containerId, status: 'running' },
            })
            return // 容器已在跑（上轮 run 成功，仅存 id 前崩溃）→ 对账完成
          }
        } catch {
          // daemon 不可达 → 继续正常 provisioning 路径
        }
      }
      // 1. provision home（cp -a 模板 → home）
      await this.provisionHome(instanceDir, homeDir)
      dirCreated = true
      // 2. 原子写 config
      const configPath = path.join(instanceDir, 'openclaw.json')
      await this.writeConfigAtomic(configPath, configText)
      // 检查点 2：run 前 —— 取消 → 统一回滚 + 删行
      const mid = await this.prisma.container.findUnique({ where: { name } })
      if (mid?.cancelRequested) {
        await this.cleanupInstanceDir(instanceDir, row, runAttempted) // 清理失败抛 CLEANUP_FAILED → 行留 REMOVING
        await this.deleteRowQuietly(row.id)
        return
      }
      // 3. docker run，bind 冲突就地换端口重试（预算 = 池大小）
      // token 解密仅在此短暂存在内存（env 注入容器），不落盘、不进日志
      // config 内容经 docker cp 进容器（不 bind-mount——嵌套挂载镜像读不到，见 dockerRuntime.run）
      const specBase: ContainerSpec = {
        name,
        image: this.cfg.image,
        hostPort: row.port,
        gatewayToken: row.tokenEncrypted
          ? this.cfg.tokenCrypto.decrypt(row.token)
          : row.token, // 兼容迁移前明文行（tokenEncrypted=false）
        homeDir,
        configText,
        llmApiKey: this.cfg.llmApiKey,
      }
      const containerId = await this.runWithPortRetry(row, specBase)
      runAttempted = true
      // 4. 先持久化 running + containerId（否则 delete 无所有权证据，容器成孤儿），再查取消
      await this.prisma.container.update({
        where: { id: row.id },
        data: { status: 'running', containerId },
      })
      // 5. run 后取消检查（覆盖「create 已完成但 delete 在飞」窗口）→ 立即自删
      const after = await this.prisma.container.findUnique({ where: { name } })
      if (after?.cancelRequested) {
        // codex 三轮 P1 #2：自删前必须先释放 DB CAS lease（provisionDelete 才能 claim）。
        // 否则 create 仍持有 lease（finally 才清），provisionDelete 抛 LeaseContention → 容器
        // running 但取消永久 pending。释放后正常走删除（行已 running，可被 claim）。
        // codex 六轮 P1 #3：用 id 而非 name（防重建行误清 lease）
        await this.prisma.container
          .updateMany({ where: { id: row.id }, data: { leaseExpiresAt: null } })
          .catch(() => {})
        this.leases.release(name) // 进程内租约也放
        await this.provisionDelete(name)
        return
      }
    } catch (e) {
      // 不可恢复失败 → 保留 ERROR 行（补偿：清残留容器/目录 best-effort）。
      // 但取消路径清理失败（CLEANUP_FAILED）时行已标 REMOVING（可重试），finalize 不得
      // 覆盖为 error（codex #4：资源跟踪不丢）。
      if (e instanceof EnvelopeError && e.code === CODE.CLEANUP_FAILED) {
        // codex 六轮 P1：不能 `return` 完成 create job（BullMQ 移除 job，行留 removing + workspace/
        // 端口永久残留，除非客户端再发 DELETE）。抛 retryable LeaseContention 让 BullMQ 重试清理，
        // 或入队 row-bound delete。此处抛 LeaseContentionError——下个重试 provisionCreate 检出
        // cancelRequested 或走 delete 路径回收。
        throw new LeaseContentionError(name)
      }
      // 记录真实 cause（smoke/CI 据此可见 docker 为何失败，而非只见 error 态）
      // eslint-disable-next-line no-console
      console.error(`[provision] create failed for ${name}`, e)
      await this.finalizeFailedCreate(instanceDir, row, runAttempted, dirCreated)
    } finally {
      this.leases.release(name) // 进程内租约
      // 释放 DB CAS 租约（leaseExpiresAt 置 null）——本 worker 已完成/失败，下个 job 可抢占。
      // codex 六轮 P1 #3：用 `id: row.id` 而非 name——取消/自删可能删掉原行 + 重建同名行（新 id），
      // name-only 更新会误清重建行的活动 lease，致第二 worker 并发 provision/delete 同资源。
      await this.prisma.container
        .updateMany({ where: { id: row.id }, data: { leaseExpiresAt: null } })
        .catch(() => {})
    }
  }

  // bind 冲突重试循环（#295 codex P2）：宿主非容器进程占池端口时探测不可见，docker run 发布
  // 时 daemon 最终仲裁 → 冲突 → 就地更新行端口重试下一空闲（learned 冲突集并入已用集）。
  private async runWithPortRetry(
    row: Container,
    specBase: ContainerSpec,
  ): Promise<string> {
    const learned = new Set<number>()
    for (let i = 0; i < this.allocator.poolSize; i++) {
      try {
        const spec = { ...specBase, hostPort: row.port }
        return await this.runtime.run(spec)
      } catch (e) {
        if (!isBindConflict(e)) throw e
        learned.add(row.port)
        let nextPort: number
        try {
          nextPort = this.allocator.nextFree(await this.usedPorts(learned))
        } catch (err) {
          if (err instanceof PortPoolExhausted) throw fail(CODE.PORT_POOL_EXHAUSTED)
          throw err
        }
        // codex 六轮 P2：bind 冲突换端口时并发 P2002——两 worker 算同 nextFree 后各自 update，
        // 后提交者撞 port unique。学习冲突端口重试下一候选（对齐 insertCreatingRow 的 P2002 重试）。
        try {
          await this.prisma.container.update({ where: { id: row.id }, data: { port: nextPort } })
        } catch (e) {
          if ((e as { code?: string }).code === 'P2002') {
            learned.add(nextPort)
            continue
          }
          throw e
        }
        row = { ...row, port: nextPort }
      }
    }
    throw fail(CODE.PORT_POOL_EXHAUSTED)
  }

  // 失败统一收尾（补偿）：清残留容器（best-effort，失败不阻断行状态）→ 清目录
  // （失败保留 ERROR 行 + 抛 CLEANUP_FAILED）→ 行标 ERROR。行保留——POST 已返 creating
  // 快照，客户端经 list + delete 感知/重试。
  private async finalizeFailedCreate(
    instanceDir: string,
    row: Container,
    runAttempted: boolean,
    dirCreated: boolean,
  ): Promise<void> {
    if (runAttempted) {
      try {
        await this.runtime.remove(row.name)
      } catch {
        // 清容器失败：行仍保留（containerId 若已记录供 delete 证明所有权）
      }
    }
    if (dirCreated) {
      try {
        await this.dirRemover(instanceDir)
      } catch {
        // 目录清理失败：保留 ERROR 行（供 delete 重试清理残留），不吞——行状态即对外契约
        await this.prisma.container
          .update({ where: { id: row.id }, data: { status: 'error' } })
          .catch(() => {})
        return
      }
    }
    await this.prisma.container
      .update({ where: { id: row.id }, data: { status: 'error' } })
      .catch(() => {})
  }

  private async cleanupInstanceDir(
    instanceDir: string,
    row: Container,
    runAttempted: boolean,
  ): Promise<void> {
    if (runAttempted) {
      try {
        await this.runtime.remove(row.name)
      } catch {
        // best-effort
      }
    }
    try {
      await this.dirRemover(instanceDir)
    } catch (e) {
      // codex #4（P1）：取消路径目录清理失败不得吞掉并删行——残留目录无 owner 无重试目标，
      // 且后续同名 create 会把模板拷进该目录，暴露上一用户 workspace。保留行 REMOVING +
      // 抛可重试 CLEANUP_FAILED（资源跟踪不丢）。
      await this.prisma.container
        .update({ where: { id: row.id }, data: { status: 'removing' } })
        .catch(() => {})
      throw fail(CODE.CLEANUP_FAILED)
    }
  }

  // ── delete 入队（异步）──
  // 变异步：返信封立即；遇在飞 create 置取消标志（检查点检出即回滚后终止）。list 轮询观察 removing。
  // 并发护栏（#313/#334）：进程内 Map 租约同时防双创建与双删除——delete 先 tryAcquire（非阻塞），
  // 成功=无在飞 create/delete，入队后释放；失败=在飞（create 或 delete 正占位）→ 置取消标志
  // （不依赖 Redis；即使 Redis 挂也防双删）。
  async deleteEnqueue(name: string, ownerId: string, isAdmin = false): Promise<void> {
    const row = await this.prisma.container.findUnique({ where: { name } })
    if (!row) throw fail(CODE.CONTAINER_NOT_FOUND)
    // codex 五轮 P1 #4 + 六轮 P1：归属二次校验——路由先查了归属，但此处按 name 重查时行可能已被删 +
    // 同名重建（新 owner）。非 admin 须 ownerId 匹配（否则 20040 防探测，不误删重建行）；
    // admin 全放行（codex 六轮：admin 删跨用户容器不应被 ownerId 挡）。
    if (!isAdmin && row.ownerId !== ownerId) throw fail(CODE.CONTAINER_NOT_FOUND)
    // codex 五轮 P1 #1：进程内 lease 已随 createReserve enqueue 释放（请求侧不留），故此处不再用它
    // 判「在飞 create」——改用 DB lease：creating + lease 未过期 = 某进程在 provisioning（含他进程）。
    const now = new Date()
    if (row.status === 'creating' && row.leaseExpiresAt && row.leaseExpiresAt > now) {
      // 在飞 create（DB lease 被持，任意进程）：置取消标志（create job 检查点检出 → 统一回滚删行后终止），
      // 不入队 delete（同名 create job 活跃，delete 需等 lease 过期——取消标志更快）
      await this.prisma.container
        .update({
          where: { id: row.id },
          data: { cancelRequested: true },
        })
        .catch(() => {}) // 行可能已被并发 delete job 删除 → 幂等
      return
    }
    // 无在飞 create：running/stopped/error 及孤儿 creating 行（lease 过期）都可入队 delete 清理
    try {
      await this.queue.enqueueDelete(name, ownerId, row.id) // rowId 绑定：防 at-least-once 重试误删重建
    } catch (e) {
      // codex 一轮 #6（P1）：入队失败（Redis 挂）不得报假成功——rethrow 信封错误让客户端重试
      //（否则轮询永远等不到 removing）。
      throw e instanceof EnvelopeError ? e : fail(CODE.CLEANUP_FAILED)
    }
  }

  // ── delete 执行（worker 调用）：removing(终态) → 清理 → 删行 ──
  // 清理失败（OSError/容器 stop/remove 失败）→ 行标 REMOVING + 抛 CLEANUP_FAILED（可重试）。
  // codex 二轮 P1（跨 worker 串行）：同 provisionCreate，DB CAS 抢占 leaseExpiresAt 实现
  // 跨进程互斥——两 worker 对同名 delete 恰一个执行，另一个 no-op（不双删）。
  // codex 四轮 P1 #1：rowId 校验——BullMQ at-least-once 重试时若同名行已被新用户重建，不得误删。
  // codex 四轮 P1 #2：DB lease 被活动 create 持有 → 抛 LeaseContentionError（retryable），非 no-op
  // （否则 BullMQ 移除 delete job，请求的删除永久丢失）。
  async provisionDelete(name: string, rowId?: string): Promise<void> {
    const row = await this.prisma.container.findUnique({ where: { name } })
    if (!row) return // 已清理 → 幂等
    if (rowId && row.id !== rowId) return // codex 四轮 #1：行已被重建（新 rowId）→ 本 delete 属旧行，no-op
    const now = new Date()
    // codex 三轮 P1 #3：删除 claim 只排除**活动租约**（removing + lease 未过期 = 另一 worker 在清），
    // 不再排除所有 removing——否则 delete 中途失败（chown/stop/remove/rmtree）标 REMOVING 后，
    // lease 过期重试也被 `not removing` 永久挡（行+容器永远残留）。removing + lease 过期 = 可回收。
    // codex 五轮 P1 #2：claim 谓词加 `id: rowId`——rowId 检查与 CAS 是分离操作，只按 name 过滤时，
    // 另一 delete 删掉检查过的行 + 用户重建同名 → 本 claim 误占替换行。id 入谓词使绑定原子化。
    const claimed = await this.prisma.container.updateMany({
      where: {
        name,
        ...(rowId ? { id: rowId } : {}), // 原子绑定保留行（防误 claim 重建行）
        OR: [
          { status: { not: 'removing' }, leaseExpiresAt: null },
          { status: { not: 'removing' }, leaseExpiresAt: { lt: now } },
          // removing 但 lease 过期：上次清理失败，可重试回收
          { status: 'removing', leaseExpiresAt: { lt: now } },
        ],
      },
      data: { status: 'removing', leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS) },
    })
    if (claimed.count === 0) {
      // codex 四轮 #2：活动 DB lease（另一 worker 在 provisioning/清理同名）→ 抛 retryable。
      // 若 no-op，BullMQ 移除 job，delete 请求永久丢失；retry 在 lease 过期后重跑。
      throw new LeaseContentionError(name)
    }
    // codex 三轮 P2：instanceDir 从行记录的 homeDir 派生（取 parent），而非当前 cfg.fleetRoot 重构——
    // FLEET_ROOT 变更后新 root 无该目录，force:true 会误判清理成功、旧 workspace 残留。
    // homeDir=<fleetRoot>/instances/<name>/home → parent = instances/<name>。
    // 防御：homeDir 占位/被篡改（parent 不在 instances 根下）时回退 cfg.fleetRoot 重构。
    const recordedParent = path.dirname(row.homeDir)
    const instanceDir =
      path.basename(recordedParent) === name && path.basename(path.dirname(recordedParent)) === 'instances'
        ? recordedParent
        : path.join(this.cfg.fleetRoot, 'instances', name)
    // container_id 是本行拥有 runtime 容器的正向证据；验证后再 stop/remove（防误删外来同名容器）
    if (row.containerId) {
      let live: { containerId: string } | null = null
      try {
        live = await this.runtime.get(name)
      } catch {
        // daemon 抖动：无法验证容器归属 → 不能贸然 rmtree/删行（容器可能仍在跑，孤儿）。
        // 保留行 REMOVING + 抛 CLEANUP_FAILED，客户端重试 delete。
        throw fail(CODE.CLEANUP_FAILED)
      }
      if (live && live.containerId === row.containerId) {
        // codex 一轮 #3 + 二轮 P1（chown 失败保留容器）：容器以 root 跑（user=0:0），bind-mount
        // home 内由容器写入的文件属主 root——host 非 root rmtree 会 EACCES，且 stop/remove 后
        // 容器没了（唯一能回收 root 属主文件的环境）无法补救。先同步 chown home 给 host uid。
        // chown 失败（容器在跑但命令错）→ 保留容器 + 行 REMOVING + 抛 CLEANUP_FAILED 可重试，
        // 不继续 stop/remove（否则 rmtree EACCES 且容器已删，永久卡 REMOVING）。
        try {
          await this.runtime.execSync(name, ['chown', '-R', String(process.getuid?.() ?? 0), HOME_BIND])
        } catch (e) {
          const isNotFound = (e as { statusCode?: number }).statusCode === 404
          if (!isNotFound) {
            // 容器在跑但 chown 失败：保留容器（可重试 chown），不删
            throw fail(CODE.CLEANUP_FAILED)
          }
          // 容器已不在（404）→ 无法 chown，继续清理（rmtree 尽力而为）
        }
        try {
          await this.runtime.stop(name)
          await this.runtime.remove(name)
        } catch {
          throw fail(CODE.CLEANUP_FAILED)
        }
      }
    }
    // home 目录清理（目录不存在视为成功；OSError → 标 REMOVING 可重试）
    try {
      await this.dirRemover(instanceDir)
    } catch {
      await this.prisma.container
        .update({ where: { id: row.id }, data: { status: 'removing' } })
        .catch(() => {})
      throw fail(CODE.CLEANUP_FAILED)
    }
    await this.prisma.container.delete({ where: { id: row.id } })
    // M4 衔接：chat pool 逐出由 worker delete 完成后触发（此处占位）
  }

  private async provisionHome(instanceDir: string, homeDir: string): Promise<void> {
    if (!this.cfg.templateDir) throw fail(CODE.LLM_KEY_MISSING, 'OPENCLAW_TEMPLATE_DIR 未配置')
    const template = path.resolve(this.cfg.templateDir)
    const home = path.resolve(homeDir)
    if (template === home || home.startsWith(template + path.sep)) {
      // 模板是 home 的祖先 → cp 会无限递归（issue #195 同类错配）
      throw fail(CODE.LLM_KEY_MISSING, '模板目录是 home 的祖先，cp 会无限递归')
    }
    // codex 四轮 P1 #3：DB 已有本行（createReserve 刚插入），instanceDir 若已存在 = 残留 orphan
    //（崩溃中断/手动清 DB）。递归 mkdir 接受旧目录 + cp force:false 会合并残留文件 → 新容器在
    // 旧 workspace 上启动，暴露上一用户数据。检测到即拒绝（20044 orphan 目录，先清理再重试）。
    try {
      const stat = await import('node:fs/promises').then((f) => f.stat(instanceDir))
      if (stat.isDirectory()) {
        throw fail(CODE.ORPHAN_DIR, '存在残留数据目录，请先删除同名实例或手动清理后重试')
      }
    } catch (e) {
      if (e instanceof EnvelopeError) throw e
      // ENOENT（目录不存在）→ 正常新建
    }
    await mkdir(instanceDir, { recursive: true })
    await cp(template, homeDir, { recursive: true, force: false })
  }

  // config 原子写：tmp 同目录 + rename（避免 torn/partial，对齐旧 ConfigStore 原子性）
  private async writeConfigAtomic(configPath: string, payload: string): Promise<void> {
    await mkdir(path.dirname(configPath), { recursive: true })
    const tmp = `${configPath}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, configPath)
  }
}
