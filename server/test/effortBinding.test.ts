// 推理强度注入映射表（ADR 0020 · #979 实现票②）：effortBindingOf 单源断言——六预设
// 逐家绑定参数面 + 零注入面（kimi none / 存量无 effort 行 / 越界 effort）。纯表测试，
// 不触 DB 与网络；装配缝行为面见 providerRegistry.test.ts / runnerEffortFence.test.ts。
import { describe, it, expect } from 'vitest'
import { effortBindingOf, type EffortTier } from '../src/models/presets'
import { ANTHROPIC_CONFIGURABLE_FIELDS, OPENAI_CONFIGURABLE_FIELDS } from '../src/models/chatFactory'

describe('effortBindingOf（ADR 0020 per-model 映射表）', () => {
  it('deepseek-v4-flash：三档 1:1 直传（modelKwargs.reasoning_effort——前缀门挡一级通道）', () => {
    expect(effortBindingOf('deepseek-v4-flash', 'low')?.configurable).toEqual({ modelKwargs: { reasoning_effort: 'low' } })
    expect(effortBindingOf('deepseek-v4-flash', 'high')?.configurable).toEqual({ modelKwargs: { reasoning_effort: 'high' } })
    expect(effortBindingOf('deepseek-v4-flash', 'max')?.configurable).toEqual({ modelKwargs: { reasoning_effort: 'max' } })
  })

  it('claude-sonnet-5-5：三档就近映射 Anthropic effort 五档（outputConfig 通道）', () => {
    expect(effortBindingOf('claude-sonnet-5-5', 'low')?.configurable).toEqual({ outputConfig: { effort: 'low' } })
    expect(effortBindingOf('claude-sonnet-5-5', 'high')?.configurable).toEqual({ outputConfig: { effort: 'high' } })
    expect(effortBindingOf('claude-sonnet-5-5', 'max')?.configurable).toEqual({ outputConfig: { effort: 'max' } })
  })

  it('gpt-5.1：三档就近映射 OpenAI reasoning effort 七值（reasoning 一级字段）', () => {
    expect(effortBindingOf('gpt-5.1', 'low')?.configurable).toEqual({ reasoning: { effort: 'low' } })
    expect(effortBindingOf('gpt-5.1', 'high')?.configurable).toEqual({ reasoning: { effort: 'high' } })
    expect(effortBindingOf('gpt-5.1', 'max')?.configurable).toEqual({ reasoning: { effort: 'max' } })
  })

  it('MiniMax-M3：thinking 两态（简洁=关、标准/深思=开；无 budget_tokens——M3 自适应）', () => {
    expect(effortBindingOf('MiniMax-M3', 'low')?.configurable).toEqual({ thinking: { type: 'disabled' } })
    expect(effortBindingOf('MiniMax-M3', 'high')?.configurable).toEqual({ thinking: { type: 'enabled' } })
    expect(effortBindingOf('MiniMax-M3', 'max')?.configurable).toEqual({ thinking: { type: 'enabled' } })
  })

  it('glm-4.6：thinking 两态走 modelKwargs（zhipu OpenAI 兼容面 body 参数）', () => {
    expect(effortBindingOf('glm-4.6', 'low')?.configurable).toEqual({ modelKwargs: { thinking: { type: 'disabled' } } })
    expect(effortBindingOf('glm-4.6', 'high')?.configurable).toEqual({ modelKwargs: { thinking: { type: 'enabled' } } })
    expect(effortBindingOf('glm-4.6', 'max')?.configurable).toEqual({ modelKwargs: { thinking: { type: 'enabled' } } })
  })

  it('kimi-k2：结构性零注入（能力 none——写侧 90002 已拦，运行层双保险）', () => {
    expect(effortBindingOf('kimi-k2', 'low')).toBeUndefined()
    expect(effortBindingOf('kimi-k2', 'high')).toBeUndefined()
    expect(effortBindingOf('kimi-k2', 'max')).toBeUndefined()
  })

  it('未命中元数据（BYOK 第三方）：缺省 native → modelKwargs.reasoning_effort 直传', () => {
    expect(effortBindingOf('my-vllm-reasoner', 'low')?.configurable).toEqual({ modelKwargs: { reasoning_effort: 'low' } })
    expect(effortBindingOf('my-vllm-reasoner', 'max')?.configurable).toEqual({ modelKwargs: { reasoning_effort: 'max' } })
  })

  it('零注入面：effort 缺省（存量旧行）或越界（手写行脏值）→ undefined，行为与今日逐字节等价', () => {
    expect(effortBindingOf('deepseek-v4-flash', undefined)).toBeUndefined()
    expect(effortBindingOf('gpt-5.1', undefined)).toBeUndefined()
    expect(effortBindingOf('MiniMax-M3', undefined)).toBeUndefined()
    // 非规范档（运行层宽松读透传的手写脏值——类型面不可表达，运行时兜底零注入）
    expect(effortBindingOf('deepseek-v4-flash', 'medium' as unknown as EffortTier)).toBeUndefined()
    expect(effortBindingOf('kimi-k2', undefined)).toBeUndefined()
  })
})

describe('chatFactory configurableFields（注入通道接线）', () => {
  it('openai 面暴露 reasoning + modelKwargs（前缀门内一级通道 / 兼容面直传通道）', () => {
    expect(OPENAI_CONFIGURABLE_FIELDS).toContain('model')
    expect(OPENAI_CONFIGURABLE_FIELDS).toContain('temperature')
    expect(OPENAI_CONFIGURABLE_FIELDS).toContain('reasoning')
    expect(OPENAI_CONFIGURABLE_FIELDS).toContain('modelKwargs')
  })

  it('anthropic 面暴露 outputConfig + thinking（五档 effort / 两态开关通道）', () => {
    expect(ANTHROPIC_CONFIGURABLE_FIELDS).toContain('model')
    expect(ANTHROPIC_CONFIGURABLE_FIELDS).toContain('temperature')
    expect(ANTHROPIC_CONFIGURABLE_FIELDS).toContain('outputConfig')
    expect(ANTHROPIC_CONFIGURABLE_FIELDS).toContain('thinking')
  })

  it('映射表引用的通道键 ⊆ 对应 provider 面的 configurableFields（接线漂移即红）', () => {
    for (const [modelId, effort] of [
      ['deepseek-v4-flash', 'high'],
      ['gpt-5.1', 'high'],
      ['glm-4.6', 'high'],
      ['byok-unknown', 'high'],
    ] as const) {
      for (const key of Object.keys(effortBindingOf(modelId, effort)?.configurable ?? {})) {
        expect(OPENAI_CONFIGURABLE_FIELDS, `${modelId} 通道 ${key}`).toContain(key)
      }
    }
    for (const [modelId, effort] of [
      ['claude-sonnet-5-5', 'high'],
      ['MiniMax-M3', 'high'],
    ] as const) {
      for (const key of Object.keys(effortBindingOf(modelId, effort)?.configurable ?? {})) {
        expect(ANTHROPIC_CONFIGURABLE_FIELDS, `${modelId} 通道 ${key}`).toContain(key)
      }
    }
  })
})
