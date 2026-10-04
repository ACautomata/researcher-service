import { parseSlash } from '../officialContent/catalog'
import type { ModelRef } from '../runner/providerRegistry'
import { snapshotOfficialContent } from '../officialContent/runtime'
// 会话域业务服务（#778 · #747 C 节会话 REST 全件）：扁平挂用户（容器维度退役）、创建/列表/
// 改标题（story 5 自动生成+可改）、发消息（story 7 32-hex 幂等）、abort（story 8 by:user）、
// resume、历史投影 GET、删会话级联删沙箱（#776 契约「消费方 = #778」）。
//
// 多端门禁（story 13 · #747 C 节）：running 全端禁输入（50005）/ interrupted 全端须先审批
//（50003，内核防御面在 RunService，此处 REST 前置即时反馈）/ resume 先到先得（50001，
// buildResumeCommand 预检 + executeRun 权威面双层）。事件扇出经 StreamHub 单例 → 该 user
// 全部连接同帧（多端广播一致由 hub.fanOut 保证，eventsHub.test.ts 锁）。
//
// 回放零差异（story 3）：SessionService.recordTurn 是 RunService 的 recordTurn 注入缝生产实现
// （server.ts 经 runner.service.setRecordTurn 回接）——run 域事件流经 TurnReducer 聚合，终态
// （completed/interrupted/aborted/failed 任一）落一条 assistant 行（attachmentsJson v1）；投影
// GET 反序列化回同形状。事件流归约 ≡ 投影行（sessionsApi.test.ts 逐字节断言）。

import type { PrismaClient, Session, SessionMessage } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { fail } from '../envelope'
import { CODE } from '../codes'
import { SANDBOX_CONTAINER_PREFIX } from '../sandboxes/values'
import { getSessionForUser } from '../sandboxes/service'
import type { SandboxRemoveOutcome } from '../sandboxes/lifecycle'
import type { EventPublisher, InFlightProjection, RunCommand, RunSnapshot } from '../runner/runtime/runService'
import { serializeAttachments, type RecordTurnPayload } from './reducer'
import { TITLE_AUTO_MAX } from './values'
import type { TeammateStatus } from '../runner/teammates/service'
import type { ApprovalInterruptPayload } from '../runner/approval/funnel'

// 会话摘要（session.created/updated 载荷 + 列表行 + 创建/PATCH 返回——同一形状）。
export interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
}

// 投影消息行（GET /messages 输出；前端单管线渲染的输入形状——实时事件归约同构）。
export interface ProjectionMessage {
  readonly id: string
  readonly turn: number
  readonly role: string
  readonly content: string
  readonly thinking?: string
  readonly tools?: unknown[]
  readonly anchorCheckpointId: string | null
  readonly createdAt: string
}

export interface SessionProjection {
  readonly sessionId: string
  readonly title: string
  readonly messages: ProjectionMessage[]
  /** in-flight 投影（story 11 · #779）：有进行中 run 时带出（从 checkpoint blob 反序列化重建，
   *  即焚 token 事件的补偿真相源）；无在飞 = 字段缺省。多端重拉同帧（同一内存态）。 */
  readonly inFlight?: InFlightProjection
  readonly teammates?: TeammateProjection[]
  readonly approvals?: Array<ApprovalInterruptPayload & { teammateId?: string }>
}

export interface TeammateProjection {
  readonly id: string
  readonly name: string
  readonly task: string
  readonly status: TeammateStatus
  readonly messages: ProjectionMessage[]
  readonly mailbox: Array<{ id: string; senderTeammateId: string | null; recipientTeammateId: string | null; kind: string; content: string; createdAt: string }>
  readonly inFlight?: InFlightProjection
}

