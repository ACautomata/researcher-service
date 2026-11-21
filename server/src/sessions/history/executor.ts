// #1079 · RF-T03 独立只读执行器（#1082 起与反思记录检索共用 utils/leasedProcessPool.ts）。
//
// 每次历史工具调用独占一条子进程（每用户 1、全平台 4）；子进程只读打开 SQLite。
// 2 秒协作时限由业务层与核心逐行检查；5 秒硬停止由主进程 SIGKILL 子进程——真实终止，
// 不是 Promise.race 假停。任何子进程错误都不把 stderr/堆栈/路径带回业务响应。
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  HistoryCooperativeTimeout,
  HistoryExecutionTimeout,
  HistoryExecutionUnavailable,
  mapHistoryErrorCode,
  type HistoryContext,
  type HistoryExecutionLease,
  type HistoryReader,
  type HistoryScan,
  type HistoryScanOptions,
  type HistorySessionQuery,
} from './model'
import { LeasedProcessPool, type ProcessLease } from '../../utils/leasedProcessPool'

export interface ProcessHistoryReaderOptions {
  readonly dbPath: string
  /** 全平台执行槽（默认 4）。 */
  readonly maxGlobal?: number
  /** 每用户执行槽（默认 1）。 */
  readonly maxPerUser?: number
  /** 单次工具调用协作时限（默认 2000ms）。 */
  readonly cooperativeMs?: number
  /** 单次工具调用硬停止（默认 5000ms）。 */
  readonly hardMs?: number
  readonly limits?: { sessions: number }
  readonly clock?: () => number
}

function resolveCorePath(): string | undefined {
  const candidates: string[] = []
  try {
    if (typeof __dirname === 'string' && __dirname) candidates.push(path.join(__dirname, 'sqliteCore.cjs'))
  } catch {
    // ESM 运行时无 __dirname
  }
  candidates.push(path.join(process.cwd(), 'src/sessions/history/sqliteCore.cjs'))
  candidates.push(path.join(process.cwd(), 'dist/server/src/sessions/history/sqliteCore.cjs'))
  return candidates.find(candidate => existsSync(candidate))
}

export class ProcessHistoryReader implements HistoryReader {
  private readonly dbPath: string
  private readonly cooperativeMs: number
  private readonly hardMs: number
  private readonly limits: { sessions: number }
  private readonly pool: LeasedProcessPool

  constructor(options: ProcessHistoryReaderOptions) {
    this.dbPath = options.dbPath
    this.cooperativeMs = options.cooperativeMs ?? 2_000
    this.hardMs = options.hardMs ?? 5_000
    this.limits = options.limits ?? { sessions: 1000 }
    this.pool = new LeasedProcessPool({
      corePath: resolveCorePath() ?? '',
      maxGlobal: options.maxGlobal ?? 4,
      maxPerUser: options.maxPerUser ?? 1,
      errors: {
        timeout: () => new HistoryExecutionTimeout(),
        abort: () => new HistoryCooperativeTimeout(),
        unavailable: () => new HistoryExecutionUnavailable(),
        code: (code, denied) => mapHistoryErrorCode(code, denied) ?? new HistoryExecutionUnavailable(),
      },
    })
  }

  executionLease(context: HistoryContext, options: { signal?: AbortSignal; waitBudgetMs?: number } = {}): HistoryExecutionLease | undefined {
    const lease = this.pool.lease(context.ownerId)
    if (!lease) return undefined
    const remainingWait = options.waitBudgetMs ?? Number.POSITIVE_INFINITY
    const hardMs = Math.max(1, Math.min(this.hardMs, remainingWait))
    const taskOptions = {
      signal: options.signal,
      cooperativeMs: Math.min(this.cooperativeMs, hardMs),
      hardMs,
    }
    const reader: HistoryReader = {
      sessions: (ctx, scanOptions) => this.run<HistorySessionQuery>(lease, {
        fn: 'sessions',
        dbPath: this.dbPath,
        args: [ctx, scanOptions ?? {}, this.limits],
      }, taskOptions),
      scan: (ctx, sessionId, scanOptions) => this.run<HistoryScan>(lease, {
        fn: 'scan',
        dbPath: this.dbPath,
        args: [ctx, sessionId, scanOptions],
      }, taskOptions),
    }
    return { reader, release: () => lease.release() }
  }

  // 直接调用（服务未使用租约时）：一次性占用槽并释放。
  sessions(context: HistoryContext, options: { sessionIds?: readonly string[] } = {}): Promise<HistorySessionQuery> {
    return this.withLease(context, lease => Promise.resolve(lease.reader.sessions(context, options)))
  }

  scan(context: HistoryContext, sessionId: string, options: HistoryScanOptions): Promise<HistoryScan> {
    return this.withLease(context, lease => Promise.resolve(lease.reader.scan(context, sessionId, options)))
  }

  /** 验证缝（B4/M6）：真实执行器中的只读连接拒绝写入。 */
  async probeReadOnly(): Promise<boolean> {
    return this.pool.probeReadOnly('__history_probe__', this.dbPath, {
      cooperativeMs: this.cooperativeMs,
      hardMs: this.hardMs,
    })
  }

  /** 验证缝（B5/B6）：真实子进程忙循环，用于证明协作超时、取消与 SIGKILL 硬停止。 */
  async probeBusy(durationMs: number, options: { cooperativeMs?: number; hardMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    await this.pool.probeBusy('__history_probe__', durationMs, {
      cooperativeMs: options.cooperativeMs ?? this.cooperativeMs,
      hardMs: options.hardMs ?? this.hardMs,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  dispose(): void {
    this.pool.dispose()
  }

  private async withLease<T>(context: HistoryContext, run: (lease: HistoryExecutionLease) => Promise<T>): Promise<T> {
    const lease = this.executionLease(context)
    if (!lease) throw new HistoryExecutionUnavailable()
    try {
      return await run(lease)
    } finally {
      lease.release()
    }
  }

  private run<T>(lease: ProcessLease, payload: { fn: string; dbPath: string; args: unknown[] }, options: { signal?: AbortSignal; cooperativeMs: number; hardMs: number }): Promise<T> {
    return lease.run<T>(payload, {
      cooperativeMs: options.cooperativeMs,
      hardMs: options.hardMs,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }
}
