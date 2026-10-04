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
import type { EventPublisher, RunCommand, RunSnapshot } from '../runner/runtime/runService'
import { serializeAttachments, type RecordTurnPayload } from './reducer'
import { TITLE_AUTO_MAX } from './values'

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
}

export interface SendMessageResult {
  readonly messageId: string
  readonly turn: number
  readonly runId: string | null // 重放（replay=true）时 run 在首次请求已入队，此处 null
  readonly replay: boolean
}

// RunService 的结构子集（门禁观测 + 配额预检 + 命令构造 + abort）——测试注入同形 fake/真
// 实例，不依赖具体类。
export interface SessionRunGateway {
  readonly stateOf: (sessionId: string) => RunSnapshot | undefined
  readonly abort: (runId: string, by?: 'user' | 'system') => boolean
  /** 额度满预检（#777 注释契约「额度即时反馈面归 #778 REST」；只读不占额） */
  readonly quotaFull: (ownerId: string) => Promise<boolean>
  readonly buildMessageCommand: (p: {
    sessionId: string
    ownerId: string
    username: string
    content: string
  }) => Promise<RunCommand>
  readonly buildResumeCommand: (p: {
    sessionId: string
    ownerId: string
    username: string
    decisions?: unknown
  }) => RunCommand
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
    p: { content: string; clientKey: string },
  ): Promise<SendMessageResult> {
    await getSessionForUser(this.deps.prisma, user, sessionId)

    const existing = await this.deps.prisma.sessionMessage.findUnique({
      where: { sessionId_clientKey: { sessionId, clientKey: p.clientKey } },
    })
    if (existing) return this.replayOrConflict(existing, p.content)

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
    if (await this.deps.runService.quotaFull(user.id)) throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED)

    // 命令构造先于落行：构造失败（caller 缺失/50002 面）不落行——幂等键只在「run 确已被
    // 接受」后锁定（失败请求锁死幂等键 = story 7 语义反转：重发恒 replay 而消息从未被处理）。
    const cmd = await this.deps.runService.buildMessageCommand({
      sessionId,
      ownerId: user.id,
      username: user.username,
      content: p.content,
    })

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

    // dispatch = submit 入队 ack：失败 → 回滚删行。行残留的后果不可补偿——submit 失败无 job、
    // 无事件（#779 补偿只覆盖 job 已入队形态），重发同 key 将恒 replay 而消息永不执行。回滚
    // 后幂等键随行消失，重发重走全流程。回滚自身失败 best-effort（行残留概率 = DB 已故障，
    // 此时告警面在日志）。
    try {
      await this.deps.dispatch(cmd)
    } catch {
      await this.deps.prisma.sessionMessage.delete({ where: { id: row.id } }).catch(() => {})
      throw fail(CODE.INTERNAL, 'run 入队失败，请稍后重试')
    }
    return { messageId: row.id, turn: row.turn, runId: cmd.runId, replay: false }
  }

  private replayOrConflict(existing: SessionMessage, content: string): SendMessageResult {
    if (existing.content !== content) throw fail(CODE.MESSAGE_KEY_CONFLICT)
    return { messageId: existing.id, turn: existing.turn, runId: null, replay: true }
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
    if (await this.deps.runService.quotaFull(user.id)) throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED)
    await this.deps.dispatch(cmd)
    return { runId: cmd.runId }
  }

  // ---- 历史投影 GET（story 3 回放面；turn 升序）。50002 同码防探测。----
  async getProjection(user: Pick<AuthUser, 'id' | 'role'>, sessionId: string): Promise<SessionProjection> {
    const session = await getSessionForUser(this.deps.prisma, user, sessionId)
    const rows = await this.deps.prisma.sessionMessage.findMany({
      where: { sessionId },
      orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }],
    })
    return {
      sessionId,
      title: session.title,
      messages: rows.map(toProjectionMessage),
    }
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
