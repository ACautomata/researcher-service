// 推理强度注入映射表（ADR 0020 · #979 实现票②）：effortBindingOf 单源断言——六预设
// 逐家绑定参数面 + 零注入面（kimi none / 存量无 effort 行 / 越界 effort）。纯表测试，
// 不触 DB 与网络；装配缝行为面见 providerRegistry.test.ts / runnerEffortFence.test.ts。
import { describe, it, expect } from 'vitest'
import { effortBindingOf, EFFORT_TIER_VALUES, type EffortTier } from '../src/models/presets'
import { EFFORT_VALUES } from '../src/validation/schemas'
import { ANTHROPIC_CONFIGURABLE_FIELDS, OPENAI_CONFIGURABLE_FIELDS } from '../src/models/chatFactory'

// 已知模型的协议面（face 实参——已知模型的通道由映射表 case 决定，face 只服务缺省
// native 分支；实参取各模型所属预设的真实面，与 ENDPOINT_PRESETS 协议面一致）。
const ANTHROPIC_FACE_MODELS = ['claude-sonnet-5-5', 'MiniMax-M3'] as const

describe('effortBindingOf（ADR 0020 per-model 映射表）', () => {
  // 词汇漂移守卫：运行层 EffortTier 值清单 ≡ 写侧 zod 单源 EFFORT_VALUES（#979 review 收敛——
  // presets.ts 类型镜像 schemas.ts 词汇，注释声明之外再钉等值）。
  it('EFFORT_TIER_VALUES ≡ EFFORT_VALUES（存储词汇单源镜像）', () => {
    expect([...EFFORT_TIER_VALUES]).toEqual([...EFFORT_VALUES])
  })

  it('deepseek-v4-flash：三档 1:1 直传（modelKwargs.reasoning_effort——前缀门挡一级通道）', () => {
    expect(effortBindingOf('deepseek-v4-flash', 'low', 'openai')?.configurable).toEqual({ modelKwargs: { reasoning_effort: 'low' } })
    expect(effortBindingOf('deepseek-v4-flash', 'high', 'openai')?.configurable).toEqual({ modelKwargs: { reasoning_effort: 'high' } })
    expect(effortBindingOf('deepseek-v4-flash', 'max', 'openai')?.configurable).toEqual({ modelKwargs: { reasoning_effort: 'max' } })
  })

  it('claude-sonnet-5-5：三档就近映射 Anthropic effort 五档（outputConfig 通道）', () => {
    expect(effortBindingOf('claude-sonnet-5-5', 'low', 'anthropic')?.configurable).toEqual({ outputConfig: { effort: 'low' } })
    expect(effortBindingOf('claude-sonnet-5-5', 'high', 'anthropic')?.configurable).toEqual({ outputConfig: { effort: 'high' } })
    expect(effortBindingOf('claude-sonnet-5-5', 'max', 'anthropic')?.configurable).toEqual({ outputConfig: { effort: 'max' } })
  })

  it('gpt-5.1：三档就近映射 OpenAI reasoning effort 七值（reasoning 一级字段）', () => {
    expect(effortBindingOf('gpt-5.1', 'low', 'openai')?.configurable).toEqual({ reasoning: { effort: 'low' } })
    expect(effortBindingOf('gpt-5.1', 'high', 'openai')?.configurable).toEqual({ reasoning: { effort: 'high' } })
    expect(effortBindingOf('gpt-5.1', 'max', 'openai')?.configurable).toEqual({ reasoning: { effort: 'max' } })
  })

  it('MiniMax-M3：thinking 两态（简洁=关、标准/深思=开；无 budget_tokens——M3 自适应）', () => {
    expect(effortBindingOf('MiniMax-M3', 'low', 'anthropic')?.configurable).toEqual({ thinking: { type: 'disabled' } })
    expect(effortBindingOf('MiniMax-M3', 'high', 'anthropic')?.configurable).toEqual({ thinking: { type: 'enabled' } })
    expect(effortBindingOf('MiniMax-M3', 'max', 'anthropic')?.configurable).toEqual({ thinking: { type: 'enabled' } })
  })

  it('glm-4.6：thinking 两态走 modelKwargs（zhipu OpenAI 兼容面 body 参数）', () => {
    expect(effortBindingOf('glm-4.6', 'low', 'openai')?.configurable).toEqual({ modelKwargs: { thinking: { type: 'disabled' } } })
    expect(effortBindingOf('glm-4.6', 'high', 'openai')?.configurable).toEqual({ modelKwargs: { thinking: { type: 'enabled' } } })
    expect(effortBindingOf('glm-4.6', 'max', 'openai')?.configurable).toEqual({ modelKwargs: { thinking: { type: 'enabled' } } })
  })

  it('kimi-k2：结构性零注入（能力 none——写侧 90002 已拦，运行层双保险）', () => {
    expect(effortBindingOf('kimi-k2', 'low', 'openai')).toBeUndefined()
    expect(effortBindingOf('kimi-k2', 'high', 'openai')).toBeUndefined()
    expect(effortBindingOf('kimi-k2', 'max', 'openai')).toBeUndefined()
  })

  it('未命中元数据（BYOK 第三方）：缺省 native，通道随协议面——openai 面 modelKwargs 直传、anthropic 面 outputConfig（modelKwargs 在该面会被白名单过滤静默丢弃 = 假注入）', () => {
    expect(effortBindingOf('my-vllm-reasoner', 'low', 'openai')?.configurable).toEqual({ modelKwargs: { reasoning_effort: 'low' } })
    expect(effortBindingOf('my-vllm-reasoner', 'max', 'openai')?.configurable).toEqual({ modelKwargs: { reasoning_effort: 'max' } })
    expect(effortBindingOf('my-anthropic-compat', 'high', 'anthropic')?.configurable).toEqual({ outputConfig: { effort: 'high' } })
    expect(effortBindingOf('my-anthropic-compat', 'max', 'anthropic')?.configurable).toEqual({ outputConfig: { effort: 'max' } })
  })

  it('零注入面：effort 缺省（存量旧行）或越界（手写行脏值）→ undefined，行为与今日逐字节等价', () => {
    expect(effortBindingOf('deepseek-v4-flash', undefined, 'openai')).toBeUndefined()
    expect(effortBindingOf('gpt-5.1', undefined, 'openai')).toBeUndefined()
    expect(effortBindingOf('MiniMax-M3', undefined, 'anthropic')).toBeUndefined()
    // 非规范档（运行层宽松读透传的手写脏值——类型面不可表达，运行时兜底零注入）
    expect(effortBindingOf('deepseek-v4-flash', 'medium' as unknown as EffortTier, 'openai')).toBeUndefined()
    expect(effortBindingOf('kimi-k2', undefined, 'openai')).toBeUndefined()
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
      for (const key of Object.keys(effortBindingOf(modelId, effort, 'openai')?.configurable ?? {})) {
        expect(OPENAI_CONFIGURABLE_FIELDS, `${modelId} 通道 ${key}`).toContain(key)
      }
    }
    for (const [modelId, effort] of [
      ['claude-sonnet-5-5', 'high'],
      ['MiniMax-M3', 'high'],
      ['byok-unknown-anthropic', 'high'],
    ] as const) {
      for (const key of Object.keys(effortBindingOf(modelId, effort, 'anthropic')?.configurable ?? {})) {
        expect(ANTHROPIC_CONFIGURABLE_FIELDS, `${modelId} 通道 ${key}`).toContain(key)
      }
    }
  })

  it('face 实参完备：全部映射断言按模型真实协议面传参（漏面即编译红——face 必填的守卫面）', () => {
    for (const modelId of ['deepseek-v4-flash', 'gpt-5.1', 'glm-4.6'] as const) {
      expect(effortBindingOf(modelId, 'high', 'openai')).toBeDefined()
    }
    for (const modelId of ANTHROPIC_FACE_MODELS) {
      expect(effortBindingOf(modelId, 'high', 'anthropic')).toBeDefined()
    }
    expect(effortBindingOf('kimi-k2', 'high', 'openai')).toBeUndefined() // none 能力照旧零注入
  })
})
