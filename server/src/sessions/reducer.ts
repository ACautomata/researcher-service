// TurnReducer —— 单 turn 聚合归约器（#778 · #747 C 节 attachmentsJson v1 / story 3「单管线渲染」
// 后端面）。消费 RunProjector 产出的 run 域目录事件（text.delta / thinking.delta / tool.start /
// tool.end），聚合为一条 assistant 消息行的结构（content/thinking/tools）。
//
// 双入口同构：「刷新回放与流式终态零差异」的验收基础——RunService 在 run 终态把本归约快照落
// session_messages 行（attachmentsJson），投影 GET 反序列化回同形状；前端（#730）实时消费同一
// 事件目录归约出同形状。纯逻辑（S3 接缝）：不触库、不发布事件，白名单外事件一律忽略（对齐
// RunProjector「多出的字段一律不进投影输出」纪律）。

import { TOOL_DETAILS_MAX_BYTES, TOOL_INPUT_MAX_BYTES } from '../runner/runtime/values'
import { truncateUtf8 } from '../runner/runtime/projector'
// type-only 环引：service 反向 import 本模块的 serializeAttachments（运行时无环，类型单向）
import type { SystemCommandResult } from './service'
// type-only：RejectionSource（#747 C 节 rejection.source 目录定稿二值）单一声明于漏斗审计面。
import type { RejectionSource } from '../runner/approval/audit'
// type-only：#959 轮次产物卡片行契约单一声明于 filejournal/turnFiles（聚合映射同址）。
import type { TurnFileRow } from '../runner/filejournal/turnFiles'

// attachmentsJson v1 的 tools 行（#747 C 节：toolCallId/name/input≤1k/result≤1k/state/durationMs/
// details?≤4KB + 截断标记）。截断纪律：RunProjector 事件侧已按同常量截（1k/4KB），本归约器
// 再截是防御面——幂等（已截文本再截不变），且归约器是纯逻辑接缝、可被非 projector 事件源
// 直灌（测试/前端同构），不信任单一上游。C 节 result 概念由 details 承载（#777 事件目录
// tool.end 无独立 result 字段）；rejection?（#783 审批漏斗拒绝红显——tool.end{rejection:
// {source, reason}} 目录载荷的保留位，实时 SSE 与回放投影零差异的依据，刷新后红显整行不消失；
// reason 同 input 纪律 ≤1k 防御截断，截断置行级 truncated 标记）。
export interface ToolLine {
  readonly toolCallId: string
  readonly name: string
  readonly input: string
  state: 'running' | 'success' | 'error'
  durationMs?: number
  details?: string
  truncated?: boolean
  rejection?: { source: RejectionSource; reason: string }
}

// #780 D9 媒体引用（attachmentsJson v1 可选 media 数组 + `attachment` 事件载荷，同一形状——
// 实时事件 ≡ 回放投影零差异）。agent→用户媒体块经 runner 校验/物化后建 Attachment 行，此处只
// 装引用不装字节（字节经 GET /attachments/:id/download）。
export interface MediaRef {
  readonly attachmentId: string
  readonly mime: string
  readonly size: number
  readonly fileName: string
  // width/height/durationMs 可选探测字段留白：服务端无媒体探测面，UX 由前端 blob 自派生兜底；探测实现归后续票。
  readonly width?: number
  readonly height?: number
  readonly durationMs?: number
}

export interface TurnSnapshot {
  readonly content: string
  readonly thinking?: string
  readonly tools?: ToolLine[]
  readonly media?: MediaRef[]
  // #959 轮次产物卡片：段级时隙（completed/interrupted）fileJournal 本 run 行聚合（turn.files
  // 事件同形状——实时事件 ≡ 回放投影零差异）。行契约见 filejournal/turnFiles.ts TurnFileRow。
  readonly files?: TurnFileRow[]
  // #960 截断计数：files 为截断后列出面（≤TURN_FILES_MAX_ROWS），filesTotal = 截断前行数
  // （payload.total——「等 N 个文件」计数行的回放面数据源；files 缺省即无卡，恒不落键）。
  readonly filesTotal?: number
  // #961 exec 提示行标记：本轮含 EXEC_TOOLS 调用（payload.hasExec === true 才置位——「有调用」
  // 非「有写入」，D6）；依附 files 块（无卡轮无帧即无标记），恒不落 false。
  readonly hasExec?: boolean
}

// RunService recordTurn 注入缝的载荷（run 终态的单 turn 聚合 + 终态 checkpoint 锚点）。
// 定义于归约器侧：缝两侧（runner/runtime/runService 与 sessions/service）共享单一声明，
// 避免 service↔runService 互相 import。
export interface RecordTurnPayload {
  readonly sessionId: string
  readonly runId: string
  readonly anchorCheckpointId: string | null
  readonly aggregate: TurnSnapshot
  /** text_trace_logs.status（#747 B 节双域第二份写的行口径）：run 终态语义——该轮 assistant
   *  generation completed → success；interrupted/suspended/aborted/failed（半成品 provenance，
   *  不留成功假象）→ failed。由 runService 在终态唯一判定并随载荷携带——锚有无不蕴含完成
   *  （interrupted 轮锚恒非空：终态推进先于 interrupt 判定），status 不得由锚推论。 */
  readonly status: 'success' | 'failed'
}

