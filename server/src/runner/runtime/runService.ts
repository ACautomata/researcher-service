// RunService —— 集中式 runner 内核（#777 · #747 A 节「runner 编排」）。
//
// 职责（BullMQ 传输面之外的全部 run 机制）：
//   ① 同 thread 严格串行：进程内 per-thread promise 链（#723 风险条目「BullMQ per-thread
//      串行是全部责任」——BullMQ OSS 无 per-group 限流，worker 可并发领同 thread job，
//      顺序性在本层保证；串行链同时是 resume 互斥的原语：同 thread 命令天然全序）。
//   ② run 状态机：queued → running ⇄ interrupted → completed|failed|aborted（#747 C 节；
//      suspended 归 #783 审批）。观测面 stateOf 供 #778 门禁消费。
//   ③ 图实例缓存：key = (threadId, configVersion, interruptPolicy, backend 双根)——拓扑因子
//      全在键内，「图拓扑可由持久化状态推导」的缓存面表达；版本/policy/沙箱重建自然重建。
//   ④ 事件发射：run.started → 投影事件（RunProjector）→ 终态三分类，全部经 hub.publish
//      扇出该 user 全部连接（多端广播语义 #726）。
//   ⑤ 错误三分类（story 10）与 abort（story 8，by:user/system）。
//   ⑥ resume 互斥权威判定：executeRun 开头 state 必须为 interrupted（先到者已把它置为
//      running/终态，后到者 50001）。
//   ⑦ tracing 显式关闭（构造期兜底 + 装配层调用，见 tracing.ts）。
//   ⑧ usage 采数接线（#775 createUsageCallbackHandler；默认链主身份记账——V1 局限：
//      fallback 链切换后的 per-call 身份不追踪，采数不 fail run）。
//   ⑨ 沙箱执行前提（#776 契约「消费方 = #777 runner ensure/touch」）：run 前 ensure
//      （闲置自动 stop 后 re-ensure，文件保留语义）/ 事件流 touch（真 activity 源，
//      长 run 中途不被闲置 sweep）。
//
// 硬约束（PoC 坑 2）：streamEvents 的 version+configurable+recursionLimit+signal 必须同一
// 参数对象（buildStreamEventsInvocation 产出基座，就地展开合并字段）。
// 副作用纪律：interrupt 前 backend 工具未执行（探针实测 exec=0），resume 后恰执行一次
// （S4 快照锁定）——「interrupt 前副作用幂等或后置」。
//
// 信封错误面：额度 40043 / 会话不存在 50002 / resume 竞态败方 50001 以 EnvelopeError 抛出
// ——Inline 路径直接到达调用方（REST/#778 转信封）；BullMQ 路径表现为 job failed，
// run 域事件不受影响（未开始执行的 run 不发事件）。

import { randomUUID } from 'node:crypto'
import { HumanMessage } from '@langchain/core/messages'
import { Command } from '@langchain/langgraph'
import { INTERRUPT } from '@langchain/langgraph-checkpoint'
import type { PrismaClient } from '../../generated/prisma/client'
import { CODE } from '../../codes'
import { fail } from '../../envelope'
import { getSessionForUser } from '../../sandboxes/service'
import type { CatalogEvent } from '../../events/logic'
import type { StreamHub } from '../../events/hub'
import type { SandboxFilePrimitives } from '../backend/primitives'
import { DockerArchiveBackend } from '../backend/dockerArchiveBackend'
import type { PrismaCheckpointSaver } from '../persistence/prismaCheckpointSaver'
import type { ProviderRegistry, ProviderConfigSnapshot } from '../providerRegistry'
import type { ConcurrencyGate } from '../concurrency'
import { createUsageCallbackHandler } from '../usage'
import { buildStreamEventsInvocation } from '../../events/bridge'
import { RunProjector } from './projector'
import { classifyRunError, type RunErrorKind } from './errorKind'
import { buildLeaderAgent, interruptPolicyKey, type DeepAgentLike, type InterruptPolicy, type LeaderAgentParams } from './graphFactory'
import { DEFAULT_RECURSION_LIMIT, DEFAULT_RESUME_DECISIONS, GRAPH_CACHE_MAX_INSTANCES, LEADER_SYSTEM_PROMPT } from './values'
import { disableLangsmithTracing } from './tracing'
import { TurnReducer, type RecordTurnPayload } from '../../sessions/reducer'

