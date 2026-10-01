// LLM usage 采数测试（#775 验收 ⑤「usage 采数落审计域可被核算查询消费」）。
//
// 接缝 S3（提取纯函数 + callback handler）+ 临时库集成（落行 + groupBy 核算查询）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser } from './helpers'
import {
  extractUsageMetadata,
  createUsageCallbackHandler,
  recordLlmUsage,
  aggregateUsage,
} from '../src/runner/usage'

describe('extractUsageMetadata（S3 纯逻辑）', () => {
  it('完整形状：input/output + cache details 提取', () => {
    expect(
      extractUsageMetadata({
        usage_metadata: {
          input_tokens: 1000,
          output_tokens: 200,
          total_tokens: 1200,
          input_token_details: { cache_read: 500, cache_creation: 100 },
          output_token_details: { reasoning: 50 },
        },
      }),
    ).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 100 })
  })

  it('无 cache details → 两 cache 字段 0', () => {
    expect(extractUsageMetadata({ usage_metadata: { input_tokens: 10, output_tokens: 5 } })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('缺失 usage_metadata / 非对象 / 全零占位 → null（不落行）', () => {
    expect(extractUsageMetadata({ content: 'hi' })).toBeNull()
    expect(extractUsageMetadata(null)).toBeNull()
    expect(extractUsageMetadata('message')).toBeNull()
    expect(extractUsageMetadata({ usage_metadata: { input_tokens: 0, output_tokens: 0 } })).toBeNull()
    expect(extractUsageMetadata({ usage_metadata: { input_tokens: -5, output_tokens: 3 } })?.inputTokens).toBe(0)
  })

  it('坏值从严归零（NaN/字符串/小数），负值归 0', () => {
    expect(
      extractUsageMetadata({ usage_metadata: { input_tokens: 'x' as unknown as number, output_tokens: 3.9 } }),
    ).toEqual({ inputTokens: 0, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })
})

describe('usage 采数落审计域（临时库集成）', () => {
  let ctx: TestContext
  let alice: { id: string; username: string }

  beforeAll(async () => {
    ctx = await setupTestApp()
    alice = await seedUser(ctx.prisma, 'usageu1', 'pw-usageu1-secure')
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('callback handler：handleLLMEnd 每代提取并落行；无 usage 代跳过', async () => {
    const handler = createUsageCallbackHandler(
      { prisma: ctx.prisma, userId: alice.id, username: alice.username, runId: 'run-1', sessionId: 'sess-1' },
      { providerId: 'minimax', lcProvider: 'anthropic', model: 'MiniMax-M3' },
    )
    await handler.handleLLMEnd({
      generations: [
        [
          { message: { usage_metadata: { input_tokens: 100, output_tokens: 40, input_token_details: { cache_read: 60 } } } },
          { message: { content: 'no usage here' } },
        ],
      ],
    })
    await handler.handleLLMEnd({
      generations: [[{ message: { usage_metadata: { input_tokens: 7, output_tokens: 3 } } }]],
    })
    const rows = await ctx.prisma.llmUsageRecord.findMany({ orderBy: { createdAt: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      runId: 'run-1',
      sessionId: 'sess-1',
      userId: alice.id,
      username: alice.username,
      providerId: 'minimax',
      lcProvider: 'anthropic',
      model: 'MiniMax-M3',
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 60,
      cacheWriteTokens: 0,
    })
    expect(rows[1]).toMatchObject({ inputTokens: 7, outputTokens: 3 })
  })

  it('handler 落库失败吞错不抛（采数不 fail run）', async () => {
    const broken = {
      create: async () => {
        throw new Error('db down')
      },
    }
    const handler = createUsageCallbackHandler(
      // @ts-expect-error 测试注入坏 prisma
      { prisma: broken, userId: 'u', username: 'n', runId: 'r', sessionId: null },
      { providerId: 'p', lcProvider: 'openai', model: 'm' },
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        handler.handleLLMEnd({ generations: [[{ message: { usage_metadata: { input_tokens: 1, output_tokens: 1 } } }]] }),
      ).resolves.toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('核算查询：按用户/模型聚合 + 时间窗过滤（可被核算消费）', async () => {
    const now = new Date()
    const bob = await seedUser(ctx.prisma, 'usageu2', 'pw-usageu2-secure')
    await recordLlmUsage(ctx.prisma, {
      runId: 'r2', sessionId: null, userId: alice.id, username: alice.username,
      providerId: 'minimax', lcProvider: 'anthropic', model: 'MiniMax-M3',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    await recordLlmUsage(ctx.prisma, {
      runId: 'r3', sessionId: 's3', userId: bob.id, username: bob.username,
      providerId: 'vllm', lcProvider: 'openai', model: 'qwen3',
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 },
    })

    // 全量聚合：alice（2 行 MiniMax-M3 求和）+ bob（1 行 qwen3）
    const all = await aggregateUsage(ctx.prisma)
    const aliceRow = all.find((r) => r.userId === alice.id && r.model === 'MiniMax-M3')
    expect(aliceRow).toMatchObject({
      username: alice.username,
      providerId: 'minimax',
      lcProvider: 'anthropic',
      calls: 3, // 前 2（handler）+ 本 describe 新 1
      inputTokens: 1107, // 100 + 7 + 1000
      outputTokens: 243, // 40 + 3 + 200
      cacheReadTokens: 60,
    })
    expect(all.find((r) => r.userId === bob.id)).toMatchObject({
      model: 'qwen3',
      calls: 1,
      inputTokens: 50,
      cacheReadTokens: 5,
    })

    // 按用户过滤
    const onlyBob = await aggregateUsage(ctx.prisma, { userId: bob.id })
    expect(onlyBob).toHaveLength(1)

    // 时间窗：未来窗排除一切（from = now+1s；createdAt 均 ≤ now 附近——SQLite CURRENT_TIMESTAMP 秒级，
    // 边界可能同秒，用远未来 from 断言空集稳健）
    const future = await aggregateUsage(ctx.prisma, { from: new Date(now.getTime() + 60_000) })
    expect(future).toEqual([])

    // 宽窗全量（过去 1h）
    const past = await aggregateUsage(ctx.prisma, { from: new Date(now.getTime() - 3_600_000) })
    expect(past.length).toBeGreaterThanOrEqual(2)
  })
})
