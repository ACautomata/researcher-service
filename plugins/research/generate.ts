// 长页生成节点共享骨架（#910 · 853 §7.1「单发 + 至多一次协议修复」· #906 触发面三源）：
// ingest createNode 与 discover extractNode/criticNode 的共同形态——attempts 进入自增、
// 超界 = 重试耗尽明确失败、generateStructured 调用、PluginLlmStructuredError（截断/解析
// 失败汇入面）诊断捕获。诊断统一经调用方 state.diagnostics 回喂下一轮 prompt。
//
// 本 helper 只管「一次进入」的判定与调用；attempts 的持有与诊断回喂归属各图 state
//（extract/critic 两条重试链独立计数，不共享）。非 PluginLlmStructuredError 的调用异常
//（abort/网络面）原样 throw——不属于协议修复触发面。

import type { z } from '../../server/src/plugins/autofigureDeps'
import type { PluginLlmPort } from '../../server/src/plugins/api'
import { PluginLlmStructuredError } from '../../server/src/plugins/api'
import { PAGE_GENERATE_MAX_ATTEMPTS, PAGE_OUTPUT_MAX_TOKENS } from './values'

export interface BoundedGenerateOutcome<T> {
  /** 生成成功 = zod 校验产物；解析失败且仍有修复余量 = undefined（诊断面在 diagnostics）。 */
  readonly value: T | undefined
  /** 本次进入后的 attempts（含本次）。 */
  readonly attempts: number
  /** 解析失败诊断（回喂下一轮 prompt）；成功时 undefined。 */
  readonly diagnostics: string | undefined
}

export async function generateWithBoundedRetry<T>(input: {
  readonly llm: PluginLlmPort
  readonly schema: z.ZodType<T>
  /** 完整 prompt（诊断回喂块的组装由 prompts.ts 面负责）。 */
  readonly prompt: string
  /** 进入前的 attempts 计数（helper 内自增）。 */
  readonly attemptsSoFar: number
  /** 上一轮诊断（重试耗尽消息面回显）。 */
  readonly diagnostics?: string
  /** 节点标签（失败消息面：「论文页」「extract 文档」…）。 */
  readonly nodeLabel: string
}): Promise<BoundedGenerateOutcome<T>> {
  const attempts = input.attemptsSoFar + 1
  if (attempts > PAGE_GENERATE_MAX_ATTEMPTS) {
    // 超界 throw 只发生在回边重入（attemptsSoFar ≥ 1），而回边路由前提 = 非空诊断
    //（图不变量）——无 `??` 兜底位（PR #917 review r1 S 修半2）。
    throw new Error(
      `${input.nodeLabel}生成重试耗尽（${PAGE_GENERATE_MAX_ATTEMPTS} 次）仍未通过校验：${input.diagnostics!}`,
    )
  }
  try {
    const value = await input.llm.generateStructured({
      schema: input.schema,
      contents: [input.prompt],
      maxTokens: PAGE_OUTPUT_MAX_TOKENS,
    })
    return { value, attempts, diagnostics: undefined }
  } catch (e) {
    if (e instanceof PluginLlmStructuredError) {
      const diagnostics = `LLM 结构化输出${e.message}：${e.diagnostics}`
      if (attempts >= PAGE_GENERATE_MAX_ATTEMPTS) {
        throw new Error(`${input.nodeLabel}生成重试耗尽（${PAGE_GENERATE_MAX_ATTEMPTS} 次）：${diagnostics}`)
      }
      return { value: undefined, attempts, diagnostics }
    }
    throw e
  }
}
