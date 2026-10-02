// TurnReducer —— 单 turn 聚合归约器（#778 · #747 C 节 attachmentsJson v1 / story 3「单管线渲染」
// 后端面）。消费 RunProjector 产出的 run 域目录事件（text.delta / thinking.delta / tool.start /
// tool.end），聚合为一条 assistant 消息行的结构（content/thinking/tools）。
//
// 双入口同构：「刷新回放与流式终态零差异」的验收基础——RunService 在 run 终态把本归约快照落
// session_messages 行（attachmentsJson），投影 GET 反序列化回同形状；前端（#730）实时消费同一
// 事件目录归约出同形状。纯逻辑（S3 接缝）：不触库、不发布事件，白名单外事件一律忽略（对齐
// RunProjector「多出的字段一律不进投影输出」纪律）。

import { TOOL_DETAILS_MAX_BYTES, TOOL_INPUT_MAX_BYTES, TRUNCATED_FLAG } from '../runner/runtime/values'
import { truncateUtf8 } from '../runner/runtime/projector'

// attachmentsJson v1 的 tools 行（#747 C 节：toolCallId/name/input≤1k/result≤1k/state/durationMs/
// details?≤4KB + 截断标记——截断已在 RunProjector 事件侧完成，本归约器信任事件形状不再截）。
// C 节 result 概念由 details 承载（#777 事件目录 tool.end 无独立 result 字段）；rejection
//（工具被拒）归 #783 审批漏斗——本票无审批面，事件目录无来源故不设保留位。
export interface ToolLine {
  readonly toolCallId: string
  readonly name: string
  readonly input: string
  state: 'running' | 'success' | 'error'
  durationMs?: number
  details?: string
  truncated?: boolean
}

export interface TurnSnapshot {
  readonly content: string
  readonly thinking?: string
  readonly tools?: ToolLine[]
}

interface DeltaPayload {
  readonly delta?: unknown
}

interface ToolStartPayload {
  readonly toolCallId?: unknown
  readonly name?: unknown
  readonly input?: unknown
  readonly [TRUNCATED_FLAG]?: unknown
}

interface ToolEndPayload {
  readonly toolCallId?: unknown
  readonly name?: unknown
  readonly state?: unknown
  readonly durationMs?: unknown
  readonly details?: unknown
  readonly [TRUNCATED_FLAG]?: unknown
}

const MAX = {
  input: TOOL_INPUT_MAX_BYTES,
  details: TOOL_DETAILS_MAX_BYTES,
}

// attachmentsJson v1 序列化（字段序稳定——「投影 GET 与实时流终态逐字节一致」的前提）。
// content 不入此 JSON——它是行独立列（schema.prisma SessionMessage.content）；本 JSON 只装
// 聚合面（thinking/tools），空聚合 = 列默认 {"v":1}。模块级共享：TurnReducer.toAttachmentsJson
// 与 SessionService.recordTurn（run 终态落行）同一实现——单一来源，不允两处漂移。
export function serializeAttachments(snap: TurnSnapshot): string {
  return JSON.stringify({
    v: 1,
    ...(snap.thinking !== undefined ? { thinking: snap.thinking } : {}),
    ...(snap.tools !== undefined ? { tools: snap.tools } : {}),
  })
}

export class TurnReducer {
  private text = ''
  private think = ''
  private readonly tools = new Map<string, ToolLine>()

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
    }
  }

  // 聚合为空（无 delta、无工具）——终态空 run 不落行的判据（failed 立即等场景）。
  isEmpty(): boolean {
    return this.text === '' && this.think === '' && this.tools.size === 0
  }

  // 当前聚合快照（投影形状：thinking/tools 仅在有内容时出现——字段缺省即「无」，非空串）。
  snapshot(): TurnSnapshot {
    return {
      content: this.text,
      ...(this.think !== '' ? { thinking: this.think } : {}),
      ...(this.tools.size > 0 ? { tools: [...this.tools.values()] } : {}),
    }
  }

  toAttachmentsJson(): string {
    return serializeAttachments(this.snapshot())
  }
}
