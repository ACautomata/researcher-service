// ctx.llm 回退链（#792 · #744 §6 · S3）：回退链封装在核心实现——owner providers（createdAt
// 序）逐 provider 构造/调用，失败逐级降级，全败明确报错；model 指定优先（集合外 = 配置错误
// 明确拒绝）；空集（物化后仍无 provider）明确报错；usage 采集。
//
// #883 T3 per-plugin 解析器：端口绑定 pluginId + run 启动捕获的快照（frame 构造期——在飞
// run 不受指派/端点变更影响）。解析优先级 = env pin（opts.model 非空，AUTOFIGURE_SVG_MODEL
// 遗留兼容面）> 用户指派（悬挂回落平台默认 + 告警；调用失败明确报错不降级）> 默认链
//（用户端点序 + 平台垫底）。
//
// #853 §3.2#3/#4：generateStructured（JSON 提取 + zod 校验 + 诊断透出）与 frame signal
// 闭包捕获（invoke 自动透传 + abort 不降级——autofigure abort 计费缺口修复）。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createLlmToolPort, parseStructuredOutput } from '../src/runner/llmToolPort'
import { PluginLlmStructuredError } from '../src/plugins/api'
import { TINY_PNG } from './autofigureFakePorts'

// 最小 registry 替身：不触 prisma（结构子集——getSnapshot/getModel 两面）。
type ProviderRegistryLike = { constructed: string[]; invoked: Array<{ modelId: string; opts: unknown; contents: unknown }> }

