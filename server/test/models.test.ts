// models REST 契约测试（#336 · #857 owner 级；#881 预设制换形 + BYOK 凭证单向流）。
//
// #881 后形状：端点 = presetId（六预设锁定协议/地址，无自由 baseURL——SSRF 构造性消灭）+
// credentialCipher（AES-256-GCM v1 信封）。白名单双层校验链整链退役（表/REST/校验/fetch
// 复验/DNS/逃生 env）——原 90002 base_url / 40042 运行时面不复存在。
//
// 凭证单向流验收（#881 AC）：写请求可带明文，落库即密文；列表/详情只出掩码；
// **响应体整 JSON 断言无明文无密文**；解密失败读不炸（key_error 标记）；
// 编辑 key 留空 = 保持不变；保留 id（'platform'）抢注写侧拒绝。
// 凭证 AES 真实 round-trip（#880 Testing Decisions：主接缝①）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { config } from '../src/config'
import { decryptCredential } from '../src/models/cipher'

const PROVIDERS_PATH = '/api/v1/models/providers'
const PRESETS_PATH = '/api/v1/models/presets'
const PLATFORM_PATH = '/api/v1/models/platform'

// 测试密钥 = config dev 弱默认（NODE_ENV=test 走 dev 分支）；AES round-trip 同源验证。
const TEST_SECRET = config.llm.credentialSecret

const VALID = {
  provider_id: 'my-gpt',
  preset_id: 'openai',
  api_key: 'sk-test-plain-key-0123456789',
  models: [
    {
      id: 'gpt-5.1',
      name: 'GPT-5.1',
      reasoning: true,
      input: ['text'],
      contextWindow: 400000,
      maxTokens: 128000,
    },
  ],
}

// 整响应体断言：任何字段不含明文 key 与密文信封（v1: 前缀）。
function assertNoKeyMaterial(body: unknown, plaintext: string): void {
  const raw = JSON.stringify(body)
  expect(raw).not.toContain(plaintext)
  expect(raw).not.toContain('v1:')
  expect(raw).not.toContain('api_key":')
}

