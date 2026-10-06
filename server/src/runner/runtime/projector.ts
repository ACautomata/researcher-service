// RunProjector —— run 域事件桥（#777 · #747 C 节「事件桥：streamEvents 薄投影 → 自有 SSE
// 事件目录，不透传 LangChain 事件」）。消费 deepagents/LangGraph streamEvents v3 的 protocol
// events（#724 PoC 坑 1 实测形态：{method, params:{data}}），白名单翻译为自有目录事件：
//
//   messages/content-block-delta {delta:{type:'text-delta',text}}      → text.delta
//   messages/content-block-delta {delta:{type:'thinking-delta',…}}     → thinking.delta（分轨）
//   tools/tool-started {tool_call_id, tool_name, input}                → tool.start
//   tools/tool-finished {tool_call_id, output:ToolMessage}             → tool.end
//
// 其余 method（lifecycle/tasks/updates/values/checkpoints）与未命中白名单的子事件一律丢弃
// ——「多出的字段一律不进投影输出」（#773 bridge 纪律；LC 事件形态随版本漂移，透传即腐化）。
// v2 经典形态（on_chat_model_stream）的翻译保留在 events/bridge.ts（骨架期已锁定），本投影
// 只认运行时真实主路径 v3。
//
// 有状态面（单 run 内）：tool.start → tool.end 的 durationMs 计时（tool_call_id → 起始时刻，
// clock 由 feed 入参注入保证确定性测试）；未见 start 的 finish（理论不可达）durationMs 记 0。
// 投影绝不抛——上游事件畸形（字段缺失/类型漂移）按未命中丢弃，不放大为 run 故障。

import type { CatalogEvent } from '../../events/logic'
import { TOOL_DETAILS_MAX_BYTES, TOOL_INPUT_MAX_BYTES, TRUNCATED_FLAG } from './values'

// v3 protocol event 的最小结构子集。
interface ProtocolEventLike {
  readonly method?: unknown
  readonly params?: { readonly data?: unknown } | null
}

interface ToolStartedData {
  readonly event?: unknown
  readonly tool_call_id?: unknown
  readonly tool_name?: unknown
  readonly input?: unknown
}

interface ToolFinishedData {
  readonly event?: unknown
  readonly tool_call_id?: unknown
  readonly output?: { readonly kwargs?: { readonly status?: unknown; readonly content?: unknown; readonly artifact?: unknown; readonly name?: unknown } } | null
}

interface ContentDeltaData {
  readonly event?: unknown
  readonly run_id?: unknown
  readonly index?: unknown
  readonly delta?: { readonly type?: unknown; readonly text?: unknown; readonly thinking?: unknown; readonly reasoning?: unknown } | null
  readonly content?: { readonly type?: unknown; readonly text?: unknown; readonly thinking?: unknown; readonly reasoning?: unknown } | null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

// UTF-8 字节上限截断（C 节「≤4KB / ≤1k」按字节计；中文最坏 3x 膨胀，按字符截断会超预算）。
// 回退 continuation bytes 保证不切出残字符；未超限原样返回。
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  const buf = Buffer.from(text, 'utf8')
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true }
}

// 工具结果 details 序列化：字符串原样；其余 JSON（循环/BigInt 由调用面兜底——上游
// ToolMessage.content 恒为字符串或块数组，防御面仅防版本漂移）。
function serializeDetails(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? ''
  } catch {
    return ''
  }
}

export class RunProjector {
  private readonly toolStarts = new Map<string, number>()
  // (runId:index) → 该块已发过 delta（流式形态）；finish 时据此跳过整块防重复。
  // 非流式合成形态（整块 chunk：start+finish、无 delta，探针实测）由 finish 补投影，
  // 保证 fallback/非流式模型不丢正文与 thinking。
  private readonly blocksWithDelta = new Set<string>()

  // 消费一个上游 protocol event，产出 0..n 条自有目录事件。sessionId/runId 由调用方
  // （RunService）统一盖印——投影只产出类型与 payload，归属字段单一来源。
  feed(raw: unknown, now: number): Omit<CatalogEvent, 'sessionId' | 'runId'>[] {
    const ev = asRecord(raw)
    if (!ev) return []
    if (typeof ev.method !== 'string') return []
    const data = asRecord((ev.params as ProtocolEventLike['params'] | undefined)?.data)
    if (!data) return []

    if (ev.method === 'messages') {
      return this.feedMessages(data as unknown as ContentDeltaData)
    }
    if (ev.method === 'tools') {
      if (data.event === 'tool-started') return this.feedToolStarted(data as unknown as ToolStartedData, now)
      if (data.event === 'tool-finished') return this.feedToolFinished(data as unknown as ToolFinishedData, now)
    }
    return []
  }

