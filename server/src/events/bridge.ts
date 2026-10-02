import type { CatalogEvent } from './logic'

// 事件桥薄投影骨架（接缝 S3，issue #773；#747 C 节 / #726「薄投影」决策）。
// runner（LangGraph，后续票）streamEvents 的订阅者调 projectStreamEvent 把上游
// protocol events 翻译为自有 SSE 事件目录——**不透传**（PoC 坑 1：LC 事件形态随版本漂移，
// 上游目录再大也只在白名单内翻译）。langchain 依赖随运行时基座票引入，本文件只依赖
// 上游事件的结构子集（StreamEventLike），多出的字段一律不进投影输出。

// LangChain streamEvents 事件的最小结构子集（v2）。
export interface StreamEventLike {
  readonly event: string
  readonly run_id?: string
  readonly data?: unknown
}

// 投影上下文：run 域事件挂在会话上（LangGraph thread_id = sessionId，#727）。
export interface ProjectionContext {
  readonly sessionId?: string
}

// AIMessageChunk content 块的最小结构子集——白名单只认 text / thinking / reasoning 块，
// 其余块（tool_call、image 等）跳过不进目录。
interface ContentBlockLike {
  readonly type?: unknown
  readonly text?: unknown
  readonly thinking?: unknown
  readonly reasoning?: unknown
}

// 单块投影：text 块 → text.delta；thinking/reasoning 块 → thinking.delta（与 text 分轨，
// #747 C 节目录）；未命中白名单 → null。
function projectBlock(
  block: ContentBlockLike,
  ctx: ProjectionContext,
  runId: string | undefined,
): CatalogEvent | null {
  if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
    return { type: 'text.delta', sessionId: ctx.sessionId, runId, payload: { delta: block.text } }
  }
  if (block.type === 'thinking' || block.type === 'reasoning') {
    // 块内容字段随版本漂移：新形态 thinking，旧形态 reasoning——两者都收。
    const delta =
      typeof block.thinking === 'string' ? block.thinking
      : typeof block.reasoning === 'string' ? block.reasoning
      : null
    if (delta !== null && delta !== '') {
      return { type: 'thinking.delta', sessionId: ctx.sessionId, runId, payload: { delta } }
    }
  }
  return null
}

// 白名单翻译：on_chat_model_stream 的 AIMessageChunk → 自有目录事件数组（一 chunk 可含
// 多块，逐块翻译）。真实上游两种 content 形态：
//   string  —— 纯文本 token 直出 → text.delta；
//   Block[] —— reasoning/thinking 模型的块数组（注意 chunk.type 恒为消息类型 'ai'，
//              块类型在**块**上——按 chunk.type 判 reasoning 对真实上游永不命中）。
// 未命中白名单 → 空数组（订阅者跳过，绝不透传上游事件）。
export function projectStreamEvent(
  raw: StreamEventLike,
  ctx: ProjectionContext = {},
): CatalogEvent[] {
  if (raw.event !== 'on_chat_model_stream') return []
  const chunk = (raw.data as { chunk?: { content?: unknown } } | null)?.chunk
  if (!chunk || chunk.content === undefined || chunk.content === null) return []
  const content = chunk.content
  if (typeof content === 'string') {
    return content === ''
      ? []
      : [{ type: 'text.delta', sessionId: ctx.sessionId, runId: raw.run_id, payload: { delta: content } }]
  }
  if (Array.isArray(content)) {
    const out: CatalogEvent[] = []
    for (const block of content as ContentBlockLike[]) {
      if (!block || typeof block !== 'object') continue
      const projected = projectBlock(block, ctx, raw.run_id)
      if (projected) out.push(projected)
    }
    return out
  }
  return []
}

// streamEvents 调用参数（PoC 坑 2 锁定，#747 A 节生产硬约束）：version + configurable
// 必须同一参数对象——resume 时参数不同会静默 no-op 假 done。构造一次、首次调用与 resume
// 复用；冻结防就地篡改。thread_id = LangGraph thread（sessionId，#727）。
// version 'v3'（#777 实测锁定，修正 #773 骨架期 v2 假设）：deepagents 1.14 / langgraph
// 1.4 的 agent.streamEvents 以 v3 产出 protocol events（{method,params} 形态）——v2 经典
// on_* 形态对 v3 投影（RunProjector）全部不可见。三包升级时以探针复测。
export interface StreamEventsParams {
  readonly version: 'v3'
  readonly configurable: Readonly<{ thread_id: string }>
}

export function buildStreamEventsInvocation(threadId: string): StreamEventsParams {
  return Object.freeze({
    version: 'v3',
    configurable: Object.freeze({ thread_id: threadId }),
  })
}
