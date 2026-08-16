// AutoFigure 单 worker 生成生命周期（T03，docs/autofigure/tickets/T03-single-worker-generation-lifecycle.md）。
//
// 职责：queued GenerationJob → 原子领取（queued→running，startedAt 置位）→ AutoFigureGenerationPort
// → 终态（succeeded|failed，finishedAt 置位，errorMessage 仅失败非敏感原因）。concurrency=1
//（进程内 active 守卫 + 原子领取双保险）；无自动重试（终态不可逆，失败即 failed；重新生成走 T02
// 幂等创建的新 Figure+Job 路径）。
//
// 本文件明确不做（T04/T07 范围，防越界）：
//   - 超时 / reconcile / 迟到结果围栏：T04 全权。`status='running'` 条件写是 T03 本地终态完整性
//     （AC5 支撑），不是迟到围栏；超时产生的转换一律不在本文件。
//   - 生产 HTTP 适配器 / sidecar / 凭证传输形态：T07。
//   - 幂等：T02（本 runner 不触碰 idempotencyKey 逻辑）。
//   - 通用 JobStateMachine：只保留 AC5 所需的最小局部转换守卫（下方 assertLegalTransition）。
//
// SQLite/Prisma 是 Job 状态的唯一持久化真相源：本 runner 的一切状态变化都经
// updateMany({ where: { id, status }, ... })+count 判定，绝不依赖进程内存状态做裁决。

import type { GenerationJobStatus, PrismaClient } from '../generated/prisma/client'
import type { AutoFigureGenerationPort, AutoFigureGenerationResult } from './port'

// ---------------------------------------------------------------------------
// 局部转换守卫（AC5）
// ---------------------------------------------------------------------------

// 合法转换表：queued→running（原子领取）、running→succeeded|failed（终态）。终态（succeeded/failed）
// 不可再转换——四个非法终态转换（failed→succeeded / failed→running / succeeded→running /
// succeeded→failed）一律拒绝。这是 T03 局部的转换完整性，不是通用状态机（T04 的超时/reconcile
// 转换不在此列，本票不实现）。
const LEGAL_TRANSITIONS: Readonly<Record<GenerationJobStatus, readonly GenerationJobStatus[]>> = {
  queued: ['running'],
  running: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
}

export function assertLegalTransition(from: GenerationJobStatus, to: GenerationJobStatus): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`非法 GenerationJob 状态转换: ${from} -> ${to}（终态 succeeded/failed 不可逆）`)
  }
}

// ---------------------------------------------------------------------------
// 持久化状态转换（原子，SQL 判定）
// ---------------------------------------------------------------------------

// 原子领取（AC3）：单条 UPDATE ... WHERE id=? AND status='queued'，count===1 证明本调用是唯一赢家
//（并发重复领取时至多一个成功）。state 由持久化状态守卫，SQL 单语句 + SQLite 单 writer 保证判定
// 原子——对齐代码库既有 CAS 模式（users/auth/tokens 的 updateMany+count）。startedAt 随领取置位，
// 即「进入 running 的时刻」。
export async function claimQueuedJob(prisma: PrismaClient, jobId: string): Promise<boolean> {
  const claimed = await prisma.generationJob.updateMany({
    where: { id: jobId, status: 'queued' },
    data: { status: 'running', startedAt: new Date() },
  })
  return claimed.count === 1
}

// 终态写入（AC2/AC5 持久化 + AC6 无重试）：以 WHERE status='running' 为条件写 succeeded|failed。
// Job 已非 running（被并发/外部改为终态）→ count=0 返回 false，绝不覆盖既有终态、绝不重试。
// finishedAt 随终态置位；成功清 errorMessage（契约：errorMessage 仅失败原因）。
export async function persistTerminalState(
  prisma: PrismaClient,
  jobId: string,
  status: 'succeeded' | 'failed',
  errorMessage?: string,
): Promise<boolean> {
  const done = await prisma.generationJob.updateMany({
    where: { id: jobId, status: 'running' },
    data: {
      status,
      finishedAt: new Date(),
      errorMessage: status === 'failed' ? errorMessage : null,
    },
  })
  return done.count === 1
}

// ---------------------------------------------------------------------------
// GenerationRunner：start/stop/tick
// ---------------------------------------------------------------------------

export interface GenerationRunner {
  start(): void
  stop(): Promise<void>
  /** 单次 pump 周期（确定性测试接缝）；已在执行时为 no-op（concurrency=1） */
  tick(): Promise<void>
}

export interface GenerationRunnerDeps {
  prisma: PrismaClient
  port: AutoFigureGenerationPort
  /** 服务端凭证（config.autofigure.llmKey）；只注入 Port，不落盘/不入 Job payload/不入日志 */
  llmKey: string
  pollIntervalMs?: number
}

