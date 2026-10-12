// #909 S3 纯逻辑：clarify 两形态模板（853 §1.3 · #866 §6 交付文本面）。
// question 面向主 agent 指令性引导，最终用户文案由主 agent 组织；candidates 元素 = 流程
// 目录四元 {label, name, fit}；none = 显式拒识退化形态（空候选 + 如实拒识）。
import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_CATALOG,
  CLARIFY_QUESTION_LOW_CONFIDENCE,
  CLARIFY_QUESTION_NONE,
  buildClarifyResult,
} from '../../plugins/research/clarify'

describe('clarify 两形态模板（853 §1.3）', () => {
  it('流程目录四项：label 与四流程 1:1，元素含 name/fit', () => {
    expect(WORKFLOW_CATALOG.map((c) => c.label)).toEqual([
      'ingest',
      'discover',
      'hypothesize',
      'experiment',
    ])
    for (const c of WORKFLOW_CATALOG) {
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.fit.length).toBeGreaterThan(0)
    }
  })

  it('低置信形态：candidates = 置信 Top-2（主选 + 次选），question 为指令性引导', () => {
    const r = buildClarifyResult({ label: 'hypothesize', confidence: 0.55, secondaryIntent: 'experiment' })
    expect(r.status).toBe('clarify')
    expect(r.candidates).toHaveLength(2)
    expect(r.candidates[0]).toEqual({
      label: 'hypothesize',
      name: WORKFLOW_CATALOG[2].name,
      fit: WORKFLOW_CATALOG[2].fit,
    })
    expect(r.candidates[1]?.label).toBe('experiment')
    expect(r.question).toBe(CLARIFY_QUESTION_LOW_CONFIDENCE)
  })

  it('低置信且无次选：如实降级 Top-1 单候选（不硬凑第二名）', () => {
    const r = buildClarifyResult({ label: 'discover', confidence: 0.58 })
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]?.label).toBe('discover')
  })

  it('同值次选过滤：secondaryIntent = 主选视为无次选，降级 Top-1（不产出重复候选）', () => {
    const r = buildClarifyResult({ label: 'discover', confidence: 0.55, secondaryIntent: 'discover' })
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]?.label).toBe('discover')
  })

  it('none 形态：空候选 + 如实拒识文案', () => {
    const r = buildClarifyResult({ label: 'none', confidence: 0.9 })
    expect(r.status).toBe('clarify')
    expect(r.candidates).toEqual([])
    expect(r.question).toBe(CLARIFY_QUESTION_NONE)
  })

  it('两形态 question 均面向主 agent（指令性引导，非最终用户文案）', () => {
    expect(CLARIFY_QUESTION_LOW_CONFIDENCE).toContain('请向用户')
    expect(CLARIFY_QUESTION_NONE).toContain('请如实告知用户')
  })
})
