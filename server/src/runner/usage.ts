// LLM usage 采数（#775 · 731 §3.2/§5.3，story 57 成本核算数据源）：
// 记账真值 = LLM 响应 usage_metadata（LangChain 标准 token 计量），行粒度 = 一次 LLM 调用，
// 落审计域 llm_usage 表（userId 冗余无 FK，跟 user 永久）。采数接线（LangChain callback →
// 本 recorder）归 #777 runner 核心；本文件提供写入面与核算查询消费面（summarizeLlmUsage）。
//
// 防御面：usage_metadata 缺 totalTokens 时以 input+output 兜底（不同 provider 的 details 形态
// 有差集）；负值/非有限值清洗为 0（采数是旁路，坏数据不进核算面——不抛错、不掩盖原始 run 错误；
// 本函数只保证「行要么不写、要么完整」）。

import type { PrismaClient } from '../generated/prisma/client'

export interface LlmUsageMetadata {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface LlmUsageInput {
  userId: string
  sessionId?: string | null
  runId?: string | null
  providerId?: string | null
  model: string
  usage: LlmUsageMetadata
}

function sanitizeTokenCount(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v < 0) return 0
  return Math.round(v)
}

// 单次 LLM 调用 usage 入账。totalTokens 缺失 → input+output 兜底。
export async function recordLlmUsage(
  prisma: Pick<PrismaClient, 'llmUsage'>,
  input: LlmUsageInput,
): Promise<void> {
  const inputTokens = sanitizeTokenCount(input.usage.inputTokens)
  const outputTokens = sanitizeTokenCount(input.usage.outputTokens)
  const totalTokens = input.usage.totalTokens !== undefined
    ? sanitizeTokenCount(input.usage.totalTokens)
    : inputTokens + outputTokens
  await prisma.llmUsage.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      providerId: input.providerId ?? null,
      model: input.model,
      inputTokens,
      outputTokens,
      totalTokens,
    },
  })
}

// 核算查询消费面（story 57）：per-user 按模型聚合（调用数 + token 三元组和），时间窗可选。
// admin 面板/成本报表直接消费本查询（后续票挂 REST 时复用）。
export interface LlmUsageSummary {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export async function summarizeLlmUsage(
  prisma: Pick<PrismaClient, 'llmUsage'>,
  opts: { userId: string; from?: Date; to?: Date },
): Promise<LlmUsageSummary[]> {
  const rows = await prisma.llmUsage.groupBy({
    by: ['model'],
    where: {
      userId: opts.userId,
      ...(opts.from || opts.to
        ? { createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lt: opts.to } : {}) } }
        : {}),
    },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, totalTokens: true },
    orderBy: { _sum: { totalTokens: 'desc' } },
  })
  return rows.map((r) => ({
    model: r.model,
    calls: r._count._all,
    inputTokens: r._sum.inputTokens ?? 0,
    outputTokens: r._sum.outputTokens ?? 0,
    totalTokens: r._sum.totalTokens ?? 0,
  }))
}
