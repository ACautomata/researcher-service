// #1082（RF-T06）记录检索主请求额度账本（Prisma 适配）。
//
// requestId = 可信 triggerMessageId；与历史检索账本独立（各自 20 次 / 10 秒 / 256KiB）。
// 首次 reserve 建行；resume/recover 用同一 requestId 延续，不重新发放。

import type { PrismaClient } from '../generated/prisma/client'
import type {
  ReflectionBudgetLimits,
  ReflectionBudgetReservation,
  ReflectionBudgetRequest,
  ReflectionBudgetStore,
} from './model'

export class PrismaReflectionBudgetLedger implements ReflectionBudgetStore {
  constructor(private readonly prisma: PrismaClient) {}

  async resolveRunRequest(input: { kind: string; runId: string; ownerId: string; sessionId: string; triggerMessageId?: string; resumeOfRunId?: string }): Promise<string | undefined> {
    if (input.kind === 'message') {
      if (!input.triggerMessageId) return undefined
      const trigger = await this.prisma.sessionMessage.findFirst({ where: { id: input.triggerMessageId, sessionId: input.sessionId, role: 'user', archivedAt: null, session: { ownerId: input.ownerId } } })
      if (!trigger) return undefined
      const row = await this.prisma.reflectionRequestBudget.upsert({ where: { requestId: trigger.id }, create: { requestId: trigger.id, ownerId: input.ownerId, sessionId: input.sessionId, lastRunId: input.runId, originRunId: input.runId }, update: {} })
      if (row.ownerId !== input.ownerId || row.sessionId !== input.sessionId) return undefined
      await this.prisma.reflectionRequestBudget.update({ where: { requestId: row.requestId }, data: { lastRunId: input.runId } })
      return row.requestId
    }
    const row = await this.prisma.reflectionRequestBudget.findFirst({ where: { ownerId: input.ownerId, sessionId: input.sessionId, OR: [{ lastRunId: input.runId }, ...(input.resumeOfRunId ? [{ originRunId: input.resumeOfRunId }, { lastRunId: input.resumeOfRunId }] : [])] } })
    if (!row) return undefined
    await this.prisma.reflectionRequestBudget.update({ where: { requestId: row.requestId }, data: { lastRunId: input.runId } })
    return row.requestId
  }

  async reserve(
    request: ReflectionBudgetRequest,
    limits: ReflectionBudgetLimits,
  ): Promise<ReflectionBudgetReservation> {
    return this.prisma.$transaction(async (tx) => {
      let row = await tx.reflectionRequestBudget.findUnique({ where: { requestId: request.requestId } })
      if (!row) {
        // 并发首个调用：upsert 由唯一键收敛，败者回读同一行。
        await tx.reflectionRequestBudget.upsert({
          where: { requestId: request.requestId },
          create: { requestId: request.requestId, ownerId: request.ownerId, sessionId: request.sessionId, lastRunId: '' },
          update: {},
        })
        row = await tx.reflectionRequestBudget.findUnique({ where: { requestId: request.requestId } })
      }
      if (!row || row.ownerId !== request.ownerId || row.sessionId !== request.sessionId) {
        return { allowed: false, reason: 'unrecoverable', remainingBytes: 0, remainingWaitMs: 0 } as const
      }
      const reason = row.calls >= limits.calls ? 'calls'
        : row.waitedMs >= limits.waitMs ? 'wait'
        : row.returnedBytes >= limits.bytes ? 'bytes'
        : undefined
      // 失败与重试也计入：无论是否允许，本次调用都记一次。
      await tx.reflectionRequestBudget.update({ where: { requestId: request.requestId }, data: { calls: { increment: 1 } } })
      return {
        allowed: reason === undefined,
        ...(reason ? { reason } : {}),
        remainingBytes: Math.max(0, limits.bytes - row.returnedBytes),
        remainingWaitMs: Math.max(0, limits.waitMs - row.waitedMs),
      }
    })
  }

  async settle(request: ReflectionBudgetRequest, usage: { bytes: number; waitedMs: number }): Promise<void> {
    const updated = await this.prisma.reflectionRequestBudget.updateMany({
      where: { requestId: request.requestId, ownerId: request.ownerId, sessionId: request.sessionId },
      data: {
        returnedBytes: { increment: Math.max(0, usage.bytes) },
        waitedMs: { increment: Math.max(0, usage.waitedMs) },
      },
    })
    if (updated.count === 0) throw new Error('reflection budget ledger unavailable')
  }

  async settleBytes(request: ReflectionBudgetRequest, bytes: number, limit: number): Promise<{ allowed: boolean; remaining: number }> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.reflectionRequestBudget.findUnique({ where: { requestId: request.requestId } })
      if (!row || row.ownerId !== request.ownerId || row.sessionId !== request.sessionId) {
        return { allowed: false, remaining: 0 }
      }
      const remaining = Math.max(0, limit - row.returnedBytes)
      if (bytes > remaining) return { allowed: false, remaining }
      await tx.reflectionRequestBudget.update({
        where: { requestId: request.requestId },
        data: { returnedBytes: { increment: Math.max(0, bytes) } },
      })
      return { allowed: true, remaining: remaining - bytes }
    })
  }
}
