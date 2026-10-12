// #910 S3：确定性校验纯函数逐清单锁定（853 §4.1–§4.2 / #848 §1–§2 · Agreements「零新缝」
// ——校验清单逐条断言，非 golden 全文对照）。
// W1 validate：11 节标题齐全 / ≥100 行 / Results 含具体数字 / title 非空（frontmatter 必填面）。
// W2 validate¹：extract 12 节节标题 checklist + 三态标注禁语扫描（禁「可能是/应该是/推测为」，
//   强制「论文中未明确说明」类规范用语——audit 维度 4 同款黑名单）。
// W2 validate²：critic §0–§7 节齐全 + `category: critic` 机读标签 + 候选问题 2–4（与 validate¹
//   检查对象不同，分列不共享 schema 名——853 §4.2 钉）。
// slug 派生：wiki-conventions kebab-case 确定性（论文页 slug 匹配标题不带日期）。
// evidenceGate 回查分类：wiki 页/节锚、lab 上传件锚、extract 节锚、描述性引用（放行）。
import { describe, expect, it } from 'vitest'
import {
  validatePaperPage,
  validateExtractDoc,
  validateCriticDoc,
  paperPageSlug,
  classifyEvidenceRef,
} from '../../plugins/research/pageValidate'
import { PAPER_PAGE_SECTIONS, EXTRACT_SECTIONS, CRITIC_SECTIONS } from '../../plugins/research/prompts'

// 11 节论文页合法正文（≥100 行 + Results 含数字）。
const validPaperContent = (): string => {
  const body = PAPER_PAGE_SECTIONS.map((s, i) => `## ${i + 1} ${s}\n\n第 ${i + 1} 节内容占位。AUROC 95.12% vs. MCM 86.05%。`)
  const filler = Array.from({ length: 100 }, (_, i) => `填充行 ${i}：实验设置与结论细节。`).join('\n')
  return `${body.join('\n\n')}\n\n${filler}\n`
}

describe('W1 validatePaperPage（确定性逐清单）', () => {
  it('合法 11 节页 → 通过（issues 空）', () => {
    const r = validatePaperPage({ title: 'A Study of Robustness', content: validPaperContent() })
    expect(r.ok).toBe(true)
  })

  it('缺节（删去 ## 4 Method）→ 拒，诊断点名缺的节', () => {
    const content = validPaperContent()
      .split('\n')
      .filter((l) => !l.startsWith('## 4 '))
      .join('\n')
    const r = validatePaperPage({ title: 'T', content })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join('\n')).toContain('Method')
  })

  it('节序号存在但标题错（## 5 Experiment 缺 s）→ 拒（节标题 checklist 按钉死标题）', () => {
    const content = validPaperContent().replace('## 5 Experiments', '## 5 Experiment')
    const r = validatePaperPage({ title: 'T', content })
    expect(r.ok).toBe(false)
  })

  it('不足 100 行 → 拒（853 §4.1 完成门禁）', () => {
    const content = PAPER_PAGE_SECTIONS.map((s, i) => `## ${i + 1} ${s}\n\n内容。数字 95.12%。`).join('\n\n')
    const r = validatePaperPage({ title: 'T', content })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join('\n')).toContain('100')
  })

  it('Results 节无具体数字（定性表述反模式）→ 拒', () => {
    const lines = validPaperContent().split('\n')
    const resultsIdx = lines.findIndex((l) => l.startsWith('## 6 '))
    const patched = lines.map((l, i) => (i === resultsIdx + 2 ? '显著优于 baseline，表现优异，无任何数字。' : l))
    const r = validatePaperPage({ title: 'T', content: patched.join('\n') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join('\n')).toContain('Results')
  })

  it('title 空串 → 拒（frontmatter 必填面）', () => {
    const r = validatePaperPage({ title: '  ', content: validPaperContent() })
    expect(r.ok).toBe(false)
  })
})

describe('W2 validate¹ validateExtractDoc（确定性逐清单）', () => {
  const validExtract = (): string =>
    EXTRACT_SECTIONS.map((s, i) => `## ${i} ${s}\n\n论文报告：主结果 AUROC 95.12%。论文中未明确说明的部分如实标注。`).join('\n\n')

  it('合法 12 节（##0–##11）→ 通过', () => {
    expect(validateExtractDoc(validExtract()).ok).toBe(true)
  })

  it('缺节（删 ## 8）→ 拒，诊断点名', () => {
    const content = validExtract()
      .split('\n')
      .filter((l) => !l.startsWith('## 8 '))
      .join('\n')
    const r = validateExtractDoc(content)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join('\n')).toContain('## 8')
  })

  it('三态禁语：「可能是」出现在正文 → 拒（强制规范用语）', () => {
    const r = validateExtractDoc(`${validExtract()}\n\n这一现象可能是过拟合导致的。`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join('\n')).toContain('可能是')
  })

  it('三态禁语：「应该是」「推测为」逐一拦截', () => {
    for (const phrase of ['结果应该是这样', '作者推测为分布偏移']) {
      const r = validateExtractDoc(`${validExtract()}\n\n${phrase}。`)
      expect(r.ok).toBe(false)
    }
  })

  it('规范用语「论文中未明确说明」不触发禁语扫描', () => {
    expect(validateExtractDoc(validExtract()).ok).toBe(true)
  })

  it('「合理推测」等 critic 规范用语不在 extract 禁语面（禁语=三词精确面）', () => {
    // 「合理推测，仍需验证」是 critic 侧规范用语——但「推测为」子串会误伤吗？禁语按
    // 「推测为」精确子串扫描：不含「为」的「合理推测」放行。
    const r = validateExtractDoc(`${validExtract()}\n\n合理推测，仍需验证。`)
    expect(r.ok).toBe(true)
  })
})

