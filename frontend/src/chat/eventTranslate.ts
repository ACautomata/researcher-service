// #369 M5 前端接线：网关事件 → ChatView 渲染帧的纯翻译函数（无 I/O 无状态，除 _sent 累积器）。
// 移植 backend/chat/event_translate.py（实测校准：ghcr 2026.6.34 / ADR 0003 / issue #153/#154）。
// 协议 v4 事件（官方 ./browser 协议机 onEvent）→ 与旧自定义 wire 同构的 ChatFrame 列表。
// 一帧网关事件可产 0..N 帧；delta 增量按 runId 累积已发文本（_sent）支持 replace 快照 / final 尾部补发。

// 翻译输出的渲染帧（对齐 ChatView 现有 onText/onDone/onError/onApproval/onApprovalResolved/onTool 签名）。
export type ChatFrame =
  | { type: 'text'; runId: string; delta: string; replace?: boolean }
  | { type: 'done'; runId: string }
  // runId 可选：run 级错误挂 runId（前端按 runId 过滤）；无 runId 为连接/会话级错误（照常显示）
  | { type: 'error'; runId?: string; message: string }
  | { type: 'approval'; id: string; kind: string; command: string; sessionKey: string | null; agentId: string | null }
  | { type: 'approvalResolved'; id: string; decision: string }
  // #459-T3 #464：附件媒体帧——final/delta(replace) 消息 content 含 image/audio/video 块时产出
  // （run 级，挂 runId 走同款 runId 路由/锚定语义；与 text 帧独立数据通道，互不污染）
  | { type: 'attachment'; runId: string; media: MediaBlock[] }
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
// type=text 的 text；content 为 string（user 消息）直返；None/空 → ''。
// E1: 与 ChatView.loadHistory 历史消息复用——history 消息 content 多态（user=string /
// assistant=数组），此函数是内容提取的单一实现，历史路径不再另写只认 string 的逻辑。
export function extractMessageText(message: unknown): string {
  if (!message) return ''
  if (typeof message === 'string') return message
  const obj = asRecord(message)
  const content = obj.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (asRecord(b).type === 'text' && typeof asRecord(b).text === 'string' ? (asRecord(b).text as string) : ''))
      .join('')
  }
  return ''
}

// ---- #459-T3 #464：附件块提取（与 extractMessageText 并列的独立数据通道）----
// 历史消息（loadHistory）与流式消息（final/delta replace 快照）中的 image/audio/video 内容块
// → 渲染媒体数据。附件块此前被渲染层丢弃（extractMessageText 只认 text 块），本函数补齐非 text
// 媒体块的提取。**文本与附件不互相污染**：extractMessageText 仍只含 text 块（摘要/审计/claimedEmpty
// 判定等文本用途），媒体块只经本函数进 Msg.media，不进 Msg.text。
// 块 type 是归类依据（0 信任：mimeType 前缀与块 type 不一致时按块 type 归类，不猜测）。
export interface MediaBlock {
  type: 'image' | 'audio' | 'video'
  mimeType: string
  src: string // 纯 base64（剥 data:...;base64, 前缀）；组件侧重建完整 dataURL 供 <img>/<audio>/<video>
  fileName?: string // 原始文件名（有则供下载/无障碍标注）
}

const MEDIA_TYPES = ['image', 'audio', 'video'] as const

