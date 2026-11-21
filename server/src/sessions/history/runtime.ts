// #1079 · 历史增强运行时装配（RF-T03）。
//
// 组合独立只读执行器 + 持久主请求账本 + 精简访问日志。生产组合根尚未注入（RF-T12
// 完整门禁），但这里的装配形态是唯一接缝：runner 只拿到 execute/resolveRunRequest，
// 不拿数据库/执行器对象。可信 DB 路径只从装配参数进入。
import type { PrismaClient } from '../../generated/prisma/client'
import { ProcessHistoryReader, type ProcessHistoryReaderOptions } from './executor'
import { createHistoryAccessLogger } from './logging'
import type { HistoryContext, HistoryReader, HistoryResult } from './model'
import { PrismaHistoryLedger } from './prismaLedger'
import { SessionHistoryService, type SessionHistoryOptions } from './service'

export interface HistoryRuntimeOptions {
  readonly prisma: PrismaClient
  /** 可信装配路径：不接受 Agent/模型指定。 */
  readonly dbPath: string
  readonly service?: SessionHistoryOptions
  readonly executor?: Omit<ProcessHistoryReaderOptions, 'dbPath'>
}

export class HistoryRuntime {
  readonly requiresRequestIdentity = true
  constructor(
    private readonly service: SessionHistoryService,
    private readonly ledger: PrismaHistoryLedger,
  ) {}

  execute(context: HistoryContext, input: unknown, signal?: AbortSignal): Promise<HistoryResult> {
    return this.service.execute(context, input, signal)
  }

  resolveRunRequest(input: import('./model').HistoryRequestLedgerInput): Promise<string | undefined> {
    return this.ledger.resolveRunRequest(input)
  }

  async dispose(): Promise<void> {
    await this.service.dispose()
  }
}

export function createHistoryRuntime(options: HistoryRuntimeOptions): HistoryRuntime {
  const ledger = new PrismaHistoryLedger(options.prisma)
  // 服务级时限与执行器硬停止同源：装配处显式穿线，避免两处默认值漂移。
  const reader: HistoryReader = new ProcessHistoryReader({
    ...options.executor,
    dbPath: options.dbPath,
    cooperativeMs: options.executor?.cooperativeMs ?? options.service?.cooperativeMs,
    hardMs: options.executor?.hardMs ?? options.service?.hardMs,
  })
  const service = new SessionHistoryService(reader, {
    ...options.service,
    budget: ledger,
    events: options.service?.events ?? createHistoryAccessLogger(),
  })
  return new HistoryRuntime(service, ledger)
}