function fakeRegistry(p: {
  providers: Array<{ providerId: string; modelIds: string[] }>
  /** 快照内插件指派（pluginId → 引用；缺省空表 = 无指派） */
  pluginAssignments?: Record<string, { providerId: string | null; modelId: string | null }>
  /** getModel 按 providerId 抛错（构造失败面） */
  failModels?: Record<string, string>
  /** invoke 按 modelId 抛错（调用失败面） */
  failInvokes?: Record<string, string>
  /** invoke 应答文本（缺省 'ok'） */
  replies?: Record<string, string>
}): ProviderRegistryLike {
  const constructed: string[] = []
  const invoked: Array<{ modelId: string; opts: unknown; contents: unknown }> = []
  const snapshot = {
    ownerId: 'u1',
    version: 1,
    providers: p.providers.map((x) => ({
      providerId: x.providerId,
      lcProvider: 'openai' as const,
      baseUrl: 'https://llm.example.com/v1',
      authHeader: true,
      models: x.modelIds.map((id) => ({ id })),
    })),
    pluginAssignments: new Map(Object.entries(p.pluginAssignments ?? {})),
  }
  return {
    constructed,
    invoked,
    async getSnapshot() {
      return snapshot
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

// 新签名构造（快照构造期捕获——run 粒度）。
async function portOf(reg: ProviderRegistryLike, pluginId = 'autofigure') {
  const snapshot = await (reg as unknown as { getSnapshot: () => Promise<unknown> }).getSnapshot()
  return createLlmToolPort({ registry: reg as never, ownerId: 'u1', pluginId, snapshot: snapshot as never })
}

describe('createLlmToolPort（ProviderRegistry 回退链封装）', () => {
  const opts = { maxTokens: 50000, temperature: 0.7 } as const

  afterEach(() => vi.restoreAllMocks())

  it('单 provider：primary 调用成功，文本与 usage 返回，invoke 参数透传', async () => {
    const reg = fakeRegistry({ providers: [{ providerId: 'p1', modelIds: ['m-1'] }] })
    const port = await portOf(reg)
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
    const port = await portOf(reg)
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
    const port = await portOf(reg)
    const r = await port.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(r.text).toBe('ok')
  })

  it('全败明确报错（不静默吞掉）', async () => {
    const reg = fakeRegistry({
      providers: [{ providerId: 'p1', modelIds: ['boom'] }],
      failInvokes: { boom: 'network down' },
    })
    const port = await portOf(reg)
    await expect(port.generateMultimodal({ contents: ['hi'], model: '', ...opts })).rejects.toThrow(/全部失败/)
  })

  it('空集（物化后仍无 provider）明确配置错误', async () => {
    const reg = fakeRegistry({ providers: [] })
    const port = await portOf(reg)
    await expect(port.generateMultimodal({ contents: ['hi'], model: '', ...opts })).rejects.toThrow(/无可用模型/)
  })

  it('model 指定 = 该模型优先；集合外 = 明确拒绝', async () => {
    const reg = fakeRegistry({ providers: [{ providerId: 'p1', modelIds: ['m-1'] }] })
    const port = await portOf(reg)
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
    const port = await portOf(reg)
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
    const port = await portOf(reg)
    await expect(port.generateMultimodal({ contents: ['hi'], model: 'm-2', ...opts })).rejects.toThrow(/m-2 调用失败/)
    // 降级默认链被 pin 语义阻断：仅 pin 模型被调用
    expect(reg.invoked.map((i) => i.modelId)).toEqual(['m-2'])
  })
})

describe('createLlmToolPort（#883 per-plugin 解析器：指派 > 默认链）', () => {
  const opts = { maxTokens: 50000, temperature: 0.7 } as const

  afterEach(() => vi.restoreAllMocks())

  it('BYOK 指派：调用指派端点+模型（非首模型经 configurable 通道）', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1', 'm-2'] },
        { providerId: 'platform', modelIds: ['MiniMax-M3'] },
      ],
      pluginAssignments: { autofigure: { providerId: 'p1', modelId: 'm-2' } },
    })
    const port = await portOf(reg)
    const r = await port.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(r.text).toBe('ok')
    expect(reg.invoked.map((i) => i.modelId)).toEqual(['m-2'])
  })

  it("指派 model_id null = 端点首模型；'platform' 指派落平台条目", async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1', 'm-2'] },
        { providerId: 'platform', modelIds: ['MiniMax-M3'] },
      ],
      pluginAssignments: {
        autofigure: { providerId: 'p1', modelId: null },
        judge: { providerId: 'platform', modelId: null },
      },
    })
    const a = await portOf(reg, 'autofigure')
    await a.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(reg.invoked.map((i) => i.modelId)).toEqual(['m-1'])
    const j = await portOf(reg, 'judge')
    await j.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(reg.invoked.at(-1)!.modelId).toBe('MiniMax-M3')
  })

  it('providerId null 行 = 显式跟随默认链（首 provider 首模型，非指派面）', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1'] },
        { providerId: 'platform', modelIds: ['MiniMax-M3'] },
      ],
      pluginAssignments: { autofigure: { providerId: null, modelId: null } },
    })
    const port = await portOf(reg)
    await port.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(reg.invoked.map((i) => i.modelId)).toEqual(['m-1'])
  })

  it('悬挂指派（端点已删 / 模型已移出）→ warn + 回落平台默认（不拒载不报错）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1'] },
        { providerId: 'platform', modelIds: ['MiniMax-M3'] },
      ],
      pluginAssignments: {
        autofigure: { providerId: 'ghost-ep', modelId: 'm' }, // 端点整行已删
        judge: { providerId: 'p1', modelId: 'm-gone' }, // 模型已移出列表
      },
    })
    const a = await portOf(reg, 'autofigure')
    await a.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(reg.invoked.at(-1)!.modelId).toBe('MiniMax-M3')
    const j = await portOf(reg, 'judge')
    await j.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(reg.invoked.at(-1)!.modelId).toBe('MiniMax-M3')
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(warnSpy.mock.calls[0]![0]).toContain('悬挂')
  })

  it('指派调用失败 = 明确报错不降级（不静默换模型——产物非指派模型 = 配置失真）', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1', 'm-2'] },
        { providerId: 'platform', modelIds: ['MiniMax-M3'] },
      ],
      pluginAssignments: { autofigure: { providerId: 'p1', modelId: 'm-2' } },
      failInvokes: { 'm-2': 'quota exceeded' },
    })
    const port = await portOf(reg)
    await expect(port.generateMultimodal({ contents: ['hi'], model: '', ...opts })).rejects.toThrow(/指派模型/)
    expect(reg.invoked.map((i) => i.modelId)).toEqual(['m-2'])
  })

  it('env pin（opts.model 非空）压过用户指派——遗留 AUTOFIGURE_SVG_MODEL 优先级最高', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1', 'm-2'] },
        { providerId: 'p2', modelIds: ['m-3'] },
      ],
      pluginAssignments: { autofigure: { providerId: 'p1', modelId: 'm-2' } },
    })
    const port = await portOf(reg)
    await port.generateMultimodal({ contents: ['hi'], model: 'm-3', ...opts })
    expect(reg.invoked.map((i) => i.modelId)).toEqual(['m-3'])
  })

  it('插件隔离：同快照不同 pluginId 各自解析（无指派插件走默认链）', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1'] },
        { providerId: 'p2', modelIds: ['m-2'] },
        { providerId: 'platform', modelIds: ['MiniMax-M3'] },
      ],
      pluginAssignments: { autofigure: { providerId: 'p2', modelId: null } },
    })
    const assigned = await portOf(reg, 'autofigure')
    await assigned.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(reg.invoked.at(-1)!.modelId).toBe('m-2')
    const unassigned = await portOf(reg, 'other-plugin')
    await unassigned.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(reg.invoked.at(-1)!.modelId).toBe('m-1') // 默认链 primary
  })
})

