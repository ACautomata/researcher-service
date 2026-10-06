// write-after-write 覆盖审计（#785 · #747 E 节锁方案语义层）：「合法覆盖 V1 接受 + 审计计数」——
// 取锁写 path 时若存在已 applied 且上家 writer ≠ 本 thread 的 journal 行，记
// path/覆盖者/被覆盖者一次（不限时窗），进审计域（file_overwrite_logs），不做运行时提示。
//
// 纪律对齐 D8「观测面进审计域（静默失败不可接受）」：审计写失败不阻断写路径（覆盖在 V1 是
// 合法语义、审计是观测面而非安全闸），但必须 console.warn 留痕。
//
// writer 归属：file_journal 无 writer 列——行锚定 checkpointId，经 checkpoints.threadId 解析
// 写者 thread（teammate journal 行挂 parent session、checkpoint 各归本 thread，跨 thread 区分
// 即由此成立；fork 复制行 checkpoint 随 threadId 改写为新会话 → fork 后「上家 = 本 thread」
// 判等成立，无审计风暴）。上家 = 最新 applied 且未 archived 的行（rewind 软删行不参与）。

import type { PrismaClient } from '../../generated/prisma/client'

// 审计行（id/createdAt 由库生成）。
export interface OverwriteAuditRow {
  /** 锁/journal 域会话（sandbox 所属 parent session） */
  readonly sessionId: string
  /** normalizeFilePath 后相对路径（lab/... | wiki/...，与锁 key 同一约定） */
  readonly path: string
  /** 覆盖者 thread（本 thread） */
  readonly overwriterThreadId: string
  /** 被覆盖者 thread（journal 上家 writer） */
  readonly overwrittenThreadId: string
  /** 触发 run（弱关联，无 FK——审计快照纪律） */
  readonly runId: string
}

// 审计 sink（依赖缝；生产 Prisma 实现，测试收集器）。
export interface OverwriteAuditSink {
  record(row: OverwriteAuditRow): Promise<void>
}

// journal 上家 writer 读取缝（依赖缝；生产 Prisma 实现，测试注内存版）。
export interface JournalWriterReader {
  /** (session, path) 最新 applied 未归档行的 writer thread；无行 / checkpoint 缺失 → null */
  latestAppliedWriterThread(sessionId: string, path: string): Promise<string | null>
}

export function createPrismaOverwriteAuditSink(prisma: PrismaClient): OverwriteAuditSink {
  return {
    async record(row: OverwriteAuditRow): Promise<void> {
      await prisma.fileOverwriteLog.create({
        data: {
          sessionId: row.sessionId,
          path: row.path,
          overwriterThreadId: row.overwriterThreadId,
          overwrittenThreadId: row.overwrittenThreadId,
          runId: row.runId,
        },
      })
    },
  }
}

export function createPrismaJournalWriterReader(prisma: PrismaClient): JournalWriterReader {
  return {
    async latestAppliedWriterThread(sessionId: string, path: string): Promise<string | null> {
      const row = await prisma.fileJournal.findFirst({
        where: { sessionId, path, applied: true, archivedAt: null },
        orderBy: { seq: 'desc' },
        select: { checkpointId: true },
      })
      if (!row) return null
      // checkpointId 全局唯一（LangGraph UUID）；threadId = Session.id（FK），teammate thread
      // 各有 Session 行——跨 thread 写者区分的直接来源。
      const cp = await prisma.checkpoint.findFirst({
        where: { checkpointId: row.checkpointId },
        select: { threadId: true },
      })
      return cp?.threadId ?? null
    },
  }
}

// 覆盖审计器（#785）：detect（锁内、op 前——journal 仍是 pre-write 状态，上家语义）/ record
// （op 成功后——写失败不产生覆盖，不落幻影行）两段式。fail-soft：审计计数不阻断写路径
//（V1 覆盖合法；读写失败均 warn 留痕，D8「静默失败不可接受」）。
export class OverwriteAuditor {
  constructor(
    private readonly reader: JournalWriterReader,
    private readonly sink: OverwriteAuditSink,
  ) {}

  // 锁内 op 前调用：上家 = 最新 applied 未归档行（rewind 软删行不参与），writer ≠ 本 thread
  // → 返回待记录行（含被覆盖者）；无上家 / 上家 = 本 thread（fork 继承形态）/ 无 run 身份
  //（label-only holder——审计行 runId NOT NULL，无 run 归属宁可漏记）/ 读取失败 → null。
  async detect(p: {
    sessionId: string
    path: string
    threadId: string
    runId?: string
  }): Promise<OverwriteAuditRow | null> {
    if (p.runId === undefined || p.runId === '') return null
    try {
      const overwritten = await this.reader.latestAppliedWriterThread(p.sessionId, p.path)
      if (overwritten === null || overwritten === p.threadId) return null
      return {
        sessionId: p.sessionId,
        path: p.path,
        overwriterThreadId: p.threadId,
        overwrittenThreadId: overwritten,
        runId: p.runId,
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[runner] overwrite audit read failed: session=${p.sessionId} path=${p.path} run=${p.runId}: ${(e as Error).message}`,
      )
      return null
    }
  }

  // op 成功后落行（每次写 op 至多一行——上家只取 detect 时点的最新 applied 行）。
  async record(row: OverwriteAuditRow): Promise<void> {
    try {
      await this.sink.record(row)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[runner] overwrite audit write failed: session=${row.sessionId} path=${row.path} run=${row.runId}: ${(e as Error).message}`,
      )
    }
  }
}
