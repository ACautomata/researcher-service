// 端点试连 REST 契约测试（#882）。
//
// 接缝（#880 Testing Decisions 预定）：REST HTTP 面 + 注入 fake 模型工厂。fake 断言
// 「模型工厂收到的参数面」（协议/baseURL/key 解析结果）与 1-token 级 invoke 形状，
// 不断言内部实现细节。
//
// 验收（#882 AC）：成功 + 延迟展示；失败 + 净化错误文本（不含 key）；不入库、
// 不产生 provider 行、不写日志；10s 超时（测试注入短超时验证路径）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { config } from '../src/config'
import type { ChatModelFactory, ModelFactoryOptions } from '../src/models/chatFactory'

const TEST_PATH = '/api/v1/models/test'

const VALID = { preset_id: 'openai', api_key: 'sk-probe-plain-key-0123456789', model: 'gpt-5.1' }

// 测试注入的平台共享 key（test env 无 LLM_API_KEY——显式注入使缺省 key 路径可断言）
const PLATFORM_KEY = 'sk-test-platform-key-0123456789'

// fake 工厂收集面：一次试连 = 一次工厂调用 + 一次 bind + 一次 invoke。
interface FakeCall {
  model: string
  opts: ModelFactoryOptions
  bindKwargs: Array<Record<string, unknown>>
  invokeInputs: unknown[]
}

// 可变行为位：每个用例自设（成功 resolve / 抛错 / 挂起）。
let factoryCalls: FakeCall[] = []
let factoryBehavior: (call: FakeCall) => Promise<void> = async () => {}

function makeFakeFactory(): ChatModelFactory {
  return async (model: string, opts: ModelFactoryOptions) => {
    const call: FakeCall = { model, opts, bindKwargs: [], invokeInputs: [] }
    factoryCalls.push(call)
    await factoryBehavior(call)
    return {
      bind: (kwargs: Record<string, unknown>) => {
        call.bindKwargs.push(kwargs)
        return {
          invoke: async (input: unknown) => {
            call.invokeInputs.push(input)
          },
        }
      },
    } as unknown as BaseChatModel
  }
}