// ---------------------------------------------------------------------------
// #853 §3.2#4 frame signal 闭包捕获：invoke 自动透传 + abort 不降级（autofigure abort
// 计费缺口修复面——abort 后插件嵌套 LLM 调用停止、不再计费）。
// ---------------------------------------------------------------------------

describe('createLlmToolPort（#853 §3.2#4 frame signal 闭包捕获）', () => {
  const opts = { maxTokens: 4096, temperature: 0.2 } as const

  afterEach(() => vi.restoreAllMocks())

  it('signal 透传底层 invoke options（签名不出现 signal——端口构造入参闭包捕获）', async () => {
    const controller = new AbortController()
    const reg = fakeRegistry({ providers: [{ providerId: 'p1', modelIds: ['m-1'] }], replies: { 'm-1': '{"v":"ok"}' } })
    const snapshot = await (reg as unknown as { getSnapshot: () => Promise<unknown> }).getSnapshot()
    const port = createLlmToolPort({ registry: reg as never, ownerId: 'u1', pluginId: 'autofigure', snapshot: snapshot as never, signal: controller.signal })
    await port.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect((reg.invoked[0]!.opts as { signal?: AbortSignal }).signal).toBe(controller.signal)
    await port.generateStructured({ schema: z.object({ v: z.string() }), contents: ['hi'] })
    expect((reg.invoked[1]!.opts as { signal?: AbortSignal }).signal).toBe(controller.signal)
  })

  it('abort 后默认链立即终止：p1 invoke 中止 signal → 不烧 p2（不降级不继续计费）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = new AbortController()
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['slow'] },
        { providerId: 'p2', modelIds: ['m-2'] },
      ],
    })
    // p1 invoke 期间中止 run signal 并抛 abort 错误（模拟 run abort 打断在飞调用）
    const snapshot = await (reg as unknown as { getSnapshot: () => Promise<unknown> }).getSnapshot()
    const base = (reg as unknown as { getModel: (s: unknown, p: string) => Promise<unknown> }).getModel.bind(reg)
    ;(reg as unknown as { getModel: typeof base }).getModel = async (snap: unknown, providerId: string) => {
      const model = await base(snap as never, providerId)
      if (providerId === 'p1') {
        return {
          invoke: async (messages: unknown, invokeOpts: unknown) => {
              // 记录面与 fakeRegistry.makeInvoke 同构（断言「仅 p1 被调」）
            ;(reg as unknown as { invoked: Array<{ modelId: string; opts: unknown; contents: unknown }> }).invoked.push({ modelId: 'slow', opts: invokeOpts, contents: messages })
            controller.abort()
            throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' })
          },
        } as never
      }
      return model
    }
    const port = createLlmToolPort({ registry: reg as never, ownerId: 'u1', pluginId: 'autofigure', snapshot: snapshot as never, signal: controller.signal })
    await expect(port.generateMultimodal({ contents: ['hi'], model: '', ...opts })).rejects.toThrow(/aborted/)
    // abort 后不进回退链下一 ref：仅 p1 被调用，全败告警面也未触达
    expect(reg.invoked.map((i) => i.modelId)).toEqual(['slow'])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// #853 §3.2#3 generateStructured：JSON 提取 + zod 校验 + 诊断透出（#906 修订①）。
// 纯逻辑面（parseStructuredOutput）+ 端口面（回退链复用 / 参数透传 / 诊断不降级）。
// ---------------------------------------------------------------------------

const CardSchema = z.object({ title: z.string(), confidence: z.number() })

