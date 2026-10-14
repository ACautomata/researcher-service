// #910 S3：prompt 模板资产节结构 checklist 断言（853 §9「prompt 模板验收 = 节结构
// checklist 断言而非 golden 全文对照」· #848 §1–§2 资产单源）。
// 锁：各生成节点 prompt 含全部节标题行 / 机读标签 / 三态规则与禁语面 / 输出 JSON 约束 /
// 重试诊断回喂块（diagnostics 非空时注入）。
import { describe, expect, it } from 'vitest'
import {
  PAPER_PAGE_SECTIONS,
  EXTRACT_SECTIONS,
  CRITIC_SECTIONS,
  CRITIC_TYPE_TAG,
  CONTENT_LANGUAGE_RULE,
  EXTRACT_BANNED_PHRASES,
  buildCreatePaperPagePrompt,
  buildExtractPrompt,
  buildCriticPrompt,
  IDEA_CARD_FIELDS,
  IDEA_TYPE_TAG,
  BUCKET_STRATEGIES,
  IDEA_QUALITY_CHECKS,
  buildBriefPrompt,
  buildBucketPrompt,
  buildChallengePrompt,
  DESIGN_SECTIONS,
  SPEC_SECTIONS,
  INFERABLE_PLACEHOLDERS,
  OPEN_PLACEHOLDERS,
  DESIGN_EXPERIMENT_TYPES,
  DESIGN_EXPERIMENT_REQUIREMENTS,
  AUDIT_REPORT_SECTIONS,
  STAGE_BOUNDARY_RULES,
  EXPERIMENT_REPORT_TYPE_TAG,
  buildDesignPrompt,
  buildSpecPrompt,
  buildAuditPrompt,
  buildCollectSummaryPrompt,
} from '../../plugins/research/prompts'
import { BRIEF_FIELDS } from '../../plugins/research/contextPack'
import { BUCKETS_ALL } from '../../plugins/research/values'

// 机读标签词形钉（#949 A 轨 · 规格 §1.2 撞名修正）：category 键保持中文值域不被英文值
// 污染——`category: <英文>` 全改 `type: <新词形>`（type 枚举 paper/critique/hypothesis/report）。
// 字面量为规格准据独立锚定（非常量自比），防词形漂移。
describe('机读标签词形（#949 A 轨 · category 键中文值域不被污染）', () => {
  it('三标签全部新词形：critic→type: critique / idea→type: hypothesis / experiment-report→type: report', () => {
    expect(CRITIC_TYPE_TAG).toBe('`type: critique`')
    expect(IDEA_TYPE_TAG).toBe('`type: hypothesis`')
    expect(EXPERIMENT_REPORT_TYPE_TAG).toBe('`type: report`')
  })
})

