// 推理强度统一三档（ADR 0020 · #977 ③ composer 滑块）：公共子集词汇「简洁 / 标准 / 深思」
// ↔ 规范存储档 low|high|max（server validation/schemas.ts EFFORT_VALUES 同词表）。此处只是
// 三档词汇与序的单一来源，**不是** per-model 映射表——capability/effortNote 全部由
// GET /models/available（#978）服务端下发，前端零映射表副本（防漂移红线）。
export type EffortTier = 0 | 1 | 2
export type EffortWire = 'low' | 'high' | 'max'

export interface EffortStop {
  tier: EffortTier
  label: string
  wire: EffortWire
}

export const EFFORT_STOPS: readonly EffortStop[] = Object.freeze([
  { tier: 0, label: '简洁', wire: 'low' },
  { tier: 1, label: '标准', wire: 'high' },
  { tier: 2, label: '深思', wire: 'max' },
])

// 滑块会话内初值 = 标准（B4 裁定「选模型即带档」）；无 effort 存量行同显示「标准」。
export const DEFAULT_EFFORT_TIER: EffortTier = 1

export function wireOfTier(tier: EffortTier): EffortWire {
  return EFFORT_STOPS[tier].wire
}

export function tierOfWire(wire: string | undefined): EffortTier {
  return EFFORT_STOPS.find((s) => s.wire === wire)?.tier ?? DEFAULT_EFFORT_TIER
}

export function tierLabel(tier: EffortTier): string {
  return EFFORT_STOPS[tier].label
}

export function clampTier(tier: number): EffortTier {
  return Math.min(2, Math.max(0, Math.round(tier))) as EffortTier
}
