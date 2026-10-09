// ctx.llm 句柄核心实现（#744 §6/§11.1 · #792 · #883 T3 per-plugin 解析器）：ProviderRegistry
// 出口的高层多模态句柄。端口绑定 pluginId + run 启动捕获的快照（frame 构造期 await
// getSnapshot——指派/端点变更 bump 版本后下一 run 重建快照，本 run 持旧快照跑完，「在飞 run
// 不受影响」与主模型 getDefaultModel 同语义）。
//
// 解析优先级（#883 AC）：
//   1. env pin（opts.model 非空 = AUTOFIGURE_SVG_MODEL 遗留兼容面，键已标废弃、设值启动告警）：
//      集合内任一模型（检索域全 provider 全模型）；集合外/调用失败明确报错不降级。
//   2. 用户指派（快照 pluginAssignments[pluginId]，providerId 非空）：端点+模型单目标；
//      modelId null = 端点首模型；悬挂（端点已删/模型已移出/端点空模型）→ warn + 回落平台
//      默认（首模型）；调用失败明确报错不降级（不静默换模型——产物非指派模型 = 配置失真）。
//   3. 默认链：providers（createdAt 序）+ 平台虚拟条目垫底（#881）各自首模型，构造或调用
//      失败逐级降级，全败明确报错。
//
// 不走 getDefaultModel 的 withFallbacks 组合链：RunnableWithFallbacks.bind 会丢 fallbacks
//（langchain RunnableBinding.bind 不复制子类字段）——figure 调用须携带上游保真参数
//（maxTokens/temperature），手动逐级链行为确定且可测（S3 fake registry）。

import { HumanMessage } from '@langchain/core/messages'
import type { ProviderRegistry, ProviderConfigSnapshot } from './providerRegistry'
import { CODE } from '../codes'
import { fail } from '../envelope'
import { PLATFORM_PROVIDER_ID } from '../models/presets'
import type { PluginLlmContent, PluginLlmPort, PluginLlmResult, PluginToolUsage } from '../plugins/api'
import { extractUsageMetadata, recordLlmUsage, type UsageCollectorContext } from './usage'
import { pngToDataUri } from '../figures/dataUri'

// 平台默认端点条目 + 首模型（悬挂回落目标，#883）。平台条目快照恒垫底（#881）；无可用
// 模型 = 面板预设无默认模型（防御面，正常配置不触达）→ 明确配置错误。
//（命名区分 providerRegistry 的平台条目构造面：此处是快照检索 + 回落专用投影。）
function platformFallbackEntry(snapshot: ProviderConfigSnapshot) {
  const platform = snapshot.providers.find((p) => p.providerId === PLATFORM_PROVIDER_ID)
  const modelId = platform?.models[0]?.id
  if (!platform || modelId === undefined) {
    throw fail(CODE.LLM_NOT_CONFIGURED, '插件指派悬挂且平台默认端点无可用模型')
  }
  return { provider: platform, modelId }
}

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

