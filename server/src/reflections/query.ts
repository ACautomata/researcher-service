// #1082（RF-T06）反思记录查询适配：真实只读子进程 + 独立执行槽（每用户 1 / 全局 4）。
//
// 查询 SQL 只走 reflectionCore.cjs；端口形状定义在 model.ts（业务内层），本文件只做外层适配。

import { existsSync } from 'node:fs'
import path from 'node:path'
import { LeasedProcessPool, type ProcessLease } from '../utils/leasedProcessPool'
import type {
  RecordSummary,
  ReflectionRecordRead,
  ReflectionQueryLease,
  ReflectionQueryPort,
} from './model'

export type { ReflectionQueryPort } from './model'
export type ReflectionRecordSummary = RecordSummary

export class ReflectionQueryLimitError extends Error {
  readonly category = 'limit' as const
  readonly code = 'timeout' as const
  constructor() { super('reflection query timeout'); this.name = 'ReflectionQueryLimitError' }
}

export class ReflectionQueryUnavailableError extends Error {
  readonly category = 'system' as const
  readonly code = 'unavailable' as const
  constructor() { super('reflection query unavailable'); this.name = 'ReflectionQueryUnavailableError' }
}

export interface ReflectionQueryOptions {
  readonly dbPath: string
  readonly maxGlobal?: number
  readonly maxPerUser?: number
  readonly cooperativeMs?: number
  readonly hardMs?: number
}

function resolveCorePath(): string | undefined {
  const candidates: string[] = []
  try {
    if (typeof __dirname === 'string' && __dirname) candidates.push(path.join(__dirname, 'reflectionCore.cjs'))
  } catch {
    // ESM 运行时无 __dirname
  }
  candidates.push(path.join(process.cwd(), 'src/reflections/reflectionCore.cjs'))
  candidates.push(path.join(process.cwd(), 'dist/server/src/reflections/reflectionCore.cjs'))
  return candidates.find((candidate) => existsSync(candidate))
}

export class ProcessReflectionQuery implements ReflectionQueryPort {
  private readonly dbPath: string
  private readonly cooperativeMs: number
  private readonly hardMs: number
  private readonly pool: LeasedProcessPool

  constructor(options: ReflectionQueryOptions) {
    this.dbPath = options.dbPath
    this.cooperativeMs = options.cooperativeMs ?? 2_000
    this.hardMs = options.hardMs ?? 5_000
    this.pool = new LeasedProcessPool({
      corePath: resolveCorePath() ?? '',
      maxGlobal: options.maxGlobal ?? 4,
      maxPerUser: options.maxPerUser ?? 1,
      errors: {
        timeout: () => new ReflectionQueryLimitError(),
        abort: () => new ReflectionQueryLimitError(),
        unavailable: () => new ReflectionQueryUnavailableError(),
        code: () => new ReflectionQueryUnavailableError(),
      },
    })
  }

  lease(ownerId: string): ReflectionQueryLease | undefined {
    const lease = this.pool.lease(ownerId)
    if (!lease) return undefined
    return {
      search: (owner, criteria, options) => this.run(lease, 'searchRecords', owner, [criteria], options),
      versions: async (owner, ids, options) =>
        (await this.run<{ records: ReflectionRecordSummary[] }>(lease, 'recordVersions', owner, [{ ids }], options)).records,
      read: async (owner, targets, experience, options) =>
        (await this.run<{ records: ReflectionRecordRead[] }>(lease, 'readRecords', owner, [{ targets, experience }], options)).records,
      release: () => lease.release(),
    }
  }

  async probeReadOnly(): Promise<boolean> {
    return this.pool.probeReadOnly('__reflection_probe__', this.dbPath, {
      cooperativeMs: this.cooperativeMs,
      hardMs: this.hardMs,
    })
  }

  async probeBusy(durationMs: number, options: { cooperativeMs?: number; hardMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    await this.pool.probeBusy('__reflection_probe__', durationMs, {
      cooperativeMs: options.cooperativeMs ?? this.cooperativeMs,
      hardMs: options.hardMs ?? this.hardMs,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  async dispose(): Promise<void> {
    await this.pool.dispose()
  }

  private run<T>(
    lease: ProcessLease,
    fn: string,
    ownerId: string,
    args: unknown[],
    options: { signal?: AbortSignal; hardMs?: number } = {},
  ): Promise<T> {
    const hardMs = Math.max(1, Math.min(this.hardMs, options.hardMs ?? Number.POSITIVE_INFINITY))
    return lease.run<T>({
      fn,
      dbPath: this.dbPath,
      args: [{ ownerId, ...(args[0] as object) }],
    }, {
      cooperativeMs: Math.min(this.cooperativeMs, hardMs),
      hardMs,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }
}
