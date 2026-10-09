// 端点试连服务（#882）：按当前表单态（预设 + key + 模型）发起最小代价的真实试连。
//
// 不入库的构造性保证：本服务不持 prisma——试连路径根本接触不到 DB（无 provider 行、
// 无 config_meta bump）。不写日志：catch 面不 console.*，错误只经信封回前端（含 key 的
// 上游错误文本先经 sanitizeProbeError 净化，防 key 回显）。
//
// 探测代价最小化：bind max_tokens=1 + 最短输入 'hi'（1-token 级）；openai 协议遇
// 「要求 max_completion_tokens」的新模型（官方 gpt-5 系）换形重试一次。10s 超时：
// invoke 携带 AbortSignal（真 SDK 提前中止）+ 外层 raceWithTimeout（fake/异常路径兜底）。

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { EnvelopeError, fail } from '../envelope'
import { CODE } from '../codes'
import { config } from '../config'
import { raceWithTimeout } from '../raceTimeout'
import { defaultFactory, type ChatModelFactory } from './chatFactory'
import {
  presetById,
  protocolToLcProvider,
  type EndpointPreset,
} from './presets'

export interface EndpointProbeInput {
  presetId: string
  /** 明文 key：undefined/'' = 用平台共享 key */
  apiKey?: string
  model: string
}

// 错误文本净化：移除 key 的明文与 URL 编码形态（防上游错误回显 key）；截断防超长 dump。
function sanitizeProbeError(raw: string, secrets: readonly string[]): string {
  let out = raw
  for (const s of secrets) {
    if (!s) continue
    out = out.split(s).join('[REDACTED]')
    const encoded = encodeURIComponent(s)
    if (encoded !== s) out = out.split(encoded).join('[REDACTED]')
  }
  return out.slice(0, 500)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface EndpointProbeDeps {
  /** 模型工厂注入缝（测试 fake；缺省 initChatModel 真工厂） */
  readonly chatModelFactory?: ChatModelFactory
  /** 试连超时预算 ms（缺省 10s，#882 AC） */
  readonly probeTimeoutMs?: number
  /** 平台共享 key（api_key 缺省时的解析源；缺省 config.llm.apiKey） */
  readonly platformApiKey?: string
}

// 最小代价探测输入（1-token 级）
const PROBE_INPUT = 'hi'

// bind kwargs 会原样并入补全请求体（ChatOpenAI/ChatAnthropic 实测语义）——1-token 级探测。
const PROBE_MAX_TOKENS = { max_tokens: 1 } as const
const PROBE_MAX_COMPLETION_TOKENS = { max_completion_tokens: 1 } as const

export class EndpointProbeService {
  private readonly factory: ChatModelFactory
  private readonly timeoutMs: number
  private readonly platformApiKey: string

  constructor(deps: EndpointProbeDeps = {}) {
    this.factory = deps.chatModelFactory ?? defaultFactory
    this.timeoutMs = deps.probeTimeoutMs ?? 10_000
    this.platformApiKey = deps.platformApiKey ?? config.llm.apiKey
  }

  /** 成功返回延迟 ms；失败抛信封 90003 + 净化错误文本。 */
  async probe(input: EndpointProbeInput): Promise<{ ok: true; latencyMs: number }> {
    const preset = presetById(input.presetId)
    if (!preset) throw fail(CODE.VALIDATION_FAILED, undefined, { preset_id: ['未知端点预设'] })
    const apiKey =
      input.apiKey !== undefined && input.apiKey.trim() !== '' ? input.apiKey.trim() : this.platformApiKey
    if (apiKey === '') {
      throw fail(CODE.LLM_NOT_CONFIGURED, '平台共享 key 未配置（LLM_API_KEY），请自带 API key 后再试连')
    }
    const startedAt = Date.now()
    try {
      await raceWithTimeout(
        this.constructAndInvoke(preset, apiKey, input.model),
        this.timeoutMs,
        () => fail(CODE.LLM_NOT_CONFIGURED, `试连超时（${Math.round(this.timeoutMs / 1000)} 秒无响应）`),
      )
      return { ok: true, latencyMs: Date.now() - startedAt }
    } catch (e) {
      // 信封错误（超时路径）原样直达；上游/工厂错误净化包装（防 key 回显）
      if (e instanceof EnvelopeError) throw e
      throw fail(CODE.LLM_NOT_CONFIGURED, sanitizeProbeError(errText(e), [apiKey, this.platformApiKey]))
    }
  }

  private async constructAndInvoke(preset: EndpointPreset, apiKey: string, modelId: string): Promise<void> {
    const model = await this.factory(modelId, {
      lcProvider: protocolToLcProvider(preset.protocol),
      baseUrl: preset.baseUrl,
      apiKey,
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
      authHeader: preset.authHeader,
    })
    // 超时预算三层面：invoke 信号为满额 timeoutMs（重试分支另开一份）；构造+invoke 整体
    // 由外层 raceWithTimeout 以同一预算封顶——信号只让真 SDK 提前中止，总量封顶在 race。
    const signal = AbortSignal.timeout(this.timeoutMs)
    try {
      await this.invokeMinimal(model, PROBE_MAX_TOKENS, signal)
    } catch (e) {
      // OpenAI 官方新模型（gpt-5 系）拒 max_tokens 参数（要求 max_completion_tokens）→ 换形重试
      if (preset.protocol === 'openai-completions' && /max_completion_tokens/i.test(errText(e))) {
        await this.invokeMinimal(model, PROBE_MAX_COMPLETION_TOKENS, AbortSignal.timeout(this.timeoutMs))
        return
      }
      throw e
    }
  }

  // bind(kwargs) 原样并入补全请求体（ChatOpenAI/ChatAnthropic 语义）→ invoke 最小输入。
  private async invokeMinimal(
    model: BaseChatModel,
    tokenKwargs: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const bound = (
      model as unknown as {
        bind: (kwargs: Record<string, unknown>) => { invoke: (input: unknown, options?: unknown) => Promise<unknown> }
      }
    ).bind(tokenKwargs)
    await bound.invoke(PROBE_INPUT, { signal })
  }
}
