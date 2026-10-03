// 审批三层漏斗中间件（#783 · 729 §1–§3 / ADR 0015）：挂在 deepagents 图的工具执行链上
// （langchain AgentMiddleware.wrapToolCall），每次工具调用依次过：
//
//   ① 规则层（确定性，零 LLM）：文件类 → 路径白名单（命中放行/未命中灰区）；
//      exec 类 → 命令黑名单（命中直接拒——终态不升级，即时红显）；其余工具 → 灰区。
//   ② judge（灰区守门）：独立小模型列拒四类，之外默认放行；per-run 20 次超限升级；
//      同 hash reject ≥3 次升级；输出畸形重试再败 fail-closed 升级。
//   ③ 升级通道：runtime.interrupt() 挂起 run 等人工落定（一 run 一 interrupt，串行）——
//      resume 回执 approve → 放行执行；reject → 错误 ToolMessage 回喂；落定同步落审计。
//
// 运行时假设（探针实测锁定，见 test/approvalFunnel.test.ts）：
//   - interrupt 后图暂停，checkpoint 落库；resume 后工具节点重放，wrapToolCall 再次进入
//     （escalationMemos 保证判定/judge/审计幂等，escalation id 稳定）；
//   - 中间件拒绝（不调 handler）的调用不产生 v3 tools/* 流事件——红显由 onRejection 回调
//     直接发 tool.start + tool.end{state:'error', rejection} 事件对（RunService 接线）。

import { randomUUID } from 'node:crypto'
import { ToolMessage } from '@langchain/core/messages'
import type { Command as LangGraphCommand } from '@langchain/langgraph'
import { createMiddleware } from 'langchain'
import type { WrapToolCallHook } from 'langchain'

// hook 参数类型由 WrapToolCallHook 推导（langchain 泛型默认值不满足 Record 约束，不直引）。
type FunnelRequest = Parameters<WrapToolCallHook>[0]
type FunnelHandler = Parameters<WrapToolCallHook>[1]
import {
  classifyTool,
  commandVerdict,
  filePathVerdict,
  toolCallHash,
  canonicalArgsJson,
} from './rules'
import { buildJudgeInput, extractJudgeContext, truncateChars, type JudgeOutcome } from './judge'
import type { ApprovalAuditRow, ApprovalAuditSink, RejectionSource } from './audit'
import {
  APPROVAL_INTERRUPT_KIND,
  APPROVAL_INTERRUPT_V,
  APPROVAL_REJECTION_CONTENT_PREFIX,
  APPROVAL_REASON_MAX_CHARS,
  APPROVAL_SUMMARY_MAX_BYTES,
  EXEC_COMMAND_PARAM_NAME,
  JUDGE_MAX_CALLS_PER_RUN,
  REPEAT_REJECT_ESCALATE_AT,
  type EscalationSource,
} from './values'

// ---------------------------------------------------------------------------
// 升级载荷（interrupt value；经 checkpoint 持久化——JSON 可序列化，重启后审批可续）
// ---------------------------------------------------------------------------

export interface ApprovalEscalation {
  readonly id: string
  readonly source: EscalationSource
  readonly toolCallId: string
  readonly toolName: string
  /** 规范化参数 JSON 摘要（≤1KB 截断） */
  readonly toolCallSummary: string
  /** judge 理由（repeat-reject / judge-malformed 附带） */
  readonly judgeReason?: string
}

export interface ApprovalActionRequest {
  readonly toolCallId: string
  readonly name: string
  readonly argsSummary: string
}

export interface ApprovalInterruptPayload {
  readonly v: number
  readonly kind: typeof APPROVAL_INTERRUPT_KIND
  readonly escalation: ApprovalEscalation
  readonly actionRequests: readonly ApprovalActionRequest[]
}

// RunService.isApprovalInterrupt 的类型守卫面：deepagents 内建 interruptOn（V1 测试面）的
// 载荷无 kind 标记，据此区分「审批升级 interrupt」与其它 interrupt。
export function isApprovalInterruptPayload(value: unknown): value is ApprovalInterruptPayload {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.kind === APPROVAL_INTERRUPT_KIND && typeof v.escalation === 'object' && v.escalation !== null
}

