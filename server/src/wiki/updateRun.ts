// wiki 全量更新独立 run（#790 · #747 G 节 wiki 三通道③「面板更新 wiki」执行体）。
//
// runNativeRepositoryGeneration（openwiki dist/agent/repository-runner.js，deep-import 纪律同
// wikisearch.ts）是「完整边界」本体：durable run 状态（.run.json）、claims finalization、
// planning/generating/finalizing 进度都在其内——runOpenWikiAgent 外壳只加 env 选 provider/
// telemetry。model: BaseChatModel 可注入（接 ProviderRegistry 按容器 owner 的默认模型，保持
// #731 单出口纪律；Runnable→BaseChatModel cast 同 graphFactory.ts 先例）。
//
// 落地副本执行模型（规格回退面——「backend 注入直打容器」在 openwiki 0.6.1 不成立：
// createOpenWikiAgent 无 backend 位，native runner 仅支持本地 git 仓库根）：pull 镜像 →
// 生成跑在副本 → base-hash 复检（与 pull 同一实现同一口径）→ 一致推回 / 冲突弃镜像不推回。
// 每 run 恰一次 putArchive（严格优于逐页 put）。
//
// 全局串行锁（AC4）：openwiki 的 checkpoint SqliteSaver 是进程级单例，V1 以进程内 async
// mutex（SerialRunGate，FIFO 串行）起步，上游 PR 解锁后再放开并发；在飞互斥的 REST 反馈面
// = 30042（start 同步预检）。锁的单测层验收 = SerialRunGate 并发次序化用例。
//
// 可观测边界（验收口径）：wiki_run 五类事件经 hub 扇出即焚不落盘（#726 语义）——控制面崩溃
// 后永无 finished 帧，客户端靠 SSE gap 检测感知断流重拉投影；独立 run V1 无用户主动中断面
//（不加 abort 端点），AC3「中断 = 作废不推回」在本路径以异常/崩溃兑现（failed → 不推回）。
// 崩溃残留的 .run.json durable 态随下次 update 的镜像 pull 重新落地 → openwiki 自动续跑
//（progress resumed 标记）。usage 采数缺口（无 session 行身份）显式留 follow-up。

import { randomUUID } from 'node:crypto'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { OpenWikiRunEvent } from 'openwiki/dist/agent/types.js'
import { runNativeRepositoryGeneration } from 'openwiki/dist/agent/repository-runner.js'
import { fail } from '../envelope'
import { CODE } from '../codes'
import type { ProviderConfigSnapshot } from '../runner/providerRegistry'
import type { ProviderRegistry } from '../runner/providerRegistry'
import type { EventPublisher } from '../runner/runtime/runService'
import type { SandboxFilePrimitives } from '../runner/backend/primitives'
import {
  pullWikiGenerationMirror,
  pushBackWikiGenerationMirror,
  readContainerWikiTree,
  type WikiGenerationMirror,
} from '../runner/wikigen/mirror'
import { buildWikiRunFinished, mapOpenWikiRunEvent } from './updateEvents'
import type { WikiRunOutcome } from '../runner/wikigen/values'
import type { CatalogEvent } from '../events/logic'

// ---------------------------------------------------------------------------
// 全局串行锁（进程内 async mutex，FIFO）——openwiki SqliteSaver 进程级单例的并发防护起步面。
// 纯逻辑单测锁定：并发 N 严格串行次序化、异常后锁释放可再入（wikigenLifecycleTools.test.ts）。
// ---------------------------------------------------------------------------
export class SerialRunGate {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    // 前序失败不阻断后继（错误向上传播给各自调用方）；链尾吞错保持 FIFO 可推进。
    const next = this.tail.then(task, task)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface WikiUpdateStartParams {
  readonly ownerId: string
  readonly wikiContainer: string
}

export interface WikiUpdateRunDeps {
  readonly registry: ProviderRegistry
  readonly primitives: SandboxFilePrimitives
  /** 事件扇出（StreamHub 结构子集；wiki_run.* 五类事件经此发布该 user 全部连接） */
  readonly hub: EventPublisher
}

export class WikiUpdateRunService {
  private readonly gate = new SerialRunGate()
  /** 在飞 runId（start 同步置位/终态清理——REST 30042 即时反馈的观测面；含排队窗口） */
  private inFlightRunId: string | null = null

  constructor(private readonly deps: WikiUpdateRunDeps) {}

  /** 在飞观测面（测试/健康检查） */
  get activeRunId(): string | null {
    return this.inFlightRunId
  }

  // POST 即返面：在飞检查先于入队（30042），返回 runId 后执行体在后台推进。同步置位 +
  // gate 串行双保险（锁是并发正确性机制，30042 是用户反馈面）。
  start(params: WikiUpdateStartParams): { runId: string } {
    if (this.inFlightRunId !== null) throw fail(CODE.WIKI_UPDATE_IN_PROGRESS)
    const runId = randomUUID()
    this.inFlightRunId = runId
    void this.gate
      .run(() => this.executeUpdate(runId, params))
      .finally(() => {
        if (this.inFlightRunId === runId) this.inFlightRunId = null
      })
    return { runId }
  }

  private async executeUpdate(runId: string, params: WikiUpdateStartParams): Promise<void> {
    const { ownerId, wikiContainer } = params
    let mirror: WikiGenerationMirror | undefined
    let outcome: WikiRunOutcome = 'failed'
    try {
      // 落地副本：容器整树 → <tmp>/wiki-gen-*/openwiki/**（含 git init；baseline hash 同源）
      mirror = await pullWikiGenerationMirror(this.deps.primitives, wikiContainer)
      const snapshot = await this.deps.registry.getSnapshot(ownerId)
      const model = await this.deps.registry.getDefaultModel(snapshot)
      const onEvent = (ev: OpenWikiRunEvent): void => {
        for (const e of mapOpenWikiRunEvent(ev, runId)) this.deps.hub.publish(ownerId, e)
      }
      // 完整边界（durable run 状态 + claims finalization 在其内）；生成跑在控制面本地副本
      await runNativeRepositoryGeneration({
        root: mirror.root,
        mode: 'update',
        modelId: wikiUpdateModelId(snapshot),
        model: model as unknown as BaseChatModel,
        onEvent,
      })
      // base-hash 复检（与 pull 同一实现同一口径——口径漂移 = 永假冲突，测试锁定）：
      // 容器树在 run 期间被轻写通道/他人改动 → 冲突弃镜像，不静默覆盖
      const current = await readContainerWikiTree(this.deps.primitives, wikiContainer)
      if (current === null || current.hash !== mirror.baselineHash) {
        outcome = 'conflict'
      } else {
        await pushBackWikiGenerationMirror(this.deps.primitives, wikiContainer, mirror.root)
        outcome = 'completed'
      }
    } catch (e) {
      // 异常/中断 = 作废不推回（AC3 在独立 run 路径的兑现面）；告警留痕（失败细节只在
      // 服务端日志——wiki_run.finished 只带 outcome 三值，不泄漏内部错误面）。
      // eslint-disable-next-line no-console
      console.warn(`[wiki-update] run failed: runId=${runId}: ${e instanceof Error ? e.message : String(e)}`)
      outcome = 'failed'
    } finally {
      await mirror?.dispose()
      // finished 终帧单点发布（成功/冲突/失败三值；事件即焚不落盘）
      this.deps.hub.publish(ownerId, buildWikiRunFinished(runId, outcome))
    }
  }
}

function wikiUpdateModelId(snapshot: ProviderConfigSnapshot): string {
  return snapshot.providers[0]?.models[0]?.id ?? 'default'
}

export type { CatalogEvent }
