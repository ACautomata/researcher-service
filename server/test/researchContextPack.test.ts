// #911 S3：contextPack 构建/裁剪纯逻辑断言（issue AC「裁剪顺序：evidence 降序、页级节选、
// Brief 恒保全、裁剪后判不足」· Agreements 预钉缝）。覆盖：证据等级按页组降序（papers >
// critics > 其他）/ 页级节选 cap（非全文）/ 预算整条目取舍（不中途截断）/ Brief 恒保全
// （超长也完整，证据让位）/ 裁剪后判不足（0 证据条目 → insufficient）/ Brief ASSUMPTION 填充。
import { describe, expect, it } from 'vitest'
import {
  BRIEF_FIELDS,
  BRIEF_SCHEMA,
  assembleContextPackText,
  buildEvidenceContext,
  capEvidenceExcerpt,
  evidenceLevelOf,
  fillBriefAssumptions,
  sortEvidenceEntries,
} from '../../plugins/research/contextPack'
import type { EvidenceEntry } from '../../plugins/research/contextPack'
import { CONTEXT_PACK_BUDGET_TOKENS, EVIDENCE_EXCERPT_MAX_CHARS } from '../../plugins/research/values'
import { JUDGE_CHARS_PER_TOKEN } from '../src/utils/tokenBudget'

const entry = (path: string, rank: number, excerpt = `节选-${path}`): EvidenceEntry => ({
  path,
  level: evidenceLevelOf(path),
  excerpt,
  rank,
})

const briefText = 'research_topic: OOD 检测\n其余字段: ASSUMPTION: 未提供'

describe('contextPack 证据分级与排序（853 §4.3「evidence 按证据等级降序」）', () => {
  it('页组派生等级：papers/=2 > critics/=1 > 其他=0（检索契约无 frontmatter 面，页组为确定性代理）', () => {
    expect(evidenceLevelOf('papers/a.md')).toBe(2)
    expect(evidenceLevelOf('critics/a.md')).toBe(1)
    expect(evidenceLevelOf('notes/a.md')).toBe(0)
  })

  it('排序 = 等级降序 + 同级保持检索序（rank 升序稳定）', () => {
    const sorted = sortEvidenceEntries([
      entry('notes/z.md', 4),
      entry('papers/b.md', 1),
      entry('critics/c.md', 3),
      entry('papers/a.md', 0),
      entry('notes/y.md', 2),
    ])
    expect(sorted.map((e) => e.path)).toEqual(['papers/a.md', 'papers/b.md', 'critics/c.md', 'notes/y.md', 'notes/z.md'])
  })
})

describe('contextPack 页级节选（「页级节选（非全文）」钉面）', () => {
  it('excerpt 超 EVIDENCE_EXCERPT_MAX_CHARS 确定性截断', () => {
    const long = 'x'.repeat(EVIDENCE_EXCERPT_MAX_CHARS + 500)
    const capped = capEvidenceExcerpt(long)
    expect(capped.length).toBe(EVIDENCE_EXCERPT_MAX_CHARS)
    expect(capEvidenceExcerpt('短节选')).toBe('短节选')
  })
})

describe('contextPack 证据上下文（构建时裁一次 · 判定在裁剪后）', () => {
  it('裁剪顺序锁定：低等级条目先被裁——预算收紧后 critics/notes 出局，papers 保留', () => {
    // 预算 = 两条 papers 块（21×2 + 分隔 2×2 = 46）+ 2 字符余量——第三条装不下即停。
    const budget = 48
    const r = buildEvidenceContext(
      [entry('notes/low.md', 3, '低等级证据'), entry('papers/p1.md', 0, '证据一'), entry('papers/p2.md', 1, '证据二')],
      Math.ceil(budget / JUDGE_CHARS_PER_TOKEN),
    )
    expect(r.evidence.map((e) => e.path)).toEqual(['papers/p1.md', 'papers/p2.md'])
  })

  it('整条目取舍不中途截断：装不下的条目原样丢弃（excerpt 不被切半）', () => {
    const big = 'y'.repeat(300)
    const budget = 32 + big.length + 10 // 第一条后剩余 10 字符，装不下 300 字符第二条
    const r = buildEvidenceContext([entry('papers/a.md', 0, big), entry('papers/b.md', 1, big)], Math.ceil(budget / JUDGE_CHARS_PER_TOKEN))
    expect(r.evidence).toHaveLength(1)
    expect(r.evidence[0]!.excerpt).toBe(big) // 完整保留，非截断形态
  })

  it('「证据不足」判定在裁剪后：0 条目 surviving → insufficient；≥1 → sufficient', () => {
    const tiny = 1 // 1 token = 2 字符——装不下任何条目
    const r = buildEvidenceContext([entry('papers/a.md', 0)], tiny)
    expect(r.evidence).toEqual([])
    expect(r.sufficient).toBe(false)
    const ok = buildEvidenceContext([entry('papers/a.md', 0)], CONTEXT_PACK_BUDGET_TOKENS)
    expect(ok.sufficient).toBe(true)
  })
})

describe('contextPack 合包（Brief 恒保全前置）', () => {
  it('Brief 块 verbatim 完整前置 + 证据条目拼接（恒保全 = 恒完整先于证据，非与证据分账）', () => {
    const text = assembleContextPackText(briefText, [entry('papers/a.md', 0, '证据甲'), entry('papers/b.md', 1, '证据乙')])
    expect(text.startsWith(briefText)).toBe(true)
    expect(text).toContain('证据甲')
    expect(text).toContain('证据乙')
    expect(text.indexOf(briefText)).toBe(0)
  })

  it('零证据条目 = Brief 单独成包（证据不足路径不会触达合包——graph 在判定后返回 clarify）', () => {
    expect(assembleContextPackText(briefText, [])).toBe(briefText)
  })
})

describe('Brief 10 字段（#848 §3 brief-template 单源 · 字段缺失不阻塞写 ASSUMPTION 继续）', () => {
  it('BRIEF_FIELDS 为 10 字段且 BRIEF_SCHEMA 形状对齐（全 optional——ASSUMPTION 填充归确定性面）', () => {
    expect(BRIEF_FIELDS).toEqual([
      'research_topic',
      'target_task',
      'current_baseline',
      'available_data',
      'available_code',
      'available_compute',
      'preferred_metrics',
      'hard_constraints',
      'known_failures',
      'desired_risk_level',
    ])
    const parsed = BRIEF_SCHEMA.parse({ research_topic: 'OOD 检测' })
    expect(parsed.research_topic).toBe('OOD 检测')
    expect(BRIEF_SCHEMA.parse({})).toEqual({})
  })

  it('fillBriefAssumptions：缺失/空字段填 ASSUMPTION: 未提供；已填字段原样', () => {
    const filled = fillBriefAssumptions({ research_topic: 'OOD 检测', target_task: '' })
    expect(filled.research_topic).toBe('OOD 检测')
    expect(filled.target_task).toBe('ASSUMPTION: 未提供')
    expect(filled.available_data).toBe('ASSUMPTION: 未提供')
    expect(BRIEF_FIELDS.every((f) => filled[f].length > 0)).toBe(true)
  })
})
