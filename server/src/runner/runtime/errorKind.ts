// run 错误三分类（#777 · #747 C 节 / story 10）：run.failed{errorKind} 的 kind 值集与判定。
//
// 分类语义（story 10「用户知道下一步该做什么」）：
//   llm_error        —— LLM 调用面失败：provider 端点不可达/HTTP 4xx·5xx、凭证缺失或非法
//                       （LLM_NOT_CONFIGURED / PROVIDER_NOT_FOUND）、端点凭证解密失败
//                      （#881 起 PROVIDER_ENDPOINT_NOT_ALLOWED 已退役——凭证解密失败 /
//                      平台 key 缺失走 LLM_NOT_CONFIGURED 同分类）。用户动作 = 检查 model 配置。
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

// run.failed{message} 的截断上限：够用户/管理员识别根因，又不让超长 docker/堆栈
// 消息撑爆 SSE 帧与前端横幅。全量错误（含 stack）由 runService 的 console.error 留痕。
const RUN_ERROR_MESSAGE_MAX_LEN = 500

// run.failed{message} 的提取面（诊断盲区修复）：错误对象 → 人类可读的一行根因。
// 不剥 cause 链——外层消息已是具体故障（dockerode/prisma 直抛），内层反而更泛。
export function describeRunError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.length > RUN_ERROR_MESSAGE_MAX_LEN ? `${raw.slice(0, RUN_ERROR_MESSAGE_MAX_LEN)}…` : raw
}

// models 域信封码 → llm_error 的白名单（运行时 LLM 配置/凭证面——providerRegistry
// 抛出的全部 code）。会话/run 域码（5xxxx）不在 run 执行体内抛，不收。
// PROVIDER_ENDPOINT_NOT_ALLOWED（40042）随 #881 白名单链退役出白名单（常量保留、语义退役）：
// 任何残留抛出面归 infra 兜底分类。
const LLM_ENVELOPE_CODES: ReadonlySet<number> = new Set([
  CODE.LLM_NOT_CONFIGURED,
  CODE.PROVIDER_NOT_FOUND,
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

// abort 与错误终态的判据：RunService 以自身 AbortController.signal 为用户中断的唯一权威
// 判据（story 8 by:user；catch 分支 signal.aborted → run.aborted，不经 classifyRunError
// ——aborted 是独立终态事件 run.aborted{by}，非 failed 分支）。provider SDK 自身的
// timeout AbortError 在 signal 未 abort 时按 LLM 面分类（llm_error）——不按错误形态猜。
