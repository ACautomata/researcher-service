// roll-forward reconcile（#782 · #766 D8「启动/restore 双路」）：
//   启动路（sessionsNeedingReconcile + 调用方 FileJournalService.reconcileOnBoot）：进程重启
//   后全表扫 applied=false 行 + 水位 session 续放残集——沙箱容器不存在的 session 跳过（启动
//   期不批量 ensure 容器；该 session 的 rewind/run 前置 restore 路兜底），计数上行（静默
//   跳过不可接受——审计面）。
//   restore 路（reconcileSession）：rewind 逆放前对目标 session 调用（容器 ensure 由调用方
//   决定——sessions 域 rewind 面容器恒在或惰性创建语义同 #776 run 前 ensure）。
//
// roll-forward：applied=false 行按 seq 升序重放 apply（journal-first 管线的②③崩溃残留）——
//   write/edit：afterSha blob 覆盖写（失联 → 行按「文件现状即真相」置位 + missing 计数）
//   delete：幂等 rm
// 续放（崩溃的 rewind 逆放）：session.fileJournalAnchorSeq 非 null → 残集 = seq > 水位 ∧
//   fileRevertedAt=null → executeRevert（判定式见 replay.ts——keepMark 已在 rewind 事务内
//   打标，残集恒为 toRevert 真子集，逆放幂等）。

import type { PrismaClient } from '../../generated/prisma/client'
import { executeRevert, parentDirOf, type RevertIo } from './replay'

export interface ReconcileOutcome {
  readonly rolledForward: number
  readonly rolledMissing: number
  readonly resumedReverted: number
  readonly resumedMissing: number
  readonly containerMissing: boolean
}

export interface ReconcilerDeps {
  readonly prisma: PrismaClient
  readonly io: RevertIo
  readonly containerOf: (sessionId: string) => Promise<string | null>
}

export class Reconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  // 单 session reconcile（restore 路；容器缺失返回 containerMissing 标志）。chain = 本次
  // rewind 锚链（rewindFilesCore 传入——续放过滤与 planRevert 同形）；boot 路传
  // activeCheckpointId 指针重建链（boot 串行遍历期间新 run 可完成落账——不过滤则锚链内
  // 新写被误撤）；null = 不滤（指针缺失的罕见组合，保守现状面）。
  async reconcileSession(sessionId: string, chain: ReadonlySet<string> | null = null): Promise<ReconcileOutcome> {
    const container = await this.deps.containerOf(sessionId)
    if (container === null) {
      return { rolledForward: 0, rolledMissing: 0, resumedReverted: 0, resumedMissing: 0, containerMissing: true }
    }
    const rolled = await this.rollForward(sessionId, container)
    const resumed = await this.resumeRevert(sessionId, container, chain)
    return { ...rolled, ...resumed, containerMissing: false }
  }

  // 启动路待处理清单：全表 applied=false 按 session 分组 + 水位 session 续放。执行互斥与
  // blob 防剪由调用方装配（FileJournalService.reconcileOnBoot——围栏 + replay lease；容器
  // 缺失 session 在 reconcileSession 跳过并计数）。
  async sessionsNeedingReconcile(): Promise<string[]> {
    const sessions = await this.deps.prisma.session.findMany({
      where: {
        OR: [{ fileJournalAnchorSeq: { not: null } }, { fileJournal: { some: { applied: false } } }],
      },
      select: { id: true },
    })
    return sessions.map((s) => s.id)
  }

  private async rollForward(sessionId: string, container: string): Promise<{ rolledForward: number; rolledMissing: number }> {
    const pending = await this.deps.prisma.fileJournal.findMany({
      where: { sessionId, applied: false },
      orderBy: { seq: 'asc' },
    })
    let rolledForward = 0
    let rolledMissing = 0
    for (const row of pending) {
      let ok = true
      if (row.op === 'delete') {
        await this.deps.io.removeFile(container, row.path)
      } else if (row.afterSha256 !== null) {
        const tar = await this.deps.io.getBlob(container, row.afterSha256)
        if (tar === null) {
          ok = false // blob 失联：文件现状即真相（重放无法复现——审计面计数）
          rolledMissing += 1
        } else {
          await this.deps.io.putTar(container, parentDirOf(row.path), tar)
        }
      } else {
        ok = false // write/edit 无 afterSha = 行损坏（防御面）
        rolledMissing += 1
      }
      await this.deps.prisma.fileJournal.updateMany({
        where: { sessionId, seq: row.seq },
        data: { applied: true },
      })
      if (ok) rolledForward += 1
    }
    return { rolledForward, rolledMissing }
  }

  // 续放：残集 = seq>水位 ∧ 未打标（上次 rewind 决策 toRevert 的执行中断残留——或容器缺失
  // 降级面）。chain 过滤（与 planRevert 同形）：∈ chain 的行是锚链保留段/新写，不可分面用
  // chain 判别——交回 planRevert 判定（keepMark/水位语义），∉ chain 才续放；否则后续 rewind
  // 的 restore 路会把 (tN, tN+1] 段合法新写一并撤销。
  private async resumeRevert(
    sessionId: string,
    container: string,
    chain: ReadonlySet<string> | null,
  ): Promise<{ resumedReverted: number; resumedMissing: number }> {
    const session = await this.deps.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { fileJournalAnchorSeq: true },
    })
    if (session.fileJournalAnchorSeq === null) {
      return { resumedReverted: 0, resumedMissing: 0 }
    }
    const residual = (await this.deps.prisma.fileJournal.findMany({
      where: { sessionId, seq: { gt: session.fileJournalAnchorSeq }, fileRevertedAt: null },
      orderBy: { seq: 'desc' },
    })).filter((r) => chain === null || !chain.has(r.checkpointId))
    if (residual.length === 0) return { resumedReverted: 0, resumedMissing: 0 }
    const outcome = await executeRevert(sessionId, container, residual, this.deps.io)
    return { resumedReverted: outcome.reverted, resumedMissing: outcome.skippedMissing }
  }
}
