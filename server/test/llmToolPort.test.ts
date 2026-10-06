// ctx.llm 回退链（#792 · #744 §6 · S3）：回退链封装在核心实现——owner providers（createdAt
// 序）逐 provider 构造/调用，失败逐级降级，全败明确报错；model 指定优先（集合外 = 配置错误
// 明确拒绝）；空集（物化后仍无 provider）明确报错；usage 采集。

import { describe, it, expect } from 'vitest'
import { createLlmToolPort } from '../src/runner/llmToolPort'
import { TINY_PNG } from './autofigureFakePorts'

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
      const first = entry.modelIds[0]!
      const makeInvoke = (modelId: string) => async (messages: unknown, opts: unknown) => {
        invoked.push({ modelId, opts, contents: messages })
        const failInvoke = p.failInvokes?.[modelId]
        if (failInvoke) throw new Error(failInvoke)
        return { content: p.replies?.[modelId] ?? 'ok', usage_metadata: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } }
      }
      return {
        // configurable 通道换模型（providerRegistry getModel 头注同源——per-request 非首模型走此）
        withConfig(cfg: { configurable?: { model?: string } }) {
          return { invoke: makeInvoke(cfg?.configurable?.model ?? first) }
        },
        invoke: makeInvoke(first),
      } as never
    },
  } as never
}

describe('createLlmToolPort（ProviderRegistry 回退链封装）', () => {
  const opts = { maxTokens: 50000, temperature: 0.7 } as const

  it('单 provider：primary 调用成功，文本与 usage 返回，invoke 参数透传', async () => {
    const reg = fakeRegistry({ providers: [{ providerId: 'p1', modelIds: ['m-1'] }] })
    const port = createLlmToolPort(reg as never, 'u1')
    const r = await port.generateMultimodal({ contents: ['画一张方法图', { png: TINY_PNG }], model: '', ...opts })
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

  it('model 指定非首模型：检索域 = 全 provider 全模型，经 configurable 通道绑定', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1', 'm-2'] },
        { providerId: 'p2', modelIds: ['m-3'] },
      ],
    })
    const port = createLlmToolPort(reg as never, 'u1')
    const r = await port.generateMultimodal({ contents: ['hi'], model: 'm-2', ...opts })
    expect(r.text).toBe('ok')
    expect(reg.invoked[0]!.modelId).toBe('m-2')
  })

  it('指定模型调用失败 = 明确报错（pin 语义，不静默降级默认链）', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1', 'm-2'] },
        { providerId: 'p2', modelIds: ['m-3'] },
      ],
      failInvokes: { 'm-2': 'quota exceeded' },
    })
    const port = createLlmToolPort(reg as never, 'u1')
    await expect(port.generateMultimodal({ contents: ['hi'], model: 'm-2', ...opts })).rejects.toThrow(/m-2 调用失败/)
    // 降级默认链被 pin 语义阻断：仅 pin 模型被调用
    expect(reg.invoked.map((i) => i.modelId)).toEqual(['m-2'])
  })
})
