// 端点预设清单单一来源守卫（#881）：六预设 = LLM 端点唯一取值域（无自由 baseURL）。
// 三处消费同一常量：REST 目录下发 / v16 迁移 host 归一 / config LLM_PRESET 校验——
// 本文件锁定目录形状与迁移映射同源（漂移即红）。
import { describe, it, expect } from 'vitest'
import {
  ENDPOINT_PRESETS,
  PRESET_IDS,
  presetById,
  protocolToLcProvider,
  PRESET_HOST_TO_ID,
  PLATFORM_PROVIDER_ID,
  RESERVED_PROVIDER_IDS,
  type EndpointPreset,
} from '../src/models/presets'

describe('端点预设清单（#881）', () => {
  it('恰好六预设，id 集合精确', () => {
    expect(PRESET_IDS).toEqual(['minimax', 'anthropic', 'openai', 'deepseek', 'kimi', 'zhipu'])
    expect(ENDPOINT_PRESETS).toHaveLength(6)
  })

  it('协议二值（anthropic-messages | openai-completions）', () => {
    const protocols = new Set(ENDPOINT_PRESETS.map((p) => p.protocol))
    expect([...protocols].sort()).toEqual(['anthropic-messages', 'openai-completions'])
  })

  it('URL 逐字锁定：https、无内嵌凭证；kimi 带尾斜杠、zhipu 不带', () => {
    for (const p of ENDPOINT_PRESETS) {
      expect(p.baseUrl.startsWith('https://'), p.id).toBe(true)
      expect(new URL(p.baseUrl).username, p.id).toBe('')
      expect(new URL(p.baseUrl).password, p.id).toBe('')
    }
    expect(presetById('kimi')?.baseUrl.endsWith('/')).toBe(true)
    expect(presetById('zhipu')?.baseUrl.endsWith('/')).toBe(false)
  })

  it('minimax 平台默认形状：anthropic 兼容面 + MiniMax-M3 默认模型条目', () => {
    const minimax = presetById('minimax')!
    expect(minimax.baseUrl).toBe('https://api.minimaxi.com/anthropic')
    expect(minimax.protocol).toBe('anthropic-messages')
    expect(minimax.authHeader).toBe(true) // Bearer（MiniMax anthropic 兼容面）
    expect(minimax.defaultModels.map((m) => m.id)).toContain('MiniMax-M3')
  })

  it('每预设至少一条默认模型（平台端点 LLM_MODEL 缺省时须有兜底）', () => {
    for (const p of ENDPOINT_PRESETS) {
      expect(p.defaultModels.length, p.id).toBeGreaterThanOrEqual(1)
      expect(p.defaultModels[0]!.id.length, p.id).toBeGreaterThan(0)
    }
  })

  it('presetById：命中返回行；未知 id 返回 undefined', () => {
    expect(presetById('deepseek')?.id).toBe('deepseek')
    expect(presetById('nope')).toBeUndefined()
  })

  it('protocolToLcProvider：wire 协议 → LangChain 二值 1:1', () => {
    expect(protocolToLcProvider('anthropic-messages')).toBe('anthropic')
    expect(protocolToLcProvider('openai-completions')).toBe('openai')
  })

  it('host→preset 归一映射与预设 baseUrl 逐条同源（v16 迁移漂移守卫）', () => {
    for (const p of ENDPOINT_PRESETS) {
      expect(PRESET_HOST_TO_ID.get(new URL(p.baseUrl).hostname)).toBe(p.id)
    }
    expect(PRESET_HOST_TO_ID.size).toBe(6)
  })

  it('保留 providerId 集 = 平台 id（BYOK 抢注写侧拒绝域）', () => {
    expect(PLATFORM_PROVIDER_ID).toBe('platform')
    expect(RESERVED_PROVIDER_IDS.has('platform')).toBe(true)
    // 六预设 id 不在 providerId 保留域——presetId 与 providerId 是两个命名域
    expect(RESERVED_PROVIDER_IDS.has('minimax')).toBe(false)
  })

  it('预设行对象冻结（运行期不可变）', () => {
    const first: EndpointPreset = ENDPOINT_PRESETS[0]!
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(ENDPOINT_PRESETS)).toBe(true)
  })
})