interface DeltaPayload {
  readonly delta?: unknown
}

interface ToolStartPayload {
  readonly toolCallId?: unknown
  readonly name?: unknown
  readonly input?: unknown
}

interface ToolEndPayload {
  readonly toolCallId?: unknown
  readonly name?: unknown
  readonly state?: unknown
  readonly durationMs?: unknown
  readonly details?: unknown
  readonly rejection?: unknown
}

const MAX = {
  input: TOOL_INPUT_MAX_BYTES,
  details: TOOL_DETAILS_MAX_BYTES,
}

// attachmentsJson v1 序列化（字段序稳定——「投影 GET 与实时流终态逐字节一致」的前提）。
// content 不入此 JSON——它是行独立列（schema.prisma SessionMessage.content）；本 JSON 只装
// 聚合面（thinking/tools/media），空聚合 = 列默认 {"v":1}。attachmentsJson 的唯一序列化实现：
// SessionService.recordTurn（run 终态落行）与投影侧快照比对共用，不允第二处漂移。
// command 元数据（#787 系统命令行）= 聚合面的第二合法形态：/new /model 行把命令结果挂此处，
// 幂等 replay 复原应答；读侧（toProjectionMessage / replayOrConflict）对未知键一律忽略，
// user 行与 assistant 行同列两形状不互染。
// content 不入参序列化（它是行独立列）——Partial 宽进：assistant 行传完整 TurnSnapshot，
// #787 系统命令行只传 command 聚合面。
export function serializeAttachments(snap: Partial<TurnSnapshot> & { command?: SystemCommandResult }): string {
  return JSON.stringify({
    v: 1,
    ...(snap.thinking !== undefined ? { thinking: snap.thinking } : {}),
    ...(snap.tools !== undefined ? { tools: snap.tools } : {}),
    ...(snap.media !== undefined && snap.media.length > 0 ? { media: snap.media } : {}),
    ...(snap.files !== undefined && snap.files.length > 0
      ? {
          files: snap.files,
          ...(snap.filesTotal !== undefined ? { filesTotal: snap.filesTotal } : {}),
          ...(snap.hasExec ? { hasExec: true } : {}),
        }
      : {}),
    ...(snap.command !== undefined ? { command: snap.command } : {}),
  })
}

// 空聚合判据（TurnSnapshot 接受面纯函数——TurnReducer.isEmpty 与 #779 checkpointTurn 产物
// 共用单一实现，「TurnSnapshot 增字段即静默漂移」的防漂移面）。hasExec 不列：依附 files 块
// （恒 true⇒files 非空，files 已列——无 files 的 hasExec 不会被写出），列入反而双计。
export function isEmptyTurnSnapshot(snap: TurnSnapshot): boolean {
  return (
    snap.content === '' &&
    (snap.thinking === undefined || snap.thinking === '') &&
    (snap.tools === undefined || snap.tools.length === 0) &&
    (snap.media === undefined || snap.media.length === 0) &&
    (snap.files === undefined || snap.files.length === 0)
  )
}

export class TurnReducer {
  private text = ''
  private think = ''
  private readonly tools = new Map<string, ToolLine>()
  private readonly media: MediaRef[] = []
  private readonly files: TurnFileRow[] = []
  private filesTotal: number | undefined = undefined
  private hasExec = false

