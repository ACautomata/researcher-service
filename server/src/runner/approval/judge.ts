// LLM judge 客户端（#783 · 729 §2）：灰区判定的输入构造（§2.2 固定契约 ≤8k tokens）、输出
// 契约校验（§2.3 温度 0 + JSON + zod，失败重试一次再败 fail-closed 交升级通道）、独立小模型
// 调用面（§2.5 与主模型解耦——模型实例由装配层注入，本文件只认结构子集）。
//
// 「不喂历史 judge 判定与理由」（§2.2）：输入只含用户输入 / 最近工具调用 / 当前调用，
// 无任何判定史——防锚定，也省 token。本文件零 Prisma / Express 依赖（S3 纯逻辑接缝）。

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import {
  APPROVAL_REJECTION_CONTENT_PREFIX,
  APPROVAL_REASON_MAX_CHARS,
  JUDGE_CHARS_PER_TOKEN,
  JUDGE_CURRENT_CALL_BUDGET_TOKENS,
  JUDGE_INPUT_TOTAL_BUDGET_TOKENS,
  JUDGE_PRIOR_CALL_BUDGET_TOKENS,
  JUDGE_PRIOR_CALLS_MAX,
  JUDGE_USER_INPUT_BUDGET_TOKENS,
} from './values'

// ---------------------------------------------------------------------------
// 输出契约（§2.3 / 附录 A schema）
// ---------------------------------------------------------------------------

export const JUDGE_POLICY_CLASSES = [
  'system_destruction',
  'data_exfiltration',
  'persistence_backdoor',
  'credential_access',
] as const

export type JudgePolicyClass = (typeof JUDGE_POLICY_CLASSES)[number]

export interface JudgeVerdict {
  readonly decision: 'approve' | 'reject'
  readonly policy_class: JudgePolicyClass | null
  readonly reason: string
}

const JudgeVerdictSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  policy_class: z.enum(JUDGE_POLICY_CLASSES).nullable(),
  reason: z.string(),
})

// token 预算 → 字符截断（换算因子单一来源 JUDGE_CHARS_PER_TOKEN；CJK 保守取 2 chars/token）。
export function truncateToTokenBudget(text: string, tokens: number): string {
  const max = Math.max(0, tokens) * JUDGE_CHARS_PER_TOKEN
  if (text.length <= max) return text
  return text.slice(0, max)
}

// 按 Unicode code points 截断（Django max_length 同语义；reason/摘要的唯一截断实现）。
export function truncateChars(text: string, max: number): string {
  return Array.from(text).length <= max ? text : Array.from(text).slice(0, max).join('')
}

// ---------------------------------------------------------------------------
// 输入契约（§2.2）：user_input（本轮首条 user message）+ 最近 10 条工具调用摘要 + 当前调用
// ——全部从图状态消息推导（结构子集，restart/replay 后仍可重建）。
// ---------------------------------------------------------------------------

export interface JudgePriorCall {
  readonly tool: string
  readonly args: unknown
  readonly result: string
}

export interface JudgeContext {
  readonly userInput: string
  readonly priorCalls: readonly JudgePriorCall[]
}

interface MessageLike {
  getType?: () => string
  content?: unknown
  tool_calls?: readonly { id?: string; name?: string; args?: unknown }[]
  tool_call_id?: unknown
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('')
  }
  return ''
}

// 最近一条 HumanMessage = 本轮输入（message run 的 cmd.content / resume run 的原消息同形）。
export function extractJudgeContext(messages: unknown[]): JudgeContext {
  let userInput = ''
  const calls: { id: string; name: string; args: unknown }[] = []
  const results = new Map<string, string>()
  for (const raw of messages) {
    const msg = raw as MessageLike | null
    if (!msg || typeof msg.getType !== 'function') continue
    const type = msg.getType()
    if (type === 'human') userInput = contentToText(msg.content)
    if (type === 'ai' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (typeof tc?.id === 'string' && typeof tc?.name === 'string') {
          calls.push({ id: tc.id, name: tc.name, args: tc.args })
        }
      }
    }
    if (type === 'tool' && typeof msg.tool_call_id === 'string') {
      const text = contentToText(msg.content)
      // 防锚定（§2.2「不喂历史 judge 判定与理由」）：审批拒绝的回喂 ToolMessage 携带
      // judge/规则理由，据此剥离——否则拒绝理由经 prior 结果回灌后续判定。
      results.set(
        msg.tool_call_id,
        text.startsWith(APPROVAL_REJECTION_CONTENT_PREFIX)
          ? '（该调用被审批层拒绝，理由不入判定输入）'
          : text,
      )
    }
  }
  const priorCalls: JudgePriorCall[] = calls
    .map((c) => ({
      tool: c.name,
      args: c.args ?? {},
      result: results.get(c.id) ?? '',
    }))
    .slice(-JUDGE_PRIOR_CALLS_MAX) // 最近 N=10 条（§2.2）
  return { userInput, priorCalls }
}

// ---------------------------------------------------------------------------
// 渲染（分项预算截断 + 总预算 ≤8k 裁剪）与输入快照 hash
// ---------------------------------------------------------------------------

