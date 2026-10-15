// B3 原型（#933）mock 数据——一次性原型代码，勿引为生产实现。
// 模型清单与推理强度映射均为写死的假数据，语义照抄 B2 锁定决议（#932）：
//   统一三档「简洁/标准/深思」（↔ low/high/max）+ per-model 映射翻译——
//   deepseek 1:1、anthropic/OpenAI 就近映射、MiniMax/GLM thinking-only（低=关，标准/深思=开）、
//   kimi-k2 无通道（滑块置灰 + tooltip）。真实实现落 presets.ts 元数据（B2 决议），此处仅演示。

export type B3EffortValue = 0 | 1 | 2

export interface B3EffortStop {
  value: B3EffortValue
  label: string
  wire: 'low' | 'high' | 'max'
}

export const B3_EFFORT_STOPS: readonly B3EffortStop[] = Object.freeze([
  { value: 0, label: '简洁', wire: 'low' },
  { value: 1, label: '标准', wire: 'high' },
  { value: 2, label: '深思', wire: 'max' },
])

// per-model effort 能力三值（B1 盘点 + B2 映射决议的可见面）。
export type B3EffortCapability = 'native' | 'thinking-only' | 'none'

export interface B3ModelOption {
  providerId: string
  modelId: string
  name: string
  capability: B3EffortCapability
  /** 映射说明（滑块/菜单内的 B2 决议可见表达） */
  effortNote: string
}

// 「默认」项 = 清空覆盖，与 /model default 同语义（B2 锁定）；capability 'none'
// 表达「无覆盖即无 effort 通道」——滑块置灰，先选模型再调强度（原型待用户裁决的口径）。
export const B3_DEFAULT_OPTION: B3ModelOption = {
  providerId: '',
  modelId: '',
  name: '默认（跟随面板指派）',
  capability: 'none',
  effortNote: '清空覆盖，与 /model default 同语义；先选模型才能调推理强度',
}

export const B3_MODEL_OPTIONS: readonly B3ModelOption[] = Object.freeze([
  B3_DEFAULT_OPTION,
  {
    providerId: 'minimax',
    modelId: 'MiniMax-M3',
    name: 'MiniMax M3',
    capability: 'thinking-only',
    effortNote: '仅思考开关——简洁=思考关 · 标准/深思=思考开',
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    capability: 'native',
    effortNote: '三档就近映射 Anthropic effort 五档',
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.1',
    name: 'GPT-5.1',
    capability: 'native',
    effortNote: '三档就近映射 OpenAI reasoning effort 七值',
  },
  {
    providerId: 'deepseek',
    modelId: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    capability: 'native',
    effortNote: '三档 1:1 直传',
  },
  {
    providerId: 'kimi',
    modelId: 'kimi-k2',
    name: 'Kimi K2',
    capability: 'none',
    effortNote: '该模型无推理强度通道，滑块置灰',
  },
  {
    providerId: 'zhipu',
    modelId: 'glm-4.6',
    name: 'GLM-4.6',
    capability: 'thinking-only',
    effortNote: '仅思考开关——简洁=思考关 · 标准/深思=思考开',
  },
])

export function b3OptionOf(selected: { providerId: string; modelId: string } | null): B3ModelOption {
  if (!selected) return B3_DEFAULT_OPTION
  return (
    B3_MODEL_OPTIONS.find((o) => o.providerId === selected.providerId && o.modelId === selected.modelId) ??
    B3_DEFAULT_OPTION
  )
}
