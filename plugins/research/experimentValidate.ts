// W4 确定性校验纯函数（#912 · 853 §4.4 · #848 §4 规则源）——validate¹ 映射校验泛化 /
// validate² 占位符未填充检查 / audit 确定性三维（#848 六维中 ①②④，③⑤⑥ 归 LLM 面
// experiment.ts auditNode）。零 IO 零 LLM；形态与 pageValidate 同源（ValidateResult，
// issues 中文诊断直供重试 prompt 回喂）。节结构清单与 prompts.ts 同源渲染（防双表漂移）。

import {
  DESIGN_SECTIONS,
  SPEC_SECTIONS,
  INFERABLE_PLACEHOLDERS,
  EXTRACT_BANNED_PHRASES,
} from './prompts'
import type { DesignExperimentSpec, SpecDeliverableSpec } from './prompts'

export interface ValidateFailure {
  readonly ok: false
  readonly issues: readonly string[]
}
export type ValidateResult = { readonly ok: true } | ValidateFailure

const pass: ValidateResult = { ok: true }
const failWith = (issues: readonly string[]): ValidateResult => ({ ok: false, issues })

// 映射匹配归一化：trim/小写/压缩空白（LLM 引用带引号/前后缀不误拒——子串双向之一命中）。
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

const matchesPool = (target: string, pool: readonly string[]): boolean => {
  const t = norm(target)
  if (t === '') return false
  return pool.some((p) => {
    const n = norm(p)
    return n !== '' && (t.includes(n) || n.includes(t))
  })
}

// ---------------------------------------------------------------------------
// validate¹：映射校验泛化（853 §4.4 · #868 D3）——每实验至少映射 critic §4 候选问题
// ∨ idea card minimum_experiment 之一（双输入允许双映射 = 候选池并集）；豁免否决
// （idea card 输入豁免映射校验已否决——假说驱动路径恰是最需忠实性校验的路径）。
// ---------------------------------------------------------------------------

export function validateDesignMapping(
  experiments: readonly DesignExperimentSpec[],
  targets: readonly string[],
): ValidateResult {
  const issues: string[] = []
  if (experiments.length === 0) {
    issues.push('design 实验清单为空——##3 核心验证实验须 3–6 个（##4 可选补充 2–4 个）')
  }
  for (const exp of experiments) {
    if (exp.validation_target.trim() === '') {
      issues.push(`实验「${exp.name}」未声明验证目标——每个实验必须服务一个明确的验证目标（critic 问题或假说）`)
    } else if (!matchesPool(exp.validation_target, targets)) {
      issues.push(
        `实验「${exp.name}」的验证目标未映射到任何 critic §4 候选问题或 idea card minimum_experiment：「${exp.validation_target}」`,
      )
    }
  }
  return issues.length === 0 ? pass : failWith(issues)
}

// ---------------------------------------------------------------------------
// validate²：占位符未填充检查（853 §4.4）——可推断占位符（论文基础 Wiki 标识 = 输入页
// 已知面）出现即拒（重试 prompt 回喂正确值）；开放占位符（确实缺失面）按「显式占位而非
// 编造」约定放行。
// ---------------------------------------------------------------------------

export function validateSpecPlaceholders(content: string): ValidateResult {
  const issues = INFERABLE_PLACEHOLDERS.filter((p) => content.includes(p)).map(
    (p) => `spec 含可推断占位符「${p}」——输入页已知，须填实（缺失信息才允许显式占位）`,
  )
  return issues.length === 0 ? pass : failWith(issues)
}

// ---------------------------------------------------------------------------
// audit 确定性三维（#848 §4.4：①结构完整性 = 节/段标题 checklist；②字段覆盖 = 非空
// 检查；④缺失信息标注 = 禁语黑名单扫描——全纯函数）。
// ---------------------------------------------------------------------------