export interface SystemCommandResult {
  readonly name: 'new' | 'model'
  readonly sessionId?: string
  readonly model?: ModelRef | null
  readonly models?: readonly ModelRef[]
  readonly appliesTo?: 'next-run'
}
export interface SendMessageResult {
  readonly command?: SystemCommandResult
  readonly messageId: string
  readonly turn: number
  readonly runId: string | null // 重放（replay=true）时 run 在首次请求已入队，此处 null
  readonly replay: boolean
}

// RunService 的结构子集（门禁观测 + 配额预检 + 命令构造 + abort）——测试注入同形 fake/真
// 实例，不依赖具体类。
export interface SessionRunGateway {
  readonly pendingApprovalProjection?: (threadId: string) => Promise<ApprovalInterruptPayload[]>
  readonly resolveApproval?: (params: { sessionId: string; ownerId: string; username: string; escalationId: string; decision: 'allow' | 'deny'; reason?: string }) => Promise<void>
  readonly resolveModelSelection?: (ownerId: string, args: string) => Promise<Omit<SystemCommandResult, 'name'>>
  readonly stateOf: (sessionId: string) => RunSnapshot | undefined
  readonly abort: (runId: string, by?: 'user' | 'system') => boolean
  /** 额度满预检（#777 注释契约「额度即时反馈面归 #778 REST」；只读不占额） */
  readonly quotaFull: (ownerId: string, sessionId?: string) => Promise<boolean>
  readonly buildMessageCommand: (p: {
    sessionId: string
    ownerId: string
    username: string
    content: string
    attachmentIds?: readonly string[]
  }) => Promise<RunCommand>
  readonly buildResumeCommand: (p: {
    sessionId: string
    ownerId: string
    username: string
    decisions?: unknown
  }) => RunCommand
  /** in-flight 投影（#779 story 11）：重拉投影的补偿重建面（running 从 checkpoint 重建/queued 空 turn） */
  readonly inFlightProjection: (sessionId: string) => Promise<InFlightProjection | undefined>
}

// run 命令发射口（submit 入队 ack 语义）：生产 = BullMQ submit（resolve = job 已入队；
// reject = 入队失败——调用方回滚落行，见 sendMessage），执行体错误在 run 域事件面表达
//（#779 补偿兜底 job 已入队形态）。50001/50003 等预检在 REST 面完成，dispatch 后的异步
// 失败经 run 域事件/日志表达。
export type RunDispatcher = (cmd: RunCommand) => Promise<void>

export interface SessionServiceDeps {
  readonly prisma: PrismaClient
  readonly hub: EventPublisher
  readonly runService: SessionRunGateway
  readonly dispatch: RunDispatcher
  /** 删会话级联删沙箱（#776；缺省 no-op——测试不注则不删） */
  readonly sandboxes?: { readonly remove: (sessionId: string) => Promise<SandboxRemoveOutcome> }
  /** #780 附件链接（≤4 件 + 归属/session 校验；缺省不注 = 发消息不接受附件引用） */
  readonly attachments?: {
    readonly linkToMessage: (
      user: Pick<AuthUser, 'id' | 'role'>,
      sessionId: string,
      messageId: string,
      attachmentIds: readonly string[],
    ) => Promise<void>
  }
}

// RunService recordTurn 注入缝的载荷（RecordTurnPayload）单一声明于 './reducer'。

function summary(s: Session): SessionSummary {
  return { id: s.id, title: s.title, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() }
}

// turn 序号分配 + 落行打包进 interactive transaction：read-then-write 在 SQLite 单连接事务内
// 原子（并发写排队），消除交错窗口——run 终态 recordTurn 与门禁放行的新 sendMessage 落行
// 曾可重叠（completed 置位于 finally recordTurn 之前），裸 read-then-write 下产生同 turn 双行，
// 投影 (turn asc, createdAt asc) 排序下答先于问（R3 评审）。
async function insertWithNextTurn(
  prisma: PrismaClient,
  sessionId: string,
  data: {
    role: string
    content: string
    clientKey?: string
    anchorCheckpointId?: string | null
    attachmentsJson?: string
  },
): Promise<SessionMessage> {
  return prisma.$transaction(async (tx) => {
    const last = await tx.sessionMessage.findFirst({
      where: { sessionId },
      orderBy: { turn: 'desc' },
      select: { turn: true },
    })
    return tx.sessionMessage.create({
      data: { sessionId, turn: (last?.turn ?? 0) + 1, ...data },
    })
  })
}

