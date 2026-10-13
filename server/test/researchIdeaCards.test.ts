// #911 S3：idea_dedup.py / validate_idea_cards.py 全规则 TS 移植逐条断言（issue AC「规则全集
// 逐条」· Agreements 预钉缝）。覆盖：dedup 键形态（norm 三键）/ 同键保留 evidence_chain 总长者 /
// 首现序（py dict 语义）/ 14 必填 / evidence 空须 low-confidence / anchor 1–4 + 泛化锚黑名单
// （TERMS 精确 + FRAGMENTS 含混 − MARKERS 豁免）/ concrete 判据（P 编号 / markers / 类标题）/
// wiki 源锚须 wiki_writeback / target_problem ≥30 字符 + 痛点 marker / minimum_experiment 短 → warning。
import { describe, expect, it } from 'vitest'
import { dedupIdeaCards, ideaDedupKey, validateIdeaCards } from '../../plugins/research/ideaCards'
import { IDEA_CARDS_SCHEMA } from '../../plugins/research/ideaCards'
import type { IdeaCard } from '../../plugins/research/ideaCards'
import { validIdeaCard } from './researchFixtures'

// 全合法卡单一来源 = researchFixtures.validIdeaCard（跨测试文件单源，S26 归口——
// 每规则恰好通过的边界形，改动须同步对应规则用例）。
const validCard = validIdeaCard

describe('idea dedup（idea_dedup.py 移植 · 853 §4.3 键 = norm(title, mechanism, minimum_experiment)）', () => {
  it('键 = 小写 + 空白折叠的三元组；大小写/多余空白视为同键', () => {
    const a = validCard({ title: 'Energy Score OOD', mechanism: 'Introduce  energy fn', minimum_experiment: 'Run  eval' })
    const b = validCard({ title: 'energy score ood', mechanism: 'introduce energy fn', minimum_experiment: 'run eval' })
    expect(ideaDedupKey(a)).toBe(ideaDedupKey(b))
    expect(ideaDedupKey(a)).toBe(JSON.stringify(['energy score ood', 'introduce energy fn', 'run eval']))
  })

  it('同键保留 evidence_chain 总长更长者；等长保留先到者', () => {
    const weak = validCard({ idea_id: 'weak', evidence_chain: ['短'] })
    const strong = validCard({ idea_id: 'strong', evidence_chain: ['明显更长的证据链条目一', '明显更长的证据链条目二'] })
    expect(dedupIdeaCards([weak, strong]).map((c) => c.idea_id)).toEqual(['strong'])
    // 等长：先出现者胜（py `>` 严格大于语义）
    const first = validCard({ idea_id: 'first', evidence_chain: ['同长一', '同长二'] })
    const second = validCard({ idea_id: 'second', evidence_chain: ['同长三', '同长四'] })
    expect(dedupIdeaCards([first, second]).map((c) => c.idea_id)).toEqual(['first'])
  })

  it('键不同都保留；首现序保持（py dict 插入序，值替换不移位）', () => {
    const a = validCard({ idea_id: 'A', title: '方案 A', evidence_chain: ['短证据'] })
    const b = validCard({ idea_id: 'B', title: '方案 B', minimum_experiment: '另一套实验方案' })
    const a2 = validCard({
      idea_id: 'A2',
      title: '方案 a',
      evidence_chain: ['更长证据链的重复变体条目一：来自论文 Results 节的完整引用文本', '更长证据链的重复变体条目二：来自 Limitations 节的完整引用文本'],
    })
    const out = dedupIdeaCards([a, b, a2])
    expect(out.map((c) => c.idea_id)).toEqual(['A2', 'B'])
  })
})