// recordTurn 注入缝（#778）：run 终态（completed/interrupted/aborted/failed 任一）的单 turn
// 聚合落库回调。anchorCheckpointId = 终态 checkpoint 锚点（issue 点名列；aborted/failed 路径
// 无可靠 state → null）。生产实现 = SessionService.recordTurn（落 session_messages + 自动标题）；
// 测试注收集器。setter 注入原因：SessionService 依赖本 service 实例（门禁/命令面），构造顺序
// 晚于 RunService——constructor 注入会成环。载荷 RecordTurnPayload 单一声明于 sessions/reducer。
export type RecordTurnFn = (p: RecordTurnPayload) => Promise<void>

// run 命令（BullMQ job data 契约：纯 JSON 可序列化，无内存句柄——进程内状态全弃后凭 DB
// 重投可从头重跑，副作用幂等约束在案；重投/断线补偿面归 #779）。
export interface RunCommand {
  readonly runId: string
  readonly sessionId: string
  readonly ownerId: string
  readonly username: string
  readonly kind: 'message' | 'resume'
  /** kind=message：用户消息文本 */
  readonly content?: string
  /** kind=resume：HITL 决策（{decisions:[...]} 形态，PoC 实测） */
  readonly decisions?: unknown
}

export type RunState = 'queued' | 'running' | 'interrupted' | 'completed' | 'failed' | 'aborted'

export interface RunSnapshot {
  readonly runId: string
  readonly state: RunState
  readonly errorKind?: RunErrorKind
  readonly by?: 'user' | 'system'
}

// stream.hub 的结构子集——runner 只需要 publish，不感知连接管理。
export type EventPublisher = Pick<StreamHub, 'publish'>

export interface RunServiceDeps {
  readonly prisma: PrismaClient
  readonly registry: ProviderRegistry
  readonly saver: PrismaCheckpointSaver
  readonly gate: ConcurrencyGate
  readonly hub: EventPublisher
  /** runner backend 的 Docker 原语（S2 接缝；生产 dockerode 适配，测试 fake） */
  readonly primitives: SandboxFilePrimitives
  /** wiki 容器名解析（#784 双容器 orchestrator 接管前由装配层给定；V1 生产为占位实现） */
  readonly resolveWikiContainer: (ownerId: string) => string
  /** 沙箱生命周期（#776；SandboxLifecycle 结构子集）。缺省回退 session.containerId（测试）。 */
  readonly sandboxes?: {
    ensure: (sessionId: string) => Promise<{ containerId: string }>
    touch: (sessionId: string) => void
  }
  /** interrupt 策略源（拓扑因子；V1 无审批恒 undefined，#783 由持久化维度派生——测试注入） */
  readonly interruptPolicyFor?: (sessionId: string) => InterruptPolicy | undefined
  readonly recursionLimit?: number
  /** 毫秒时钟（durationMs 计时；缺省 Date.now，测试注入步进时钟） */
  readonly clock?: () => number
}

// getState 快照的结构子集（PoC 实测：agent.graph.getState）。
interface GraphStateLike {
  next?: string[]
  tasks?: { interrupts?: unknown[] }[]
  // LangGraph StateSnapshot.config.configurable.checkpoint_id——终态 checkpoint 锚点
  //（#778 session_messages.anchorCheckpointId 落值来源；issue 正文点名该列）。
  config?: { configurable?: { checkpoint_id?: string } }
}

// LangGraph interrupt 的 putWrites channel：上游一等导出 INTERRUPT（checkpoint 包
// WRITES_IDX_MAP 的负 idx 通道键，prismaCheckpointSaver「不自造」同纪律）——三包升级
// 通道名漂移时此处类型红，推导面不会静默失效。
const INTERRUPT_CHANNEL = INTERRUPT

export class RunService {
  private readonly graphs = new Map<string, DeepAgentLike>()
  private readonly runs = new Map<string, RunSnapshot>()
  private readonly aborts = new Map<string, { controller: AbortController; by: 'user' | 'system' }>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly recursionLimit: number
  private readonly clock: () => number
  private recordTurn: RecordTurnFn | undefined

  constructor(private readonly deps: RunServiceDeps) {
    this.recursionLimit = deps.recursionLimit ?? DEFAULT_RECURSION_LIMIT
    this.clock = deps.clock ?? (() => Date.now())
    // 构造期兜底：任何 runner 实例化路径都覆盖 env 误开（装配层亦显式调用，双保险）
    disableLangsmithTracing()
  }

