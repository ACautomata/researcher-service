// LLM usage 全量采数（#775 · #747 F 节 / story 57 成本核算数据源 · 731 §3.2「记账真值改采
// usage_metadata」）。
//
// 链路：runner 侧 LangChain callback 采数（handleLLMEnd → AIMessage.usage_metadata）→
// llm_usage_records 落行（一次 LLM 调用一行）→ aggregateUsage 核算查询（按用户/模型/时间窗
// 聚合，admin 核算面 #800 的数据源）。模型单价不入行（核算时 join modelsJson.cost——单价随
// 配置版本可变，行只存用量真值；每调用行携带 providerId/model/lcProvider 供 join）。
//
// 本文件零 langchain 类型依赖：提取器按 LangChain 消息的结构子集（usage_metadata snake_case
// 形态）宽进严出——多出的字段不进投影，缺字段回 null（采数失败不 fail run，story 57 面向
// 成本核算而非正确性关键路径）。

import type { PrismaClient } from '../generated/prisma/client'

// ---------------------------------------------------------------------------
// usage_metadata 提取（纯函数，接缝 S3）
// ---------------------------------------------------------------------------

// LangChain usage_metadata 的结构子集（AIMessage.usage_metadata，snake_case）。
// input_token_details.cache_read = 提示缓存命中；cache_creation = 缓存写入（Anthropic 语义）。
export interface UsageTokens {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

// 从 LLM 响应消息（AIMessage / AIMessageChunk / 任意结构子集）提取 usage。
// 无 usage_metadata / 形状异常 → null（调用方跳过该次采数，不落行不抛错）。
export function extractUsageMetadata(message: unknown): UsageTokens | null {
  const msg = asRecord(message)
  if (!msg) return null
  const meta = asRecord(msg.usage_metadata)
  if (!meta) return null
  const input = num(meta.input_tokens)
  const output = num(meta.output_tokens)
  // 全零不落行（空 usage 的占位块，非真实调用）
  if (input === 0 && output === 0) return null
  const details = asRecord(meta.input_token_details)
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: details ? num(details.cache_read) : 0,
    cacheWriteTokens: details ? num(details.cache_creation) : 0,
  }
}

// ---------------------------------------------------------------------------
// 落库（审计域写入；runId/sessionId 弱关联无 FK——审计行跟 user 永久）
// ---------------------------------------------------------------------------

export interface LlmUsageInput {
  readonly runId: string
  readonly sessionId: string | null
  readonly userId: string
  readonly username: string
  readonly providerId: string
  readonly lcProvider: string
  readonly model: string
  readonly usage: UsageTokens
}

export async function recordLlmUsage(
  prisma: Pick<PrismaClient, 'llmUsageRecord'>,
  row: LlmUsageInput,
): Promise<void> {
  await prisma.llmUsageRecord.create({
    data: {
      runId: row.runId,
      sessionId: row.sessionId,
      userId: row.userId,
      username: row.username,
      providerId: row.providerId,
      lcProvider: row.lcProvider,
      model: row.model,
      inputTokens: row.usage.inputTokens,
      outputTokens: row.usage.outputTokens,
      cacheReadTokens: row.usage.cacheReadTokens,
      cacheWriteTokens: row.usage.cacheWriteTokens,
    },
  })
}

// ---------------------------------------------------------------------------
// callback handler（LangChain Callbacks 装配点；结构子集宽进）
// ---------------------------------------------------------------------------

// run 采数上下文（一次 run 的身份恒定面）。注意：identity 在 handler 创建期绑定 = run 默认
// 链身份；run 内换模型（wrapModelCall）的 per-call 记账在 #777 接线时按调用上下文重建设
// 或扩展 handler 入参——本工厂不承诺从 output 自动派生 provider/model。
export interface UsageCollectorContext {
  readonly prisma: Pick<PrismaClient, 'llmUsageRecord'>
  readonly userId: string
  readonly username: string
  readonly runId: string
  readonly sessionId: string | null
}

