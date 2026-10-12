// #910 S3：prompt 模板资产节结构 checklist 断言（853 §9「prompt 模板验收 = 节结构
// checklist 断言而非 golden 全文对照」· #848 §1–§2 资产单源）。
// 锁：各生成节点 prompt 含全部节标题行 / 机读标签 / 三态规则与禁语面 / 输出 JSON 约束 /
// 重试诊断回喂块（diagnostics 非空时注入）。
import { describe, expect, it } from 'vitest'
import {
  PAPER_PAGE_SECTIONS,
  EXTRACT_SECTIONS,
  CRITIC_SECTIONS,
  CRITIC_CATEGORY_TAG,
  EXTRACT_BANNED_PHRASES,
  buildCreatePaperPagePrompt,
  buildExtractPrompt,
  buildCriticPrompt,
} from '../../plugins/research/prompts'

describe('W1 create prompt（11 节论文页模板 · #848 §1）', () => {
  it('11 节标题行全部在模板正文中逐字出现', () => {
    const p = buildCreatePaperPagePrompt(['PAGE1'])
    for (let i = 0; i < PAPER_PAGE_SECTIONS.length; i++) {
      expect(p).toContain(`## ${i + 1} ${PAPER_PAGE_SECTIONS[i]}`)
    }
  })

  it('含 Experiments/Results 最低标准与确定性校验硬性要求', () => {
    const p = buildCreatePaperPagePrompt(['PAGE1'])
    expect(p).toContain('100 行')
    expect(p).toContain('具体数字')
    expect(p).toContain('原文未报告')
  })

  it('含 JSON 输出约束与 claims 结构说明', () => {
    const p = buildCreatePaperPagePrompt(['PAGE1'])
    expect(p).toContain('{"title"')
    expect(p).toContain('"claims"')
    expect(p).toContain('禁止输出 JSON 之外')
  })

  it('论文页文本注入 prompt；diagnostics 非空 → 注入诊断回喂块', () => {
    expect(buildCreatePaperPagePrompt(['PAGE-XYZ'])).toContain('PAGE-XYZ')
    const p = buildCreatePaperPagePrompt(['PAGE1'], '缺节 ## 4 Method')
    expect(p).toContain('上一轮产出未通过校验')
    expect(p).toContain('缺节 ## 4 Method')
    expect(buildCreatePaperPagePrompt(['PAGE1'])).not.toContain('上一轮产出未通过校验')
  })
})

describe('W2 extract prompt（12 节模板 + 三态规则 · #848 §2.1）', () => {
  it('12 节标题行全部在模板正文中逐字出现（##0–##11）', () => {
    const p = buildExtractPrompt('PAPER')
    for (let i = 0; i < EXTRACT_SECTIONS.length; i++) {
      expect(p).toContain(`## ${i} ${EXTRACT_SECTIONS[i]}`)
    }
  })

  it('含三态标注规则、规范用语与全部禁语', () => {
    const p = buildExtractPrompt('PAPER')
    expect(p).toContain('论文报告 / 间接观察 / 未提供')
    expect(p).toContain('论文中未明确说明')
    for (const phrase of EXTRACT_BANNED_PHRASES) expect(p).toContain(phrase)
  })

  it('阶段边界负约束（不做问题挖掘/不提新方法）在模板中', () => {
    const p = buildExtractPrompt('PAPER')
    expect(p).toContain('不做问题挖掘')
    expect(p).toContain('不提新方法')
  })

  it('diagnostics 非空 → 注入诊断回喂块', () => {
    expect(buildExtractPrompt('PAPER', '禁语「可能是」')).toContain('禁语「可能是」')
  })
})

describe('W2 critic prompt（§0–§7 模板 + 9 类质疑 + 证据三档 · #848 §2.2）', () => {
  it('8 节标题行全部在模板正文中逐字出现', () => {
    const p = buildCriticPrompt('PAPER', 'EXTRACT')
    for (let i = 0; i < CRITIC_SECTIONS.length; i++) {
      expect(p).toContain(`## ${i} ${CRITIC_SECTIONS[i]}`)
    }
  })

  it('含机读标签、证据强度三档、质疑 9 类型、候选 2–4 约束', () => {
    const p = buildCriticPrompt('PAPER', 'EXTRACT')
    expect(p).toContain(CRITIC_CATEGORY_TAG)
    expect(p).toContain('已有较强证据支持')
    expect(p).toContain('实验间接暗示')
    expect(p).toContain('仍需后续验证')
    expect(p).toContain('创新性')
    expect(p).toContain('可复现性')
    expect(p).toContain('2–4')
  })

  it('candidates 边上传输 schema 说明（question/priority/evidence）在模板中', () => {
    const p = buildCriticPrompt('PAPER', 'EXTRACT')
    expect(p).toContain('"priority": "high|medium|low"')
    expect(p).toContain('"evidence"')
  })

  it('两份输入材料（论文页 + extract）均注入；diagnostics 非空 → 注入诊断回喂块', () => {
    const p = buildCriticPrompt('PAPER-BODY', 'EXTRACT-BODY', '候选不足 2 个')
    expect(p).toContain('PAPER-BODY')
    expect(p).toContain('EXTRACT-BODY')
    expect(p).toContain('候选不足 2 个')
  })
})
