// #1088 真实模型评测的请求级护栏：在 fetch 边界验证实际报文参数、计数预算并采集
// provider 返回的模型版本。报告字段只是声明；本模块让「temperature/maxTokens 已生效」
// 与「没有超额请求」由实际 wire 请求证明。
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { LLMResult } from '@langchain/core/outputs'
import type { ChatModelFactory, ModelFactoryOptions } from '../../src/models/chatFactory'

export interface EvalSampling {
  readonly temperature: number
  readonly maxTokens: number
  /** DeepSeek 等供应商在 thinking 模式下忽略 temperature；评测显式关闭后才能声称 0 生效。 */
  readonly thinking?: 'enabled' | 'disabled'
}

export interface WireSamplingSample {
  readonly model: string | null
  readonly temperature: number | null
  readonly maxTokens: number | null
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens' | null
  readonly stream: boolean | null
  readonly thinking: 'enabled' | 'disabled' | null
}

export interface EvalBudget {
  maxRequests: number
  requestsUsed: number
  exhausted: boolean
}

export interface SamplingVerification {
  verified: boolean
  observed: WireSamplingSample[]
  mismatch: string[]
}

export class EvalHarnessError extends Error {
  constructor(readonly code: 'request_budget_exhausted' | 'sampling_parameter_mismatch', message: string) {
    super(message)
    this.name = 'EvalHarnessError'
  }
}

export interface EvalHarnessOptions {
  readonly maxRequests: number
  readonly modelId: string
  readonly sampling: EvalSampling
}

export interface EvalHarness {
  readonly budget: EvalBudget
  readonly samplingVerification: SamplingVerification
  readonly collector: ModelVersionCollector
  /** 解析请求体、验证采样参数并扣预算；验证失败/超额时在发网之前抛出 EvalHarnessError。 */
  wrapFetch(baseFetch: typeof fetch): typeof fetch
  modelVersions(): string[]
  modelVersion(): string | null
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error('RF_EVAL_MAX_REQUESTS must be a positive integer')
  return value
}

export function maxRequestsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.RF_EVAL_MAX_REQUESTS, 600)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 只抽取可公开的报文参数；prompt/消息正文绝不进入观测记录。 */
export function extractWireSampling(body: unknown): WireSamplingSample | null {
  const record = asRecord(body)
  if (!record) return null
  const maxTokens = numberOrNull(record.max_tokens) ?? numberOrNull(record.max_completion_tokens)
  const thinking = asRecord(record.thinking)?.type
  return {
    model: stringOrNull(record.model),
    temperature: numberOrNull(record.temperature),
    maxTokens,
    maxTokensField: numberOrNull(record.max_tokens) !== null ? 'max_tokens' : numberOrNull(record.max_completion_tokens) !== null ? 'max_completion_tokens' : null,
    stream: typeof record.stream === 'boolean' ? record.stream : null,
    thinking: thinking === 'enabled' || thinking === 'disabled' ? thinking : null,
  }
}

async function readRequestBody(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<unknown> {
  if (typeof init?.body === 'string') {
    try { return JSON.parse(init.body) } catch { return null }
  }
  if (input instanceof Request) {
    try { return await input.clone().json() } catch { return null }
  }
  return null
}

function mismatchReasons(sample: WireSamplingSample, expected: EvalHarnessOptions): string[] {
  const reasons: string[] = []
  if (!sample.model) reasons.push('missing_model')
  else if (sample.model !== expected.modelId) reasons.push(`model:${sample.model}`)
  if (sample.temperature !== expected.sampling.temperature) reasons.push(`temperature:${sample.temperature ?? 'missing'}`)
  if (sample.maxTokens !== expected.sampling.maxTokens) reasons.push(`maxTokens:${sample.maxTokens ?? 'missing'}`)
  if (expected.sampling.thinking !== undefined && sample.thinking !== expected.sampling.thinking) reasons.push(`thinking:${sample.thinking ?? 'missing'}`)
  return reasons
}

function versionFromMetadata(metadata: unknown): string | null {
  const record = asRecord(metadata)
  if (!record) return null
  for (const key of ['model_name', 'model', 'model_id', 'modelName']) {
    const version = stringOrNull(record[key])
    if (version) return version
  }
  return null
}

export class ModelVersionCollector extends BaseCallbackHandler {
  name = 'reflectionEvalModelVersionCollector'
  private readonly versions = new Set<string>()

  override async handleLLMEnd(output: LLMResult): Promise<void> {
    const llmOutput = asRecord(output.llmOutput)
    const topLevel = llmOutput ? versionFromMetadata(llmOutput) : null
    if (topLevel) this.versions.add(topLevel)
    for (const generation of output.generations ?? []) {
      for (const item of generation) {
        const message = asRecord((item as unknown as { message?: unknown }).message)
        const version = message ? versionFromMetadata(message.response_metadata) : null
        if (version) this.versions.add(version)
      }
    }
  }

  get all(): string[] {
    return [...this.versions]
  }

  get one(): string | null {
    return this.all[0] ?? null
  }
}

export function createEvalHarness(options: EvalHarnessOptions): EvalHarness {
  if (!Number.isInteger(options.maxRequests) || options.maxRequests <= 0) throw new Error('maxRequests must be a positive integer')
  const budget: EvalBudget = { maxRequests: options.maxRequests, requestsUsed: 0, exhausted: false }
  const samplingVerification: SamplingVerification = { verified: false, observed: [], mismatch: [] }
  const collector = new ModelVersionCollector()

  const wrapFetch = (baseFetch: typeof fetch): typeof fetch => async (input, init) => {
    const body = await readRequestBody(input, init)
    const sample = extractWireSampling(body)
    if (!sample) {
      samplingVerification.verified = false
      samplingVerification.mismatch.push('missing_request_body')
      throw new EvalHarnessError('sampling_parameter_mismatch', 'request body without observable sampling parameters')
    }
    const reasons = mismatchReasons(sample, options)
    if (reasons.length > 0) {
      samplingVerification.verified = false
      samplingVerification.mismatch.push(...reasons)
      throw new EvalHarnessError('sampling_parameter_mismatch', `wire sampling mismatch: ${reasons.join(',')}`)
    }
    if (budget.requestsUsed >= budget.maxRequests) {
      budget.exhausted = true
      throw new EvalHarnessError('request_budget_exhausted', `request budget exhausted at ${budget.maxRequests}`)
    }
    budget.requestsUsed += 1
    samplingVerification.observed.push(sample)
    samplingVerification.verified = true
    return baseFetch(input, init)
  }

  return {
    budget,
    samplingVerification,
    collector,
    wrapFetch,
    modelVersions: () => collector.all,
    modelVersion: () => collector.one,
  }
}

/** 与评测脚本共用同一构造路径：ConfigurableModel 的 temperature/maxTokens 必须走
 *  configurableFields 白名单，且 callbacks 随调用配置传播。 */
export async function createEvalModel(
  factory: ChatModelFactory,
  modelId: string,
  options: ModelFactoryOptions,
  sampling: EvalSampling,
  collector: ModelVersionCollector,
): Promise<BaseChatModel> {
  const model = await factory(modelId, options)
  return model.withConfig({
    configurable: {
      temperature: sampling.temperature,
      maxTokens: sampling.maxTokens,
      ...(sampling.thinking !== undefined ? { modelKwargs: { thinking: { type: sampling.thinking } } } : {}),
    },
    callbacks: [collector],
  }) as BaseChatModel
}