// 语言约束（#949 A 轨「中文保证」· 规格 §4.5「内容中文、结构豁免」）：正文 / tags 值 /
// description / title 全中文 + 结构豁免条款（节标题锚点 / frontmatter 键名 / type 枚举 /
// 论文页 title 英文豁免）——注入全部正文生成节点，brief/challenge 纯结构化 JSON 不注。
describe('语言约束 CONTENT_LANGUAGE_RULE（内容中文、结构豁免 · #949 A 轨）', () => {
  it('约束含全中文面与全部结构豁免条款（节标题锚点 / frontmatter 键名 / type 枚举 / 论文页 title）', () => {
    expect(CONTENT_LANGUAGE_RULE).toContain('正文')
    expect(CONTENT_LANGUAGE_RULE).toContain('tags 值')
    expect(CONTENT_LANGUAGE_RULE).toContain('description')
    expect(CONTENT_LANGUAGE_RULE).toContain('title')
    expect(CONTENT_LANGUAGE_RULE).toContain('节标题锚点')
    expect(CONTENT_LANGUAGE_RULE).toContain('frontmatter 键名')
    expect(CONTENT_LANGUAGE_RULE).toContain('type 枚举')
    expect(CONTENT_LANGUAGE_RULE).toContain('论文页 title')
    // type 枚举值字面量钉（plugins 树禁裸 import server 域——PLUGIN_PAGE_TYPES 单源不可达，
    // 字面量改值时此断言变红防静默漂移；通道② prompt 同字面量由 wikigenTeammate 断言钉）。
    expect(CONTENT_LANGUAGE_RULE).toContain('paper/critique/hypothesis/report')
  })

  it('注入全部正文生成节点（create/extract/critic/bucket/design/spec/audit/collect）', () => {
    expect(buildCreatePaperPagePrompt(['P'])).toContain(CONTENT_LANGUAGE_RULE)
    expect(buildExtractPrompt('P')).toContain(CONTENT_LANGUAGE_RULE)
    expect(buildCriticPrompt('P', 'E', 'papers/x.md')).toContain(CONTENT_LANGUAGE_RULE)
    expect(buildBucketPrompt('gap', 'PACK')).toContain(CONTENT_LANGUAGE_RULE)
    expect(buildDesignPrompt({ intent: 'I', pageBodies: ['P'], mappingTargets: ['T'] })).toContain(CONTENT_LANGUAGE_RULE)
    expect(buildSpecPrompt({ intent: 'I', pageBodies: ['P'], designContent: 'D', wikiIdentity: 'critics/x.md' })).toContain(CONTENT_LANGUAGE_RULE)
    expect(buildAuditPrompt({ designContent: 'D', specContent: 'S', deterministicIssues: [] })).toContain(CONTENT_LANGUAGE_RULE)
    expect(
      buildCollectSummaryPrompt({
        specContent: 'S',
        reckonings: [{ path: '/lab/r.json', success_criterion: '含数字', present: true, content: '{}' }],
      }),
    ).toContain(CONTENT_LANGUAGE_RULE)
  })

  it('brief/challenge 纯结构化 JSON 输出不注入', () => {
    expect(buildBriefPrompt('主题', '证据')).not.toContain(CONTENT_LANGUAGE_RULE)
    expect(buildChallengePrompt('PACK', '{"title": "X"}', [])).not.toContain(CONTENT_LANGUAGE_RULE)
  })
})