describe('parseStructuredOutput（结构化输出解析：提取 + zod + 诊断）', () => {
  it('裸 JSON 与代码围栏/前后噪声形态均解析出 zod 产物', () => {
    expect(parseStructuredOutput('{"title":"t","confidence":0.9}', CardSchema)).toEqual({ title: 't', confidence: 0.9 })
    expect(
      parseStructuredOutput('前言\n```json\n{"title":"t","confidence":0.9}\n```\n后记', CardSchema),
    ).toEqual({ title: 't', confidence: 0.9 })
    expect(
      parseStructuredOutput('模型自述：{"title":"t","confidence":0.9} 以上。', CardSchema),
    ).toEqual({ title: 't', confidence: 0.9 })
  })

  it('无 JSON 对象 → PluginLlmStructuredError（diagnostics 透出）', () => {
    let caught: unknown
    try {
      parseStructuredOutput('完全没有结构化内容', CardSchema)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PluginLlmStructuredError)
    expect((caught as PluginLlmStructuredError).diagnostics).toContain('无 JSON 对象')
    expect((caught as PluginLlmStructuredError).raw).toBe('完全没有结构化内容')
  })

  it('JSON 语法错误 → diagnostics 带语法诊断', () => {
    try {
      parseStructuredOutput('{"title": t}', CardSchema)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(PluginLlmStructuredError)
      expect((e as PluginLlmStructuredError).diagnostics).toContain('JSON 语法错误')
    }
  })

  it('zod 校验失败 → diagnostics 透出 issue 路径与消息（节点层重试 prompt 回喂面）', () => {
    try {
      parseStructuredOutput('{"title":"t","confidence":"high"}', CardSchema)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(PluginLlmStructuredError)
      const diag = (e as PluginLlmStructuredError).diagnostics
      expect(diag).toContain('confidence')
      expect(diag).toContain('number')
    }
  })
})

describe('createLlmToolPort.generateStructured（端口面）', () => {
  const OkSchema = z.object({ v: z.string() })

  afterEach(() => vi.restoreAllMocks())

  it('默认链成功路径：JSON 文本 → zod 产物；temperature 缺省 0、maxTokens 缺省不透传', async () => {
    const reg = fakeRegistry({ providers: [{ providerId: 'p1', modelIds: ['m-1'] }], replies: { 'm-1': '{"v":"ok"}' } })
    const port = await portOf(reg)
    await expect(port.generateStructured({ schema: OkSchema, contents: ['hi'] })).resolves.toEqual({ v: 'ok' })
    const invokeOpts = reg.invoked[0]!.opts as { maxTokens?: number; temperature?: number }
    expect(invokeOpts.temperature).toBe(0)
    expect('maxTokens' in invokeOpts).toBe(false)
    await port.generateStructured({ schema: OkSchema, contents: ['hi'], maxTokens: 32000, temperature: 0.3 })
    expect(reg.invoked[1]!.opts).toMatchObject({ maxTokens: 32000, temperature: 0.3 })
  })

  it('解析失败诊断透出调用方（不降级默认链——诊断交节点层重试回喂）', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1'] },
        { providerId: 'p2', modelIds: ['m-2'] },
      ],
      replies: { 'm-1': 'not json at all' },
    })
    const port = await portOf(reg)
    await expect(port.generateStructured({ schema: OkSchema, contents: ['hi'] })).rejects.toBeInstanceOf(PluginLlmStructuredError)
    expect(reg.invoked.map((i) => i.modelId)).toEqual(['m-1'])
  })

  it('回退链复用：默认链 p1 调用层失败（非解析面）→ p2 成功', async () => {
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['boom'] },
        { providerId: 'p2', modelIds: ['m-2'] },
      ],
      failInvokes: { boom: 'transport reset' },
      replies: { 'm-2': '{"v":"from-p2"}' },
    })
    const port = await portOf(reg)
    await expect(port.generateStructured({ schema: OkSchema, contents: ['hi'] })).resolves.toEqual({ v: 'from-p2' })
  })

  it('model pin 语义同 generateMultimodal：集合外明确拒绝', async () => {
    const reg = fakeRegistry({ providers: [{ providerId: 'p1', modelIds: ['m-1'] }] })
    const port = await portOf(reg)
    await expect(port.generateStructured({ schema: OkSchema, contents: ['hi'], model: 'ghost' })).rejects.toThrow(/不在 provider 配置集合内/)
  })
})

// ---------------------------------------------------------------------------
// #906 修订② usage 采数口径（ctx.llm 面 usageOf）：inputTokens = input_tokens + cache_read。
// ---------------------------------------------------------------------------