// 节标题行匹配（`## <n> <title>`，对齐 pageValidate.sectionLineRegex 钉形态）。
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sectionMissing = (sections: readonly string[], content: string, start: number, label: string): string[] =>
  sections
    .map((title, i) => ({ n: i + start, title }))
    .filter(({ n, title }) => !new RegExp(`^##\\s*${n}\\s+${escapeRegExp(title)}\\s*$`, 'm').test(content))
    .map(({ n, title }) => `${label}缺少节标题「## ${n} ${title}」`)

// 节正文非空检查（audit ②「必填字段有内容」——节标题在而正文空壳 = 字段覆盖失败；
// 节切片 = 标题行起至下一 `## ` 标题行前，对齐 pageValidate.sectionBody 形态）。
const sectionEmptyIssues = (sections: readonly string[], content: string, start: number, label: string): string[] => {
  const lines = content.split('\n')
  return sections
    .map((title, i) => ({ n: i + start, title }))
    .filter(({ n, title }) => new RegExp(`^##\\s*${n}\\s+${escapeRegExp(title)}\\s*$`, 'm').test(content))
    .filter(({ title }) => {
      const head = lines.findIndex((l) => l.startsWith('## ') && l.includes(`${title}`))
      if (head < 0) return false
      let end = lines.length
      for (let i = head + 1; i < lines.length; i++) {
        if (lines[i]!.startsWith('## ')) {
          end = i
          break
        }
      }
      return lines.slice(head + 1, end).every((l) => l.trim() === '')
    })
    .map(({ n, title }) => `${label}节「## ${n} ${title}」正文为空——必填字段须有内容（缺失信息用规范用语标注）`)
}

/** ① design 10 节（##0–##9）结构完整性 + 节正文非空。 */
export function auditStructureDesign(designContent: string): string[] {
  return [...sectionMissing(DESIGN_SECTIONS, designContent, 0, 'design 文档'), ...sectionEmptyIssues(DESIGN_SECTIONS, designContent, 0, 'design 文档')]
}

/** ① spec 9 段（##1–##9）结构完整性 + 段正文非空。 */
export function auditStructureSpec(specContent: string): string[] {
  return [...sectionMissing(SPEC_SECTIONS, specContent, 1, 'spec 文档'), ...sectionEmptyIssues(SPEC_SECTIONS, specContent, 1, 'spec 文档')]
}

/** ② 字段覆盖：experiments 三字段 + deliverables 两件非空。 */
export function auditFieldsNonEmpty(input: {
  readonly experiments: readonly DesignExperimentSpec[]
  readonly deliverables: readonly SpecDeliverableSpec[]
}): string[] {
  const issues: string[] = []
  for (const exp of input.experiments) {
    if (exp.name.trim() === '') issues.push('design 实验条目 name 为空')
    if (exp.validation_target.trim() === '') issues.push(`design 实验「${exp.name || '未命名'}」validation_target 为空`)
    if (exp.expected_outcome.trim() === '') issues.push(`design 实验「${exp.name || '未命名'}」expected_outcome 为空`)
  }
  for (const d of input.deliverables) {
    if (d.path.trim() === '') issues.push('spec 交付物 path 为空')
    if (d.success_criterion.trim() === '') issues.push(`spec 交付物「${d.path || '未命名'}」success_criterion 为空`)
  }
  return issues
}

/** ④ 缺失信息标注禁语扫描（EXTRACT_BANNED_PHRASES 同源——「可能是/应该是/推测为」）。 */
export function auditBannedPhrases(designContent: string, specContent: string): string[] {
  const issues: string[] = []
  for (const phrase of EXTRACT_BANNED_PHRASES) {
    if (designContent.includes(phrase))
      issues.push(`design 文档出现禁语「${phrase}」——缺失信息用规范用语标注，不做推测`)
    if (specContent.includes(phrase))
      issues.push(`spec 文档出现禁语「${phrase}」——缺失信息用规范用语标注，不做推测`)
  }
  return issues
}