  private blockKey(data: { run_id?: unknown; index?: unknown }): string {
    return `${asString(data.run_id) ?? ''}:${String(data.index ?? '')}`
  }

  private feedMessages(data: ContentDeltaData): Omit<CatalogEvent, 'sessionId' | 'runId'>[] {
    if (data.event === 'content-block-delta') {
      const delta = asRecord(data.delta)
      if (!delta) return []
      const type = asString(delta.type)
      if (type === 'text-delta') {
        const text = asString(delta.text)
        if (text === null || text === '') return []
        this.blocksWithDelta.add(this.blockKey(data))
        return [{ type: 'text.delta', payload: { delta: text } }]
      }
      // thinking 分轨：新形态 thinking-delta（字段 thinking），宽容 reasoning 变体——字段漂移
      // 收敛在白名单枚举，不透传未知形态。
      if (type === 'thinking-delta' || type === 'reasoning-delta') {
        const text =
          asString(delta.thinking) ?? asString(delta.reasoning) ?? asString(delta.text)
        if (text === null || text === '') return []
        this.blocksWithDelta.add(this.blockKey(data))
        return [{ type: 'thinking.delta', payload: { delta: text } }]
      }
      return []
    }
    // 非流式合成形态：content-block-finish 携完整块且该块从未有 delta → 补投影
    //（content-block-start 与 finish 同内容，一律跳过）。
    if (data.event === 'content-block-finish') {
      const key = this.blockKey(data)
      if (this.blocksWithDelta.has(key)) return []
      const content = asRecord(data.content)
      if (!content) return []
      const type = asString(content.type)
      if (type === 'text') {
        const text = asString(content.text)
        if (text === null || text === '') return []
        this.blocksWithDelta.add(key)
        return [{ type: 'text.delta', payload: { delta: text } }]
      }
      if (type === 'thinking' || type === 'reasoning') {
        const text = asString(content.thinking) ?? asString(content.reasoning)
        if (text === null || text === '') return []
        this.blocksWithDelta.add(key)
        return [{ type: 'thinking.delta', payload: { delta: text } }]
      }
    }
    return []
  }

  private feedToolStarted(
    data: ToolStartedData,
    now: number,
  ): Omit<CatalogEvent, 'sessionId' | 'runId'>[] {
    const toolCallId = asString(data.tool_call_id)
    const name = asString(data.tool_name)
    if (toolCallId === null || name === null) return []
    this.toolStarts.set(toolCallId, now)
    const rawInput = asString(data.input) ?? ''
    const { text, truncated } = truncateUtf8(rawInput, TOOL_INPUT_MAX_BYTES)
    return [
      {
        type: 'tool.start',
        payload: {
          toolCallId,
          name,
          input: text,
          ...(truncated ? { [TRUNCATED_FLAG]: true } : {}),
        },
      },
    ]
  }

  private feedToolFinished(
    data: ToolFinishedData,
    now: number,
  ): Omit<CatalogEvent, 'sessionId' | 'runId'>[] {
    const toolCallId = asString(data.tool_call_id)
    if (toolCallId === null) return []
    // output 两种运行时形态（实测锁定）：ToolMessage 类实例（字段在顶层：name/content/
    // status/tool_call_id）与序列化信封 {lc,type,id,kwargs:{…}}（streamEvents 跨层序列化时）。
    // kwargs 优先、顶层兜底。
    const out = asRecord(data.output)
    const kwargs = asRecord(out?.kwargs) ?? out ?? {}
    const name = asString(kwargs.name) ?? ''
    const startedAt = this.toolStarts.get(toolCallId)
    this.toolStarts.delete(toolCallId)
    const durationMs = startedAt === undefined ? 0 : Math.max(0, now - startedAt)
    // LangChain ToolMessage status 语义（实测锁定）：成功态 status 缺省，失败态显式 'error'
    // ——缺省即 success，不得按「非 success 即 error」判。
    const state = kwargs.status === 'error' ? 'error' : 'success'
    // details 数据源（#788 R5 双面契约）：artifact 优先（插件工具经 ContentAndArtifact 的
    // 渲染面通道透传 manifest details），缺省回落序列化输出（核心工具行为不变）。
    const detailsSource = kwargs.artifact !== undefined ? kwargs.artifact : kwargs.content
    const { text, truncated } = truncateUtf8(serializeDetails(detailsSource), TOOL_DETAILS_MAX_BYTES)
    return [
      {
        type: 'tool.end',
        payload: {
          toolCallId,
          name,
          state,
          durationMs,
          details: text,
          ...(truncated ? { [TRUNCATED_FLAG]: true } : {}),
        },
      },
    ]
  }
}