describe('端点试连 POST /api/v1/models/test（#882）', () => {
  let ctx: TestContext
  let access: string

  beforeAll(async () => {
    ctx = await setupTestApp({
      models: { chatModelFactory: makeFakeFactory(), platformApiKey: PLATFORM_KEY },
    })
    const user = await seedUser(ctx.prisma)
    access = (await login(ctx.request, user.username, 'pw-user1-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('未认证 → 10001', async () => {
    const res = await ctx.request.post(TEST_PATH).send(VALID)
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(10001)
  })

  it('成功：code 0 + latency_ms 数字；工厂收到参数面（协议/baseURL/key/authHeader）；invoke 前先 bind 1-token 级参数', async () => {
    factoryCalls = []
    factoryBehavior = async () => {}
    const res = await ctx.request.post(TEST_PATH).set(bearer(access)).send(VALID)
    expect(res.body.code).toBe(0)
    const data = res.body.data as Record<string, unknown>
    expect(data.ok).toBe(true)
    expect(typeof data.latency_ms).toBe('number')
    expect(data.latency_ms as number).toBeGreaterThanOrEqual(0)

    expect(factoryCalls).toHaveLength(1)
    const { model, opts, bindKwargs, invokeInputs } = factoryCalls[0]!
    // 工厂参数面：key 解析结果 = 表单明文（BYOK 直通，不经 DB）；协议/baseURL 随预设派生
    expect(model).toBe('gpt-5.1')
    expect(opts.apiKey).toBe(VALID.api_key)
    expect(opts.lcProvider).toBe('openai')
    expect(opts.baseUrl).toBe('https://api.openai.com/v1')
    expect(opts.authHeader).toBe(true)
    // 1-token 级探测：bind max_tokens=1（openai 面），最小输入
    expect(bindKwargs).toEqual([{ max_tokens: 1 }])
    expect(invokeInputs).toEqual(['hi'])
  })

  it('失败：错误 key → code 90003 + 净化错误文本（整响应不含 key 明文）', async () => {
    factoryCalls = []
    factoryBehavior = async () => {
      throw new Error(`Error 401: Incorrect API key provided: ${VALID.api_key}. Please check.`)
    }
    const res = await ctx.request.post(TEST_PATH).set(bearer(access)).send(VALID)
    expect(res.body.code).toBe(90003)
    expect(res.body.data).toBeNull()
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain(VALID.api_key)
    expect(String(res.body.message)).toContain('REDACTED')
  })

  it('api_key 缺省 + 平台预设端点 → 工厂收到平台共享 key（注入的 PLATFORM_KEY）', async () => {
    factoryCalls = []
    factoryBehavior = async () => {}
    const res = await ctx.request
      .post(TEST_PATH)
      .set(bearer(access))
      .send({ preset_id: 'minimax', model: 'MiniMax-M3' })
    expect(res.body.code).toBe(0)
    expect(factoryCalls[0]!.opts.apiKey).toBe(PLATFORM_KEY)
    // 平台预设 anthropic 兼容面：lcProvider=anthropic + Bearer 策略随预设派生
    expect(factoryCalls[0]!.opts.lcProvider).toBe('anthropic')
    expect(factoryCalls[0]!.opts.authHeader).toBe(true)
  })

  it('api_key 缺省 + 非平台预设 → 90003 拒绝（平台 key 只对平台预设地址有效，防凭证外发），不经工厂', async () => {
    factoryCalls = []
    factoryBehavior = async () => {}
    const res = await ctx.request
      .post(TEST_PATH)
      .set(bearer(access))
      .send({ preset_id: 'anthropic', model: 'claude-sonnet-5-5' })
    expect(res.body.code).toBe(90003)
    expect(String(res.body.message)).toContain('填写 API key')
    expect(factoryCalls).toHaveLength(0)
  })

  it('不入库：试连后 modelProvider 行数不变、config_meta version 不 bump', async () => {
    factoryCalls = []
    factoryBehavior = async () => {}
    const rowsBefore = await ctx.prisma.modelProvider.count()
    const versionBefore = (await ctx.prisma.configMeta.findUnique({ where: { id: 1 } }))?.version ?? 1
    const res = await ctx.request.post(TEST_PATH).set(bearer(access)).send(VALID)
    expect(res.body.code).toBe(0)
    expect(await ctx.prisma.modelProvider.count()).toBe(rowsBefore)
    const versionAfter = (await ctx.prisma.configMeta.findUnique({ where: { id: 1 } }))?.version ?? 1
    expect(versionAfter).toBe(versionBefore)
  })

  it('不写日志：试连全程（含失败路径）console 零输出', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
    factoryCalls = []
    factoryBehavior = async () => {
      throw new Error(`Error 401: bad key ${VALID.api_key}`)
    }
    await ctx.request.post(TEST_PATH).set(bearer(access)).send(VALID)
    factoryBehavior = async () => {}
    await ctx.request.post(TEST_PATH).set(bearer(access)).send(VALID)
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled()
      s.mockRestore()
    }
  })

  it('校验：未知 preset_id / 空 model / 超长 api_key → 90002 字段明细', async () => {
    factoryCalls = []
    const cases = [
      { body: { ...VALID, preset_id: 'not-a-preset' }, field: 'preset_id' },
      { body: { ...VALID, model: '' }, field: 'model' },
      { body: { ...VALID, api_key: 'k'.repeat(4097) }, field: 'api_key' },
    ]
    for (const c of cases) {
      const res = await ctx.request.post(TEST_PATH).set(bearer(access)).send(c.body)
      expect(res.body.code).toBe(90002)
      expect(res.body.data?.[c.field]).toBeDefined()
    }
    expect(factoryCalls).toHaveLength(0)
  })

  it('平台共享 key 未配置（LLM_API_KEY 空 + api_key 缺省 + 平台预设）→ 90003，不经工厂', async () => {
    const original = config.llm.apiKey
    try {
      ;(config.llm as { apiKey: string }).apiKey = ''
      // 独立 app：不注入 platformApiKey → 服务构造时落 config.llm.apiKey（已被置空）
      const emptyCtx = await setupTestApp({ models: { chatModelFactory: makeFakeFactory() } })
      const user = await seedUser(emptyCtx.prisma)
      const userAccess = (await login(emptyCtx.request, user.username, 'pw-user1-secure')).access!
      factoryCalls = []
      factoryBehavior = async () => {}
      const res = await emptyCtx.request
        .post(TEST_PATH)
        .set(bearer(userAccess))
        .send({ preset_id: 'minimax', model: 'MiniMax-M3' })
      expect(res.body.code).toBe(90003)
      expect(factoryCalls).toHaveLength(0)
      await emptyCtx.cleanup()
    } finally {
      ;(config.llm as { apiKey: string }).apiKey = original
    }
  })

  it('超时：invoke 挂起超过预算 → 90003 超时文案（测试注入短超时）', async () => {
    // 独立 app 注入 50ms 超时预算——挂起的 fake invoke 永不 settle，走 raceWithTimeout 超时路径
    const hangingCtx = await setupTestApp({
      models: { chatModelFactory: makeFakeFactory(), probeTimeoutMs: 50 },
    })
    const user = await seedUser(hangingCtx.prisma)
    const userAccess = (await login(hangingCtx.request, user.username, 'pw-user1-secure')).access!
    factoryCalls = []
    factoryBehavior = () => new Promise<void>(() => {}) // 永挂
    try {
      const res = await hangingCtx.request.post(TEST_PATH).set(bearer(userAccess)).send(VALID)
      expect(res.body.code).toBe(90003)
      expect(String(res.body.message)).toMatch(/超时/)
      const raw = JSON.stringify(res.body)
      expect(raw).not.toContain(VALID.api_key)
    } finally {
      await hangingCtx.cleanup()
    }
  })
})