// resume 回执（RunCommand.decisions 契约，与 deepagents HITL 决策形态同形）：
// {decisions:[{type:'approve'} | {type:'reject', message?}]}
interface ResumeDecision {
  readonly type: 'approve' | 'reject'
  readonly message?: string
}

function parseResumeDecisions(value: unknown): ResumeDecision {
  const decisions = (value as { decisions?: unknown } | null | undefined)?.decisions
  if (Array.isArray(decisions) && decisions.length > 0) {
    const first = decisions[0] as { type?: unknown; message?: unknown } | null
    if (first?.type === 'approve') {
      return { type: 'approve', ...(typeof first.message === 'string' ? { message: first.message } : {}) }
    }
    if (first?.type === 'reject') {
      return {
        type: 'reject',
        ...(typeof first.message === 'string' && first.message.trim() !== '' ? { message: first.message } : {}),
      }
    }
  }
  // 回执缺失/无法解析 → fail-closed 按 reject 处理（审批通道不容含糊）
  return { type: 'reject' }
}

// ---------------------------------------------------------------------------
// 运行状态（per-thread 槽；同 thread 严格串行由 RunService 承诺，无并发竞争）
// ---------------------------------------------------------------------------

export interface FunnelIdentity {
  readonly runId: string
  readonly userId: string
  /** 弱关联 text_trace_logs.traceId（#727 接缝）；V1 = runId 占位 */
  readonly traceId: string
}

interface FunnelRunState {
  cautious: boolean
  identity: FunnelIdentity
  judgeCalls: number
  rejectCounts: Map<string, number>
  /** toolCallId → 升级载荷（resume 重放幂等面 + escalation id 稳定面） */
  escalationMemos: Map<string, ApprovalInterruptPayload>
}

// ---------------------------------------------------------------------------
// 漏斗
// ---------------------------------------------------------------------------

export interface RejectionNotice {
  /** threadId = sessionId（RunService 据此定位活跃 run 命令盖印事件归属） */
  readonly threadId: string
  readonly toolCallId: string
  readonly name: string
  readonly argsSummary: string
  readonly source: RejectionSource
  readonly reason: string
}

export interface ApprovalFunnelDeps {
  /** judge 客户端；未配置 = 灰区一律升级人工（fail-closed，判定不可得即 judge 层失守） */
  readonly judge?: { run(input: { rendered: string; inputHash: string }): Promise<JudgeOutcome> }
  readonly audit: ApprovalAuditSink
  /** 拒绝即时红显回调（RunService 接线为 tool.start + tool.end 事件对发布） */
  readonly onRejection?: (notice: RejectionNotice) => void
}

// UTF-8 字节上限截断（与 runtime/projector.ts truncateUtf8 同形——摘要按字节计，
// CJK 最坏 3x 膨胀，按字符截断会超预算；独立实现避免 approval→runtime 模块环）。
function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const buf = Buffer.from(text, 'utf8')
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

export class ApprovalFunnel {
  private readonly runs = new Map<string, FunnelRunState>()
  private rejectionSink?: (notice: RejectionNotice) => void

  constructor(private readonly deps: ApprovalFunnelDeps) {}

  /**
   * 拒绝红显事件的发布面（RunService 接线——漏斗自身无 hub/cmd 上下文）。
   * 独立 setter 而非构造参数：漏斗在装配层构造，RunService 后构造（回调需要它）。
   */
  setRejectionSink(sink: (notice: RejectionNotice) => void): void {
    this.rejectionSink = sink
  }

  /** 消息 run 启动：重置计数器（新逻辑 run），刷新谨慎模式与审计身份。 */
  beginRun(threadId: string, opts: { cautious: boolean; identity: FunnelIdentity }): void {
    this.runs.set(threadId, {
      cautious: opts.cautious,
      identity: opts.identity,
      judgeCalls: 0,
      rejectCounts: new Map(),
      escalationMemos: new Map(),
    })
  }

  /** resume 启动：保留计数器与升级 memo（同一逻辑 run 的延续），仅刷新谨慎模式。 */
  refreshRun(threadId: string, opts: { cautious: boolean }): void {
    const state = this.runs.get(threadId)
    if (!state) return // 重启后 resume：状态缺失由 wrapToolCall 兜底重建（fail-closed 面）
    state.cautious = opts.cautious
  }

