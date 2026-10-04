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

import { randomUUID } from 'node:crypto'
import type { PrismaClient, PrismaPromise, Session, SessionMessage } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { fail, EnvelopeError } from '../envelope'
import { CODE } from '../codes'
import { SANDBOX_CONTAINER_PREFIX } from '../sandboxes/values'
import { getSessionForUser } from '../sandboxes/service'
import type { SandboxRemoveOutcome } from '../sandboxes/lifecycle'
import type { EventPublisher, InFlightProjection, RunCommand, RunSnapshot } from '../runner/runtime/runService'
import { serializeAttachments, type RecordTurnPayload } from './reducer'
import {
  abandonedCheckpointIds,
  anchorChainOf,
  resolveRewindAnchor,
  visibleRowIds,
  type HistoryRowLite,
} from './rewind'
import { TITLE_AUTO_MAX, TITLE_MAX } from './values'

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
  /** 删会话级联删沙箱（#776；缺省 no-op——测试不注则不删）。fork（#781 · #768 D7）：
   *  源沙箱字面复制 → 'copied'；源不存在 → 'source-missing'（调用方空起步 + 系统消息）。
   *  缺省不注 = 恒 'source-missing'（纯 DB fork，测试面可控）。 */
  readonly sandboxes?: {
    readonly remove: (sessionId: string) => Promise<SandboxRemoveOutcome>
    readonly fork: (sourceSessionId: string, newSessionId: string) => Promise<'copied' | 'source-missing'>
  }
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
      where: { ownerId: user.id, archivedAt: null },
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
    this.requireTerminal(sessionId)
    await this.deps.sandboxes?.remove(sessionId)
    await this.deps.prisma.session.delete({ where: { id: sessionId } })
  }

  // ---- 终态门禁（#778 多端互斥的 rewind/fork/删 共用面）：queued/running/interrupted/suspended
  // → 50005（rewind 换锚会作废在飞 checkpoint 链；fork 复制源沙箱要求导出快照静止——run 进行
  // 中导出文件系统在变）。stateOf 内存缺失 = 可操作（worker 同进程模型）。----
  private requireTerminal(sessionId: string): void {
    const snap = this.deps.runService.stateOf(sessionId)
    const terminal =
      snap === undefined ||
      snap.state === 'completed' ||
      snap.state === 'aborted' ||
      snap.state === 'failed'
    if (!terminal) throw fail(CODE.RUN_IN_PROGRESS)
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
    // 归属门（50002 同码防探测）先行；此后本体不再消费入口快照（残留清理在函数内重读指针——
    // 入口快照可能落后于上一轮 completed 的指针推进，R 评审）。
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
      attachmentIds: p.attachmentIds,
    })

    // rewind 残留清理（#781 story 16）：rewind 态（指针非空）时，锚点之后的残留行归档（#770
    // 软删）——落新 user 行前清场，防「失败轮 + 重开轮」双 user 并列投影。指针在清理函数内
    // 重读（见 archiveRowsOffAnchor）；未 rewind 会话（指针恒 null）全量历史保留。
    await this.archiveRowsOffAnchor(sessionId)

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

  // ---- 历史投影 GET（story 3 回放面；turn 升序）。50002 同码防探测。
  // inFlight（#779 story 11）：有进行中 run 时同响应带出「从 checkpoint blob 反序列化重建」
  // 的进行中 turn——断线补偿 = 重拉投影 + in-flight 重建一次完成（前端以投影为锚重挂视图）。
  // archivedAt 过滤（#781 rewind 软删）：被放弃路线行产品面不可读（#770「无恢复入口」——
  // 比较路线 = fork 并存多开）。
  async getProjection(user: Pick<AuthUser, 'id' | 'role'>, sessionId: string): Promise<SessionProjection> {
    const session = await getSessionForUser(this.deps.prisma, user, sessionId)
    const rows = await this.deps.prisma.sessionMessage.findMany({
      where: { sessionId, archivedAt: null },
      orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }],
    })
    const inFlight = await this.deps.runService.inFlightProjection(sessionId)
    return {
      sessionId,
      title: session.title,
      messages: rows.map(toProjectionMessage),
      ...(inFlight !== undefined ? { inFlight } : {}),
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

  // ---- rewind（story 16 · #770 三操作模型）：换 activeCheckpointId 指针重开 + 被放弃路线
  // 软删存档（checkpoint/journal/消息行 archivedAt——行不物理删，产品面不可读无恢复入口，
  // 「比较路线」= fork 并存多开）。锚点以消息行表达（产品面选历史消息），解析 + 挂靠判定在
  // 纯逻辑（./rewind）。完成后 session.invalidated{reason:rewind} 广播（多端重拉投影）。
  // 文件 /lab 的 journal 逆放恢复归 #782（本票纯对话指针）。----
  async rewindSession(
    user: Pick<AuthUser, 'id' | 'role'>,
    sessionId: string,
    p: { messageId: string },
  ): Promise<{ sessionId: string; activeCheckpointId: string }> {
    const session = await getSessionForUser(this.deps.prisma, user, sessionId)
    this.requireTerminal(sessionId)

    const rows = await this.listHistoryRows(sessionId)
    const anchor = resolveRewindAnchor(rows, p.messageId)
    if (anchor === null) {
      throw fail(CODE.VALIDATION_FAILED, '该消息不可作为回退锚点（无更早的可回退 state）')
    }
    // 归档 checkpoint 不可作锚点（#770 无恢复入口；归档行已由 listHistoryRows 滤除，此处兜
    // 「行未归档但 checkpoint 已归档」的机制性不一致）。
    const parentOf = await this.checkpointParentLookup(sessionId)
    if (!parentOf.has(anchor)) {
      throw fail(CODE.VALIDATION_FAILED, '锚点 checkpoint 缺失或已归档')
    }
    const anchorChain = anchorChainOf((id) => parentOf.get(id) ?? null, anchor)

    // 软删存档（#770）：被放弃 checkpoint（未归档全体 − 锚点链）+ journal（checkpointId ∈
    // 被放弃集）+ 挂靠不可见消息行——共享前缀（锚点之前）一律不打标记。
    const abandoned = abandonedCheckpointIds([...parentOf.keys()], anchorChain)
    const now = new Date()
    const writes: PrismaPromise<unknown>[] = [
      ...(abandoned.size > 0
        ? [
            this.deps.prisma.checkpoint.updateMany({
              where: { threadId: sessionId, checkpointId: { in: [...abandoned] } },
              data: { archivedAt: now },
            }),
            this.deps.prisma.fileJournal.updateMany({
              where: { sessionId, checkpointId: { in: [...abandoned] } },
              data: { archivedAt: now },
            }),
          ]
        : []),
      ...this.archiveRowWrites(sessionId, rows, anchorChain, now),
      this.deps.prisma.session.update({
        where: { id: sessionId },
        data: { activeCheckpointId: anchor },
      }),
    ]
    await this.deps.prisma.$transaction(writes)

    this.publishSessionEvent(session.ownerId, 'session.invalidated', { reason: 'rewind' }, sessionId)
    return { sessionId, activeCheckpointId: anchor }
  }

  // ---- fork（story 18/20 · #768 D7 修订）：唯一复制原语。新 Session 行（parentSessionKey +
  // forkSourceJson 溯源）+ checkpoint 祖先链行复制（blob 自包含，新 thread 直读——「切点 state
  // 起步」的机制面，保锚点引用有效）+ 消息行挂靠截断复制 + 沙箱整容器字面复制（docker
  // export→import，含墓碑目录；源已删 → 空起步 + 系统消息）+ file_journal 切点截断继承
  //（seq 保留原值接续）+ attachments 行复制（不改 attachmentId；挂切点后消息的行随其消息行
  // 留在源会话——FK 完整性交集，规格「全量复制」指不按 attachmentId 锚点筛选）。
  // 顺序：session 行先落（拿 id）→ 沙箱复制（Docker 成功才落数据行）→ 数据复制事务（含系统
  // 消息）；任一步失败补偿删 session 行（cascade 清子行）+ 删沙箱尽力——fork 可整体重试。
  async forkSession(
    user: Pick<AuthUser, 'id' | 'role' | 'username'>,
    sessionId: string,
    p: { messageId?: string; title?: string },
  ): Promise<{ session: SessionSummary }> {
    const session = await getSessionForUser(this.deps.prisma, user, sessionId)
    this.requireTerminal(sessionId)

    // 切点解析：缺省 = 当前活跃头（指针或最新锚点；皆无 = 空会话 fork，纯新会话 + 沙箱复制）
    const rows = await this.listHistoryRows(sessionId)
    let anchor: string | null
    if (p.messageId !== undefined) {
      anchor = resolveRewindAnchor(rows, p.messageId)
      if (anchor === null) {
        throw fail(CODE.VALIDATION_FAILED, '该消息不可作为 fork 切点（无更早的可回退 state）')
      }
    } else {
      anchor = session.activeCheckpointId ?? this.latestAnchoredId(rows)
    }
    // 切点有效性前置校验（R 评审）：归档 checkpoint 不可作切点——否则新会话指针悬空、
    // checkpoint 零复制。校验先于 session 行落库（失败零残留）。
    if (anchor !== null) {
      const cp = await this.deps.prisma.checkpoint.findFirst({
        where: { threadId: sessionId, checkpointId: anchor, archivedAt: null },
        select: { checkpointId: true },
      })
      if (!cp) throw fail(CODE.VALIDATION_FAILED, '切点 checkpoint 缺失或已归档')
    }

    // 新 session 行先行（containerId 预言名两跳，同 createSession）
    const fresh = await this.deps.prisma.$transaction(async (tx) => {
      const created = await tx.session.create({
        data: {
          ownerId: session.ownerId,
          containerId: '',
          title: p.title ?? (session.title !== '' ? `${session.title} (fork)`.slice(0, TITLE_MAX) : ''),
          parentSessionKey: session.id,
          forkSourceJson: JSON.stringify({
            sourceSessionId: session.id,
            ...(anchor !== null ? { sourceCheckpointId: anchor } : {}),
            sourceMessageId: p.messageId ?? null,
            forkedAt: new Date().toISOString(),
          }),
          ...(anchor !== null ? { activeCheckpointId: anchor } : {}),
        },
      })
      return tx.session.update({
        where: { id: created.id },
        data: { containerId: `${SANDBOX_CONTAINER_PREFIX}${created.id}` },
      })
    })

    // 沙箱字面复制先行（Docker 成功才落数据行；失败走补偿，fork 可整体重试）。Docker 层错误
    // 包 INTERNAL 信封（R 评审：不漏裸错误出路由）；已是信封错误（理论上不存在）原样放行。
    let sandboxOutcome: 'copied' | 'source-missing' = 'source-missing'
    try {
      sandboxOutcome = await this.deps.sandboxes?.fork(session.id, fresh.id) ?? 'source-missing'
    } catch (e) {
      await this.compensateFork(fresh.id)
      if (e instanceof EnvelopeError) throw e
      // eslint-disable-next-line no-console
      console.warn(`[sessions] fork 沙箱复制失败: source=${session.id} target=${fresh.id}: ${(e as Error).message}`)
      throw fail(CODE.INTERNAL, 'fork 沙箱复制失败，请稍后重试')
    }

    // 数据复制事务（#770 截断口径：checkpoint = 锚点祖先链、消息 = 挂靠可见行、journal =
    // checkpointId ∈ 祖先链；attachments 全量 [FK 交集]）
    try {
      await this.copyForkData(session, fresh.id, anchor, sandboxOutcome === 'source-missing')
    } catch (e) {
      await this.compensateFork(fresh.id)
      if (e instanceof EnvelopeError) throw e
      // eslint-disable-next-line no-console
      console.warn(`[sessions] fork 数据复制失败: source=${session.id} target=${fresh.id}: ${(e as Error).message}`)
      throw fail(CODE.INTERNAL, 'fork 数据复制失败，已回滚')
    }

    this.publishSessionEvent(
      session.ownerId,
      'session.created',
      { source: 'fork', session: summary(fresh) },
      fresh.id,
    )
    return { session: summary(fresh) }
  }

  // fork 补偿：删 session 行（cascade 清已复制子行）+ 删沙箱尽力（Docker 失败不掩盖原始错误）
  private async compensateFork(forkedSessionId: string): Promise<void> {
    await this.deps.prisma.session.delete({ where: { id: forkedSessionId } }).catch(() => {})
    await this.deps.sandboxes?.remove(forkedSessionId).catch(() => {})
  }

  // fork 数据复制（单事务）：checkpoint 祖先链 + checkpoint_writes + 消息行 + attachments +
  // file_journal + 系统消息（源沙箱缺失时）。行面输入在事务外一次性读取（事务内不混用非 tx
  // client 读——R 评审）。切点链缺失（理论上已由前置校验挡下）→ 抛错整滚，绝不落「指针悬空」
  // 的半成品 fork。
  private async copyForkData(
    source: Session,
    forkedSessionId: string,
    anchor: string | null,
    systemMessage: boolean,
  ): Promise<void> {
    const rows = anchor !== null ? await this.listHistoryRows(source.id) : []
    await this.deps.prisma.$transaction(async (tx) => {
      if (anchor !== null) {
        const checkpoints = await tx.checkpoint.findMany({
          where: { threadId: source.id, archivedAt: null },
        })
        const parentOf = new Map(checkpoints.map((c) => [c.checkpointId, c.parentCheckpointId]))
        const chain = anchorChainOf((id) => parentOf.get(id) ?? null, anchor)
        const chainRows = checkpoints.filter((c) => chain.has(c.checkpointId))
        const chainIds = [...chain]
        if (chainRows.length === 0) {
          throw fail(CODE.VALIDATION_FAILED, '切点 checkpoint 链缺失（机制数据不一致）')
        }
        await tx.checkpoint.createMany({
          data: chainRows.map((c) => ({ ...c, threadId: forkedSessionId })),
        })
        const writes = await tx.checkpointWrite.findMany({
          where: { threadId: source.id, checkpointId: { in: chainIds } },
        })
        if (writes.length > 0) {
          await tx.checkpointWrite.createMany({
            data: writes.map((w) => ({ ...w, threadId: forkedSessionId })),
          })
        }
        const journals = await tx.fileJournal.findMany({
          where: { sessionId: source.id, archivedAt: null, checkpointId: { in: chainIds } },
        })
        if (journals.length > 0) {
          // seq 保留原值（新会话内唯一 ✓），后续写入从 max(seq)+1 接续（写入面归 #782）
          await tx.fileJournal.createMany({
            data: journals.map((j) => ({
              id: randomUUID(),
              sessionId: forkedSessionId,
              checkpointId: j.checkpointId,
              seq: j.seq,
              op: j.op,
              path: j.path,
              beforeSha256: j.beforeSha256,
              afterSha256: j.afterSha256,
              tombstoneKey: j.tombstoneKey,
              toolCallId: j.toolCallId,
              applied: j.applied,
            })),
          })
        }

        // 消息行挂靠截断复制：turn/createdAt/clientKey 原样，id 新生成（全局主键，复制体是
        // 独立行）——attachments.messageId 随映射改指新行。
        const visible = visibleRowIds(rows, chain)
        const visibleIds = [...visible]
        const rowsToCopy = await tx.sessionMessage.findMany({
          where: { sessionId: source.id, id: { in: visibleIds } },
        })
        if (rowsToCopy.length > 0) {
          const messageIdMap = new Map(rowsToCopy.map((r) => [r.id, randomUUID()]))
          await tx.sessionMessage.createMany({
            data: rowsToCopy.map((r) => ({
              id: messageIdMap.get(r.id)!,
              sessionId: forkedSessionId,
              turn: r.turn,
              role: r.role,
              content: r.content,
              clientKey: r.clientKey,
              attachmentsJson: r.attachmentsJson,
              anchorCheckpointId: r.anchorCheckpointId,
              createdAt: r.createdAt,
            })),
          })
          // attachments 复制：messageId ∈ 复制行或 null（FK 完整）；attachmentId 不改（路径
          // 在沙箱 /lab/uploads/——字面复制后继续有效；下载面按 id 全表 + owner 过滤，多行
          // 同 id 语义安全，#766 D7「不改 attachmentId」）
          const attachments = await tx.attachment.findMany({
            where: {
              sessionId: source.id,
              OR: [{ messageId: null }, { messageId: { in: visibleIds } }],
            },
          })
          if (attachments.length > 0) {
            await tx.attachment.createMany({
              data: attachments.map((a) => ({
                sessionId: forkedSessionId,
                id: a.id,
                ownerId: a.ownerId,
                ...(a.messageId !== null ? { messageId: messageIdMap.get(a.messageId) ?? null } : {}),
                fileName: a.fileName,
                mimeType: a.mimeType,
                size: a.size,
                sha256: a.sha256,
                path: a.path,
              })),
            })
          }
        }
      }

      // 源沙箱已删 → 空起步 + 系统消息（#768 D7「源已删则空起步+系统消息」）
      if (systemMessage) {
        const last = await tx.sessionMessage.findFirst({
          where: { sessionId: forkedSessionId },
          orderBy: { turn: 'desc' },
          select: { turn: true },
        })
        await tx.sessionMessage.create({
          data: {
            sessionId: forkedSessionId,
            turn: (last?.turn ?? 0) + 1,
            role: 'system',
            content: '源会话的沙箱不存在，新会话从空白文件环境开始。',
          },
        })
      }
    })
  }

  // 活跃行读取（rewind/fork/残留清理共用投影判定输入）：只取未归档行——归档行产品面不可读、
  // 不可作锚点/切点（#770 无恢复入口；R 评审：连续/向前 rewind 到被放弃分支须 90002 而非
  // 把指针指进归档区）。挂靠判定在未归档集内自洽（归档行不再参与可见性传播）。
  private async listHistoryRows(sessionId: string): Promise<HistoryRowLite[]> {
    const rows = await this.deps.prisma.sessionMessage.findMany({
      where: { sessionId, archivedAt: null },
      orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, turn: true, role: true, anchorCheckpointId: true, createdAt: true },
    })
    return rows
  }

  // thread 的未归档 checkpointId → parentCheckpointId 查找表（rewind/fork/残留清理共用）：
  // 链行走只在活跃（未归档）图上进行——归档行不参与祖先链（被放弃分叉不复活）。
  private async checkpointParentLookup(sessionId: string): Promise<Map<string, string | null>> {
    const cps = await this.deps.prisma.checkpoint.findMany({
      where: { threadId: sessionId, archivedAt: null },
      select: { checkpointId: true, parentCheckpointId: true },
    })
    return new Map(cps.map((c) => [c.checkpointId, c.parentCheckpointId]))
  }

  // 活跃行里最新带锚 assistant 锚点（fork 缺省切点解析面；无 → null）
  private latestAnchoredId(rows: readonly HistoryRowLite[]): string | null {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!
      if (r.role === 'assistant' && r.anchorCheckpointId !== null) return r.anchorCheckpointId
    }
    return null
  }

  // 锚点链之外的活跃行归档写操作（rewind 与 sendMessage 残留清理共用）
  private archiveRowWrites(
    sessionId: string,
    rows: readonly HistoryRowLite[],
    anchorChain: ReadonlySet<string>,
    now: Date,
  ): PrismaPromise<unknown>[] {
    const visible = visibleRowIds(rows, anchorChain)
    if (visible.size === rows.length) return []
    const stale = rows.filter((r) => !visible.has(r.id)).map((r) => r.id)
    return [
      this.deps.prisma.sessionMessage.updateMany({
        where: { sessionId, id: { in: stale } },
        data: { archivedAt: now },
      }),
    ]
  }

  // sendMessage 残留清理（rewind 态专属，R 评审重写）：指针在函数内重读（入口快照可能落后于
  // 上一轮 completed 的指针推进——按旧链归档会误伤刚完成的成功轮）；参照链取「指针 ∪ 行面最新
  // 锚点」中的较新者（recordTurn 已落行、指针推进未至的窗口内以行面锚为准，同步消除误伤）。
  // 未 rewind 会话（指针 null）不清理——全量历史保留（回放零差异）。只清消息行不扫 checkpoint：
  // 失败轮超步残留（checkpoint 面）由下一次 rewind 的差集归档收口（sendMessage 时点在 completed
  // 观测窗口内扫 checkpoint 会误伤刚完成轮的落盘行，故不扫——残留只影响缺省寻址的「最新」，而
  // 新轮 checkpoint 恒更新）。
  private async archiveRowsOffAnchor(sessionId: string): Promise<void> {
    const current = await this.deps.prisma.session.findUnique({
      where: { id: sessionId },
      select: { activeCheckpointId: true },
    })
    const pointer = current?.activeCheckpointId ?? null
    if (pointer === null) return
    const [rows, parentOf] = await Promise.all([
      this.listHistoryRows(sessionId),
      this.checkpointParentLookup(sessionId),
    ])
    const parentOfFn = (id: string) => parentOf.get(id) ?? null
    const rowHead = this.latestAnchoredId(rows)
    const ref =
      rowHead !== null && rowHead !== pointer && anchorChainOf(parentOfFn, rowHead).has(pointer)
        ? rowHead
        : pointer
    const writes = this.archiveRowWrites(sessionId, rows, anchorChainOf(parentOfFn, ref), new Date())
    if (writes.length > 0) await this.deps.prisma.$transaction(writes)
  }

  private publishSessionEvent(
    userId: string,
    type: 'session.created' | 'session.updated' | 'session.invalidated',
    payload: Record<string, unknown>,
    sessionId: string,
  ): void {
    this.deps.hub.publish(userId, { type, sessionId, payload })
  }
}