// 从 message.content[] 提取 image/audio/video 块 → MediaBlock[]（渲染数据）。
// 0 信任：仅取 string content（纯 base64）的块；缺失/非 string/空 content 跳过。
// content 多态同 extractMessageText（string message / 无 content → 无附件）。
export function extractMessageAttachments(message: unknown): MediaBlock[] {
  if (!message || typeof message === 'string') return []
  const obj = asRecord(message)
  const content = obj.content
  if (!Array.isArray(content)) return []
  const out: MediaBlock[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = asRecord(block)
    const type = typeof b.type === 'string' ? b.type : ''
    if (!(MEDIA_TYPES as readonly string[]).includes(type)) continue
    const src = typeof b.content === 'string' ? b.content : ''
    if (!src) continue // 无 string base64 内容 → 无法渲染，跳过
    // mimeType 缺失/非 string → 回退 `${type}/*`（组件重建完整 dataURL 须有 mime 段）。
    const mimeType = typeof b.mimeType === 'string' && b.mimeType ? b.mimeType : `${type}/*`
    out.push({
      type: type as MediaBlock['type'],
      mimeType,
      src,
      ...(typeof b.fileName === 'string' && b.fileName ? { fileName: b.fileName } : {}),
    })
  }
  return out
}

// 发送侧单附件（attachments.ts 采集/校验后的官方形状，type 已从 mimeType 主段派生）→ MediaBlock。
// 与 extractMessageAttachments 共用同一 MediaBlock 投影，避免发送 echo（useChatConnection.send）与
// 历史/流式提取两路各自重写「mimeType 主段派生 type / string content 门 / fileName 条件拷贝」而 drift
// （code-review Standards 轴）。content 非 string/空 → null（该附件无 echo 渲染数据，跳过）。
// 块 type 取自 a.type（采集层已校验白名单 image/audio/video）；mimeType 缺失回退 `${type}/*`。
export function attachmentToMediaBlock(a: {
  type?: string
  mimeType?: string
  fileName?: string
  content?: unknown
}): MediaBlock | null {
  const type = typeof a.type === 'string' ? a.type : ''
  if (!(MEDIA_TYPES as readonly string[]).includes(type)) return null
  const src = typeof a.content === 'string' ? a.content : ''
  if (!src) return null
  const mimeType = typeof a.mimeType === 'string' && a.mimeType ? a.mimeType : `${type}/*`
  return {
    type: type as MediaBlock['type'],
    mimeType,
    src,
    ...(typeof a.fileName === 'string' && a.fileName ? { fileName: a.fileName } : {}),
  }
}

export class ChatEventTranslator {
  // runId → 已发文本累积；final 尾部补发 / replace 整段替换时用于求差集或覆盖。
  // P2（code review）：有界清理——只在 aborted/error/final 终态删除会泄漏断线中断/外来 run 的
  // 条目（长连接内无界增长）；容量上限防御极端场景，连接生命周期边界（reset）由 gatewayChat
  // onHello 调用（断线 resume 从头重放也不双重追加）。
  private readonly sent = new Map<string, string>()
  private readonly MAX_SENT_ENTRIES = 500