describe('createLlmToolPort（#906 修订② usageOf 全输入口径）', () => {
  afterEach(() => vi.restoreAllMocks())

  it('usage_metadata 带 cache_read：返回与分账落库均为全输入（input + cache_read）', async () => {
    const rows: Record<string, unknown>[] = []
    const reg = fakeRegistry({ providers: [{ providerId: 'p1', modelIds: ['m-1'] }] })
    // 扩展 fake 应答带 input_token_details.cache_read（MiniMax 网关形态：input_tokens 只计未命中部分）
    const snapshot = await (reg as unknown as { getSnapshot: () => Promise<unknown> }).getSnapshot()
    const base = (reg as unknown as { getModel: (s: unknown, p: string) => Promise<unknown> }).getModel.bind(reg)
    ;(reg as unknown as { getModel: typeof base }).getModel = async (snap: unknown, providerId: string) => {
      const model = (await base(snap as never, providerId)) as { invoke: (m: unknown, o: unknown) => Promise<unknown> }
      return {
        invoke: async (m: unknown, o: unknown) => {
          const res = (await model.invoke(m, o)) as { content: string; usage_metadata: Record<string, unknown> }
          return { ...res, usage_metadata: { ...res.usage_metadata, input_token_details: { cache_read: 700 } } }
        },
      } as never
    }
    const port = createLlmToolPort({
      registry: reg as never,
      ownerId: 'u1',
      pluginId: 'autofigure',
      snapshot: snapshot as never,
      usage: { prisma: { llmUsageRecord: { create: async ({ data }: { data: Record<string, unknown> }) => void rows.push(data) } } as never, userId: 'u1', username: 'alice', runId: 'r1', sessionId: 's1' },
    })
    const r = await port.generateMultimodal({ contents: ['hi'], model: '', maxTokens: 1024, temperature: 0 })
    // totalTokens 按全输入口径重算（input+output）——网关 total 原值不含 cache_read 不自洽
    expect(r.usage).toEqual({ inputTokens: 703, outputTokens: 5, totalTokens: 708 })
    expect(rows[0]).toMatchObject({ inputTokens: 703, providerId: 'p1' })
  })
})

describe('createLlmToolPort（#880 US23 用量分账：ctx.llm 流量落 llm_usage_records）', () => {
  const opts = { maxTokens: 50000, temperature: 0.7 } as const

  function fakePrisma(rows: Record<string, unknown>[], failCreate = false) {
    return {
      llmUsageRecord: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (failCreate) throw new Error('db down')
          rows.push(data)
        },
      },
    }
  }

  async function portWithUsage(reg: ProviderRegistryLike, prisma: unknown, pluginId = 'autofigure') {
    const snapshot = await (reg as unknown as { getSnapshot: () => Promise<unknown> }).getSnapshot()
    return createLlmToolPort({
      registry: reg as never,
      ownerId: 'u1',
      pluginId,
      snapshot: snapshot as never,
      usage: { prisma: prisma as never, userId: 'u1', username: 'alice', runId: 'r1', sessionId: 's1' },
    })
  }

  it('成功调用按解析命中的 providerId/modelId 落一行（BYOK 指派面）', async () => {
    const rows: Record<string, unknown>[] = []
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1', 'm-2'] },
        { providerId: 'platform', modelIds: ['MiniMax-M3'] },
      ],
      pluginAssignments: { autofigure: { providerId: 'p1', modelId: 'm-2' } },
    })
    const port = await portWithUsage(reg, fakePrisma(rows))
    const r = await port.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(r.text).toBe('ok')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      providerId: 'p1',
      lcProvider: 'openai',
      model: 'm-2',
      runId: 'r1',
      sessionId: 's1',
      userId: 'u1',
      username: 'alice',
      inputTokens: 3,
      outputTokens: 5,
    })
  })

  it('悬挂回落平台：分账记回落后的实际调用面（providerId=platform）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rows: Record<string, unknown>[] = []
    const reg = fakeRegistry({
      providers: [
        { providerId: 'p1', modelIds: ['m-1'] },
        { providerId: 'platform', modelIds: ['MiniMax-M3'] },
      ],
      pluginAssignments: { autofigure: { providerId: 'ghost-ep', modelId: 'm' } },
    })
    const port = await portWithUsage(reg, fakePrisma(rows))
    await port.generateMultimodal({ contents: ['hi'], model: '', ...opts })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ providerId: 'platform', model: 'MiniMax-M3' })
    warnSpy.mockRestore()
  })

  it('落库失败不 fail run（采数纪律）；无 usage ctx（探针面）不记账', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rows: Record<string, unknown>[] = []
    const reg = fakeRegistry({ providers: [{ providerId: 'p1', modelIds: ['m-1'] }] })
    const port = await portWithUsage(reg, fakePrisma(rows, true))
    await expect(port.generateMultimodal({ contents: ['hi'], model: '', ...opts })).resolves.toMatchObject({ text: 'ok' })
    expect(rows).toHaveLength(0)
    // 无 usage ctx：调用成功且不触任何 prisma
    const bare = await portOf(reg)
    await expect(bare.generateMultimodal({ contents: ['hi'], model: '', ...opts })).resolves.toMatchObject({ text: 'ok' })
    warnSpy.mockRestore()
  })
})