  /** 终态清理（防长生命周期进程状态累积；非正确性依赖）。 */
  dropRun(threadId: string): void {
    this.runs.delete(threadId)
  }

  // 先声明 hook 再声明 middleware（类字段初始化序）。
  private readonly wrapToolCall: WrapToolCallHook = async (request, handler) => {
    return this.runFunnel(request, handler)
  }

  /** deepagents 图的中间件（graphFactory 透传 createDeepAgent.middleware）。 */
  readonly middleware = createMiddleware({
    name: 'tool-approval-funnel',
    wrapToolCall: this.wrapToolCall,
  })

  pendingEscalation(threadId: string): ApprovalInterruptPayload | undefined {
    const state = this.runs.get(threadId)
    if (!state || state.escalationMemos.size === 0) return undefined
    for (const payload of state.escalationMemos.values()) return payload
    return undefined
  }

  private async runFunnel(request: FunnelRequest, handler: FunnelHandler): Promise<ToolMessage | LangGraphCommand> {
    const threadId = String(
      (request.runtime as { configurable?: { thread_id?: unknown } } | undefined)?.configurable?.thread_id ?? '',
    )
    let state = this.runs.get(threadId)
    if (!state) {
      // 无运行状态（重启后仅 resume / 装配遗漏）：按谨慎模式兜底（fail-closed 走人工升级）
      state = {
        cautious: true,
        identity: { runId: '', userId: '', traceId: '' },
        judgeCalls: 0,
        rejectCounts: new Map(),
        escalationMemos: new Map(),
      }
      this.runs.set(threadId, state)
    }
    const name = String(request.toolCall.name ?? '')
    const args = (request.toolCall.args ?? {}) as Record<string, unknown>
    const callId = String(request.toolCall.id ?? '')
    const toolCallJson = canonicalArgsJson(args)

    // ① 重放 memo：升级中调用的 resume 回执（规则判定/judge/审计已在上次进入时完成）
    const memo = state.escalationMemos.get(callId)
    if (memo) return this.applyHumanDecision(state, memo, request, handler, toolCallJson)

    // ② 规则层（729 §1）
    const category = classifyTool(name)
    if (category === 'file') {
      const verdict = filePathVerdict(args)
      if (verdict.kind === 'allow') {
        const ok = await this.writeAudit(state, {
          layer: 'rule',
          decision: 'allow',
          toolName: name,
          toolCall: toolCallJson,
          reason: verdict.rule,
        })
        if (!ok) return this.auditUnavailable(request)
        return handler(request)
      }
      // 未命中 → 灰区
    } else if (category === 'exec') {
      const command = typeof args[EXEC_COMMAND_PARAM_NAME] === 'string' ? (args[EXEC_COMMAND_PARAM_NAME] as string) : ''
      const verdict = commandVerdict(command)
      if (verdict.kind === 'deny') {
        const ok = await this.writeAudit(state, {
          layer: 'rule',
          decision: 'deny',
          toolName: name,
          toolCall: toolCallJson,
          reason: `${verdict.rule}：${verdict.reason}`,
        })
        if (!ok) return this.auditUnavailable(request)
        this.notifyRejection(threadId, request, toolCallJson, 'blacklist', verdict.reason)
        return rejectedToolMessage(request, verdict.reason)
      }
      // 未命中 → 灰区
    }
    // other 类工具无规则层 → 灰区

    // ③ 灰区 → judge / 升级通道（729 §2/§3）
    if (state.cautious) {
      return this.escalate(state, request, handler, toolCallJson, { source: 'cautious-mode' })
    }
    if (state.judgeCalls >= JUDGE_MAX_CALLS_PER_RUN) {
      return this.escalate(state, request, handler, toolCallJson, { source: 'judge-limit' })
    }
    if (!this.deps.judge) {
      // judge 未配置：判定不可得 → fail-closed 升级人工（source 枚举为 729 §3.1 锁定四值，
      // 部署缺失经 judgeReason 区分，不与「输出畸形」静默混淆）
      return this.escalate(state, request, handler, toolCallJson, {
        source: 'judge-malformed',
        judgeReason: 'judge 未配置（部署面缺 RUNNER_JUDGE_*），fail-closed 升级',
      })
    }

    state.judgeCalls += 1
    const messages = (request.state as { messages?: unknown[] } | undefined)?.messages ?? []
    const ctx = extractJudgeContext(messages)
    const input = buildJudgeInput({
      userInput: ctx.userInput,
      priorCalls: ctx.priorCalls,
      currentCall: { tool: name, args },
    })
    const outcome = await this.deps.judge.run(input)

    if (outcome.kind === 'malformed') {
      // 畸形判定按 deny 落审计（fail-closed 语义），决策真值由后续 human 行承接
      await this.writeAudit(state, {
        layer: 'judge',
        decision: 'deny',
        toolName: name,
        toolCall: toolCallJson,
        reason: 'judge 输出畸形（schema 校验重试仍失败），fail-closed 升级人工',
        judgeInputHash: outcome.inputHash,
        latencyMs: outcome.latencyMs,
        judgeTokens: outcome.tokens,
      })
      return this.escalate(state, request, handler, toolCallJson, { source: 'judge-malformed' })
    }
    if (outcome.verdict.decision === 'approve') {
      const ok = await this.writeAudit(state, {
        layer: 'judge',
        decision: 'allow',
        toolName: name,
        toolCall: toolCallJson,
        judgeInputHash: outcome.inputHash,
        latencyMs: outcome.latencyMs,
        judgeTokens: outcome.tokens,
      })
      if (!ok) return this.auditUnavailable(request)
      return handler(request)
    }

    // judge reject：回喂（换姿势重过漏斗）或同 hash ≥3 升级（729 §2.6）
    const hash = toolCallHash(name, args)
    const count = (state.rejectCounts.get(hash) ?? 0) + 1
    state.rejectCounts.set(hash, count)
    await this.writeAudit(state, {
      layer: 'judge',
      decision: 'deny',
      toolName: name,
      toolCall: toolCallJson,
      policyClass: outcome.verdict.policy_class,
      reason: outcome.verdict.reason,
      judgeInputHash: outcome.inputHash,
      latencyMs: outcome.latencyMs,
      judgeTokens: outcome.tokens,
    })
    if (count >= REPEAT_REJECT_ESCALATE_AT) {
      return this.escalate(state, request, handler, toolCallJson, {
        source: 'repeat-reject',
        judgeReason: outcome.verdict.reason,
      })
    }
    this.notifyRejection(threadId, request, toolCallJson, 'judge', outcome.verdict.reason)
    return rejectedToolMessage(request, outcome.verdict.reason)
  }

