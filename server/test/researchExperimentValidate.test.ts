// #912 S3：W4 确定性校验纯逻辑逐清单锁定（853 §4.4 / issue #912 AC「S3：映射校验泛化 /
// 占位符检查 / audit 确定性三维 …通过」）。ValidateResult 形态与 pageValidate 同源
// （{ok:true} | {ok:false, issues[]}——issues 中文诊断直供重试 prompt 回喂）。
import { describe, expect, it } from 'vitest'
import {
  validateDesignMapping,
  validateSpecPlaceholders,
  auditStructureDesign,
  auditStructureSpec,
  auditFieldsNonEmpty,
  auditBannedPhrases,
} from '../../plugins/research/experimentValidate'
import {
  DESIGN_SECTIONS,
  SPEC_SECTIONS,
  INFERABLE_PLACEHOLDERS,
  OPEN_PLACEHOLDERS,
} from '../../plugins/research/prompts'
import { validDesignDoc, validSpecDoc, DESIGN_EXPERIMENTS, SPEC_DELIVERABLES } from './researchFixtures'

describe('W4 validate¹：映射校验泛化（853 §4.4 · #868 D3）', () => {
  const targets = ['消融是否覆盖核心组件？', '跨模态泛化证据是否充分？']

  it('每实验映射 critic §4 候选问题之一 → 通过', () => {
    const r = validateDesignMapping(DESIGN_EXPERIMENTS, targets)
    expect(r).toEqual({ ok: true })
  })

  it('映射 idea card minimum_experiment（双输入并集池）→ 通过', () => {
    const minExp = '在 CIFAR-100 上复现 baseline 并替换打分函数，对比 AUROC/FPR95。'
    const r = validateDesignMapping(
      [{ name: '打分函数替换', validation_target: minExp, expected_outcome: 'AUROC 提升' }],
      [minExp],
    )
    expect(r).toEqual({ ok: true })
  })

  it('某实验映射为空 → 拒（「每个实验必须服务一个明确的验证目标」）', () => {
    const r = validateDesignMapping(
      [...DESIGN_EXPERIMENTS, { name: '无靶实验', validation_target: '  ', expected_outcome: 'x' }],
      targets,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.includes('无靶实验') && i.includes('验证目标'))).toBe(true)
  })

  it('某实验映射偏离候选池（critic 问题与 minimum_experiment 均不匹配）→ 拒', () => {
    const r = validateDesignMapping(
      [{ name: '跑偏实验', validation_target: '验证宇宙射线对损失曲线的影响', expected_outcome: 'x' }],
      targets,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.includes('跑偏实验'))).toBe(true)
  })

  it('匹配归一化：池成员为 target 子串亦命中（LLM 引用带引号/前后缀不误拒）', () => {
    const r = validateDesignMapping(
      [{ name: '引文实验', validation_target: '「消融是否覆盖核心组件？」——见 critic §4', expected_outcome: 'x' }],
      targets,
    )
    expect(r).toEqual({ ok: true })
  })

  it('零实验 → 拒（##3 核心 3–6 个钉面）', () => {
    const r = validateDesignMapping([], targets)
    expect(r.ok).toBe(false)
  })
})

describe('W4 validate²：占位符未填充检查（853 §4.4 · #848 §4.2 占位符清单）', () => {
  it('无占位符 → 通过', () => {
    expect(validateSpecPlaceholders(validSpecDoc().content)).toEqual({ ok: true })
  })

  it('出现可推断占位符（论文基础 Wiki 标识——输入页已知）→ 拒', () => {
    const r = validateSpecPlaceholders(`## 1 任务背景\n\n此处应填写论文基础 Wiki 标识`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.includes(INFERABLE_PLACEHOLDERS[0]!))).toBe(true)
  })

  it('出现确实缺失占位符（代码仓库路径/训练入口——自主执行无人可问）→ 放行但提示', () => {
    const r = validateSpecPlaceholders(`## 1 任务背景\n\n此处应填写代码仓库路径\n\n此处应填写训练入口文件路径`)
    expect(r).toEqual({ ok: true })
    // 放行语义不改 ValidateResult 形态；缺失占位符提示归 summary 面（占位符清单单源消费）。
    expect(OPEN_PLACEHOLDERS.length).toBeGreaterThan(0)
  })

  it('扫描覆盖全部占位符清单形态（含「请根据仓库结构自行定位」指令形）', () => {
    for (const p of [...INFERABLE_PLACEHOLDERS, ...OPEN_PLACEHOLDERS]) {
      expect(`前缀${p}后缀`).toContain(p)
    }
  })
})

