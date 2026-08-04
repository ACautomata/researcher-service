// #369 M5 前端接线：网关事件 → ChatView 渲染帧的纯翻译函数（无 I/O 无状态，除 _sent 累积器）。
// 移植 backend/chat/event_translate.py（实测校准：ghcr 2026.6.34 / ADR 0003 / issue #153/#154）。
// 协议 v4 事件（官方 ./browser 协议机 onEvent）→ 与旧自定义 wire 同构的 ChatFrame 列表。
// 一帧网关事件可产 0..N 帧；delta 增量按 runId 累积已发文本（_sent）支持 replace 快照 / final 尾部补发。

// 翻译输出的渲染帧（对齐 ChatView 现有 onText/onDone/onError/onApproval/onApprovalResolved/onTool 签名）。
export type ChatFrame =
  | { type: 'text'; runId: string; delta: string; replace?: boolean }
  | { type: 'done'; runId: string }
  | { type: 'error'; runId: string; message: string }
  | { type: 'approval'; id: string; kind: string; command: string; sessionKey: string | null }
  | { type: 'approvalResolved'; id: string; decision: string }
  | {
      type: 'tool'
      runId: string
      name: string
      state: 'running' | 'done' | 'error'
      id: string | null
      title: unknown
      input: unknown
      result: unknown
      isError?: boolean
    }

// 网关 onEvent 回调的帧（官方 EventFrame 的窄化投影；payload 无严格 schema，0 信任防御取值）。
export interface GatewayEventFrame {
  type: string
  event?: string
  payload?: unknown
}

// 审批事件名（连接级广播，不挂 chat runId；实测校准 wire/values.py）
const APPROVAL_REQUESTED_EVENTS = ['exec.approval.requested', 'plugin.approval.requested'] as const
const APPROVAL_RESOLVED_EVENTS = ['exec.approval.resolved', 'plugin.approval.resolved'] as const
// 工具事件（实测校准：event:'agent' + payload.stream:'tool' + payload.data.phase）
const TOOL_AGENT_EVENT = 'agent'
const TOOL_STREAM = 'tool'

// delta state 下增量字段；replace=true + message 快照时改发 replace 帧（整段替换）
const DELTA_TEXT = 'deltaText'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

// 从 final/delta 的 message 提取文本（实测校准 spike ghcr 2026.6.34-browser, 2026-07-27）：
// message 实测是 dict {role, content:[{type:text,text}], timestamp}；str 直返；dict 拼 content 中
// type=text 的 text；None/空 → ''。
export function extractMessageText(message: unknown): string {
  if (!message) return ''
  if (typeof message === 'string') return message
  const obj = asRecord(message)
  const content = obj.content
  if (Array.isArray(content)) {
    return content
      .map((b) => (asRecord(b).type === 'text' && typeof asRecord(b).text === 'string' ? (asRecord(b).text as string) : ''))
      .join('')
  }
  return ''
}

export class ChatEventTranslator {
  // runId → 已发文本累积；final 尾部补发 / replace 整段替换时用于求差集或覆盖
  private readonly sent = new Map<string, string>()

  translate(frame: GatewayEventFrame): ChatFrame[] {
    if (frame.type !== 'event') return []
    const event = frame.event ?? ''
    const payload = frame.payload ? asRecord(frame.payload) : {}
    // 审批事件是连接级广播（不挂 chat runId，r26:88）→ 单独翻译出卡，不进 chat 分支
    if ((APPROVAL_REQUESTED_EVENTS as readonly string[]).includes(event)) {
      const card = this.approvalCard(event, payload)
      return card ? [card] : []
    }
    // 他端 resolve 后的网关 resolved 事件（codex R3 P2）→ approvalResolved 帧收敛 peer 卡
    if ((APPROVAL_RESOLVED_EVENTS as readonly string[]).includes(event)) {
      const resolved = this.approvalResolved(payload)
      return resolved ? [resolved] : []
    }
    // 工具生命周期事件（实测校准：event:agent + stream:tool + phase；旧假设独立事件从不触发 #153）
    if (event === TOOL_AGENT_EVENT) {
      if (payload.stream === TOOL_STREAM) {
        return this.translateTool(payload, String((asRecord(payload.data).phase) ?? ''))
      }
      return []
    }
    if (event !== 'chat') return []
    const runId = typeof payload.runId === 'string' ? payload.runId : ''
    if (!runId) return []
    const state = payload.state
    if (state === 'delta') return this.translateDelta(runId, payload)
    if (state === 'final') return this.translateFinal(runId, payload)
    if (state === 'aborted') {
      this.sent.delete(runId)
      return [{ type: 'done', runId }]
    }
    if (state === 'error') {
      this.sent.delete(runId)
      // 网关 error 字段为 errorMessage（缺则退 errorKind），对齐 openclaw_service / r13:118
      const message = String(payload.errorMessage ?? payload.errorKind ?? '')
      return [{ type: 'error', runId, message }]
    }
    return []
  }