  // 装配期注入 session_messages 落库缝（见 RecordTurnFn 注；幂等——重复注入覆盖前者）。
  setRecordTurn(fn: RecordTurnFn | undefined): void {
    this.recordTurn = fn
  }

  // ---- 命令构造（REST/传输面用；runId 单点生成）----

  buildCommand(params: {
    sessionId: string
    ownerId: string
    username: string
    kind: 'message' | 'resume'
    content?: string
    decisions?: unknown
  }): RunCommand {
    return { runId: randomUUID(), ...params }
  }

  // ---- 发消息入口（story 7 的 runner 侧；幂等 key/落 session_messages 归 #778）----
  // 归属判定复用 #776 getSessionForUser（admin 全放行 / user 仅本人；「不存在 vs 越权」
  // 同码 50002 防探测，区分仅进服务端日志——#312⑤；#778 会话域落地后随 sessions 域收编）。
  // 额度即时反馈面归 #778 REST（读 gate.inFlight），权威判定在 executeNow 的 gate.acquire
  //（满 → 40043）。
  async buildMessageCommand(params: {
    sessionId: string
    ownerId: string
    username: string
    content: string
  }): Promise<RunCommand> {
    const caller = await this.deps.prisma.user.findUnique({
      where: { id: params.ownerId },
      select: { role: true },
    })
    if (!caller) {
      // eslint-disable-next-line no-console
      console.warn(`[runner] message caller not_found: id=${params.ownerId} session=${params.sessionId}`)
      throw fail(CODE.SESSION_NOT_FOUND)
    }
    await getSessionForUser(this.deps.prisma, { id: params.ownerId, role: caller.role }, params.sessionId)
    return this.buildCommand({ ...params, kind: 'message' })
  }

  // ---- resume 命令构造：interrupted 态预检（权威互斥判定在 executeRun）----
  // 预检只拒内存面权威可知的失败（state 已被先到者推离 interrupted）。内存缺失（控制面
  // 重启/跨进程 resume）不在此误报 50001——放行至 executeRun，由 checkpoint 推导
  //（threadInterruptedFromCheckpoint）权威判定；S4 A2「断线」场景的入口面。
  buildResumeCommand(params: {
    sessionId: string
    ownerId: string
    username: string
    decisions?: unknown
  }): RunCommand {
    const snap = this.runs.get(params.sessionId)
    if (snap && snap.state !== 'interrupted') throw fail(CODE.RUN_ALREADY_RESUMED)
    return this.buildCommand({
      sessionId: params.sessionId,
      ownerId: params.ownerId,
      username: params.username,
      kind: 'resume',
      decisions: params.decisions ?? DEFAULT_RESUME_DECISIONS,
    })
  }

  // ---- 中断（story 8；REST 面归 #778）----
  // 仅对 running 在飞 run 有效（aborts 条目随 executeRun finally 清除——interrupted/终态
  // run 返 false）。interrupted run 的「不审批直接终止」面归 #783 审批漏斗/#778——既有
  // 出路 = reject 决策 resume（50003 文案同源）。
  abort(runId: string, by: 'user' | 'system' = 'user'): boolean {
    const a = this.aborts.get(runId)
    if (!a) return false
    a.by = by
    a.controller.abort()
    return true
  }

  // ---- 状态观测面（#778 门禁/回放消费）----
  stateOf(sessionId: string): RunSnapshot | undefined {
    return this.runs.get(sessionId)
  }

  // 额度满预检（#778 REST 即时反馈；#777 注释契约「额度即时反馈面归 #778」）——只读不占额，
  // 权威判定仍在 executeNow 的 gate.acquire。
  quotaFull(ownerId: string): Promise<boolean> {
    return this.deps.gate.wouldReject(ownerId)
  }

