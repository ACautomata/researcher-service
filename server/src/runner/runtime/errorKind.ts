// run 错误三分类（#777 · #747 C 节 / story 10）：run.failed{errorKind} 的 kind 值集与判定。
//
// 分类语义（story 10「用户知道下一步该做什么」）：
//   llm_error        —— LLM 调用面失败：provider 端点不可达/HTTP 4xx·5xx、凭证缺失或非法
//                       （LLM_NOT_CONFIGURED / PROVIDER_NOT_FOUND）、端点白名单运行时拒绝
//                      （PROVIDER_ENDPOINT_NOT_ALLOWED 40042）。用户动作 = 检查 model 配置。
//   recursion_limit  —— LangGraph GraphRecursionError（图深度护栏触发）。用户动作 = 拆小任务。
//   infra            —— 其余一切：Docker/DB/未知（含无类型异常）。用户动作 = 重试/联系管理员。
//
// 判定顺序钉死：递归限制（类型判据，最特异）→ LLM 面（信封码白名单 + HTTP status 启发式）
// → infra 兜底。白名单 + 显式 status 判据，绝不出「看消息文案猜」的脆弱面（S3 纯函数锁定）。

import { GraphRecursionError } from '@langchain/langgraph'
import { CODE } from '../../codes'
import { EnvelopeError } from '../../envelope'
import { CAUSE_CHAIN_MAX_DEPTH } from './values'

export type RunErrorKind = 'llm_error' | 'recursion_limit' | 'infra'

// models 域信封码 → llm_error 的白名单（运行时 LLM 配置/凭证/白名单面——providerRegistry
// 与 fetch wrapper 抛出的全部 code）。会话/run 域码（5xxxx）不在 run 执行体内抛，不收。
const LLM_ENVELOPE_CODES: ReadonlySet<number> = new Set([
  CODE.LLM_NOT_CONFIGURED,
  CODE.PROVIDER_NOT_FOUND,
  CODE.PROVIDER_ENDPOINT_NOT_ALLOWED,
])

function envelopeCodeOf(err: unknown): number | null {
  return err instanceof EnvelopeError ? err.code : null
}

// LangChain provider SDK 的 HTTP 故障形态（OpenAI/Anthropic APIError 均带数字 status）。
function httpStatusOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

// cause 链剥离：langchain agents 中间件把内层错误包成 MiddlewareError（判据在 cause 链上，
// PoC 实测形态 {~brand, cause:…}）；递归剥到命中判据或链尾。
function* walkCauseChain(err: unknown): Generator<unknown> {
  let cur: unknown = err
  for (let depth = 0; cur !== null && cur !== undefined && depth < CAUSE_CHAIN_MAX_DEPTH; depth += 1) {
    yield cur
    cur = typeof cur === 'object' && cur !== null ? (cur as { cause?: unknown }).cause : undefined
  }
}

export function classifyRunError(err: unknown): RunErrorKind {
  // 优先级：recursion_limit（类型判据）> llm_error（信封码白名单 / HTTP status）> infra。
  // recursion_limit 全链扫描；envelope 分支取链上**首个** EnvelopeError 定分类（非 LLM 白名单
  // 码 → infra）——5xxxx 会话/run 域码不在 run 执行体内抛，链上首见即 models 域码或非 LLM 码。
  const chain = [...walkCauseChain(err)]
  if (chain.some((e) => e instanceof GraphRecursionError)) return 'recursion_limit'
  for (const e of chain) {
    const code = envelopeCodeOf(e)
    if (code !== null) return LLM_ENVELOPE_CODES.has(code) ? 'llm_error' : 'infra'
  }
  if (chain.some((e) => httpStatusOf(e) !== null)) return 'llm_error'
  return 'infra'
}

// abort 与错误终态的判据：RunService 以自身 AbortRunError 标记用户中断（story 8 by:user），
// 不经 classifyRunError（aborted 是独立终态事件 run.aborted{by}，非 failed 分支）。
export class AbortRunError extends Error {
  readonly by: 'user' | 'system'
  constructor(by: 'user' | 'system' = 'user') {
    super('run aborted')
    this.name = 'AbortRunError'
    this.by = by
  }
}

export function isAbortError(err: unknown): err is AbortRunError {
  return err instanceof AbortRunError
}