describe('idea card validate（validate_idea_cards.py 全规则逐条 · #848 §3.3）', () => {
  it('全合法卡 → 零 error 零 warning', () => {
    const [v] = validateIdeaCards([validCard()])
    expect(v!.errors).toEqual([])
    expect(v!.warnings).toEqual([])
  })

  it('规则1：14 必填逐字段——缺失与空串均报（wiki_writeback 不在必填列）', () => {
    const card = validCard()
    const broken = { ...card } as Record<string, unknown>
    delete broken.expected_metric_change // 缺失面
    broken.risks = '   ' // 空串面
    const [v] = validateIdeaCards([broken as unknown as IdeaCard])
    expect(v!.errors.some((e) => e.includes('expected_metric_change'))).toBe(true)
    expect(v!.errors.some((e) => e.includes('risks'))).toBe(true)
    expect(v!.errors.some((e) => e.includes('wiki_writeback'))).toBe(false)
  })

  it('规则2：evidence_chain 空须 low-confidence——必填错误照报；标 low 只豁免 low-confidence 追加错误', () => {
    // py 语义：evidence_chain 在 14 必填内——空链永远报必填错误；low-confidence 标记豁免的是
    //「missing evidence must be marked low-confidence」第二条（规则全集忠实移植，双重判据）。
    const [okCase] = validateIdeaCards([validCard({ evidence_chain: [], confidence: 'low-confidence' })])
    expect(okCase!.errors.some((e) => e.includes('evidence_chain') && e.includes('必填'))).toBe(true)
    expect(okCase!.errors.some((e) => e.includes('low-confidence'))).toBe(false)
    const [badCase] = validateIdeaCards([validCard({ evidence_chain: [], confidence: 'medium' })])
    expect(badCase!.errors.some((e) => e.includes('low-confidence'))).toBe(true)
  })

  it('规则3：anchor_sources 空报错；>4 个报错（同型集群 2–4 上限）', () => {
    const [empty] = validateIdeaCards([validCard({ anchor_sources: [] })])
    expect(empty!.errors.some((e) => e.includes('anchor_sources'))).toBe(true)
    const [five] = validateIdeaCards([
      validCard({
        anchor_sources: ['papers/a.md', 'papers/b.md', 'papers/c.md', 'papers/d.md', 'papers/e.md'],
      }),
    ])
    expect(five!.errors.some((e) => e.includes('2-4') || e.includes('2–4'))).toBe(true)
  })

  it('规则4：泛化锚黑名单——GENERIC_ANCHOR_TERMS 精确命中报错（「related work」）', () => {
    const [v] = validateIdeaCards([validCard({ anchor_sources: ['Related Work'], wiki_writeback: 'x' })])
    expect(v!.errors.some((e) => e.includes('泛化'))).toBe(true)
  })

  it('规则4b：泛化 fragment（literature/domain/field/area/prior work）含混且无 concrete marker → 报错；有 marker 豁免', () => {
    const [bad] = validateIdeaCards([validCard({ anchor_sources: ['federated learning literature'], wiki_writeback: 'x' })])
    expect(bad!.errors.some((e) => e.includes('泛化'))).toBe(true)
    const [good] = validateIdeaCards([
      validCard({ anchor_sources: ['literature/papers/robust.md'], wiki_writeback: 'x' }),
    ])
    expect(good!.errors.filter((e) => e.includes('泛化'))).toEqual([])
  })

  it('规则5：concrete 判据——非 concrete 锚（无 marker 的两词短语）报错；P 编号 / .md / 类标题放行', () => {
    const [bad] = validateIdeaCards([validCard({ anchor_sources: ['federated scope'], wiki_writeback: 'x' })])
    expect(bad!.errors.some((e) => e.includes('具体'))).toBe(true)
    const [byId] = validateIdeaCards([validCard({ anchor_sources: ['p12'], wiki_writeback: 'x' })])
    expect(byId!.errors.filter((e) => e.includes('具体'))).toEqual([])
    const [byTitle] = validateIdeaCards([
      validCard({ anchor_sources: ['Energy-Based Out-of-Distribution Detection'], wiki_writeback: 'x' }),
    ])
    expect(byTitle!.errors.filter((e) => e.includes('具体'))).toEqual([])
  })

  it('规则6：wiki 源锚（含 wiki / .md 结尾 / /papers/）须 wiki_writeback 非空——缺则报错', () => {
    const [v] = validateIdeaCards([validCard({ wiki_writeback: undefined })])
    expect(v!.errors.some((e) => e.includes('wiki_writeback'))).toBe(true)
  })

  it('规则7：target_problem 痛点具体度——<30 字符报错；≥30 无 marker 报错；marker（机制）命中放行', () => {
    const [short] = validateIdeaCards([validCard({ target_problem: '效果不够好，机制层面的支撑偏弱' })])
    expect(short!.errors.some((e) => e.includes('target_problem'))).toBe(true)
    const [noMarker] = validateIdeaCards([
      validCard({ target_problem: '这是一个长度足够但是没有任何领域标记词的普通描述句子' }),
    ])
    expect(noMarker!.errors.some((e) => e.includes('target_problem'))).toBe(true)
    const [okCase] = validateIdeaCards([validCard()])
    expect(okCase!.errors.filter((e) => e.includes('target_problem'))).toEqual([])
  })

  it('规则8：minimum_experiment <20 字符 → warning 非 error（不打断 persist）', () => {
    const [v] = validateIdeaCards([validCard({ minimum_experiment: '跑个评测' })])
    expect(v!.warnings.some((w) => w.includes('minimum_experiment'))).toBe(true)
    expect(v!.errors).toEqual([])
  })

  it('逐卡独立判：坏卡报错不污染好卡（批次面 labels 用 idea_id）', () => {
    const bad = validCard({ idea_id: 'BAD-1', title: ' ', expected_metric_change: '' })
    const [vBad, vGood] = validateIdeaCards([bad, validCard()])
    expect(vBad!.errors.length).toBeGreaterThan(0)
    expect(vBad!.errors.every((e) => e.startsWith('BAD-1'))).toBe(true)
    expect(vGood!.errors).toEqual([])
  })

  it('schema 面：IDEA_CARDS_SCHEMA 宽容上限 = 5（IDEA_CANDIDATES_SCHEMA_MAX 消费）——6 卡拒、5 卡过', () => {
    const card = validCard({ title: 'x' })
    const five = Array.from({ length: 5 }, (_, i) => ({ ...card, idea_id: `C${i}` }))
    expect(IDEA_CARDS_SCHEMA.safeParse({ cards: five }).success).toBe(true)
    expect(IDEA_CARDS_SCHEMA.safeParse({ cards: [...five, { ...card, idea_id: 'C6' }] }).success).toBe(false)
  })
})