  // ---- 执行（传输面调用点：Inline 直调 / BullMQ worker processor）----
  // 同 thread 串行链：任意时刻同 thread 至多一个 executeRun 在跑，其余按提交序排队。
  // executeNow 的信封错误（40043/50002）向上传播；run 执行体错误在 executeRun 内消化
  //（终态事件已发，对传输面表现为正常完成）。
  async execute(cmd: RunCommand): Promise<void> {
    // 入队面 fast-fail：interrupted 态 message 拒绝（queued 覆盖之前——#747 C 节「interrupt
    // 全端可审批」，见 executeRun 权威面）。内存面可知即不排队，调用方即时感知。
    if (cmd.kind === 'message' && this.runs.get(cmd.sessionId)?.state === 'interrupted') {
      throw fail(CODE.RUN_INTERRUPT_PENDING)
    }
    // queued 只标 message 命令的新 run，且仅在无活跃条目时落——running/queued 不被新排队
    // 命令覆盖（stateOf 是 #778「running 全端禁输入」门禁的观测面，覆盖即门禁失效）；
    // resume 延续既有 run（interrupted 保持到 running，否则 executeRun 的互斥权威判定会被
    // 覆盖态误伤）。interrupted 态已在上方 fast-fail 拒绝，不会走到覆盖。
    if (cmd.kind === 'message') {
      const prev = this.runs.get(cmd.sessionId)
      const active = prev !== undefined && (prev.state === 'running' || prev.state === 'queued' || prev.state === 'interrupted')
      if (!active) this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'queued' })
    }
    const prev = this.chains.get(cmd.sessionId) ?? Promise.resolve()
    const task = prev.then(
      () => this.executeNow(cmd),
      () => this.executeNow(cmd),
    )
    const tail = task.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(cmd.sessionId, tail)
    void tail.then(() => {
      if (this.chains.get(cmd.sessionId) === tail) this.chains.delete(cmd.sessionId)
    })
    return task
  }

  private publish(ownerId: string, ev: Omit<CatalogEvent, 'sessionId' | 'runId'>, cmd: RunCommand): void {
    this.deps.hub.publish(ownerId, { ...ev, sessionId: cmd.sessionId, runId: cmd.runId })
  }

  private async executeNow(cmd: RunCommand): Promise<void> {
    let lease: Awaited<ReturnType<ConcurrencyGate['acquire']>> | undefined
    try {
      lease = await this.deps.gate.acquire(cmd.ownerId) // 满 → 40043（权威判定）
      await this.executeRun(cmd)
    } catch (e) {
      // pre-start 失败回滚 queued 占位（40043/50003 等——「未开始执行的 run 不发事件」
      // 同纪律：不留观测态）。回滚只认本命令的 queued 条目（runId 匹配），不碰后继命令的。
      const snap = this.runs.get(cmd.sessionId)
      if (snap?.state === 'queued' && snap.runId === cmd.runId) this.runs.delete(cmd.sessionId)
      throw e
    } finally {
      lease?.release()
    }
  }

  private async executeRun(cmd: RunCommand): Promise<void> {
    // resume 互斥权威判定：先到者已把 state 推离 interrupted（串行链保证本检查原子于
    // 同 thread 的其它命令），后到者 50001。message 命令不做此检查（queued 态可覆盖）。
    // 内存态缺失（控制面重启/跨进程 resume）→ 从持久化状态推导（#747 A 节硬约束：
    // 「图拓扑必须可由持久化状态推导」——最新 checkpoint 带 pending interrupt ⇔ interrupted）。
    if (cmd.kind === 'resume') {
      let snap = this.runs.get(cmd.sessionId)
      if (!snap) {
        const interrupted = await this.threadInterruptedFromCheckpoint(cmd.sessionId)
        if (interrupted) {
          snap = { runId: cmd.runId, state: 'interrupted' }
          this.runs.set(cmd.sessionId, snap)
        }
      }
      if (!snap || snap.state !== 'interrupted') throw fail(CODE.RUN_ALREADY_RESUMED)
    } else {
      // #747 C 节「running 全端禁输入、interrupt 全端可审批」的内核权威面：interrupted 态
      // message 会作废 pending interrupt（静默丢审批）——拒绝之（#778 REST 门禁之外的第二
      // 道，接线遗漏不丢 interrupt）。queued/内存缺失态（排队窗口撞上前序 run 中断、重启后
      // 首条消息）走 checkpoint 推导同挡——每条消息一次 getTuple，SQLite 本地读，人机尺度可忽略。
      const snap = this.runs.get(cmd.sessionId)
      const threadInterrupted =
        snap?.state === 'interrupted' ||
        ((snap === undefined || snap.state === 'queued') &&
          (await this.threadInterruptedFromCheckpoint(cmd.sessionId)))
      if (threadInterrupted) throw fail(CODE.RUN_INTERRUPT_PENDING)
    }

    const session = await this.deps.prisma.session.findUnique({ where: { id: cmd.sessionId } })
    if (!session) throw fail(CODE.SESSION_NOT_FOUND)

    // 沙箱执行前提（#776 契约「消费方 = #777 runner ensure/touch」）：闲置自动 stop 后
    // re-ensure（stopped → start，文件保留），返回容器即 /lab/ 工具根（可能 ≠
    // session.containerId 陈旧值）。失败按 pre-start 面向上传播（job failed / Inline 调用方；
    // 未开始执行的 run 不发 run 域事件——文件头信封错误面，registry 故障同先例）。
    const sandbox = this.deps.sandboxes ? await this.deps.sandboxes.ensure(cmd.sessionId) : undefined
    const labContainer = sandbox?.containerId ?? session.containerId

    const snapshot = await this.deps.registry.getSnapshot(cmd.ownerId)
    const model = await this.deps.registry.getDefaultModel(snapshot)
    const policy = this.deps.interruptPolicyFor?.(cmd.sessionId)
    const agent = this.getOrBuildGraph(cmd.sessionId, snapshot.version, policy, model, cmd.ownerId, labContainer)

    this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'running' })
    // 新 run = run.started；interrupted 后的续跑 = run.resumed（#747 C 节目录二者并列——
    // resume 不重发 started，消费方按事件类型区分首轮/续跑轮）
    this.publish(
      cmd.ownerId,
      { type: cmd.kind === 'resume' ? 'run.resumed' : 'run.started', payload: {} },
      cmd,
    )

    // usage 身份：默认链主 provider（snapshot.providers[0] 首模型）。fallback 链切换后的
    // per-call 身份不追踪（#775 usage.ts 声明的 #777 接线局限；采数不 fail run）。
    const identity = snapshot.providers[0]
    const usageHandler = createUsageCallbackHandler(
      {
        prisma: this.deps.prisma,
        userId: cmd.ownerId,
        username: cmd.username,
        runId: cmd.runId,
        sessionId: cmd.sessionId,
      },
      {
        providerId: identity?.providerId ?? '',
        lcProvider: identity?.lcProvider ?? '',
        model: String(identity?.models[0]?.id ?? ''),
      },
    )

    const controller = new AbortController()
    const abortEntry = { controller, by: 'user' as 'user' | 'system' }
    this.aborts.set(cmd.runId, abortEntry)

    const projector = new RunProjector()
    // 单 turn 聚合（#778 回放零差异的实时面）：与 publish 同源同序消费投影事件——归约快照即
    // SSE 事件流终态（前端 #730 消费同一目录）。
    const turn = new TurnReducer()
    const invocation = buildStreamEventsInvocation(cmd.sessionId)
    const input =
      cmd.kind === 'message'
        ? { messages: [new HumanMessage(cmd.content ?? '')] }
        : new Command({ resume: cmd.decisions ?? DEFAULT_RESUME_DECISIONS })

    // 终态 checkpoint 锚点（#778 anchorCheckpointId）：成功路径从终态 state 取；
    // aborted/failed 路径无可靠 state → null（回放面锚点缺位不阻断落行）。
    let anchorCheckpointId: string | null = null
    try {
      const stream = await agent.streamEvents(input, {
        ...invocation,
        recursionLimit: this.recursionLimit,
        signal: controller.signal,
        callbacks: [usageHandler],
      })
      for await (const raw of stream) {
        // 工具/推理活动刷新沙箱闲置计时（#776 真 activity 源——长 run 中途不被 sweep stop）
        this.deps.sandboxes?.touch(cmd.sessionId)
        for (const ev of projector.feed(raw, this.clock())) {
          turn.feed(ev)
          this.publish(cmd.ownerId, ev, cmd)
        }
      }
      // 流正常结束：判定停在 interrupt（PoC 形态：next 非空或 tasks 带 interrupts）
      const state = await this.graphState(agent, cmd.sessionId)
      anchorCheckpointId = state.config?.configurable?.checkpoint_id ?? null
      const interrupted =
        (state.next?.length ?? 0) > 0 || (state.tasks?.some((t) => (t.interrupts?.length ?? 0) > 0) ?? false)
      if (interrupted) {
        this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'interrupted' })
        // interrupted 不发终态事件（#777 契约「interrupted 态无终态事件」，S4 锁；恢复面 =
        // run.resumed 起新轮）
      } else {
        this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'completed' })
        this.publish(cmd.ownerId, { type: 'run.completed', payload: {} }, cmd)
      }
    } catch (e) {
      // 用户中断唯一权威判据 = signal.aborted（provider 自身 timeout AbortError 不误判——
      // 那是 llm_error，见 errorKind.ts 头注）
      if (controller.signal.aborted) {
        this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'aborted', by: abortEntry.by })
        this.publish(cmd.ownerId, { type: 'run.aborted', payload: { by: abortEntry.by } }, cmd)
      } else {
        const kind = classifyRunError(e)
        this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'failed', errorKind: kind })
        this.publish(cmd.ownerId, { type: 'run.failed', payload: { errorKind: kind } }, cmd)
      }
    } finally {
      this.aborts.delete(cmd.runId)
      // 终态聚合落 session_messages（#778；interrupted/aborted/failed 也落——刷新回放须含
      // 已流出的部分，story 3「零差异」）。空聚合不落（failed 立即等场景无用户可见内容）。
      // 落库失败不放大为 run 故障（终态事件已发）：告警留痕，#779 补偿面兜底。
      if (this.recordTurn && !turn.isEmpty()) {
        try {
          await this.recordTurn({
            sessionId: cmd.sessionId,
            runId: cmd.runId,
            anchorCheckpointId,
            aggregate: turn.snapshot(),
          })
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[runner] recordTurn failed: session=${cmd.sessionId} run=${cmd.runId}: ${(err as Error).message}`)
        }
      }
    }
  }

  // ---- 图实例缓存（拓扑因子全在键内：thread | configVersion | policy | backend 双根）----
  private getOrBuildGraph(
    threadId: string,
    configVersion: number,
    policy: InterruptPolicy | undefined,
    model: LeaderAgentParams['model'],
    ownerId: string,
    labContainer: string,
  ): DeepAgentLike {
    // 双根入键：docker 实例变更（沙箱 remove/recreate、#784 wiki 容器接管后改名）时缓存图
    // 持旧 backend 会指向已删容器——backend 双根都是拓扑因子。
    const wikiContainer = this.deps.resolveWikiContainer(ownerId)
    const key = `${threadId}|${configVersion}|${interruptPolicyKey(policy)}|${labContainer}|${wikiContainer}`
    const cached = this.graphs.get(key)
    if (cached) return cached
    const backend = new DockerArchiveBackend(this.deps.primitives, {
      wiki: wikiContainer,
      lab: labContainer,
    })
    const agent = buildLeaderAgent({
      model,
      backend,
      checkpointer: this.deps.saver,
      systemPrompt: LEADER_SYSTEM_PROMPT,
      interruptPolicy: policy,
    })
    // 图实例数护栏（正确性由键保证，此处防长期运行退化；超限整表清——重建成本 =
    // 一次 createDeepAgent 编译，进行中 run 持既有实例引用不受影响）。
    if (this.graphs.size >= GRAPH_CACHE_MAX_INSTANCES) this.graphs.clear()
    this.graphs.set(key, agent)
    return agent
  }

  private async graphState(agent: DeepAgentLike, threadId: string): Promise<GraphStateLike> {
    return (await agent.getState({ configurable: { thread_id: threadId } })) as GraphStateLike
  }

  // 从持久化状态推导「thread 停在 interrupt」（#747 A 节硬约束的内存缺失 fallback 面）：
  // 最新 checkpoint 的 pendingWrites 带 __interrupt__ channel（LangGraph interrupt 的标准
  // putWrites 通道，WRITES_IDX_MAP 负 idx）。blob 反序列化不做——pendingWrites 面足够。
  private async threadInterruptedFromCheckpoint(threadId: string): Promise<boolean> {
    let tuple: Awaited<ReturnType<PrismaCheckpointSaver['getTuple']>> | undefined
    try {
      tuple = await this.deps.saver.getTuple({ configurable: { thread_id: threadId } })
    } catch {
      return false // checkpoint 读取故障按「无 interrupt」处理——resume 判定 50001，不放大
    }
    return (tuple?.pendingWrites ?? []).some(([, channel]) => channel === INTERRUPT_CHANNEL)
  }
}

// 快照类型的导出面（#778 消费；避免消费方反向 import 内部形状）
export type { ProviderConfigSnapshot }
