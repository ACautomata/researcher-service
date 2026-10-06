// ctx.llm 回退链（#792 · #744 §6 · S3）：回退链封装在核心实现——owner providers（createdAt
// 序）逐 provider 构造/调用，失败逐级降级，全败明确报错；model 指定优先（集合外 = 配置错误
// 明确拒绝）；空集（物化后仍无 provider）明确报错；usage 采集。

import { describe, it, expect } from 'vitest'
import { createLlmToolPort } from '../src/runner/llmToolPort'

// 最小 registry 替身：不触 prisma（结构子集——getSnapshot/getModel 两面）。
type ProviderRegistryLike = { constructed: string[]; invoked: Array<{ modelId: string; opts: unknown; contents: unknown }> }

function fakeRegistry(p: {
  providers: Array<{ providerId: string; modelIds: string[] }>
  /** getModel 按 providerId 抛错（构造失败面） */
  failModels?: Record<string, string>
  /** invoke 按 modelId 抛错（调用失败面） */
  failInvokes?: Record<string, string>
  /** invoke 应答文本（缺省 'ok'） */
  replies?: Record<string, string>
}): ProviderRegistryLike {
  const constructed: string[] = []
  const invoked: Array<{ modelId: string; opts: unknown; contents: unknown }> = []
  return {
    constructed,
    invoked,
    async getSnapshot() {
      return {
        ownerId: 'u1',
        version: 1,
        providers: p.providers.map((x) => ({
          providerId: x.providerId,
          lcProvider: 'openai' as const,
          baseUrl: 'https://llm.example.com/v1',
          credentialEnvId: 'LLM_API_KEY',
          authHeader: true,
          models: x.modelIds.map((id) => ({ id })),
        })),
        endpoints: [],
      }
    },
    async getModel(_snapshot: unknown, providerId: string) {
      constructed.push(providerId)
      const fail = p.failModels?.[providerId]
      if (fail) throw new Error(fail)
      const entry = p.providers.find((x) => x.providerId === providerId)!
      const modelId = entry.modelIds[0]!
      return {
        withConfig() {
          return this
        },
        async invoke(messages: unknown, opts: unknown) {
          invoked.push({ modelId, opts, contents: messages })
          const failInvoke = p.failInvokes?.[modelId]
          if (failInvoke) throw new Error(failInvoke)
          return { content: p.replies?.[modelId] ?? 'ok', usage_metadata: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } }
        },
      } as never
    },
  } as never
}

function png(): Uint8Array {
  // 4x4 PNG（TINY_PNG 同物）
  return Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8AAAxIDEwMDAwMDAwAkBgMBjfAPdAAAAAElFTkSuQmCC', 'base64'))
}

describe('createLlmToolPort（ProviderRegistry 回退链封装）', () => {
  const opts = { maxTokens: 50000, temperature: 0.7 } as const

  it('单 provider：primary 调用成功，文本与 usage 返回，invoke 参数透传', async () => {
    const reg = fakeRegistry({ providers: [{ providerId: 'p1', modelIds: ['m-1'] }] })
    const port = createLlmToolPort(reg as never, 'u1')
    const r = await port.generateMultimodal({ contents: ['画一张方法图', { png: png() }], model: '', ...opts })
    expect(r.text).toBe('ok')
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 5, totalTokens: 8 })
    expect(reg.invoked[0]!.opts).toMatchObject({ maxTokens: 50000, temperature: 0.7 })
    const blocks = (reg.invoked[0]!.contents as { content: unknown[] }[])[0]!.content as Array<Record<string, unknown>>
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect(blocks[1]).toMatchObject({ type: 'image_url' })
    expect(String((blocks[1]!.image_url as { url: string }).url).startsWith('data:image/png;base64,')).toBe(true)
  })

  it('构造失败逐级降级：p1 构造抛错 → p2 调用成功（createdAt 序回退）', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['bad-construct'] },
        { providerId: 'p2', modelIds: ['m-2'] },
      ],
      failModels: { p1: 'whitelist miss' },
    })
    const port = createLlmToolPort(reg as never, 'u1')
    const r = await port.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(r.text).toBe('ok')
    expect(reg.constructed).toEqual(['p1', 'p2'])
  })

  it('调用失败逐级降级：p1 模型调用抛错 → p2 成功', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['boom'] },
        { providerId: 'p2', modelIds: ['m-2'] },
      ],
      failInvokes: { boom: 'rate limited' },
    })
    const port = createLlmToolPort(reg as never, 'u1')
    const r = await port.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(r.text).toBe('ok')
  })

  it('全败明确报错（不静默吞掉）', async () => {
    const reg = fakeRegistry({
      providers: [{ providerId: 'p1', modelIds: ['boom'] }],
      failInvokes: { boom: 'network down' },
    })
    const port = createLlmToolPort(reg as never, 'u1')
    await expect(port.generateMultimodal({ contents: ['hi'], model: '', ...opts })).rejects.toThrow(/全部失败/)
  })

  it('空集（物化后仍无 provider）明确配置错误', async () => {
    const reg = fakeRegistry({ providers: [] })
    const port = createLlmToolPort(reg as never, 'u1')
    await expect(port.generateMultimodal({ contents: ['hi'], model: '', ...opts })).rejects.toThrow(/无可用模型/)
  })

  it('model 指定 = 该模型优先；集合外 = 明确拒绝', async () => {
    const reg = fakeRegistry({ providers: [{ providerId: 'p1', modelIds: ['m-1'] }] })
    const port = createLlmToolPort(reg as never, 'u1')
    // 集合内指定：仍走首模型路径（fake 模型单模型），invoke 正常
    await expect(port.generateMultimodal({ contents: ['hi'], model: 'm-1', ...opts })).resolves.toMatchObject({ text: 'ok' })
    // 集合外指定：明确报错
    await expect(port.generateMultimodal({ contents: ['hi'], model: 'not-there', ...opts })).rejects.toThrow(/不在 provider 配置集合内/)
  })
})
