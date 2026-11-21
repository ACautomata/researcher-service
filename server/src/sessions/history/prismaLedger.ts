// #1079 · 主请求额度账本（Prisma 适配）——外层适配，业务内核只依赖 model.ts 的接口。
//
// requestId = 可信 triggerMessageId，与可重建的 runId 分离。resume/recover 经本行延续，
// 不重新发放；找不到行 = 不可靠恢复 → 停止旧请求增强（unrecoverable）。
import type { PrismaClient } from '../../generated/prisma/client'
import type {
  HistoryBudgetRequest,
  HistoryBudgetReservation,
  HistoryRequestBudgetLimits,
  HistoryRequestBudgetStore,
  HistoryRequestLedgerInput,
} from './model'

export interface HistoryRequestLedger {
  startMessageRequest(input: HistoryRequestLedgerInput & { triggerMessageId: string }): Promise<string | undefined>
  resolveRunRequest(input: HistoryRequestLedgerInput): Promise<string | undefined>
}

export class PrismaHistoryLedger implements HistoryRequestLedger, HistoryRequestBudgetStore {
  constructor(private readonly prisma: PrismaClient) {}

  async startMessageRequest(input: HistoryRequestLedgerInput & { triggerMessageId: string }): Promise<string | undefined> {
    const requestId = input.triggerMessageId
    const existing = await this.prisma.historyRequestBudget.findUnique({ where: { requestId } })
    if (existing) {
      if (existing.ownerId !== input.ownerId || existing.sessionId !== input.sessionId) return undefined
      await this.prisma.historyRequestBudget.update({ where: { requestId }, data: { lastRunId: input.runId } }).catch(() => {})
      return requestId
    }
    try {
      await this.prisma.historyRequestBudget.create({
        data: { requestId, ownerId: input.ownerId, sessionId: input.sessionId, lastRunId: input.runId },
      })
      return requestId
    } catch {
      // 并发同请求：唯一约束败者回读，仍须身份一致。
      const row = await this.prisma.historyRequestBudget.findUnique({ where: { requestId } }).catch(() => null)
      if (!row || row.ownerId !== input.ownerId || row.sessionId !== input.sessionId) return undefined
      return requestId
    }
  }

  async resolveRunRequest(input: HistoryRequestLedgerInput): Promise<string | undefined> {
    if (input.kind === 'message') {
      if (!input.triggerMessageId) return undefined
      return this.startMessageRequest({ ...input, triggerMessageId: input.triggerMessageId })
    }
    // resume/recover：优先按原 runId（recover 重放同一命令 / resume 的 resumeOfRunId）
    // 定位，再按会话最新账本。会话串行链在 interrupted/suspended 期间拒绝新主请求，
    // 因此回退读到的「最新」不会把旧请求绑到更新的主请求上。
    const byRun = input.resumeOfRunId
      ? await this.prisma.historyRequestBudget.findFirst({
          where: { ownerId: input.ownerId, sessionId: input.sessionId, lastRunId: input.resumeOfRunId },
          orderBy: { updatedAt: 'desc' },
        })
      : undefined
    const byCurrentRun = byRun ?? await this.prisma.historyRequestBudget.findFirst({
      where: { ownerId: input.ownerId, sessionId: input.sessionId, lastRunId: input.runId },
      orderBy: { updatedAt: 'desc' },
    })
    const row = byCurrentRun ?? await this.prisma.historyRequestBudget.findFirst({
      where: { ownerId: input.ownerId, sessionId: input.sessionId },
      orderBy: { updatedAt: 'desc' },
    })
    // 不可靠恢复：不新建账本、不重新发放额度。
    if (!row) return undefined
    await this.prisma.historyRequestBudget.update({ where: { requestId: row.requestId }, data: { lastRunId: input.runId } }).catch(() => {})
    return row.requestId
  }

  async reserve(
    request: HistoryBudgetRequest,
    limits: HistoryRequestBudgetLimits,
  ): Promise<HistoryBudgetReservation> {
    return this.prisma.$transaction(async tx => {
      const row = await tx.historyRequestBudget.findUnique({ where: { requestId: request.requestId } })
      if (!row || row.ownerId !== request.ownerId || row.sessionId !== request.sessionId) {
        return { allowed: false, reason: 'unrecoverable', remainingBytes: 0, remainingWaitMs: 0 } as const
      }
      const reason = row.calls >= limits.calls ? 'calls'
        : row.waitedMs >= limits.waitMs ? 'wait'
        : row.returnedBytes >= limits.bytes ? 'bytes'
        : undefined
      // 失败与重试也计入：无论是否允许，本次调用都记一次。
      await tx.historyRequestBudget.update({ where: { requestId: request.requestId }, data: { calls: { increment: 1 } } })
      return {
        allowed: reason === undefined,
        ...(reason ? { reason } : {}),
        remainingBytes: Math.max(0, limits.bytes - row.returnedBytes),
        remainingWaitMs: Math.max(0, limits.waitMs - row.waitedMs),
      }
    })
  }

  async settle(
    request: HistoryBudgetRequest,
    usage: { bytes: number; waitedMs: number },
  ): Promise<void> {
    const updated = await this.prisma.historyRequestBudget.updateMany({
      where: { requestId: request.requestId, ownerId: request.ownerId, sessionId: request.sessionId },
      data: { returnedBytes: { increment: Math.max(0, usage.bytes) }, waitedMs: { increment: Math.max(0, usage.waitedMs) } },
    })
    // 计量不可靠 → 停止增强，不冒险超额交付。
    if (updated.count === 0) throw new Error('history budget ledger unavailable')
  }
}
