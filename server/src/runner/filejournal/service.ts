// FileJournalService 门面（#782）：装配 fence/writer/gc/reconciler/audit，向 RunService
//（backend 工厂 / ingestion·D9 物化打点）与 SessionService（rewindFiles / preview）单一出口。
// 逆放判定式与执行细节见 replay.ts；崩溃语义见 writer.ts / reconcile.ts。

import type { PrismaClient } from '../../generated/prisma/client'
import type { SandboxFilePrimitives } from '../backend/primitives'
import { ancestorChainOf } from '../../checkpointChain'
import { AtticStore } from './attic'
import { JournalAudit } from './audit'
import { SessionWriteFence } from './fence'
import { AtticGc } from './gc'
import { JournalingBackend, type JournalingBackendParams } from './journalingBackend'
import { buildRewindPreview, type RewindPreview } from './preview'
import { filePreTar } from './preimage'
import { Reconciler, type ReconcileOutcome } from './reconcile'
import { executeRevert, leaseShasOf, parentDirOf, planRevert, type RevertIo, type RevertOutcome } from './replay'
import { JournalWriter } from './writer'

export interface FileJournalServiceDeps {
  readonly prisma: PrismaClient
  readonly primitives: SandboxFilePrimitives
  /** attic per-session 配额（对称 100MB checkpoint 护栏；config 注入） */
  readonly quotaBytes: number
  /** 逆放深度上限（超限降级「对话照回退、文件保持现状」；config 注入） */
  readonly depthLimit: number
  /** 稳态写围栏有界等待（ms；config 注入） */
  readonly fenceTimeoutMs: number
  /** 沙箱容器名解析（researcher-sandbox-<sessionId>；不 ensure——reconcile 启动面禁止批量
   *  起容器，容器缺失 = containerMissing 跳过面） */
  readonly containerOf: (sessionId: string) => Promise<string | null>
  /** 沙箱 ensure 解析（#776 同语义：stopped 复启/惰性创建——rewindFiles 前置；缺省回退
   *  containerOf。生产注入 sandboxes.lifecycle.ensure。） */
  readonly ensureContainerOf?: (sessionId: string) => Promise<string>
  /** checkpoint 父查表（leader threadId = sessionId；chain 判定单一来源——sessions 域同形） */
  readonly checkpointParentOf: (sessionId: string) => Promise<Map<string, string | null>>
}

export interface RewindFilesResult {
  readonly reverted: number
  readonly skippedMissing: number
  /** 深度超限或容器缺失——「文件保持现状」+ UI 明示（对话面照常回退） */
  readonly degraded: boolean
}

export class FileJournalService {
  readonly fence: SessionWriteFence
  private readonly writer: JournalWriter
  private readonly gc: AtticGc
  private readonly reconciler: Reconciler
  private readonly audit: JournalAudit
  private readonly attic: AtticStore

  constructor(private readonly deps: FileJournalServiceDeps) {
    this.fence = new SessionWriteFence()
    this.audit = new JournalAudit(deps.prisma)
    this.writer = new JournalWriter(deps.prisma, deps.primitives, { quotaBytes: deps.quotaBytes }, this.audit)
    this.attic = this.writer.atticStore
    this.gc = new AtticGc(deps.prisma, this.attic)
    this.reconciler = new Reconciler({
      prisma: deps.prisma,
      io: this.revertIo(),
      getBlob: (container, sha) => this.attic.getBlob(container, sha),
      containerOf: deps.containerOf,
    })
  }

  private revertIo(): RevertIo {
    return {
      getBlob: (container, sha256) => this.attic.getBlob(container, sha256),
      putTar: async (container, dir, tar) => {
        const absDir = dir === '' ? '/lab' : `/lab/${dir}`
        await this.deps.primitives.exec(container, ['mkdir', '-p', absDir])
        await this.deps.primitives.putArchive(container, absDir, tar)
      },
      removeFile: async (container, path) => {
        await this.deps.primitives.exec(container, ['sh', '-c', 'rm -rf -- "$1"', 'sh', `/lab/${path}`])
      },
      markReverted: async (sessionId, seqs, at) => {
        await this.deps.prisma.fileJournal.updateMany({
          where: { sessionId, seq: { in: [...seqs] } },
          data: { fileRevertedAt: at },
        })
      },
    }
  }