  // 消费一条 run 域目录事件；白名单外（run.* / session.* / 未知）一律忽略，绝不抛。
  feed(event: { type: string; payload: unknown }): void {
    const payload = event.payload
    if (event.type === 'text.delta') {
      const delta = (payload as DeltaPayload | null)?.delta
      if (typeof delta === 'string') this.text += delta
      return
    }
    if (event.type === 'thinking.delta') {
      const delta = (payload as DeltaPayload | null)?.delta
      if (typeof delta === 'string') this.think += delta
      return
    }
    if (event.type === 'attachment') {
      // #780 D9：媒体块物化成功 → 引用进聚合（回放同形状；同一事件经 hub 发实时面）
      const p = payload as Partial<MediaRef> | null
      if (
        p &&
        typeof p.attachmentId === 'string' && p.attachmentId !== '' &&
        typeof p.mime === 'string' &&
        typeof p.size === 'number' &&
        typeof p.fileName === 'string'
      ) {
        this.media.push({
          attachmentId: p.attachmentId,
          mime: p.mime,
          size: p.size,
          fileName: p.fileName,
          ...(typeof p.width === 'number' ? { width: p.width } : {}),
          ...(typeof p.height === 'number' ? { height: p.height } : {}),
          ...(typeof p.durationMs === 'number' ? { durationMs: p.durationMs } : {}),
        })
      }
      return
    }
    if (event.type === 'turn.files') {
      // #959 轮次产物卡片：段级时隙（completed/interrupted——#972·R1 B 裁决分段按段出卡）
      // runService 聚合产物整帧入聚合（回放同形状；同一事件经 hub 发实时面）。行级校验门 0 信任——非法行丢弃不放大，整帧非数组忽略。
      // 单帧不变量：每 run 恰一帧（前端 applyEvent 按「整帧替换」消费——本处 append 在单帧
      // 下与之等价）；#960 物化回填发生在 runService 发帧前（回填第二帧两入口即分叉）。
      const p = payload as { files?: unknown; total?: unknown; hasExec?: unknown } | null
      if (!p || !Array.isArray(p.files)) return
      const rows: TurnFileRow[] = []
      for (const raw of p.files) {
        const f = raw as Partial<TurnFileRow> | null
        if (!f || typeof f.path !== 'string' || f.path === '') continue
        if (f.op !== 'created' && f.op !== 'modified' && f.op !== 'deleted') continue
        rows.push({
          path: f.path,
          op: f.op,
          ...(typeof f.attachmentId === 'string' && f.attachmentId !== '' ? { attachmentId: f.attachmentId } : {}),
          ...(typeof f.fileName === 'string' && f.fileName !== '' ? { fileName: f.fileName } : {}),
          ...(typeof f.size === 'number' ? { size: f.size } : {}),
        })
      }
      if (rows.length === 0) return
      this.files.push(...rows)
      // #960 截断计数：total 须 number 且 ≥ 列出数（截断前行数不可能小于列出面——0 信任
      // 非法值丢弃用缺省 = 列出数，不截断即无计数行）。
      this.filesTotal =
        typeof p.total === 'number' && Number.isFinite(p.total) && p.total >= rows.length ? p.total : rows.length
      // #961 exec 提示行标记：仅 true 置位（0 信任——非 true 一律不落键；单帧不变量同 files：
      // 每 run 恰一帧，整帧替换语义下重复帧幂等）。
      if (p.hasExec === true) this.hasExec = true
      return
    }
    if (event.type === 'tool.start') {
      const p = payload as ToolStartPayload | null
      if (!p) return
      const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : null
      const name = typeof p.name === 'string' ? p.name : null
      if (!toolCallId || name === null || this.tools.has(toolCallId)) return
      const input = typeof p.input === 'string' ? p.input : ''
      const { text, truncated } = truncateUtf8(input, MAX.input)
      this.tools.set(toolCallId, {
        toolCallId,
        name,
        input: text,
        state: 'running',
        ...(truncated ? { truncated: true } : {}),
      })
      return
    }
    if (event.type === 'tool.end') {
      const p = payload as ToolEndPayload | null
      if (!p) return
      const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : null
      if (!toolCallId) return
      const line = this.tools.get(toolCallId)
      if (!line) return
      if (p.state === 'success' || p.state === 'error') line.state = p.state
      if (typeof p.durationMs === 'number') line.durationMs = p.durationMs
      if (typeof p.details === 'string') {
        const { text, truncated } = truncateUtf8(p.details, MAX.details)
        line.details = text
        if (truncated) line.truncated = true
      }
      // #783 拒绝红显：tool.end{rejection:{source, reason}} 进聚合（0 信任——形态不合法
      // 一律丢弃，不炸归约；仅黑名单/judge 二值来源进保留位，与目录定稿同值集）。reason
      // 防御截断 ≤1k 对齐 input（上游 publishRejection/漏斗 notice.reason 无截断面——
      // 归约器不信任单一上游，同函数 input/details 二次防御纪律）；截断置 truncated 标记。
      const r = p.rejection as { source?: unknown; reason?: unknown } | null
      if (r && (r.source === 'blacklist' || r.source === 'judge') && typeof r.reason === 'string') {
        const { text, truncated } = truncateUtf8(r.reason, MAX.input)
        line.rejection = { source: r.source, reason: text }
        if (truncated) line.truncated = true
      }
    }
  }

  // 聚合为空（无 delta、无工具、无媒体）——终态空 run 不落行的判据（failed 立即等场景）。
  isEmpty(): boolean {
    return isEmptyTurnSnapshot(this.snapshot())
  }

  // 当前聚合快照（投影形状：thinking/tools/media 仅在有内容时出现——字段缺省即「无」，非空串）。
  snapshot(): TurnSnapshot {
    return {
      content: this.text,
      ...(this.think !== '' ? { thinking: this.think } : {}),
      ...(this.tools.size > 0 ? { tools: [...this.tools.values()] } : {}),
      ...(this.media.length > 0 ? { media: [...this.media] } : {}),
      ...(this.files.length > 0
        ? { files: [...this.files], filesTotal: this.filesTotal ?? this.files.length, ...(this.hasExec ? { hasExec: true } : {}) }
        : {}),
    }
  }
}