  // ---- 升级（interrupt）与人工落定（resume 回执）----

  private escalate(
    state: FunnelRunState,
    request: FunnelRequest,
    handler: FunnelHandler,
    toolCallJson: string,
    opts: { source: EscalationSource; judgeReason?: string },
  ): Promise<ToolMessage | LangGraphCommand> {
    // 串行升级（729 §3.2「一个 run 同时只挂一个 interrupt」）：同超步并行工具调用的第二笔
    // 不再挂 interrupt——错误回喂令 agent 在前一升级落定后重试（重放时前笔 memo 已清）。
    if (state.escalationMemos.size > 0) {
      return Promise.resolve(rejectedToolMessage(request, '已有升级审批待落定，请稍后重试该操作'))
    }
    const callId = String(request.toolCall.id ?? '')
    const name = String(request.toolCall.name ?? '')
    const summary = truncateUtf8Bytes(toolCallJson, APPROVAL_SUMMARY_MAX_BYTES)
    const payload: ApprovalInterruptPayload = {
      v: APPROVAL_INTERRUPT_V,
      kind: APPROVAL_INTERRUPT_KIND,
      escalation: {
        id: randomUUID(),
        source: opts.source,
        toolCallId: callId,
        toolName: name,
        toolCallSummary: summary,
        ...(opts.judgeReason !== undefined ? { judgeReason: opts.judgeReason } : {}),
      },
      actionRequests: [{ toolCallId: callId, name, argsSummary: summary }],
      // actionRequests 摘要与 toolCallSummary 同为 UTF-8 字节截断面
    }
    state.escalationMemos.set(callId, payload) // 先记 memo 再 interrupt——重放幂等 + id 稳定
    return this.applyHumanDecision(state, payload, request, handler, toolCallJson)
  }