describe('W2 validate² validateCriticDoc（确定性逐清单）', () => {
  const validCritic = (): string =>
    [
      '# 某论文审稿式问题分析',
      '',
      '`category: critic`',
      '',
      ...CRITIC_SECTIONS.map((s, i) => `## ${i} ${s}\n\n已有较强证据支持：具体质疑与依据。`),
    ].join('\n')

  it('合法 §0–§7 + 机读标签 + 候选 2–4 → 通过', () => {
    const r = validateCriticDoc({
      content: validCritic(),
      candidates: [
        { question: 'Q1：消融是否充分？', priority: 'high' },
        { question: 'Q2：泛化性证据？', priority: 'medium' },
      ],
    })
    expect(r.ok).toBe(true)
  })

  it('缺 § 节（删 §5）→ 拒，诊断点名', () => {
    const content = validCritic()
      .split('\n')
      .filter((l) => !l.startsWith('## 5 '))
      .join('\n')
    const r = validateCriticDoc({ content, candidates: [{ question: 'q', priority: 'high' }, { question: 'q2', priority: 'low' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join('\n')).toContain('## 5')
  })

  it('缺 `category: critic` 机读标签 → 拒', () => {
    const content = validCritic().replace('`category: critic`', '')
    const r = validateCriticDoc({ content, candidates: [{ question: 'q', priority: 'high' }, { question: 'q2', priority: 'low' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join('\n')).toContain('category: critic')
  })

  it('候选问题 1 个（< 2）→ 拒；5 个（> 4）→ 拒（853 §4.2 候选 2–4）', () => {
    const one = [{ question: 'q', priority: 'high' as const }]
    const five = [1, 2, 3, 4, 5].map((i) => ({ question: `q${i}`, priority: 'low' as const }))
    expect(validateCriticDoc({ content: validCritic(), candidates: one }).ok).toBe(false)
    expect(validateCriticDoc({ content: validCritic(), candidates: five }).ok).toBe(false)
  })

  it('validate¹ 与 validate² 分列：validateCriticDoc 不做三态禁语扫描（检查对象不同）', () => {
    // critic 规范用语「合理推测，仍需验证」合法；「推测为」禁语扫描不属 validate² 清单。
    const content = validCritic().replace('已有较强证据支持：具体质疑与依据。', '此处出现「可能是」表述——validate² 不扫禁语。')
    expect(validateCriticDoc({ content, candidates: [{ question: 'q', priority: 'high' }, { question: 'q2', priority: 'low' }] }).ok).toBe(true)
  })
})

describe('paperPageSlug（wiki-conventions kebab-case 确定性）', () => {
  it('标题 → 小写 kebab-case，非词字符折叠为连字符', () => {
    expect(paperPageSlug('Robust Out-of-Distribution Detection: A Survey')).toBe('robust-out-of-distribution-detection-a-survey')
  })

  it('中英文混排：中文丢弃、英文词保留（slug 面取拉丁词）', () => {
    expect(paperPageSlug('基于扩散模型的研究 Diffusion Models for Editing')).toContain('diffusion-models-for-editing')
  })

  it('连续分隔符折叠 + 首尾 trim；全无效字符 → 兜底 slug', () => {
    expect(paperPageSlug('  A -- B  ')).toBe('a-b')
    expect(paperPageSlug('!!!')).toBe('untitled-paper')
  })

  it('长度上限截断（路径安全）', () => {
    expect(paperPageSlug('a'.repeat(300)).length).toBeLessThanOrEqual(96)
  })
})

describe('classifyEvidenceRef（evidenceGate 回查分类）', () => {
  it('wiki 页锚（.md 路径）→ wiki-page', () => {
    expect(classifyEvidenceRef('papers/robust-detection.md')).toEqual({ kind: 'wiki-page', path: 'papers/robust-detection.md', section: undefined })
  })

  it('wiki 节锚（.md#节名 / .md:节名）→ wiki-section', () => {
    expect(classifyEvidenceRef('papers/robust-detection.md#6 Results')).toEqual({ kind: 'wiki-page', path: 'papers/robust-detection.md', section: '6 Results' })
    expect(classifyEvidenceRef('papers/robust-detection.md:3 主结果')).toEqual({ kind: 'wiki-page', path: 'papers/robust-detection.md', section: '3 主结果' })
  })

  it('lab 上传件锚（/lab/uploads/…pdf）→ lab-file', () => {
    expect(classifyEvidenceRef('/lab/uploads/2026-01-01-paper.pdf')).toEqual({ kind: 'lab-file', path: '/lab/uploads/2026-01-01-paper.pdf' })
  })

  it('extract 节锚（extract §N / extract#§N）→ extract-node', () => {
    expect(classifyEvidenceRef('extract §3')).toEqual({ kind: 'extract-node', section: 3 })
    expect(classifyEvidenceRef('extract#§11')).toEqual({ kind: 'extract-node', section: 11 })
  })

  it('描述性引用（无可回查锚）→ descriptive（放行不回查）', () => {
    expect(classifyEvidenceRef('论文 Table 2 的消融对比').kind).toBe('descriptive')
  })
})