function jsonOrEmpty(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

export function buildJudgeInput(parts: {
  readonly userInput: string
  readonly priorCalls: readonly JudgePriorCall[]
  readonly currentCall: { readonly tool: string; readonly args: unknown }
}): { rendered: string; inputHash: string } {
  const totalBudgetChars = JUDGE_INPUT_TOTAL_BUDGET_TOKENS * JUDGE_CHARS_PER_TOKEN
  let userInput = truncateToTokenBudget(parts.userInput, JUDGE_USER_INPUT_BUDGET_TOKENS)
  const currentArgs = truncateToTokenBudget(jsonOrEmpty(parts.currentCall.args), JUDGE_CURRENT_CALL_BUDGET_TOKENS)
  let priors = parts.priorCalls.slice(-JUDGE_PRIOR_CALLS_MAX).map((c) => ({
    tool: c.tool,
    args: truncateToTokenBudget(jsonOrEmpty(c.args), JUDGE_PRIOR_CALL_BUDGET_TOKENS),
    result: truncateToTokenBudget(c.result, JUDGE_PRIOR_CALL_BUDGET_TOKENS),
  }))

  const render = (): string =>
    JSON.stringify({
      user_input: userInput,
      prior_tool_calls: priors,
      current_call: { tool: parts.currentCall.tool, args: currentArgs },
    })

  let rendered = render()
  // 分项预算之和可超总预算（10×1k + 2k + 1k > 8k）——超限时裁最旧 prior 条目直到不超。
  while (Buffer.byteLength(rendered, 'utf8') > totalBudgetChars && priors.length > 0) {
    priors = priors.slice(1)
    rendered = render()
  }
  // 仅剩 user_input + current 仍超：对折 user_input 直到不超（确定性收敛）。
  while (Buffer.byteLength(rendered, 'utf8') > totalBudgetChars && userInput.length > 0) {
    userInput = userInput.slice(0, Math.floor(userInput.length / 2))
    rendered = render()
  }
  return { rendered, inputHash: createHash('sha256').update(rendered).digest('hex') }
}

// ---------------------------------------------------------------------------
// 输出解析：容错提取 JSON（去围栏/前后噪声）→ zod → 语义归一（approve 强制空理由；
// reject 必须带政策类与非空理由——理由是回喂与审计的生命线）。
// ---------------------------------------------------------------------------

export function parseJudgeOutput(raw: string): JudgeVerdict {
  let text = String(raw ?? '').trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fence) text = fence[1]!.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('输出中无 JSON 对象')
  const parsed = JudgeVerdictSchema.parse(JSON.parse(text.slice(start, end + 1)))
  if (parsed.decision === 'approve') {
    return { decision: 'approve', policy_class: null, reason: '' }
  }
  if (parsed.policy_class === null || parsed.reason.trim() === '') {
    throw new Error('reject 决策缺 policy_class 或 reason（输出契约违例）')
  }
  return {
    decision: 'reject',
    policy_class: parsed.policy_class,
    reason: truncateChars(parsed.reason, APPROVAL_REASON_MAX_CHARS),
  }
}

// ---------------------------------------------------------------------------
// judge 客户端：模型结构子集（真 BaseChatModel / 测试 fake 均可注入），异常与畸形一律
// 重试一次再败 → malformed（调用方 fail-closed 升级人工，不抛错）。
// ---------------------------------------------------------------------------

// judge 模型的最小结构面：LangChain BaseChatModel.invoke 天然满足。
export interface JudgeModelLike {
  invoke(messages: unknown[]): Promise<unknown>
}

export type JudgeOutcome =
  | {
      readonly kind: 'verdict'
      readonly verdict: JudgeVerdict
      readonly inputHash: string
      readonly latencyMs: number
      readonly tokens: number | null
    }
  | {
      readonly kind: 'malformed'
      readonly inputHash: string
      readonly latencyMs: number
      readonly tokens: number | null
    }

function responseText(res: unknown): string {
  const msg = res as { content?: unknown } | null
  return contentToText(msg?.content)
}

function responseTokens(res: unknown): { input: number; output: number } | null {
  const meta = (res as { usage_metadata?: { input_tokens?: unknown; output_tokens?: unknown } } | null)
    ?.usage_metadata
  if (!meta || typeof meta !== 'object') return null
  const input = typeof meta.input_tokens === 'number' ? meta.input_tokens : 0
  const output = typeof meta.output_tokens === 'number' ? meta.output_tokens : 0
  if (input === 0 && output === 0) return null
  return { input, output }
}

export class ToolCallJudgeClient {
  private readonly clock: () => number

  constructor(
    private readonly model: JudgeModelLike,
    private readonly opts: { readonly policy: string; readonly clock?: () => number } = { policy: '' },
  ) {
    this.clock = opts.clock ?? (() => Date.now())
  }

  async run(input: { readonly rendered: string; readonly inputHash: string }): Promise<JudgeOutcome> {
    const started = this.clock()
    let tokens: number | null = null
    const accumulate = (res: unknown): void => {
      const t = responseTokens(res)
      if (t) tokens = (tokens ?? 0) + t.input + t.output
    }
    const messages: unknown[] = [new SystemMessage(this.opts.policy), new HumanMessage(input.rendered)]
    let lastRaw = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await this.model.invoke(messages)
        accumulate(res)
        lastRaw = responseText(res)
        const verdict = parseJudgeOutput(lastRaw)
        return { kind: 'verdict', verdict, inputHash: input.inputHash, latencyMs: this.clock() - started, tokens }
      } catch (e) {
        if (attempt > 0) {
          return { kind: 'malformed', inputHash: input.inputHash, latencyMs: this.clock() - started, tokens }
        }
        // 回灌校验错误重试一次（§2.3）
        messages.push(
          new AIMessage(lastRaw),
          new HumanMessage(
            `上次输出不符合 JSON 契约（${(e as Error).message}）。严格只输出符合契约的 JSON 对象，不要任何其他内容。`,
          ),
        )
      }
    }
    return { kind: 'malformed', inputHash: input.inputHash, latencyMs: this.clock() - started, tokens } // 不可达面
  }
}