  private async applyHumanDecision(
    state: FunnelRunState,
    payload: ApprovalInterruptPayload,
    request: FunnelRequest,
    handler: FunnelHandler,
    toolCallJson: string,
  ): Promise<ToolMessage | LangGraphCommand> {
    const interrupt = (request.runtime as { interrupt?: (value: unknown) => unknown } | undefined)?.interrupt
    let resumeValue: unknown
    if (typeof interrupt === 'function') {
      // 首次进入：抛 GraphInterrupt 挂起（不得 try/catch 吞掉）；resume 重放：返回回执
      resumeValue = interrupt(payload)
    } else {
      resumeValue = undefined // 审批通道不可用（理论不可达）→ fail-closed
    }
    const decision = parseResumeDecisions(resumeValue)
    const callId = payload.escalation.toolCallId
    const name = payload.escalation.toolName
    if (decision.type === 'approve') {
      const ok = await this.writeAudit(state, {
        layer: 'human',
        decision: 'allow',
        toolName: name,
        toolCall: toolCallJson,
        reason: decision.message ?? null,
      })
      if (!ok) return this.auditUnavailable(request)
      state.escalationMemos.delete(callId)
      return handler(request)
    }
    const reason =
      decision.message !== undefined && decision.message.trim() !== ''
        ? truncateChars(decision.message, APPROVAL_REASON_MAX_CHARS)
        : '操作被人工拒绝'
    await this.writeAudit(state, {
      layer: 'human',
      decision: 'deny',
      toolName: name,
      toolCall: toolCallJson,
      reason,
    })
    state.escalationMemos.delete(callId)
    // 人工拒绝的红显走 approval.resolved 事件（卡片落定即撤），tool.end 不带 rejection
    // 来源标记（#747 C 节目录 rejection.source 仅 blacklist|judge）
    return rejectedToolMessage(request, reason)
  }

  // ---- 审计（同步写；失败 fail-closed）与红显回调 ----

  private async writeAudit(state: FunnelRunState, row: Omit<ApprovalAuditRow, 'traceId' | 'runId' | 'userId'>): Promise<boolean> {
    try {
      await this.deps.audit.record({
        ...row,
        traceId: state.identity.traceId,
        runId: state.identity.runId,
        userId: state.identity.userId,
      })
      return true
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[approval] 审计写入失败（fail-closed 拒绝该调用）: ${(e as Error).message}`)
      return false
    }
  }

  private auditUnavailable(request: FunnelRequest): ToolMessage {
    return rejectedToolMessage(request, '审批审计暂不可用，操作被拒绝（安全路径不允许丢审计）')
  }

  private notifyRejection(
    threadId: string,
    request: FunnelRequest,
    toolCallJson: string,
    source: RejectionSource,
    reason: string,
  ): void {
    const sink = this.rejectionSink ?? this.deps.onRejection
    if (!sink) return
    try {
      sink({
        threadId,
        toolCallId: String(request.toolCall.id ?? ''),
        name: String(request.toolCall.name ?? ''),
        argsSummary: truncateUtf8Bytes(toolCallJson, APPROVAL_SUMMARY_MAX_BYTES),
        source,
        reason,
      })
    } catch {
      // 红显回调故障不影响判定执行
    }
  }
}

// 拒绝回喂（§2.6）：错误 ToolMessage（状态 error → tool.end 红显；内容 = 错误 + 理由）。
function rejectedToolMessage(request: FunnelRequest, reason: string): ToolMessage {
  return new ToolMessage({
    tool_call_id: String(request.toolCall.id ?? ''),
    name: String(request.toolCall.name ?? ''),
    // 前缀契约：APPROVAL_REJECTION_CONTENT_PREFIX（judge 输入构造据此剥离拒绝理由防锚定）
    content: `${APPROVAL_REJECTION_CONTENT_PREFIX}${reason}`,
    status: 'error',
  })
}