  // 连接生命周期边界清空累积器（断线重连后旧 run 的已发文本作废——若网关 resume 从头重放，
  // 不清空会双重追加，直到 final 才 replace 纠正）。
  reset(): void {
    this.sent.clear()
  }

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
    const state = payload.state
    if (state === 'delta') {
      if (!runId) return [] // 无 runId 的 delta 无锚点，无法渲染
      return this.translateDelta(runId, payload)
    }
    if (state === 'final') {
      if (!runId) return []
      return this.translateFinal(runId, payload)
    }
    if (state === 'aborted') {
      if (!runId) return []
      this.sent.delete(runId)
      return [{ type: 'done', runId }]
    }
    if (state === 'error') {
      // P2（code review）：无 runId 的 chat.error（会话级，如「会话不存在」）不再返回 [] 静默丢弃
      // ——译成连接级错误帧（runId 缺省），ChatView.handleError 的 no-runId 分支（原为不可达死代码）
      // 现在真正消费；run 级错误挂 runId 走 runId 过滤。
      if (!runId) {
        const message = String(payload.errorMessage ?? payload.errorKind ?? '')
        return [{ type: 'error', message }]
      }
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
      // #459-T3 #464：replace 快照无文本但含媒体块（纯图片 run 的流式快照）→ 产 attachment 帧，
      // 不回退 deltaText（媒体块不在 deltaText 增量字段里）。
      const media = extractMessageAttachments(payload.message)
      if (media.length) return [{ type: 'attachment', runId, media }]
      // 无快照 → 退回 deltaText 增量（追加），对齐 r13:127「若无 message，发 deltaText」
      const delta = typeof payload[DELTA_TEXT] === 'string' ? (payload[DELTA_TEXT] as string) : ''
      if (!delta) return []
      this.sent.set(runId, (this.sent.get(runId) ?? '') + delta)
      return [{ type: 'text', runId, delta }]
    }
    const delta = typeof payload[DELTA_TEXT] === 'string' ? (payload[DELTA_TEXT] as string) : ''
    if (!delta) return []
    if (this.sent.size >= this.MAX_SENT_ENTRIES && !this.sent.has(runId)) {
      // P2：有界防御——条目超上限且是全新 run，不增长（等价于该 run 无已发文本，final 走 replace）
    } else {
      this.sent.set(runId, (this.sent.get(runId) ?? '') + delta)
    }
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
    } else if (message && !message.startsWith(sent)) {
      // F9: 非前缀 final（空白规范化 / markdown 改写 / 重复 delta 使 sent 翻倍）——权威最终文本与
      // 流式累积不一致。若只发 done，权威文本被静默丢弃、UI 停在未规范化的流式态。发整段 replace
      // 帧（协议支持 replace 快照；前端按 replace 标志 set 而非 append），纠正流式投影。
      this.sent.set(runId, message)
      out.push({ type: 'text', runId, delta: message, replace: true })
    }
    // #459-T3 #464：final.message 含 image/audio/video 块（browser 截图/AI 工具产出多媒体）→
    // 产 attachment 帧（权威最终媒体，与 text 帧独立通道）。纯媒体 run（无文本）也经此渲染。
    const media = extractMessageAttachments(payload.message)
    if (media.length) out.push({ type: 'attachment', runId, media })
    out.push({ type: 'done', runId })
    this.sent.delete(runId)
    return out
  }

  // 待审批事件 payload → 前端审批卡帧；无稳定审批 id 返回 null（无法 resolve，不出卡）。
  // kind 缺省时从事件名族派生（exec/plugin）；sessionKey 透传自 request.sessionKey
  // （issue #154 实测校准：systemRunPlan 实测为 null，command/sessionKey 在 payload.request 下）。
  // agentId（#405-T1）：request.agentId 恒下发（#394 实测，string 才取 0 信任）为首选；
  // request 缺失走 systemRunPlan 回退路径读 runPlan.agentId（host=node 时存在，本部署恒 null）。
  private approvalCard(event: string, payload: Record<string, unknown>): ChatFrame | null {
    const approvalId = typeof payload.id === 'string' ? payload.id : ''
    if (!approvalId) return null
    const req = asRecord(payload.request)
    const runPlan = asRecord(payload.systemRunPlan)
    let command = ''
    let sessionKey: string | null = null
    let agentId: string | null = null
    if (Object.keys(req).length > 0) {
      command = typeof req.command === 'string' ? req.command : ''
      sessionKey = typeof req.sessionKey === 'string' ? req.sessionKey : null
      agentId = typeof req.agentId === 'string' ? req.agentId : null
    } else {
      command =
        (typeof runPlan.rawCommand === 'string' ? runPlan.rawCommand : '') ||
        (typeof runPlan.command === 'string' ? runPlan.command : '') ||
        (typeof payload.command === 'string' ? payload.command : '')
      sessionKey = typeof runPlan.sessionKey === 'string' ? runPlan.sessionKey : null
      agentId = typeof runPlan.agentId === 'string' ? runPlan.agentId : null
    }
    return {
      type: 'approval',
      id: approvalId,
      kind: typeof payload.kind === 'string' && payload.kind ? (payload.kind as string) : event.split('.')[0],
      command,
      sessionKey,
      agentId,
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