describe('models REST（#881 预设制 + BYOK 凭证单向流）', () => {
  let ctx: TestContext
  let adminAccess: string
  let userAccess: string
  let otherAccess: string
  const providerOf = (pid: string): string => `${PROVIDERS_PATH}/${pid}`
  const configVersion = async (): Promise<number | null> => {
    const row = await ctx.prisma.configMeta.findUnique({ where: { id: 1 } })
    return row?.version ?? null
  }

  beforeAll(async () => {
    ctx = await setupTestApp()
    const admin = await seedAdmin(ctx.prisma)
    const user = await seedUser(ctx.prisma)
    const other = await seedUser(ctx.prisma, 'user2', 'pw-user2-secure')
    adminAccess = (await login(ctx.request, admin.username, 'pw-admin1-secure')).access!
    userAccess = (await login(ctx.request, user.username, 'pw-user1-secure')).access!
    otherAccess = (await login(ctx.request, other.username, 'pw-user2-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // ---------------------------- 认证（公共前置）----------------------------

  it('未认证 → 10001（presets / platform / providers 三面同守）', async () => {
    for (const path of [PRESETS_PATH, PLATFORM_PATH, PROVIDERS_PATH]) {
      const res = await ctx.request.get(path)
      expect(res.status).toBe(200)
      expect(res.body.code).toBe(10001)
    }
  })

  // ---------------------------- 预设目录 + 平台默认端点视图 ----------------------------

  it('GET /presets：六预设下发（id/protocol/base_url/default_models；无敏感面）', async () => {
    const res = await ctx.request.get(PRESETS_PATH).set(bearer(userAccess))
    expect(res.body.code).toBe(0)
    const presets = res.body.data as Array<Record<string, unknown>>
    expect(presets.map((p) => p.id)).toEqual(['minimax', 'anthropic', 'openai', 'deepseek', 'kimi', 'zhipu'])
    const openai = presets.find((p) => p.id === 'openai')!
    expect(openai.protocol).toBe('openai-completions')
    expect(openai.base_url).toBe('https://api.openai.com/v1')
    expect((openai.default_models as Array<{ id: string }>).length).toBeGreaterThanOrEqual(1)
    // kimi 带尾斜杠、zhipu 不带（URL 逐字锁定经 wire 下发）
    expect(presets.find((p) => p.id === 'kimi')!.base_url).toBe('https://api.moonshot.cn/v1/')
    expect(presets.find((p) => p.id === 'zhipu')!.base_url).toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  it('GET /platform：平台默认端点只读卡（协议/地址/默认模型/key 配置状态；整响应无 key 材料）', async () => {
    const res = await ctx.request.get(PLATFORM_PATH).set(bearer(userAccess))
    expect(res.body.code).toBe(0)
    const card = res.body.data as Record<string, unknown>
    expect(card.provider_id).toBe('platform')
    expect(card.preset_id).toBe(config.llm.preset)
    expect(card.protocol).toBe('anthropic-messages')
    expect(card.base_url).toBe('https://api.minimaxi.com/anthropic')
    // default_model = LLM_MODEL 覆盖 ?? 预设首模型；key_configured = 平台 key 已配置布尔
    const expectedModel = config.llm.model !== '' ? config.llm.model : 'MiniMax-M3'
    expect(card.default_model).toBe(expectedModel)
    expect(card.key_configured).toBe(config.llm.apiKey !== '')
    assertNoKeyMaterial(res.body, config.llm.apiKey || 'sk-nothing')
  })

  // ---------------------------- POST：建 BYOK 端点 ----------------------------

  it('POST：建端点成功——响应只出掩码；DB 落密文；整响应 JSON 无明文无密文；AES round-trip 可解', async () => {
    const before = (await configVersion()) ?? 1 // 无行按基线 1（bumpConfigVersion 首建 = 2）
    const res = await ctx.request.post(PROVIDERS_PATH).set(bearer(userAccess)).send(VALID)
    expect(res.body.code).toBe(0)
    const view = res.body.data as Record<string, unknown>
    expect(view.provider_id).toBe('my-gpt')
    expect(view.preset_id).toBe('openai')
    expect(view.protocol).toBe('openai-completions')
    expect(view.base_url).toBe('https://api.openai.com/v1') // 预设派生只读
    expect(view.api_key_masked).toBe('sk-••••6789')
    expect(view.key_error).toBe(false)
    assertNoKeyMaterial(res.body, VALID.api_key)

    // DB 直读：落库即密文（无明文列）；AES 真实 round-trip
    const row = await ctx.prisma.modelProvider.findFirst({ where: { ownerId: { not: '' }, providerId: 'my-gpt' } })
    expect(row).not.toBeNull()
    expect(row!.credentialCipher).not.toBeNull()
    expect(row!.credentialCipher).not.toContain(VALID.api_key)
    expect(decryptCredential(row!.credentialCipher!, TEST_SECRET)).toBe(VALID.api_key)

    // 事务内 version bump（热生效信号）
    expect(await configVersion()).toBe((before ?? 0) + 1)
  })

  it('POST：无 api_key → cipher NULL（平台共享 key），掩码 null', async () => {
    const res = await ctx.request.post(PROVIDERS_PATH).set(bearer(userAccess)).send({
      provider_id: 'no-key',
      preset_id: 'deepseek',
      models: [{ id: 'deepseek-v4-flash' }],
    })
    expect(res.body.code).toBe(0)
    expect(res.body.data.api_key_masked).toBeNull()
    const row = await ctx.prisma.modelProvider.findFirst({ where: { providerId: 'no-key' } })
    expect(row!.credentialCipher).toBeNull()
  })

  it('POST：未知 preset_id → 90002 字段级；保留 id "platform" 抢注 → 90002', async () => {
    const badPreset = await ctx.request.post(PROVIDERS_PATH).set(bearer(userAccess)).send({
      ...VALID,
      provider_id: 'bad-preset',
      preset_id: 'vllm',
    })
    expect(badPreset.body.code).toBe(90002)
    expect(badPreset.body.data.preset_id).toBeDefined()

    const reserved = await ctx.request.post(PROVIDERS_PATH).set(bearer(userAccess)).send({
      ...VALID,
      provider_id: 'platform',
    })
    expect(reserved.body.code).toBe(90002)
    expect(reserved.body.data.provider_id).toBeDefined()
    expect(await ctx.prisma.modelProvider.count({ where: { providerId: 'platform' } })).toBe(0)
  })

  it('POST：provider_id 格式非法（DNS-label 外）→ 90002 字段级', async () => {
    const res = await ctx.request.post(PROVIDERS_PATH).set(bearer(userAccess)).send({
      ...VALID,
      provider_id: 'bad id!',
    })
    expect(res.body.code).toBe(90002)
    expect(res.body.data.provider_id).toBeDefined()
    expect(await ctx.prisma.modelProvider.count({ where: { providerId: 'bad id!' } })).toBe(0)
  })

  it('POST：自由 base_url 字段传入被剥离（zod strict 未知 key 丢弃；端点按预设建）', async () => {
    const res = await ctx.request.post(PROVIDERS_PATH).set(bearer(userAccess)).send({
      ...VALID,
      provider_id: 'with-url',
      base_url: 'https://attacker.example.com/v1',
    })
    // zod strict 语义：未知 key 剥离（passthrough 未开）——base_url 不入库，端点按预设建
    expect(res.body.code).toBe(0)
    expect(res.body.data.base_url).toBe('https://api.openai.com/v1')
  })

  it('POST：同 owner pid 冲突 → 40041；models 空 → 90002', async () => {
    const conflict = await ctx.request.post(PROVIDERS_PATH).set(bearer(userAccess)).send(VALID)
    expect(conflict.body.code).toBe(40041)
    const noModels = await ctx.request.post(PROVIDERS_PATH).set(bearer(userAccess)).send({
      provider_id: 'empty-models',
      preset_id: 'openai',
      models: [],
    })
    expect(noModels.body.code).toBe(90002)
  })

  // ---------------------------- GET：列表 / 单条（掩码 + key_error）----------------------------

  it('GET 列表与单条：掩码回显、无明文无密文；跨用户探测同码 40040（防探测）', async () => {
    const list = await ctx.request.get(PROVIDERS_PATH).set(bearer(userAccess))
    expect(list.body.code).toBe(0)
    const mine = (list.body.data as Array<Record<string, unknown>>).find((p) => p.provider_id === 'my-gpt')!
    expect(mine.api_key_masked).toBe('sk-••••6789')
    assertNoKeyMaterial(list.body, VALID.api_key)

    const detail = await ctx.request.get(providerOf('my-gpt')).set(bearer(userAccess))
    expect(detail.body.code).toBe(0)
    assertNoKeyMaterial(detail.body, VALID.api_key)

    // 跨用户探测：other 用户取 user 的 pid → 40040 同码（不存在对外不可区分）
    const probe = await ctx.request.get(providerOf('my-gpt')).set(bearer(otherAccess))
    expect(probe.body.code).toBe(40040)
    const missing = await ctx.request.get(providerOf('never-existed')).set(bearer(otherAccess))
    expect(missing.body.code).toBe(40040)
  })

  it('坏密文行：读不炸 200 + key_error=true + 掩码 null（解密失败标记）', async () => {
    await ctx.prisma.modelProvider.create({
      data: {
        ownerId: (await ctx.prisma.user.findFirst({ where: { username: 'user1' } }))!.id,
        providerId: 'broken-cipher',
        presetId: 'anthropic',
        credentialCipher: 'v1:AAAA:BBBB:CCCC',
        modelsJson: JSON.stringify([{ id: 'claude-sonnet-5-5' }]),
      },
    })
    const res = await ctx.request.get(providerOf('broken-cipher')).set(bearer(userAccess))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.key_error).toBe(true)
    expect(res.body.data.api_key_masked).toBeNull()
    assertNoKeyMaterial(res.body, 'v1:AAAA:BBBB:CCCC')
  })

  // ---------------------------- PUT：key 留空保持不变 ----------------------------

  it('PUT：key 留空 → 凭证保持（DB 密文不变）；提供新 key → 密文更新且可解', async () => {
    const rowBefore = await ctx.prisma.modelProvider.findFirst({ where: { providerId: 'my-gpt' } })
    const cipherBefore = rowBefore!.credentialCipher

    const keep = await ctx.request.put(providerOf('my-gpt')).set(bearer(userAccess)).send({
      provider_id: 'my-gpt',
      preset_id: 'openai',
      models: [{ id: 'gpt-5.1' }],
    })
    expect(keep.body.code).toBe(0)
    expect(keep.body.data.api_key_masked).toBe('sk-••••6789') // 掩码不变 = 凭证保持
    const rowKeep = await ctx.prisma.modelProvider.findFirst({ where: { providerId: 'my-gpt' } })
    expect(rowKeep!.credentialCipher).toBe(cipherBefore) // 密文逐字节不变

    const rotated = 'sk-rotated-key-9876543210'
    const replace = await ctx.request.put(providerOf('my-gpt')).set(bearer(userAccess)).send({
      provider_id: 'my-gpt',
      preset_id: 'openai',
      api_key: rotated,
      models: [{ id: 'gpt-5.1' }],
    })
    expect(replace.body.code).toBe(0)
    expect(replace.body.data.api_key_masked).toBe('sk-••••3210')
    assertNoKeyMaterial(replace.body, rotated)
    const rowNew = await ctx.prisma.modelProvider.findFirst({ where: { providerId: 'my-gpt' } })
    expect(rowNew!.credentialCipher).not.toBe(cipherBefore)
    expect(decryptCredential(rowNew!.credentialCipher!, TEST_SECRET)).toBe(rotated)
  })

  it('纯空白 api_key 归一为「留空」语义：PUT trim 后空 → 凭证逐字节保持（不落坏密文）；POST trim 后空 → 平台共享（cipher NULL）', async () => {
    const rowBefore = await ctx.prisma.modelProvider.findFirst({ where: { providerId: 'my-gpt' } })
    const cipherBefore = rowBefore!.credentialCipher

    const keep = await ctx.request.put(providerOf('my-gpt')).set(bearer(userAccess)).send({
      provider_id: 'my-gpt',
      preset_id: 'openai',
      api_key: '   ',
      models: [{ id: 'gpt-5.1' }],
    })
    expect(keep.body.code).toBe(0)
    const rowKeep = await ctx.prisma.modelProvider.findFirst({ where: { providerId: 'my-gpt' } })
    expect(rowKeep!.credentialCipher).toBe(cipherBefore) // trim 后空 = 保持不变（绝非 cipher=NULL 清成平台共享）

    const blank = await ctx.request.post(PROVIDERS_PATH).set(bearer(userAccess)).send({
      provider_id: 'blank-key',
      preset_id: 'deepseek',
      api_key: '   ',
      models: [{ id: 'deepseek-chat' }],
    })
    expect(blank.body.code).toBe(0)
    expect(blank.body.data.api_key_masked).toBeNull() // trim 后空 = 平台共享 key 语义
    const rowBlank = await ctx.prisma.modelProvider.findFirst({ where: { providerId: 'blank-key' } })
    expect(rowBlank!.credentialCipher).toBeNull()
  })

  it('PUT：撞同 owner 既有 pid → 40041；不存在 → 40040', async () => {
    await ctx.request.post(PROVIDERS_PATH).set(bearer(userAccess)).send({
      provider_id: 'second-ep',
      preset_id: 'kimi',
      models: [{ id: 'kimi-k2' }],
    })
    const conflict = await ctx.request.put(providerOf('my-gpt')).set(bearer(userAccess)).send({
      provider_id: 'second-ep',
      preset_id: 'kimi',
      models: [{ id: 'kimi-k2' }],
    })
    expect(conflict.body.code).toBe(40041)
    const missing = await ctx.request.put(providerOf('never-existed')).set(bearer(userAccess)).send({
      provider_id: 'never-existed',
      preset_id: 'kimi',
      models: [{ id: 'kimi-k2' }],
    })
    expect(missing.body.code).toBe(40040)
  })

  // ---------------------------- DELETE ----------------------------

  it('DELETE：删除 + 热生效 bump；不存在/越权 → 40040 同码', async () => {
    const before = (await configVersion()) ?? 1
    const res = await ctx.request.delete(providerOf('second-ep')).set(bearer(userAccess))
    expect(res.body.code).toBe(0)
    expect(await configVersion()).toBe((before ?? 0) + 1)
    expect(
      await ctx.prisma.modelProvider.count({ where: { providerId: 'second-ep' } }),
    ).toBe(0)

    const gone = await ctx.request.delete(providerOf('second-ep')).set(bearer(userAccess))
    expect(gone.body.code).toBe(40040)
    // 跨用户删除他人端点：同码 40040（防探测）
    const foreign = await ctx.request.delete(providerOf('my-gpt')).set(bearer(otherAccess))
    expect(foreign.body.code).toBe(40040)
    expect(await ctx.prisma.modelProvider.count({ where: { providerId: 'my-gpt' } })).toBe(1)
  })

  it('admin 亦只操作本人配置面（owner 级无跨用户覆写面）', async () => {
    const res = await ctx.request.get(providerOf('my-gpt')).set(bearer(adminAccess))
    expect(res.body.code).toBe(40040)
  })
})