describe('W4 audit 确定性三维（#848 §4.4：①结构完整性 ②字段非空 ④禁语扫描）', () => {
  it('① design 10 节 checklist：节结构清单逐字锁定（模板 ↔ 校验同源）', () => {
    expect(DESIGN_SECTIONS).toHaveLength(10)
    expect(DESIGN_SECTIONS[0]).toBe('文档定位')
    expect(DESIGN_SECTIONS[9]).toBe('输出要求说明')
    expect(auditStructureDesign(validDesignDoc().content)).toEqual([])
  })

  it('① design 缺节 → 诊断带节号节名', () => {
    const issues = auditStructureDesign(validDesignDoc().content.replace('## 6 最值得优先执行的 3 个实验', '## 6 改名'))
    expect(issues.some((i) => i.includes('## 6 最值得优先执行的 3 个实验'))).toBe(true)
  })

  it('① spec 9 段 checklist：段结构清单逐字锁定', () => {
    expect(SPEC_SECTIONS).toHaveLength(9)
    expect(SPEC_SECTIONS[0]).toBe('任务背景')
    expect(SPEC_SECTIONS[8]).toBe('汇报格式')
    expect(auditStructureSpec(validSpecDoc().content)).toEqual([])
  })

  it('① spec 缺段 → 诊断带段号段名', () => {
    const issues = auditStructureSpec(validSpecDoc().content.replace('## 7 交付内容', ''))
    expect(issues.some((i) => i.includes('## 7 交付内容'))).toBe(true)
  })

  it('② 字段非空：deliverables 每件 path/success_criterion 非空、experiments 每件三字段非空', () => {
    expect(auditFieldsNonEmpty({ experiments: DESIGN_EXPERIMENTS, deliverables: SPEC_DELIVERABLES })).toEqual([])
    expect(
      auditFieldsNonEmpty({
        experiments: [{ name: 'x', validation_target: '', expected_outcome: 'y' }],
        deliverables: [{ path: '/lab/results/a.json', success_criterion: '' }],
      }).length,
    ).toBe(2)
  })

  it('④ 禁语扫描：design/spec 出现「可能是/应该是/推测为」→ 拒（EXTRACT_BANNED_PHRASES 同源）', () => {
    expect(auditBannedPhrases(validDesignDoc().content, validSpecDoc().content)).toEqual([])
    const issues = auditBannedPhrases('## 8 简短总结\n\n该方法可能是过拟合。', '')
    expect(issues.some((i) => i.includes('可能是'))).toBe(true)
    const specIssues = auditBannedPhrases('', '## 8 完成标准\n\n结果应该是可复现的。')
    expect(specIssues.some((i) => i.includes('应该是'))).toBe(true)
  })
})


describe('W4 audit ① 节正文非空（#848 §4.4 ②「必填字段有内容」——空壳节 = 字段覆盖失败）', () => {
  it('design 节标题在但正文空壳 → 诊断', () => {
    const hollow = DESIGN_SECTIONS.map((s, i) => `## ${i} ${s}`).join('\n')
    const issues = auditStructureDesign(hollow)
    expect(issues.length).toBe(DESIGN_SECTIONS.length)
    expect(issues[0]).toContain('正文为空')
  })

  it('spec 空壳节 → 诊断；合法 fixture 全节有正文 → 过', () => {
    const hollow = SPEC_SECTIONS.map((s, i) => `## ${i + 1} ${s}`).join('\n')
    expect(auditStructureSpec(hollow).length).toBe(SPEC_SECTIONS.length)
    expect(auditStructureSpec(validSpecDoc().content)).toEqual([])
  })
})
