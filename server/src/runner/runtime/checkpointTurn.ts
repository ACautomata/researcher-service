// checkpointTurn —— LangGraph checkpoint messages → TurnSnapshot 纯逻辑（#779）。
//
// 「补偿 = 重拉投影 + in-flight 从 checkpoint blob 反序列化重建」（#747 C 节断线补偿）的
// 反序列化面：PoC S3 已验证 blob 自包含（messages 通道即完整消息历史），本模块把「最后一条
// human 之后的产出」聚合为 TurnSnapshot（TurnReducer 同形状）。两个消费面共用单一实现：
//   story 11  inFlightProjection（投影 GET inFlight 字段——重连重建进行中 turn，即焚 token
//             事件的补偿真相源）
//   story 14  recover run 终态落行（断点前内容只在 blob，聚合以终态 checkpoint 为准）
//
// 与流式 reducer（TurnReducer）的结构差异（记录不补偿）：durationMs 无 blob 来源（缺省）；
// tool input 为 JSON.stringify(args)（流式面为投影截断文本）——形状同为 string，前端单管线
// 渲染不受影响。防御纪律：非 BaseMessage 形状条目跳过（blob 演进容忍，绝不抛）。

import { TOOL_DETAILS_MAX_BYTES, TOOL_INPUT_MAX_BYTES } from './values'
import { truncateUtf8 } from './projector'
import type { TurnSnapshot, ToolLine } from '../../sessions/reducer'

// 入参宽进形状：checkpoint channel_values.messages（BaseMessage 运行时面的结构子集——
// 从 blob 反序列化回真实例，字段访问全防御）。

interface ContentBlockLike {
  type?: unknown
  text?: unknown
  thinking?: unknown
}

interface ToolCallLike {
  id?: unknown
  name?: unknown
  args?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function msgType(m: unknown): string | null {
  if (!isRecord(m)) return null
  // BaseMessage._getType() 是实例方法（LangChain 消息运行时唯一形态）
  const fn = (m as { _getType?: unknown })._getType
  if (typeof fn === 'function') {
    try {
      const t = (fn as () => unknown).call(m)
      if (typeof t === 'string') return t
    } catch {
      return null
    }
  }
  return null
}

function blocksOf(m: unknown): ContentBlockLike[] {
  const content = isRecord(m) ? m.content : undefined
  if (Array.isArray(content)) return content as ContentBlockLike[]
  return []
}

function toolCallsOf(m: unknown): ToolCallLike[] {
  const tcs = isRecord(m) ? m.tool_calls : undefined
  return Array.isArray(tcs) ? (tcs as ToolCallLike[]) : []
}

// 「最后一条 human 之后的产出」→ TurnSnapshot。无尾部 human（上一轮已完成）→ 空 turn。
export function turnFromCheckpointMessages(messages: unknown): TurnSnapshot {
  const list = Array.isArray(messages) ? messages : []
  let anchor = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (msgType(list[i]) === 'human') {
      anchor = i
      break
    }
  }
  const contentParts: string[] = []
  let thinking = ''
  const tools = new Map<string, ToolLine>()
  const human = list[anchor]
  const kwargs = isRecord(human) ? human.additional_kwargs : undefined
  const ingestion = isRecord(kwargs) ? kwargs.researcherAttachmentIngestion : undefined
  if (isRecord(ingestion) && ingestion.name === 'ingest_attachments' && ingestion.state === 'success'
    && typeof ingestion.toolCallId === 'string' && typeof ingestion.input === 'string'
    && typeof ingestion.durationMs === 'number' && Number.isFinite(ingestion.durationMs) && ingestion.durationMs >= 0) {
    const { text, truncated } = truncateUtf8(ingestion.input, TOOL_INPUT_MAX_BYTES)
    tools.set(ingestion.toolCallId, {
      toolCallId: ingestion.toolCallId, name: 'ingest_attachments', state: 'success', input: text,
      durationMs: ingestion.durationMs, ...(truncated ? { truncated: true } : {}),
    })
  }

  for (let i = anchor + 1; i < list.length; i++) {
    const m = list[i]
    const type = msgType(m)
    if (type === 'ai') {
      for (const block of blocksOf(m)) {
        if (block?.type === 'text' && typeof block.text === 'string') contentParts.push(block.text)
        if (block?.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking
      }
      for (const tc of toolCallsOf(m)) {
        const id = typeof tc.id === 'string' ? tc.id : null
        const name = typeof tc.name === 'string' ? tc.name : null
        if (!id || name === null || tools.has(id)) continue
        const input = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {})
        const { text, truncated } = truncateUtf8(input, TOOL_INPUT_MAX_BYTES)
        tools.set(id, {
          toolCallId: id,
          name,
          input: text,
          state: 'running',
          ...(truncated ? { truncated: true } : {}),
        })
      }
      continue
    }
    if (type === 'tool') {
      const callId = isRecord(m) && typeof m.tool_call_id === 'string' ? m.tool_call_id : null
      const line = callId ? tools.get(callId) : undefined
      if (!line) continue
      const status = isRecord(m) ? m.status : undefined
      line.state = status === 'error' ? 'error' : 'success'
      const content = isRecord(m) ? m.content : undefined
      if (typeof content === 'string') {
        const { text, truncated } = truncateUtf8(content, TOOL_DETAILS_MAX_BYTES)
        line.details = text
        if (truncated) line.truncated = true
      }
    }
  }

  const content = contentParts.join('')
  return {
    content,
    ...(thinking !== '' ? { thinking } : {}),
    ...(tools.size > 0 ? { tools: [...tools.values()] } : {}),
  }
}