  private translateDelta(runId: string, payload: Record<string, unknown>): ChatFrame[] {
    if (payload.replace) {
      const snapshot = extractMessageText(payload.message)
      if (snapshot) {
        // replace=true + 快照：整段替换（前缀/非前缀均正确）。前端按 replace 标志 set 而非 append
        this.sent.set(runId, snapshot)
        return [{ type: 'text', runId, delta: snapshot, replace: true }]
      }
      // 无快照 → 退回 deltaText 增量（追加），对齐 r13:127「若无 message，发 deltaText」
      const delta = typeof payload[DELTA_TEXT] === 'string' ? (payload[DELTA_TEXT] as string) : ''
      if (!delta) return []
      this.sent.set(runId, (this.sent.get(runId) ?? '') + delta)
      return [{ type: 'text', runId, delta }]
    }
    const delta = typeof payload[DELTA_TEXT] === 'string' ? (payload[DELTA_TEXT] as string) : ''
    if (!delta) return []
    this.sent.set(runId, (this.sent.get(runId) ?? '') + delta)
    return [{ type: 'text', runId, delta }]
  }

  private translateFinal(runId: string, payload: Record<string, unknown>): ChatFrame[] {
    const out: ChatFrame[] = []
    const message = extractMessageText(payload.message)
    const sent = this.sent.get(runId) ?? ''
    // final.message 可能含此前未在 delta 投递的尾部文本 → 先补 text 再 done（r13:128-129）
    if (message && message.startsWith(sent) && message.length > sent.length) {
      const tail = message.slice(sent.length)
      this.sent.set(runId, sent + tail)
      out.push({ type: 'text', runId, delta: tail })
    }
    out.push({ type: 'done', runId })
    this.sent.delete(runId)
    return out
  }

  // 待审批事件 payload → 前端审批卡帧；无稳定审批 id 返回 null（无法 resolve，不出卡）。
  // kind 缺省时从事件名族派生（exec/plugin）；sessionKey 透传自 request.sessionKey
  // （issue #154 实测校准：systemRunPlan 实测为 null，command/sessionKey 在 payload.request 下）。
  private approvalCard(event: string, payload: Record<string, unknown>): ChatFrame | null {
    const approvalId = typeof payload.id === 'string' ? payload.id : ''
    if (!approvalId) return null
    const req = asRecord(payload.request)
    const runPlan = asRecord(payload.systemRunPlan)
    let command = ''
    let sessionKey: string | null = null
    if (Object.keys(req).length > 0) {
      command = typeof req.command === 'string' ? req.command : ''
      sessionKey = typeof req.sessionKey === 'string' ? req.sessionKey : null
    } else {
      command =
        (typeof runPlan.rawCommand === 'string' ? runPlan.rawCommand : '') ||
        (typeof runPlan.command === 'string' ? runPlan.command : '') ||
        (typeof payload.command === 'string' ? payload.command : '')
      sessionKey = typeof runPlan.sessionKey === 'string' ? runPlan.sessionKey : null
    }
    return {
      type: 'approval',
      id: approvalId,
      kind: typeof payload.kind === 'string' && payload.kind ? (payload.kind as string) : event.split('.')[0],
      command,
      sessionKey,
    }
  }

  // 网关 resolved 事件 payload → 前端 approvalResolved 帧；无 id 返回 null（不伪造，跳过）。
  private approvalResolved(payload: Record<string, unknown>): ChatFrame | null {
    const approvalId = typeof payload.id === 'string' ? payload.id : ''
    if (!approvalId) return null
    return {
      type: 'approvalResolved',
      id: approvalId,
      decision: typeof payload.decision === 'string' ? payload.decision : '',
    }
  }

  // 工具生命周期事件 payload → 工具帧。字段在 data 子对象下：name/toolCallId/args（start）、
  // result/isError/meta（result）。phase 映射：start→running / update→跳过（前端已有 start 行，
  // 避免重复行 codex #162 P2）/ result→done|error；未知 phase → []（0 信任，不猜测）。
  private translateTool(payload: Record<string, unknown>, phase: string): ChatFrame[] {
    if (phase !== 'start' && phase !== 'result') return []
    const runId = typeof payload.runId === 'string' ? payload.runId : ''
    if (!runId) return []
    const data = asRecord(payload.data)
    const name = typeof data.name === 'string' ? data.name : ''
    if (!name) return []
    const isError = phase === 'result' ? Boolean(data.isError) : false
    return [
      {
        type: 'tool',
        runId,
        name,
        state: phase === 'start' ? 'running' : isError ? 'error' : 'done',
        id: typeof data.toolCallId === 'string' ? data.toolCallId : null,
        title: data.title ?? null,
        input: phase === 'start' ? (data.args ?? null) : null,
        result: phase === 'result' ? (data.result ?? null) : null,
        isError,
      },
    ]
  }
}
