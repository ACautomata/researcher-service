// ProviderConfigBuilder 纯逻辑测试（#336 · 平移 backend/models/tests/test_config_builder.py）。
// 消费 ProviderSpec 列表，把 DB model provider 合并进 base openclaw.json cfg：
// - 空 providers → base 透传（P0 兼容：无托管 provider 时沿用模板默认）。
// - 非空 → 全量替换 models.providers（DB 单一来源）；agents.defaults.model 按序重算
//   primary/fallbacks/aliases —— 删除任一 provider 天然无悬空引用。
// - apiKey 永远写 SecretRef {source:env,provider:default,id:<env_id>}，不落明文（r28 §2）。

import { describe, it, expect } from 'vitest'
import { ProviderConfigBuilder, type ProviderSpec } from '../src/models/configBuilder'
import { ConfigurationError } from '../src/containers/errors'

// 生产 base 一定来自模板（deploy/openclaw.json 含 secrets.providers.default，#366 codex P2：
// 非空 providers 写 SecretRef(provider:default) 前须确认该 secret provider 存在）。纯逻辑测试
// 的 base 沿用「模板含 default secret provider」的常态，缺省校验单独用负例覆盖。
const SECRETS_BASE = { secrets: { providers: { default: { source: 'env' } } } }

function spec(overrides: Partial<ProviderSpec> = {}): ProviderSpec {
  return {
    providerId: 'my-anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://x/anthropic',
    apiKeyEnvId: 'LLM_API_KEY',
    authHeader: true,
    models: [{ id: 'm1', name: 'M1' }],
    ...overrides,
  }
}

