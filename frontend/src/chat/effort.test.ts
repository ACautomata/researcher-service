// seam: 推理强度三档词汇（ADR 0020）纯函数——composer 滑块与 PATCH 写面的换算单源。
import { describe, expect, it } from 'vitest'
import { DEFAULT_EFFORT_TIER, EFFORT_STOPS, clampTier, tierLabel, tierOfWire, wireOfTier } from './effort'

describe('推理强度三档词汇（#980 · ADR 0020）', () => {
  it('三档「简洁/标准/深思」↔ low/high/max 序与词表锁定', () => {
    expect(EFFORT_STOPS.map((s) => s.label)).toEqual(['简洁', '标准', '深思'])
    expect(EFFORT_STOPS.map((s) => s.wire)).toEqual(['low', 'high', 'max'])
    expect(wireOfTier(0)).toBe('low')
    expect(wireOfTier(1)).toBe('high')
    expect(wireOfTier(2)).toBe('max')
    expect(tierOfWire('low')).toBe(0)
    expect(tierOfWire('high')).toBe(1)
    expect(tierOfWire('max')).toBe(2)
  })

  it('缺档/未知 wire 回退标准（滑块会话内初值 = 标准；无 effort 存量行同显示）', () => {
    expect(DEFAULT_EFFORT_TIER).toBe(1)
    expect(tierOfWire(undefined)).toBe(1)
    expect(tierOfWire('medium')).toBe(1)
    expect(tierLabel(1)).toBe('标准')
  })

  it('clampTier 夹取在 0–2（段内 ←/→ 微调边界）', () => {
    expect(clampTier(-1)).toBe(0)
    expect(clampTier(0)).toBe(0)
    expect(clampTier(1.4)).toBe(1)
    expect(clampTier(3)).toBe(2)
  })
})
