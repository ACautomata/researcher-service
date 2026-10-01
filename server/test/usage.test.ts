// LLM usage 采数单测（#775 · 731 §3.2/§5.3，story 57）。
// 覆盖验收「usage 采数落审计域可被核算查询消费」：recordLlmUsage 落行（per-call 粒度、
// totalTokens 兜底、防御清洗）、summarizeLlmUsage 按模型聚合 + 时间窗 + user 隔离。
// 经 setupTestApp 真 SQLite（审计域表族 S1 同基座）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { recordLlmUsage, summarizeLlmUsage } from '../src/runner/usage'

describe('LLM usage 采数（llm_usage 审计域）', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('recordLlmUsage 落行：per-call 粒度 + 关联字段齐备', async () => {
    await recordLlmUsage(ctx.prisma, {
      userId: 'u-usage-1',
      sessionId: 'sess-1',
      runId: 'run-1',
      providerId: 'minimax',
      model: 'MiniMax-M3',
      usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
    })
    const row = await ctx.prisma.llmUsage.findFirst({ where: { userId: 'u-usage-1' } })
    expect(row).toMatchObject({
      userId: 'u-usage-1',
      sessionId: 'sess-1',
      runId: 'run-1',
      providerId: 'minimax',
      model: 'MiniMax-M3',
      inputTokens: 120,
      outputTokens: 80,
      totalTokens: 200,
    })
  })

  it('totalTokens 缺失 → input+output 兜底；可选项缺省 null；负值/非有限清洗为 0', async () => {
    await recordLlmUsage(ctx.prisma, {
      userId: 'u-usage-2',
      model: 'glm-4-plus',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    await recordLlmUsage(ctx.prisma, {
      userId: 'u-usage-2',
      model: 'glm-4-plus',
      usage: { inputTokens: -3, outputTokens: Number.NaN },
    })
    const rows = await ctx.prisma.llmUsage.findMany({ where: { userId: 'u-usage-2' }, orderBy: { createdAt: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ sessionId: null, runId: null, providerId: null, totalTokens: 15 })
    expect(rows[1]).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })

  it('summarizeLlmUsage：按模型聚合（调用数 + token 三元组和），totalTokens 降序', async () => {
    for (const usage of [
      { model: 'MiniMax-M3', inputTokens: 100, outputTokens: 50 },
      { model: 'MiniMax-M3', inputTokens: 10, outputTokens: 5 },
      { model: 'glm-4-plus', inputTokens: 1000, outputTokens: 500 }, // 最大 total
    ]) {
      await recordLlmUsage(ctx.prisma, { userId: 'u-sum', model: usage.model, usage })
    }
    const summary = await summarizeLlmUsage(ctx.prisma, { userId: 'u-sum' })
    expect(summary).toEqual([
      { model: 'glm-4-plus', calls: 1, inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      { model: 'MiniMax-M3', calls: 2, inputTokens: 110, outputTokens: 55, totalTokens: 165 },
    ])
  })

  it('summarizeLlmUsage：时间窗过滤 + user 隔离（核算查询按 user 消费）', async () => {
    // 窗口相对 now 构造（测试不依赖运行日期）：from = 明天 → 既有行全部窗外
    const from = new Date(Date.now() + 86_400_000)
    const to = new Date(from.getTime() + 86_400_000)
    await recordLlmUsage(ctx.prisma, { userId: 'u-win', model: 'm1', usage: { inputTokens: 1, outputTokens: 1 } })
    const before = await summarizeLlmUsage(ctx.prisma, { userId: 'u-win', from, to })
    expect(before).toEqual([])
    // 窗内：直接写 createdAt 落窗
    await ctx.prisma.llmUsage.create({
      data: { userId: 'u-win', model: 'm1', inputTokens: 7, outputTokens: 3, totalTokens: 10, createdAt: from },
    })
    const inWin = await summarizeLlmUsage(ctx.prisma, { userId: 'u-win', from, to })
    expect(inWin).toEqual([{ model: 'm1', calls: 1, inputTokens: 7, outputTokens: 3, totalTokens: 10 }])
    // user 隔离：他 user 的行不进本 user 的核算
    const other = await summarizeLlmUsage(ctx.prisma, { userId: 'u-sum', from, to })
    expect(other).toEqual([])
  })
})