  // ---- RunService 面 ----

  // backend 工厂（RunService.graphFor 装配点；每会话图实例一份）。
  backendFor(p: Omit<JournalingBackendParams, 'primitives' | 'writer' | 'fence' | 'fenceTimeoutMs'>): JournalingBackend {
    return new JournalingBackend({
      ...p,
      primitives: this.deps.primitives,
      writer: this.writer,
      fence: this.fence,
      fenceTimeoutMs: this.deps.fenceTimeoutMs,
    })
  }

  // runner 物化打点（ingestion / D9 媒体共用）：围栏内 journal-first 写 uploads 新文件。
  async journalMaterialize(p: {
    sessionId: string
    container: string
    /** /lab 相对路径：uploads/<attachmentId>/<fileName> */
    path: string
    bytes: Buffer
    toolCallId: string
    /** 打点所在 run（checkpointId 终态回填键） */
    runId: string
  }): Promise<void> {
    const afterTar = filePreTar(p.path.split('/').pop() ?? 'file', p.bytes)
    const parent = parentDirOf(p.path)
    const dir = parent === '' ? '/lab' : `/lab/${parent}`
    await this.fence.runExclusive(p.sessionId, { holder: 'materialize', timeoutMs: this.deps.fenceTimeoutMs }, async () => {
      await this.writer.write({
        sessionId: p.sessionId,
        container: p.container,
        path: p.path,
        op: 'write',
        readPreImage: async () => null, // 物化恒新文件（ID 子目录结构性防同名碰撞）
        afterBytes: afterTar,
        apply: async () => {
          await this.deps.primitives.exec(p.container, ['mkdir', '-p', dir])
          await this.deps.primitives.putArchive(p.container, dir, afterTar)
        },
        runId: p.runId,
        toolCallId: p.toolCallId,
      })
    })
  }

  // ---- SessionService 面 ----

