// ctx.llm 句柄核心实现（#744 §6/§11.1 · #792）：ProviderRegistry 出口的高层多模态句柄。
// 回退链封装在核心实现内，插件不碰 registry 查询逻辑：默认链 = owner providers（createdAt
// 序）× 各自首模型，构造或调用失败逐级降级，全败明确报错（不静默换模型）；AUTOFIGURE_SVG_MODEL
// 指定 = 集合内任一模型优先（检索域全 provider 全模型，非首模型经 configurable 通道绑定）。
// owner 无 provider → loadSnapshot 惰性物化面板默认 provider（providerDefaults）——物化后
// 仍为空集 = 面板未配置 → 明确配置错误。
//
// 不走 getDefaultModel 的 withFallbacks 组合链：RunnableWithFallbacks.bind 会丢 fallbacks
//（langchain RunnableBinding.bind 不复制子类字段）——figure 调用须携带上游保真参数
//（maxTokens/temperature），手动逐级链行为确定且可测（S3 fake registry）。

import { HumanMessage } from '@langchain/core/messages'
import type { ProviderRegistry } from './providerRegistry'
import { CODE } from '../codes'
import { fail } from '../envelope'
import type { PluginLlmContent, PluginLlmPort, PluginLlmResult, PluginToolUsage } from '../plugins/api'
import { pngToDataUri } from '../figures/dataUri'

// provider 内非首模型的绑定形态（getModel 缓存 key 不含 model——per-request 换模型走
// configurable 通道，providerRegistry getModel 头注同源）。
function bindModelId(base: Awaited<ReturnType<ProviderRegistry['getModel']>>, modelId: string, firstModelId: string | undefined) {
  return modelId === firstModelId ? base : base.withConfig({ configurable: { model: modelId } })
}

function toMessageContent(contents: readonly PluginLlmContent[]) {
  return contents.map((c) =>
    typeof c === 'string'
      ? { type: 'text' as const, text: c }
      : { type: 'image_url' as const, image_url: { url: pngToDataUri(c.png) } },
  )
}

function usageOf(message: unknown): PluginToolUsage | undefined {
  const meta = (message as { usage_metadata?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown } } | null)?.usage_metadata
  if (!meta) return undefined
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const inputTokens = num(meta.input_tokens)
  const outputTokens = num(meta.output_tokens)
  const totalTokens = num(meta.total_tokens)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}) }
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .join('')
  }
  return ''
}

export function createLlmToolPort(registry: ProviderRegistry, ownerId: string): PluginLlmPort {
  return {
    async generateMultimodal(opts): Promise<PluginLlmResult> {
      const snapshot = await registry.getSnapshot(ownerId)
      // 默认回退链：providers（createdAt 序）× 各自首模型（agent 面不暴露选模参数——V1
      // 图形面多模态文本缺省固定 provider 首模型，#744 §6「多模态文本走 ProviderRegistry」；
      // 面板级选模 = AUTOFIGURE_SVG_MODEL，走下方指定路径）。
      let refs = snapshot.providers.flatMap((p) => (p.models[0]?.id ? [{ provider: p, modelId: p.models[0]!.id }] : []))
      if (refs.length === 0) {
        throw fail(CODE.LLM_NOT_CONFIGURED, '无可用模型（figure 生成需要 owner 或面板默认 provider）')
      }
      // model 非空 = 指定模型优先：检索域 = 全 provider 全模型（AUTOFIGURE_SVG_MODEL 可指
      // 集合内任一模型，非首模型经 bindModelId 的 configurable 通道绑定）；集合外 = 配置错误
      // 明确拒绝（resolveModelRef「集合外值拒绝」同语义，不静默换模型）。
      if (opts.model.trim() !== '') {
        const owner = snapshot.providers.find((p) => p.models.some((m) => m.id === opts.model))
        if (!owner) throw fail(CODE.PROVIDER_NOT_FOUND, `模型 ${opts.model} 不在 provider 配置集合内（AUTOFIGURE_SVG_MODEL 配置错误）`)
        refs = [{ provider: owner, modelId: opts.model }, ...refs.filter((r) => r.modelId !== opts.model)]
      }
      let lastError: unknown
      for (const ref of refs) {
        try {
          const model = bindModelId(await registry.getModel(snapshot, ref.provider.providerId), ref.modelId, ref.provider.models[0]?.id)
          // 参数走 invoke CallOptions 通道（bind 会经 RunnableBinding 丢 fallback 语义面）。
          const message = await model.invoke(
            [new HumanMessage({ content: toMessageContent(opts.contents) })] as never,
            { maxTokens: opts.maxTokens, temperature: opts.temperature } as never,
          )
          const text = textOf(message)
          if (!text) throw new Error('empty LLM response')
          const usage = usageOf(message)
          return { text, ...(usage !== undefined ? { usage } : {}) }
        } catch (e) {
          lastError = e
        }
      }
      // 全败明确报错（#744 §6「无默认 → 工具返回明确配置错误」同语义——这里是调用全败）。
      // reason 稳定非敏感（#744 §11.2 failed{reason} 落审计面）：provider 细节只进服务端
      // 日志，不串入错误消息。
      // eslint-disable-next-line no-console
      console.warn(`[figures] llm 回退链全败: owner=${ownerId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
      throw fail(CODE.LLM_NOT_CONFIGURED, 'figure 生成模型调用全部失败（见服务端日志）')
    },
  }
}