// LangChain LLMResult 结构子集（handleLLMEnd 入参形状）。
interface LlmEndOutputLike {
  readonly generations?: ReadonlyArray<ReadonlyArray<{ message?: unknown }>>
}

// 创建可塞进 invoke/stream `callbacks` 的 usage 采数 handler（LangChain CallbackManager
// 接受带 handleLLMEnd 方法的结构对象）。落库失败吞错留日志（采数不 fail run——与提取器
// 同纪律）；每 generation 一行。
export function createUsageCallbackHandler(
  ctx: UsageCollectorContext,
  identity: { providerId: string; lcProvider: string; model: string },
): { handleLLMEnd(output: unknown): Promise<void> } {
  return {
    async handleLLMEnd(output: unknown): Promise<void> {
      try {
        const out = asRecord(output) as LlmEndOutputLike | null
        if (!out?.generations) return
        for (const batch of out.generations) {
          if (!Array.isArray(batch)) continue
          for (const gen of batch) {
            const usage = extractUsageMetadata(asRecord(gen)?.message)
            if (!usage) continue
            await recordLlmUsage(ctx.prisma, {
              runId: ctx.runId,
              sessionId: ctx.sessionId,
              userId: ctx.userId,
              username: ctx.username,
              providerId: identity.providerId,
              lcProvider: identity.lcProvider,
              model: identity.model,
              usage,
            })
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[usage] 采数落库失败（不 fail run）: ${(e as Error).message}`)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 核算查询（数据消费面；admin 核算页 #800 的后端数据源）
// ---------------------------------------------------------------------------

export interface UsageQuery {
  readonly userId?: string
  /** 时间窗半开区间 [from, to)：含 from、不含 to——相邻核算窗拼接不双计边界行（#812 打捞）。 */
  readonly from?: Date
  readonly to?: Date
}

export interface UsageAggregateRow {
  readonly userId: string
  readonly username: string
  readonly providerId: string
  readonly lcProvider: string
  readonly model: string
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

// 按用户 × provider × 模型聚合（时间窗过滤，半开区间 [from, to)——相邻核算窗拼接不双计
// 落在边界时刻的行（#812 打捞）；输出按 groupBy 全键字典序稳定——groupBy 无
// 保序承诺，消费端（核算导出/对账 diff）需要确定性序）。
// 单价 join：消费方拿 model → model_providers.modelsJson[].cost 计算（单价随配置版本可变，
// 用量行是唯一真值）。
export async function aggregateUsage(
  prisma: PrismaClient,
  query: UsageQuery = {},
): Promise<UsageAggregateRow[]> {
  const where = {
    ...(query.userId !== undefined ? { userId: query.userId } : {}),
    ...(query.from !== undefined || query.to !== undefined
      ? {
          createdAt: {
            ...(query.from !== undefined ? { gte: query.from } : {}),
            ...(query.to !== undefined ? { lt: query.to } : {}),
          },
        }
      : {}),
  }
  const groups = await prisma.llmUsageRecord.groupBy({
    by: ['userId', 'username', 'providerId', 'lcProvider', 'model'],
    where,
    _count: { _all: true },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
    },
  })
  return groups
    .map((g) => ({
      userId: g.userId,
      username: g.username,
      providerId: g.providerId,
      lcProvider: g.lcProvider,
      model: g.model,
      calls: g._count._all,
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      cacheReadTokens: g._sum.cacheReadTokens ?? 0,
      cacheWriteTokens: g._sum.cacheWriteTokens ?? 0,
    }))
    .sort(
      // 排序键覆盖 groupBy 全键（userId/username/providerId/lcProvider/model）——并列行
      // （改名/换 lcProvider 的历史数据）相对序也确定，对账 diff 才稳定。
      (a, b) =>
        a.userId.localeCompare(b.userId) ||
        a.username.localeCompare(b.username) ||
        a.providerId.localeCompare(b.providerId) ||
        a.lcProvider.localeCompare(b.lcProvider) ||
        a.model.localeCompare(b.model),
    )
}