describe('W1 create prompt（11 节论文页模板 · #848 §1）', () => {
  it('11 节标题行全部在模板正文中逐字出现', () => {
    const p = buildCreatePaperPagePrompt(['PAGE1'])
    for (let i = 0; i < PAPER_PAGE_SECTIONS.length; i++) {
      expect(p).toContain(`## ${i + 1} ${PAPER_PAGE_SECTIONS[i]}`)
    }
  })

  it('含 Experiments/Results 最低标准（#848 §1.2 全量规则）与确定性校验硬性要求', () => {
    const p = buildCreatePaperPagePrompt(['PAGE1'])
    expect(p).toContain('100 行')
    expect(p).toContain('具体数字')
    expect(p).toContain('原文未报告')
    expect(p).toContain('backbone')
    expect(p).toContain('mean±std over N runs')
    expect(p).toContain('测了什么变体')
    expect(p).toContain('最佳方法/最强 baseline/差距')
  })

  it('含 JSON 输出约束（闭合形态）与 claims 结构说明', () => {
    const p = buildCreatePaperPagePrompt(['PAGE1'])
    expect(p).toContain('{"title"')
    expect(p).toContain('"claims": [{"statement": "...", "evidence": ["..."]}]}')
    expect(p).toContain('禁止输出 JSON 之外')
  })

  it('wiki 约定（#848 §1.3 链接/矛盾迁移面）在模板中', () => {
    const p = buildCreatePaperPagePrompt(['PAGE1'])
    expect(p).toContain('相对 markdown 链接')
    expect(p).toContain('不得省略或抹平')
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

  it('领域特定关注 6 项（#848 §2.1：增量学习/持续学习等场景）在模板中', () => {
    const p = buildExtractPrompt('PAPER')
    expect(p).toContain('阶段间性能变化')
    expect(p).toContain('新旧知识保持与适应')
    expect(p).toContain('任务顺序与结构变化强度')
    expect(p).toContain('memory budget 敏感性')
    expect(p).toContain('特定数据集退化')
    expect(p).toContain('性能提升代价')
  })

  it('diagnostics 非空 → 注入诊断回喂块', () => {
    expect(buildExtractPrompt('PAPER', '禁语「可能是」')).toContain('禁语「可能是」')
  })
})

describe('W2 critic prompt（§0–§7 模板 + 9 类质疑 + 证据三档 · #848 §2.2）', () => {
  it('8 节标题行全部在模板正文中逐字出现', () => {
    const p = buildCriticPrompt('PAPER', 'EXTRACT', 'papers/robust-detection.md')
    for (let i = 0; i < CRITIC_SECTIONS.length; i++) {
      expect(p).toContain(`## ${i} ${CRITIC_SECTIONS[i]}`)
    }
  })

  it('含机读标签、证据强度三档、质疑 9 类型、候选 2–4 约束', () => {
    const p = buildCriticPrompt('PAPER', 'EXTRACT', 'papers/robust-detection.md')
    expect(p).toContain(CRITIC_TYPE_TAG)
    expect(p).toContain('已有较强证据支持')
    expect(p).toContain('实验间接暗示')
    expect(p).toContain('仍需后续验证')
    expect(p).toContain('创新性')
    expect(p).toContain('可复现性')
    expect(p).toContain('2–4')
  })

  it('第一行 H1 槽位 + 正文中文约定（#848 §0/§2.2 · Spec#16/#18）在模板中', () => {
    const p = buildCriticPrompt('PAPER', 'EXTRACT', 'papers/robust-detection.md')
    expect(p).toContain('# <分析标题>')
    expect(p).toContain('正文中文')
  })

  it('candidates 边上传输 schema 说明（question/priority/evidence）在模板中', () => {
    const p = buildCriticPrompt('PAPER', 'EXTRACT', 'papers/robust-detection.md')
    expect(p).toContain('"priority": "high|medium|low"')
    expect(p).toContain('"evidence"')
  })

  it('evidence 引用指引注入真实论文页路径（Spec#4——evidenceGate 回查锚）', () => {
    const p = buildCriticPrompt('PAPER', 'EXTRACT', 'papers/robust-detection.md')
    expect(p).toContain('papers/robust-detection.md#<节标题>')
    expect(p).toContain('papers/robust-detection.md#6 Results')
    expect(p).toContain('不得虚构节标题')
  })

  it('两份输入材料（论文页 + extract）均注入；diagnostics 非空 → 注入诊断回喂块', () => {
    const p = buildCriticPrompt('PAPER-BODY', 'EXTRACT-BODY', 'papers/x.md', '候选不足 2 个')
    expect(p).toContain('PAPER-BODY')
    expect(p).toContain('EXTRACT-BODY')
    expect(p).toContain('候选不足 2 个')
  })
})

describe('W3 brief prompt（Brief 10 字段模板 · #848 §3 brief-template）', () => {
  it('10 字段键名全部在模板正文中', () => {
    const p = buildBriefPrompt('OOD 检测', '证据节选')
    for (const f of BRIEF_FIELDS) expect(p).toContain(f)
    expect(BRIEF_FIELDS).toHaveLength(10)
  })

  it('主题与证据节选注入；字段缺失不阻塞语义（下游 ASSUMPTION 填充）与 risk 档在模板中', () => {
    const p = buildBriefPrompt('OOD 检测', 'EVIDENCE-EXCERPT')
    expect(p).toContain('OOD 检测')
    expect(p).toContain('EVIDENCE-EXCERPT')
    expect(p).toContain('ASSUMPTION')
    expect(p).toContain('low-risk / medium-risk / exploratory')
    expect(p).toContain('禁止输出 JSON 之外')
  })
})

describe('W3 bucket prompt（策略段按桶注入 · #848 §3 generation-strategies + output-spec）', () => {
  it('8 桶策略段齐全（5 固定 + 3 opt-in），每桶段落非空', () => {
    expect(BUCKETS_ALL).toEqual([
      'gap', 'contradiction', 'failure', 'transfer', 'constraint', 'ablation', 'metric', 'assumption-challenge',
    ])
    for (const bucket of BUCKETS_ALL) {
      const strategy = BUCKET_STRATEGIES[bucket]
      expect(strategy).toBeTruthy()
      expect(strategy!.length).toBeGreaterThan(10)
    }
  })

  it('每桶 prompt 含：本桶策略段 + 15 字段全量 + 质量检查清单 + 1–3 张候选钉面 + Context Pack 注入', () => {
    const pack = 'PACK-BODY'
    const p = buildBucketPrompt('gap', pack)
    expect(p).toContain(BUCKET_STRATEGIES.gap)
    for (const f of IDEA_CARD_FIELDS) expect(p).toContain(f)
    expect(IDEA_CARD_FIELDS).toHaveLength(15)
    for (const check of IDEA_QUALITY_CHECKS) expect(p).toContain(check)
    expect(p).toContain('1–3')
    expect(p).toContain(pack)
    expect(p).toContain('禁止输出 JSON 之外')
    // opt-in 桶策略段同样注入（assumption-challenge 为自撰段——brainstorm 反驳视角生成桶）
    expect(buildBucketPrompt('assumption-challenge', pack)).toContain(BUCKET_STRATEGIES['assumption-challenge'])
  })

  it('泛化锚禁令与 low-confidence 义务（output-spec 质量清单 + validate 黑名单同源语义）在模板中', () => {
    const p = buildBucketPrompt('metric', 'PACK')
    expect(p).toContain('related work')
    expect(p).toContain('low-confidence')
  })
})

describe('W3 challenge prompt（反驳判据边界 · 853 §4.3「笼统不确定性不是反驳」）', () => {
  it('verdict 枚举 + rejected 判据全类型 + 笼统不确定性拒识语义在模板中', () => {
    const p = buildChallengePrompt('PACK-BODY', '{"title": "X"}', ['卡A', '卡B'])
    expect(p).toContain('"verdict": "rejected|survived"')
    expect(p).toContain('无来源支撑')
    expect(p).toContain('已有工作已覆盖')
    expect(p).toContain('硬约束')
    expect(p).toContain('不能区分竞争解释')
    expect(p).toContain('不可检验')
    expect(p).toContain('笼统的不确定性不是反驳')
  })

  it('Context Pack / 待反驳卡 JSON / 本批次其他候选（语义去重面）三注入', () => {
    const p = buildChallengePrompt('PACK-BODY', '{"title": "X"}', ['卡A', '卡B'])
    expect(p).toContain('PACK-BODY')
    expect(p).toContain('{"title": "X"}')
    expect(p).toContain('卡A')
    expect(p).toContain('语义去重')
  })
})


describe('W4 prompt 节结构 checklist（853 §9——模板与确定性校验同源，#848 §4 单一来源）', () => {
  it('design 10 节 + spec 9 段 + audit 报告 7 节：节标题逐字在模板中渲染', () => {
    const design = buildDesignPrompt({ intent: 'I', pageBodies: ['P'], mappingTargets: ['T'] })
    for (const [i, s] of DESIGN_SECTIONS.entries()) expect(design).toContain(`## ${i} ${s}`)
    const spec = buildSpecPrompt({ intent: 'I', pageBodies: ['P'], designContent: 'D', wikiIdentity: 'critics/x.md' })
    for (const [i, s] of SPEC_SECTIONS.entries()) expect(spec).toContain(`## ${i + 1} ${s}`)
    const audit = buildAuditPrompt({ designContent: 'D', specContent: 'S', deterministicIssues: [] })
    for (const [i, s] of AUDIT_REPORT_SECTIONS.entries()) expect(audit).toContain(`## ${i} ${s}`)
  })

  it('design：11 类推荐实验类型 + 每实验必须明确清单 + 映射池注入（#848 §4.1）', () => {
    const p = buildDesignPrompt({ intent: 'I', pageBodies: ['P1', 'P2'], mappingTargets: ['靶A', '靶B'] })
    for (const t of DESIGN_EXPERIMENT_TYPES) expect(p).toContain(t)
    for (const r of DESIGN_EXPERIMENT_REQUIREMENTS) expect(p).toContain(r)
    expect(p).toContain('靶A')
    expect(p).toContain('靶B')
    expect(p).toContain('不下最终结论')
  })

  it('design 修订模式：上轮 spec + 用户理由注入（853 §5.1 修订输入契约）', () => {
    const p = buildDesignPrompt({
      intent: 'I',
      pageBodies: ['P'],
      mappingTargets: ['T'],
      revision: { priorSpec: '上轮 SPEC 正文', reason: '样本量不足' },
    })
    expect(p).toContain('修订模式')
    expect(p).toContain('上轮 SPEC 正文')
    expect(p).toContain('样本量不足')
  })

  it('spec：标题「沙箱执行规格」（DROP 外发语义）+ 占位符纪律 + nohup 执行指引', () => {
    const p = buildSpecPrompt({ intent: 'I', pageBodies: ['P'], designContent: 'D', wikiIdentity: 'critics/x.md' })
    expect(p).toContain('# 沙箱执行规格')
    expect(p).not.toContain('发给 claude-code')
    expect(p).toContain('critics/x.md')
    expect(p).toContain(OPEN_PLACEHOLDERS[0])
    for (const ph of INFERABLE_PLACEHOLDERS) expect(p).toContain(ph)
    expect(p).toContain('nohup')
    expect(p).toContain('120s')
    expect(p).toContain('deliverables')
  })

  it('spec 诊断回喂块（重试触发面三源——确定性校验拒的诊断面）', () => {
    const p = buildSpecPrompt({ intent: 'I', pageBodies: ['P'], designContent: 'D', wikiIdentity: 'W', diagnostics: 'DIAG-占位符未填' })
    expect(p).toContain('上一轮产出未通过校验')
    expect(p).toContain('DIAG-占位符未填')
  })

  it('audit：③⑤⑥ 维度 + 阶段边界清单 + 确定性问题注入 + blocking 非空 fail 语义', () => {
    const p = buildAuditPrompt({ designContent: 'D', specContent: 'S', deterministicIssues: ['ISSUE-缺节'] })
    expect(p).toContain('阶段边界遵守')
    expect(p).toContain('证据强度分级')
    expect(p).toContain('跨阶段一致性')
    for (const r of STAGE_BOUNDARY_RULES) expect(p).toContain(r.split(' ')[0])
    expect(p).toContain('ISSUE-缺节')
    expect(p).toContain('blocking 非空时本调用将失败不进人审')
  })

  it('collect 报告 prompt：机读标签归写入面（LLM 契约不含）+ 对账结果注入', () => {
    const p = buildCollectSummaryPrompt({
      specContent: 'SPEC-BODY',
      reckonings: [
        { path: '/lab/results/a.json', success_criterion: '含数字', present: true, content: '{"auroc": 95}' },
        { path: '/lab/results/b.csv', success_criterion: '每行有值', present: false, content: undefined },
      ],
    })
    expect(p).toContain('SPEC-BODY')
    expect(p).toContain('已就位：/lab/results/a.json')
    expect(p).toContain('缺失：/lab/results/b.csv')
    expect(p).toContain('如实记录不得编造')
    expect(p).not.toContain(EXPERIMENT_REPORT_TYPE_TAG)
  })
})