// 用量分账（#880 US23）：ctx.llm 每次成功调用按解析命中的 providerId/modelId 落
// llm_usage_records 一行——插件流量（BYOK 端点或平台 key）与主对话同面核算。
// 采数不 fail run（usage.ts callback 同纪律）；无 usage ctx（探针面）跳过。
async function recordUsage(
  ctx: UsageCollectorContext | undefined,
  ref: { provider: ProviderConfigSnapshot['providers'][number]; modelId: string },
  message: unknown,
): Promise<void> {
  if (!ctx) return
  const tokens = extractUsageMetadata(message)
  if (!tokens) return
  try {
    await recordLlmUsage(ctx.prisma, {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      username: ctx.username,
      providerId: ref.provider.providerId,
      lcProvider: ref.provider.lcProvider,
      model: ref.modelId,
      usage: tokens,
    })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[usage] 插件 ctx.llm 采数落库失败（不 fail run）: ${(e as Error).message}`)
  }
}

export interface LlmToolPortInput {
  readonly registry: ProviderRegistry
  readonly ownerId: string
  /** 绑定的插件 id（per-plugin 解析键；'judge' 行消费面归审批判定器后票） */
  readonly pluginId: string
  /** run 启动捕获的配置快照（frame 构造期——在飞 run 不受指派/端点变更影响） */
  readonly snapshot: ProviderConfigSnapshot
  /** 用量分账上下文（#880 US23：ctx.llm 流量按 providerId 落 llm_usage_records；
   *  缺省不记账——注册期探针等无 run 身份的调用面） */
  readonly usage?: UsageCollectorContext
}

export function createLlmToolPort(input: LlmToolPortInput): PluginLlmPort {
  const { registry, ownerId, pluginId, snapshot } = input
  return {
    async generateMultimodal(opts): Promise<PluginLlmResult> {
      // 默认回退链：providers（createdAt 序）× 各自首模型（agent 面不暴露选模参数——V1
      // 图形面多模态文本缺省固定 provider 首模型，#744 §6「多模态文本走 ProviderRegistry」；
      // 面板级选模 = AUTOFIGURE_SVG_MODEL，走下方指定路径）。
      let refs = snapshot.providers.flatMap((p) => (p.models[0]?.id ? [{ provider: p, modelId: p.models[0]!.id }] : []))
      // single = pin/指派单目标语义：调用失败明确报错，不走逐级降级（不静默换模型）。
      let single = false
      // model 非空 = 指定模型（运维 pin，#883 起标废弃的遗留兼容面）：检索域 = 全 provider
      // 全模型（AUTOFIGURE_SVG_MODEL 可指集合内任一模型，非首模型经 bindModelId 的
      // configurable 通道绑定）；集合外 = 明确拒绝（resolveModelRef「集合外值拒绝」同语义）。
      // pin 失败 = 明确报错不降级默认链（spec §6「不静默换模型」精神——降级出产 = 产物非
      // pin 模型 + graph meta.svgModel 误记请求名）。码沿用 PROVIDER_NOT_FOUND 是刻意的：
      // 它在 errorKind LLM 白名单内（errorKind.ts）→ run.failed 分类 llm_error，用户动作面 =
      // 「检查 model 配置」。
      const pinned = opts.model.trim() !== '' ? opts.model : undefined
      if (pinned !== undefined) {
        const owner = snapshot.providers.find((p) => p.models.some((m) => m.id === pinned))
        if (!owner) throw fail(CODE.PROVIDER_NOT_FOUND, `模型 ${pinned} 不在 provider 配置集合内（AUTOFIGURE_SVG_MODEL 配置错误）`)
        refs = [{ provider: owner, modelId: pinned }]
        single = true
      } else {
        // 用户指派（#883）：providerId null = 显式跟随默认链（落默认链路径）。
        const assignment = snapshot.pluginAssignments.get(pluginId)
        if (assignment && assignment.providerId !== null) {
          const entry = snapshot.providers.find((p) => p.providerId === assignment.providerId)
          const modelId = assignment.modelId ?? entry?.models[0]?.id ?? null
          if (!entry || modelId === null || (assignment.modelId !== null && !entry.models.some((m) => m.id === assignment.modelId))) {
            // 悬挂回落（#880 story 11「服务不中断」同族）：指派引用已删端点/已移出模型是
            // 配置变更后的常态数据 → warn + 回落平台默认（首模型），不拒载不报错。
            const fallback = platformFallbackEntry(snapshot)
            refs = [{ provider: fallback.provider, modelId: fallback.modelId }]
            // eslint-disable-next-line no-console
            console.warn(`[plugins] 插件 LLM 指派悬挂，回落平台默认：plugin=${pluginId} providerId=${assignment.providerId} modelId=${assignment.modelId ?? '<端点默认>'}`)
          } else {
            refs = [{ provider: entry, modelId }]
          }
          single = true
        }
      }
      if (refs.length === 0) {
        throw fail(CODE.LLM_NOT_CONFIGURED, '无可用模型（figure 生成需要 owner 或面板默认 provider）')
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
          await recordUsage(input.usage, ref, message)
          return { text, ...(usage !== undefined ? { usage } : {}) }
        } catch (e) {
          lastError = e
          if (single) break // pin/指派单目标：调用失败明确报错，不静默换模型
        }
      }
      // 全败明确报错（#744 §6「无默认 → 工具返回明确配置错误」同语义——这里是调用全败）。
      // reason 稳定非敏感（#744 §11.2 failed{reason} 落审计面）：provider 细节只进服务端
      // 日志，不串入错误消息。
      // eslint-disable-next-line no-console
      console.warn(`[figures] llm 回退链全败: owner=${ownerId} plugin=${pluginId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
      const reason =
        pinned !== undefined
          ? `figure 生成模型 ${pinned} 调用失败（见服务端日志）`
          : single
            ? `插件 ${pluginId} 指派模型调用失败（见服务端日志；可在 Model 页改指派或撤回默认链）`
            : 'figure 生成模型调用全部失败（见服务端日志）'
      throw fail(CODE.LLM_NOT_CONFIGURED, reason)
    },
  }
}