  // 文件 rewind（scope=all/files 消费；scope=chat 不入——水位推进在对话面事务内）。
  // 前置 restore 路 reconcile（崩溃残留 roll-forward + 续放）→ plan → 逆放 → GC。
  async rewindFiles(p: {
    sessionId: string
    anchor: string
    userId: string
    username: string
  }): Promise<RewindFilesResult> {
    // 前置 ensure（stopped 复启/惰性创建——#776 run 前同语义）；失败 = 容器面降级（degraded
    // 分支处理——「对话照回退、文件保持现状」，ensure 故障不放大为 rewind 失败）
    const resolve = this.deps.ensureContainerOf ?? this.deps.containerOf
    let container: string | null = null
    try {
      container = await resolve(p.sessionId)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[filejournal] sandbox ensure failed: session=${p.sessionId}: ${String(err)}`)
    }
    const session = await this.deps.prisma.session.findUniqueOrThrow({
      where: { id: p.sessionId },
      select: { fileJournalAnchorSeq: true },
    })
    let degraded = false
    let outcome: RevertOutcome = { reverted: 0, skippedMissing: 0 }

    await this.fence.runExclusive(p.sessionId, { holder: 'rewind-replay', timeoutMs: 0 }, async () => {
      // restore 路：journal-first 崩溃残留补 apply + 上次中断的续放（容器缺失 = 跳过）
      if (container !== null) await this.reconciler.reconcileSession(p.sessionId)

      const parentOf = await this.deps.checkpointParentOf(p.sessionId)
      const chain = ancestorChainOf((id) => parentOf.get(id) ?? null, p.anchor)
      const rows = await this.deps.prisma.fileJournal.findMany({ where: { sessionId: p.sessionId } })
      const plan = planRevert(rows, chain, session.fileJournalAnchorSeq, this.deps.depthLimit)
      const now = new Date()

      // tx：保留集补标 + 水位推进（原子——中断续放判定式的前提）
      await this.deps.prisma.$transaction([
        ...(plan.keepMark.length > 0
          ? [
              this.deps.prisma.fileJournal.updateMany({
                where: { sessionId: p.sessionId, seq: { in: plan.keepMark.map((r) => r.seq) }, fileRevertedAt: null },
                data: { fileRevertedAt: now },
              }),
            ]
          : []),
        this.deps.prisma.session.update({
          where: { id: p.sessionId },
          data: { fileJournalAnchorSeq: plan.watermark },
        }),
      ])

      if (container === null) {
        // 沙箱已删的异常态：不逆放（降级——对话照回退、文件保持现状），行处置保持待续放面
        degraded = true
        await this.audit.record({
          kind: 'reconcile', sessionId: p.sessionId, userId: p.userId, username: p.username,
          detail: { anchor: p.anchor, containerMissing: true },
        })
        return
      }

      if (plan.degraded) {
        // 深度超限降级：「对话照回退、文件保持现状」——toRevert 跳过式处置（残集空，续放不再拾起）
        degraded = true
        await this.revertIo().markReverted(p.sessionId, plan.toRevert.map((r) => r.seq), now)
        await this.audit.record({
          kind: 'degraded', sessionId: p.sessionId, userId: p.userId, username: p.username,
          detail: { anchor: p.anchor, skipped: plan.toRevert.length, depthLimit: this.deps.depthLimit },
        })
        return
      }

      // replay lease（防 GC 剪枝 use-after-free）→ 全局序逆放（逐行打标，崩溃续放幂等）
      this.gc.acquireLease(p.sessionId, leaseShasOf(plan.toRevert))
      try {
        outcome = await executeRevert(p.sessionId, container, plan.toRevert, this.revertIo())
      } finally {
        this.gc.releaseLease(p.sessionId)
      }
      const gcOutcome = await this.gc.gc(container, p.sessionId)
      await this.audit.record({
        kind: 'gc',
        sessionId: p.sessionId,
        userId: p.userId,
        username: p.username,
        detail: { anchor: p.anchor, scanned: gcOutcome.scanned, freed: gcOutcome.freed },
      })
      await this.audit.record({
        kind: 'revert_complete', sessionId: p.sessionId, userId: p.userId, username: p.username,
        detail: {
          anchor: p.anchor, reverted: outcome.reverted, missing: outcome.skippedMissing,
          watermark: plan.watermark, keepMarked: plan.keepMark.length,
        },
      })
    })

    return { reverted: outcome.reverted, skippedMissing: outcome.skippedMissing, degraded }
  }

  // ---- 预览（REST preview 端点消费）----

  async preview(p: {
    sessionId: string
    anchor: string
    /** REST 调用者上下文——有则记 exec_crossing 审计（观测面计数；内部调用缺省不记） */
    caller?: { userId: string; username: string }
  }): Promise<RewindPreview> {
    const parentOf = await this.deps.checkpointParentOf(p.sessionId)
    const chain = ancestorChainOf((id) => parentOf.get(id) ?? null, p.anchor)
    const out = await buildRewindPreview(this.deps.prisma, p.sessionId, p.anchor, chain)
    if (p.caller) {
      await this.audit.record({
        kind: 'exec_crossing',
        sessionId: p.sessionId,
        userId: p.caller.userId,
        username: p.caller.username,
        detail: { anchor: p.anchor, revertOps: out.revertOps, execCrossed: out.execCrossed.length },
      })
    }
    return out
  }

  // ---- 启动面 ----

  // 启动 reconcile（server.ts 装配后异步调；容器缺失 session 跳过——restore 路兜底）。
  async reconcileOnBoot(): Promise<Map<string, ReconcileOutcome>> {
    return this.reconciler.reconcileOnBoot()
  }

  // 观测面（测试/健康检查）。
  async atticUsage(container: string): Promise<{ bytes: number; blobs: number }> {
    return this.attic.usage(container)
  }
}