// 投影行组装：content 独立列 + attachmentsJson 聚合面（v 版本字段不外露）；assistant 行
// thinking/tools 仅在有内容时出现（与 TurnReducer.snapshot 缺省纪律一致）。
function toProjectionMessage(row: SessionMessage): ProjectionMessage {
  let aggregate: { thinking?: string; tools?: unknown[] } = {}
  if (row.role === 'assistant') {
    try {
      const parsed = JSON.parse(row.attachmentsJson) as { v?: number; thinking?: string; tools?: unknown[] }
      const { v: _v, ...rest } = parsed
      aggregate = rest
    } catch {
      aggregate = {} // 坏 JSON 不炸读路径（写面恒经 serializeAttachments，防御面）
    }
  }
  return {
    id: row.id,
    turn: row.turn,
    role: row.role,
    content: row.content,
    ...aggregate,
    anchorCheckpointId: row.anchorCheckpointId,
    createdAt: row.createdAt.toISOString(),
  }
}

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  // ---- 创建（扁平挂用户；containerId = 预言名 researcher-sandbox-<id>，沙箱本体惰性创建
  // 由 #776 ensure 在首次 run/上传时落地）+ session.created{source:new} 广播 ----
  async createSession(user: Pick<AuthUser, 'id'>, title = ''): Promise<SessionSummary> {
    const fresh = await this.deps.prisma.$transaction(async (tx) => {
      // 两跳打包事务：预言名 PREFIX+id 依赖 create 生成的 id——打包消除 containerId 空值
      // 中间态（并发列表/详情读不可见）。
      const created = await tx.session.create({
        data: { ownerId: user.id, containerId: '', title },
      })
      return tx.session.update({
        where: { id: created.id },
        data: { containerId: `${SANDBOX_CONTAINER_PREFIX}${created.id}` },
      })
    })
    this.publishSessionEvent(user.id, 'session.created', { source: 'new', session: summary(fresh) }, fresh.id)
    return summary(fresh)
  }

  // ---- 列表：本人会话（扁平挂用户；updatedAt DESC 最新在前）----
  async listSessions(user: Pick<AuthUser, 'id'>): Promise<{ sessions: SessionSummary[] }> {
    const rows = await this.deps.prisma.session.findMany({
      where: { ownerId: user.id, archivedAt: null, isTeammate: false },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    })
    return { sessions: rows.map(summary) }
  }

  // ---- 改标题（story 5 可改面；归属门同码 50002）+ session.updated 广播 ----
  async renameSession(user: Pick<AuthUser, 'id' | 'role'>, sessionId: string, title: string): Promise<SessionSummary> {
    await getSessionForUser(this.deps.prisma, user, sessionId)
    const fresh = await this.deps.prisma.session.update({ where: { id: sessionId }, data: { title } })
    this.publishSessionEvent(user.id, 'session.updated', { session: summary(fresh) }, sessionId)
    return summary(fresh)
  }

  // ---- 删会话（级联：沙箱容器+网络 → DB 行 onDelete Cascade 清 messages/checkpoints/
  // attachments/fileJournal）。先删沙箱（失败保留行可重试——remove 'not-found' 幂等）再删行，
  // 防孤儿容器（sweeper 只 stop 不 remove）。
  // 在飞 run 互斥（R3 评审）：非终态（queued/running/interrupted）挡删 50005——删 = 沙箱随删
  //（在飞工具全失败）+ 行删后 run 域事件成无主引用 + recordTurn FK 失败。先 abort/等终态再
  // 删；stateOf 内存缺失（本进程无该会话 run 记录——worker 同进程模型）= 可删。----
  async deleteSession(user: Pick<AuthUser, 'id' | 'role'>, sessionId: string): Promise<void> {
    await getSessionForUser(this.deps.prisma, user, sessionId)
    const snap = this.deps.runService.stateOf(sessionId)
    const terminal =
      snap === undefined ||
      snap.state === 'completed' ||
      snap.state === 'aborted' ||
      snap.state === 'failed'
    if (!terminal) throw fail(CODE.RUN_IN_PROGRESS)
    const teammates = await this.deps.prisma.teammate.findMany({
      where: { parentSessionId: sessionId },
      select: { threadId: true, status: true },
    })
    for (const teammate of teammates) {
      const state = this.deps.runService.stateOf(teammate.threadId)?.state
      const executing = state === 'queued' || state === 'running'
      const live = teammate.status !== 'archived' && (state
        ? !['completed', 'aborted', 'failed'].includes(state)
        : ['queued', 'running', 'waiting', 'suspended'].includes(teammate.status))
      if (executing || live) {
        throw fail(CODE.RUN_IN_PROGRESS)
      }
    }
    await this.deps.sandboxes?.remove(sessionId)
    await this.deps.prisma.$transaction(async (tx) => {
      const teammateThreads = await tx.teammate.findMany({
        where: { parentSessionId: sessionId },
        select: { threadId: true },
      })
      if (teammateThreads.length > 0) {
        await tx.session.deleteMany({ where: { id: { in: teammateThreads.map((row) => row.threadId) } } })
      }
      await tx.session.delete({ where: { id: sessionId } })
    })
  }

  // ---- 发消息（story 7 幂等 + 多端门禁）。顺序：归属 → 幂等 → 门禁 → 配额预检 → 命令构造
  // → 落 user 行 → dispatch（ack 失败回滚删行）。
  // 幂等查先于门禁：断网重发的首个请求可能已把 run 推入 running——重发必须拿 replay 应答
  //（200）而非 50005 门禁错误（「断网重发不重复入列」的语义面：已收的消息不应答错误）。
  // 并发同 key 单落：先查 + 唯一约束 P2002 兜底重查（bootstrap 先例）——约束是单落权威，
  // 双请求都越过先查时后落者撞约束回读既有行（replay 形态返回，不重复 dispatch）。----
  async sendMessage(
    user: Pick<AuthUser, 'id' | 'role' | 'username'>,
    sessionId: string,
    p: { content: string; clientKey: string; attachmentIds?: readonly string[] },
  ): Promise<SendMessageResult> {
    await getSessionForUser(this.deps.prisma, user, sessionId)
    // 斜杠识别/幂等/门禁全部作用于**原始输入**：落行存用户所发原文，官方模板展开只在命令
    // 构造点进行——模板发版改文不改变已存内容，同 key 重发恒 replay（#778 story 7；50007 只对
    // 真正异 content 的输入触发）。系统命令（/new /compact /model）为保留名（catalog 构造期
    // 拒绝同名官方命令），恒以原文穿过 expand。
    const slash = parseSlash(p.content)
    const existing = await this.deps.prisma.sessionMessage.findUnique({
      where: { sessionId_clientKey: { sessionId, clientKey: p.clientKey } },
    })
    if (existing) return this.replayOrConflict(existing, p.content)
    if (slash?.name === 'new' || slash?.name === 'model') return this.executeSystemCommand(user, sessionId, p, slash)
    if (slash?.name === 'compact' && slash.args) throw fail(CODE.VALIDATION_FAILED, '/compact 不接受参数')

    // 多端门禁（#747 C 节）：queued/running → 50005 禁新输入；interrupted → 50003 须先审批
    //（内核面 RunService.execute 同挡，此处 REST 即时反馈——入队前拒绝，不产生 queued 幽灵）。
    // 观测窗口（已知边界）：dispatch=BullMQ 异步入队，submit→worker 拾取间 stateOf 尚无记录，
    // 窗口内新输入穿透 50005 沿串行链排队（顺序保证不丢，仅门禁反馈弱化；S1 Inline 同步
    // 执行无此窗口——测试面与生产行为在此点的分叉已认知）。
    const snap = this.deps.runService.stateOf(sessionId)
    if (snap?.state === 'running' || snap?.state === 'queued') throw fail(CODE.RUN_IN_PROGRESS)
    if (snap?.state === 'interrupted') throw fail(CODE.RUN_INTERRUPT_PENDING)

    // 配额即时反馈（#777 注释契约「额度即时反馈面归 #778 REST」）：满 → 40043。预检只读不占
    // 额——紧邻并发仍可能双双穿透，权威判定在 worker 的 gate.acquire（job failed 面，#779
    // 兜底该形态：job 已入队故可观测）。
    if (await this.deps.runService.quotaFull(user.id, sessionId)) throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED)

    // 命令构造先于落行：构造失败（caller 缺失/50002 面）不落行——幂等键只在「run 确已被
    // 接受」后锁定（失败请求锁死幂等键 = story 7 语义反转：重发恒 replay 而消息从未被处理）。
    // 官方命令展开在此处（唯一消费方 = run）：/research x → 模板正文 $ARGUMENTS 插值；非官方
    // 输入恒等返回。落行 content 列仍存原始输入（见 sendMessage 头注）。
    let cmd = await this.deps.runService.buildMessageCommand({
      sessionId,
      ownerId: user.id,
      username: user.username,
      content: snapshotOfficialContent().expand(p.content),
      attachmentIds: p.attachmentIds,
    })

    if (slash?.name === 'compact') cmd = { ...cmd, operation: 'compact' }

    // 落行先于 dispatch：dispatch 后 run 域事件（run.started 起）才可见，用户行必已在投影中
    //（刷新窗口无「事件先于消息」跳变）。
    let row: SessionMessage
    try {
      row = await insertWithNextTurn(this.deps.prisma, sessionId, {
        role: 'user',
        content: p.content,
        clientKey: p.clientKey,
      })
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        // 已知毫秒窗口（R4 记录备查）：败方经此分支拿 replay 应答后，若胜方 dispatch ack
        // 失败回滚删行，败方应答与实况相悖——需 dispatch 故障叠加并发窗口，刷新自愈。
        const winner = await this.deps.prisma.sessionMessage.findUnique({
          where: { sessionId_clientKey: { sessionId, clientKey: p.clientKey } },
        })
        if (!winner) throw e
        return this.replayOrConflict(winner, p.content)
      }
      throw e
    }

    // #780：附件引用链接（≤4 件 + 归属/session 校验在 linkToMessage）。失败 → 消息行回滚
    //（引用与消息同生共死——校验失败的消息不应留下无引用的幽灵行）。链接先于 dispatch：
    // worker 拾取 run 时按消息行读附件（片 2 ingestion），引用必须在 run 事件前就位。
    if (p.attachmentIds && p.attachmentIds.length > 0 && this.deps.attachments) {
      try {
        await this.deps.attachments.linkToMessage(user, sessionId, row.id, p.attachmentIds)
      } catch (e) {
        await this.deps.prisma.sessionMessage.delete({ where: { id: row.id } }).catch(() => {})
        throw e
      }
    }

    // dispatch = submit 入队 ack：失败 → 回滚删行。行残留的后果不可补偿——submit 失败无 job、
    // 无事件（#779 补偿只覆盖 job 已入队形态），重发同 key 将恒 replay 而消息永不执行。回滚
    // 后幂等键随行消失，重发重走全流程。回滚自身失败 best-effort（行残留概率 = DB 已故障，
    // 此时告警面在日志）。附件链接随行回滚（messageId → null，字节与临时区不动）。
    try {
      await this.deps.dispatch(cmd)
    } catch {
      await this.deps.prisma.sessionMessage.delete({ where: { id: row.id } }).catch(() => {})
      if (p.attachmentIds && p.attachmentIds.length > 0) {
        await this.deps.prisma.attachment
          .updateMany({ where: { id: { in: [...p.attachmentIds] }, sessionId }, data: { messageId: null } })
          .catch(() => {})
      }
      throw fail(CODE.INTERNAL, 'run 入队失败，请稍后重试')
    }
    return { messageId: row.id, turn: row.turn, runId: cmd.runId, replay: false }
  }

  private replayOrConflict(existing: SessionMessage, content: string): SendMessageResult {
    if (existing.content !== content) throw fail(CODE.MESSAGE_KEY_CONFLICT)
    // 坏 JSON 不炸 replay 路径（写面恒经 serializeAttachments，防御面同 toProjectionMessage）
    let command: SystemCommandResult | undefined
    try {
      command = (JSON.parse(existing.attachmentsJson || '{}') as { command?: SystemCommandResult }).command
    } catch {
      command = undefined
    }
    return { messageId: existing.id, turn: existing.turn, runId: null, replay: true, ...(command ? { command } : {}) }
  }

  private async executeSystemCommand(
    user: Pick<AuthUser, 'id'>, sessionId: string, p: { content: string; clientKey: string }, slash: { name: string; args: string },
  ): Promise<SendMessageResult> {
    if (slash.name === 'new' && slash.args) throw fail(CODE.VALIDATION_FAILED, '/new 不接受参数')
    const selection = slash.name === 'model'
      ? await this.deps.runService.resolveModelSelection?.(user.id, slash.args)
      : undefined
    if (slash.name === 'model' && !selection) throw fail(CODE.INTERNAL, '模型选择能力未接线')
    const result = await this.deps.prisma.$transaction(async tx => {
      const previous = await tx.sessionMessage.findUnique({ where: { sessionId_clientKey: { sessionId, clientKey: p.clientKey } } })
      if (previous) return { response: this.replayOrConflict(previous, p.content) }
      let created: Session | undefined
      let command: SystemCommandResult
      if (slash.name === 'new') {
        const fresh = await tx.session.create({ data: { ownerId: user.id, containerId: '', title: '' } })
        created = await tx.session.update({ where: { id: fresh.id }, data: { containerId: `${SANDBOX_CONTAINER_PREFIX}${fresh.id}` } })
        command = { name: 'new', sessionId: created.id }
      } else {
        if (selection && 'model' in selection) await tx.session.update({ where: { id: sessionId }, data: { preferredModelJson: selection.model ? JSON.stringify(selection.model) : null } })
        command = { name: 'model', ...selection }
      }
      // turn 分配与幂等查同处一个 interactive transaction：better-sqlite3 单连接下事务体
      // 串行执行（写排队），read-then-write 无交错窗口——无需常规路径的 P2002 兜底重查
      //（该兜底防的是「先查在事务外」的间隙，此处查/写同事务，约束撞不上）。
      const last = await tx.sessionMessage.findFirst({ where: { sessionId }, orderBy: { turn: 'desc' }, select: { turn: true } })
      const row = await tx.sessionMessage.create({
        data: { sessionId, turn: (last?.turn ?? 0) + 1, role: 'user', content: p.content, clientKey: p.clientKey, attachmentsJson: serializeAttachments({ command }) },
      })
      return { created, response: { messageId: row.id, turn: row.turn, runId: null, replay: false, command } }
    })
    if (result.created) this.publishSessionEvent(user.id, 'session.created', { source: 'new', session: summary(result.created) }, result.created.id)
    // session.updated 只随「偏好真实落定」（含 /model default 重置）广播——/model 无参纯列清单
    // 不发事件（列清单是查询不是变更，广播 model:undefined 是噪音）。
    const command = result.response.command
    if (command?.name === 'model' && 'model' in command && !result.response.replay) {
      this.publishSessionEvent(user.id, 'session.updated', { sessionId, model: command.model, appliesTo: 'next-run' }, sessionId)
    }
    return result.response
  }

  // ---- 中断（story 8，by:user）。仅 running 在飞 run 可中断（RunService.abort 只对 aborts
  // 条目生效——queued/interrupted/终态 → 50006）。run.aborted{by:user} 事件由 RunService 发。----
  async abortRun(user: Pick<AuthUser, 'id' | 'role'>, sessionId: string): Promise<{ runId: string }> {
    await getSessionForUser(this.deps.prisma, user, sessionId)
    const snap = this.deps.runService.stateOf(sessionId)
    if (snap?.state !== 'running' || !this.deps.runService.abort(snap.runId, 'user')) {
      throw fail(CODE.RUN_NOT_ABORTABLE)
    }
    return { runId: snap.runId }
  }

  // ---- resume（interrupt 全端可审批面；#783 审批漏斗接 decisions 构造，本票机制面直通）。
  // 先到先得：buildResumeCommand 预检 50001（executeRun 权威面兜底并发窗口）。配额即时反馈同
  // sendMessage（quotaFull → 40043）——resume 是 interrupted 会话唯一可用入口（sendMessage 被
  // 50003 挡），缺预检时配额满期间 REST 200 → worker 40043 → 无 run 域事件，会话停 interrupted
  // 用户零信号（R4 评审）。
  // REST 应答语义边界（已知）：两端紧邻并发时败方预检仍过（先到者尚未把 state 推离 interrupted）→
  // REST 200 + runId，权威 50001 在内核面拒绝且无该 runId 的任何事件——最终一致由赢家的
  // run.resumed 同帧扇出保证（多端事件面同一真相），REST 应答在窗口内有误导性。
  // dispatch await 入队 ack：失败（state 仍 interrupted 未变）→ 90000，重试 resume 即可。----
  async resumeRun(
    user: Pick<AuthUser, 'id' | 'role' | 'username'>,
    sessionId: string,
    decisions?: unknown,
  ): Promise<{ runId: string }> {
    await getSessionForUser(this.deps.prisma, user, sessionId)
    const cmd = this.deps.runService.buildResumeCommand({
      sessionId,
      ownerId: user.id,
      username: user.username,
      decisions,
    })
    if (await this.deps.runService.quotaFull(user.id, sessionId)) throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED)
    await this.deps.dispatch(cmd)
    return { runId: cmd.runId }
  }

  // ---- 历史投影 GET（story 3 回放面；turn 升序）。50002 同码防探测。
  // inFlight（#779 story 11）：有进行中 run 时同响应带出「从 checkpoint blob 反序列化重建」
  // 的进行中 turn——断线补偿 = 重拉投影 + in-flight 重建一次完成（前端以投影为锚重挂视图）。----
  async getProjection(user: Pick<AuthUser, 'id' | 'role'>, sessionId: string): Promise<SessionProjection> {
    const session = await getSessionForUser(this.deps.prisma, user, sessionId)
    const rows = await this.deps.prisma.sessionMessage.findMany({
      where: { sessionId },
      orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }],
    })
    const inFlight = await this.deps.runService.inFlightProjection(sessionId)
    const peers = await this.deps.prisma.teammate.findMany({
      where: { parentSessionId: sessionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { thread: { include: { messages: { orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }] } } } },
    })
    const mail = peers.length > 0 ? await this.deps.prisma.teammateMailboxMessage.findMany({
      where: { parentSessionId: sessionId, invalidatedAt: null, OR: [{ readAt: { not: null } }, { expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }) : []
    const teammates = await Promise.all(peers.map(async peer => {
      const active = await this.deps.runService.inFlightProjection(peer.threadId)
      return {
        id: peer.id, name: peer.name, task: peer.task, status: peer.status as TeammateStatus,
        messages: peer.thread.messages.map(toProjectionMessage),
        mailbox: mail.filter(message => message.senderTeammateId === peer.id || message.recipientTeammateId === peer.id).map(message => ({
          id: message.id, senderTeammateId: message.senderTeammateId, recipientTeammateId: message.recipientTeammateId,
          kind: message.kind, content: message.content, createdAt: message.createdAt.toISOString(),
        })),
        ...(active !== undefined ? { inFlight: active } : {}),
      }
    }))
    const approvals = this.deps.runService.pendingApprovalProjection ? [
      ...await this.deps.runService.pendingApprovalProjection(sessionId),
      ...(await Promise.all(peers.filter(peer => peer.archivedAt === null).map(async peer =>
        (await this.deps.runService.pendingApprovalProjection!(peer.threadId)).map(approval => ({ ...approval, teammateId: peer.id })),
      ))).flat(),
    ] : []
    return {
      sessionId,
      title: session.title,
      messages: rows.map(toProjectionMessage),
      ...(inFlight !== undefined ? { inFlight } : {}),
      ...(teammates.length > 0 ? { teammates } : {}),
      ...(approvals.length > 0 ? { approvals } : {}),
    }
  }

  async resolveApproval(user: Pick<AuthUser, 'id' | 'role' | 'username'>, sessionId: string, escalationId: string, decision: 'allow' | 'deny', reason?: string): Promise<void> {
    const session = await getSessionForUser(this.deps.prisma, user, sessionId)
    if (!this.deps.runService.resolveApproval) throw fail(CODE.APPROVAL_NOT_FOUND)
    await this.deps.runService.resolveApproval({ sessionId, ownerId: session.ownerId, username: user.username, escalationId, decision, reason })
  }

  // ---- RunService recordTurn 注入缝（生产实现）：终态聚合落 assistant 行（含终态 checkpoint
  // 锚点 anchorCheckpointId——issue 点名列；aborted/failed 路径 null）+ 自动标题（story 5）。
  // attachmentsJson 走 serializeAttachments（唯一序列化实现——单一来源），字段序稳定
  //（回放零差异断言的前提）。----
  async recordTurn(p: RecordTurnPayload): Promise<void> {
    await insertWithNextTurn(this.deps.prisma, p.sessionId, {
      role: 'assistant',
      content: p.aggregate.content,
      anchorCheckpointId: p.anchorCheckpointId,
      attachmentsJson: serializeAttachments(p.aggregate),
    })
    await this.autoTitle(p.sessionId)
    const child = await this.deps.prisma.teammate.findUnique({ where: { threadId: p.sessionId }, select: { parentSessionId: true } })
    const parent = await this.deps.prisma.session.findUnique({ where: { id: child?.parentSessionId ?? p.sessionId }, select: { ownerId: true } })
    if (parent) this.publishSessionEvent(parent.ownerId, 'session.updated', { projectionChanged: true }, child?.parentSessionId ?? p.sessionId)
  }

  // 自动标题（story 5）：首个 run 终态时 title 仍空 → 首条 user 消息截断派生 + session.updated。
  private async autoTitle(sessionId: string): Promise<void> {
    const session = await this.deps.prisma.session.findUnique({
      where: { id: sessionId },
      select: { title: true, ownerId: true },
    })
    if (!session || session.title !== '') return
    const firstUser = await this.deps.prisma.sessionMessage.findFirst({
      where: { sessionId, role: 'user' },
      orderBy: { turn: 'asc' },
      select: { content: true },
    })
    if (!firstUser?.content) return
    const title = firstUser.content.slice(0, TITLE_AUTO_MAX)
    const fresh = await this.deps.prisma.session.update({ where: { id: sessionId }, data: { title } })
    this.publishSessionEvent(session.ownerId, 'session.updated', { session: summary(fresh) }, sessionId)
  }

  private publishSessionEvent(
    userId: string,
    type: 'session.created' | 'session.updated',
    payload: Record<string, unknown>,
    sessionId: string,
  ): void {
    this.deps.hub.publish(userId, { type, sessionId, payload })
  }
}