// Port 抛异常（执行体崩溃/网络异常）→ 归一为 failed（非敏感消息；不暴露内部栈/凭证）。
const GENERATION_EXECUTION_ERROR = '生成执行异常（内部错误）'

const DEFAULT_POLL_INTERVAL_MS = 1000

class DefaultGenerationRunner implements GenerationRunner {
  private readonly prisma: PrismaClient
  private readonly port: AutoFigureGenerationPort
  private readonly llmKey: string
  private readonly pollIntervalMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  // concurrency=1 守卫：tick 进入即同步置位（无 await 间隙，事件循环内原子），退出才复位——
  // 任何并发 tick（interval 重入 / 测试 Promise.all）在置位后立即 no-op，杜绝同一进程内不同
  // queued Job 的重叠执行。
  private active = false
  private currentTick: Promise<void> | null = null

  constructor(deps: GenerationRunnerDeps) {
    this.prisma = deps.prisma
    this.port = deps.port
    this.llmKey = deps.llmKey
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  start(): void {
    if (this.timer !== undefined) return // 幂等启动
    this.timer = setInterval(() => {
      void this.tick()
    }, this.pollIntervalMs)
    this.timer.unref?.() // 后台 pump 不阻止进程退出；宿主优雅关闭仍走 stop()
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    const inflight = this.currentTick
    if (inflight) await inflight // 等在飞周期 settle（优雅关闭）
    this.currentTick = null
  }

  tick(): Promise<void> {
    if (this.active) return Promise.resolve() // concurrency=1：已有周期在执行，本次 no-op
    this.active = true
    // DB 层错误（updateMany 抛错等）：状态由已执行的持久化步骤决定，吞错后由 T04 reconcile 兜底
    //（本票无超时/reconcile）；绝不自动重试。catch 保证 interval 触发不产生未处理 rejection。
    const p = this.runOne()
      .catch(() => {
        // 空吞：T03 不实现任何自动重试；DB 故障时 Job 保持 claim 后的 running，交 T04。
      })
      .finally(() => {
        this.active = false
      })
    this.currentTick = p
    return p
  }

  private async runOne(): Promise<void> {
    // 取最老的 queued Job（FIFO，确定性顺序），连带其 1:1 Figure 的 prompt。
    const job = await this.prisma.generationJob.findFirst({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, figure: { select: { prompt: true } } },
    })
    if (!job) return

    assertLegalTransition('queued', 'running')
    const claimed = await claimQueuedJob(this.prisma, job.id)
    if (!claimed) return // 并发重复领取的输家：他人已领，本 writer 放弃（至多一次执行）

    // 凭证只在此处注入 Port；prompt 是域输入，分开传。
    let result: AutoFigureGenerationResult
    try {
      result = await this.port.generate({ prompt: job.figure.prompt }, { apiKey: this.llmKey })
    } catch {
      result = { ok: false, errorMessage: GENERATION_EXECUTION_ERROR }
    }

    if (result.ok) {
      assertLegalTransition('running', 'succeeded')
      await persistTerminalState(this.prisma, job.id, 'succeeded')
    } else {
      assertLegalTransition('running', 'failed')
      await persistTerminalState(this.prisma, job.id, 'failed', result.errorMessage)
    }
  }
}

export function createGenerationRunner(deps: GenerationRunnerDeps): GenerationRunner {
  return new DefaultGenerationRunner(deps)
}

// ---------------------------------------------------------------------------
// 装配门（AC8 flag 门）
// ---------------------------------------------------------------------------

export interface AutoFigureRunnerHandle {
  runner: GenerationRunner
  close(): Promise<void> // 优雅关闭（停 pump、等在飞周期）
}

export interface AutoFigureRunnerAssembleDeps extends GenerationRunnerDeps {
  /** flag（装配层 server.ts 传 config.autofigure.enabled；flag 只在装配层消费） */
  enabled: boolean
}

// flag 关 → 不构造不启动（返回 null：无 pump，queued 恒不迁移）；flag 开 → 构造并启动 pump，返回
// 含 close() 的 handle（对齐 assembleFleet 的 close 先例）。T03 不接线 server.ts（无生产 Port，
// T07 才装配 HTTP 适配器），但本门即 T07 的装配点，现即可测两分支。
export function assembleAutoFigureRunner(
  deps: AutoFigureRunnerAssembleDeps,
): AutoFigureRunnerHandle | null {
  if (!deps.enabled) return null
  const runner = createGenerationRunner(deps)
  runner.start()
  return { runner, close: () => runner.stop() }
}