describe('ProviderConfigBuilder（#336 纯逻辑）', () => {
  // ---------------------------- 空 providers：透传 ----------------------------

  it('空 providers → base 透传（深拷贝，不 mutate 入参）', () => {
    const base = {
      models: { mode: 'merge', providers: { minimax: { api: 'anthropic-messages' } } },
      agents: { defaults: { model: { primary: 'minimax/x' } } },
    }
    const out = new ProviderConfigBuilder().build(base, [])
    expect(out).toEqual(base)
    expect(out).not.toBe(base) // 深拷贝：返回新对象
    // 二次断言不 mutate：构建后入参原样
    expect(base.models.providers.minimax).toEqual({ api: 'anthropic-messages' })
  })

  // ---------------------------- 单 provider：完整形态 + SecretRef ----------------------------

  it('单 anthropic provider 渲染完整形态 + SecretRef 不落明文', () => {
    const out = new ProviderConfigBuilder().build(
      { secrets: { providers: { default: { source: 'env' } } } },
      [
        spec({
          providerId: 'my-anthropic',
          api: 'anthropic-messages',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          apiKeyEnvId: 'LLM_API_KEY',
          models: [
            {
              id: 'MiniMax-M3',
              name: 'MiniMax M3',
              reasoning: true,
              input: ['text', 'image'],
              cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
              contextWindow: 1048576,
              maxTokens: 524288,
            },
          ],
        }),
      ],
    )
    const prov = (out.models as Record<string, any>).providers['my-anthropic']
    expect(prov.baseUrl).toBe('https://api.minimaxi.com/anthropic')
    expect(prov.api).toBe('anthropic-messages')
    expect(prov.authHeader).toBe(true)
    expect(prov.models[0].id).toBe('MiniMax-M3')
    // apiKey 必为 SecretRef，不落明文（r28 §2）
    expect(prov.apiKey).toEqual({ source: 'env', provider: 'default', id: 'LLM_API_KEY' })
    expect(typeof prov.apiKey).not.toBe('string')
  })

  it('单 provider：primary 取首个 ref、fallbacks 空、aliases 生成', () => {
    const out = new ProviderConfigBuilder().build(SECRETS_BASE, [spec({ providerId: 'p', models: [{ id: 'm', name: 'M' }] })])
    const model = (out.agents as Record<string, any>).defaults.model
    expect(model.primary).toBe('p/m')
    expect(model.fallbacks).toEqual([])
    expect((out.agents as Record<string, any>).defaults.models).toEqual({ 'p/m': { alias: 'M' } })
  })

  // ---------------------------- api 取值：openai vs anthropic（r28 修正点）----------------------------

  it('openai-completions provider 原样写入（r28 修正点：不写死 anthropic-messages）', () => {
    const out = new ProviderConfigBuilder().build(SECRETS_BASE, [spec({ api: 'openai-completions' })])
    expect((out.models as Record<string, any>).providers['my-anthropic'].api).toBe('openai-completions')
  })

  it('anthropic-messages provider 原样写入', () => {
    const out = new ProviderConfigBuilder().build(SECRETS_BASE, [spec({ api: 'anthropic-messages' })])
    expect((out.models as Record<string, any>).providers['my-anthropic'].api).toBe('anthropic-messages')
  })

  // ---------------------------- 多 provider：primary/fallbacks 顺序 ----------------------------

  it('多 provider：入参序决定 primary/fallbacks；多模型展开为多个 ref', () => {
    const a = spec({ providerId: 'pa', models: [{ id: 'a1', name: 'A1' }] })
    const b = spec({ providerId: 'pb', models: [{ id: 'b1', name: 'B1' }, { id: 'b2', name: 'B2' }] })
    const out = new ProviderConfigBuilder().build(SECRETS_BASE, [a, b])
    const model = (out.agents as Record<string, any>).defaults.model
    expect(model.primary).toBe('pa/a1')
    expect(model.fallbacks).toEqual(['pb/b1', 'pb/b2'])
    expect((out.agents as Record<string, any>).defaults.models).toEqual({
      'pa/a1': { alias: 'A1' },
      'pb/b1': { alias: 'B1' },
      'pb/b2': { alias: 'B2' },
    })
  })

  // ---------------------------- 删除级联：无悬空引用 ----------------------------

  it('删除任一 provider 后重 build：无悬空引用', () => {
    // 模拟「先有两个 provider，删除第一个」：仅剩 b
    const b = spec({ providerId: 'pb', models: [{ id: 'b1', name: 'B1' }] })
    const out = new ProviderConfigBuilder().build(SECRETS_BASE, [b])
    const providers = (out.models as Record<string, any>).providers
    expect(providers.pa).toBeUndefined()
    expect(providers.pb).toBeDefined()
    const model = (out.agents as Record<string, any>).defaults.model
    expect(model.primary).toBe('pb/b1')
    const serialized = JSON.stringify(out.agents)
    expect(serialized).not.toContain('pa/')
  })

  // ---------------------------- 非空替换模板 providers（DB 单一来源）----------------------------

  it('非空 providers 全量替换模板 providers（DB 单一来源）；无关键保留', () => {
    const base = {
      ...SECRETS_BASE,
      models: { mode: 'merge', providers: { minimax: { api: 'anthropic-messages' } } },
      agents: { defaults: { model: { primary: 'minimax/MiniMax-M3' } } },
    }
    const out = new ProviderConfigBuilder().build(base, [
      spec({ providerId: 'my-openai', api: 'openai-completions', models: [{ id: 'g', name: 'G' }] }),
    ])
    expect((out.models as Record<string, any>).mode).toBe('merge') // 无关键保留
    expect(Object.keys((out.models as Record<string, any>).providers)).toEqual(['my-openai'])
    expect((out.agents as Record<string, any>).defaults.model.primary).toBe('my-openai/g') // 不残留 minimax
  })

  it('apiKey 恒为 SecretRef —— 即便 env id 看起来像 key 本体（防御）', () => {
    const out = new ProviderConfigBuilder().build(SECRETS_BASE, [spec({ apiKeyEnvId: 'MY_PROVIDER_KEY' })])
    expect((out.models as Record<string, any>).providers['my-anthropic'].apiKey).toEqual({
      source: 'env',
      provider: 'default',
      id: 'MY_PROVIDER_KEY',
    })
  })

  // ---------------------------- #366 codex P2：模板缺 secrets.providers.default ----------------------------

  it('模板缺 secrets.providers.default → ConfigurationError（90003）——非空 providers 写 SecretRef 前拦截', () => {
    // openclaw.json 写出的 apiKey 引用 provider:'default'；模板无该 secret provider 时凭证解析必失败，
    // DB 却已提交报成功 = 不可用配置。build 是纯逻辑校验点，抛 ConfigurationError（错误面转 90003）。
    expect(() => new ProviderConfigBuilder().build({ models: { providers: {} } }, [spec()])).toThrow(
      ConfigurationError,
    )
    // 空 providers 不写 SecretRef → 不校验（模板缺 default 不影响透传）
    expect(() => new ProviderConfigBuilder().build({ models: { providers: {} } }, [])).not.toThrow()
  })
})
