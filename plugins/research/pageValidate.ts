// research 流程确定性校验纯函数（#910 · 853 §4.1–§4.2「形状档」校验 · #848 §1–§2 规则源）。
// 零 IO 零 LLM——图内 validate 节点直接调用；清单与 prompt 模板从 prompts.ts 节结构数组
// 同源渲染（防双表漂移）。全部返回 {ok:true} | {ok:false, issues[]} 形态——issues 逐条
// 中文诊断，节点层重试 prompt 直接回喂（853 §7.1 重试触发面「确定性校验拒」的诊断面）。

import {
  PAPER_PAGE_SECTIONS,
  EXTRACT_SECTIONS,
  CRITIC_SECTIONS,
  EXTRACT_BANNED_PHRASES,
  CRITIC_CATEGORY_TAG,
} from './prompts'

export interface ValidateFailure {
  readonly ok: false
  readonly issues: readonly string[]
}
export type ValidateResult = { readonly ok: true } | ValidateFailure

const pass: ValidateResult = { ok: true }
const failWith = (issues: readonly string[]): ValidateResult => ({ ok: false, issues })

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 节标题行匹配（钉死形态 `## <n> <title>`，宽松空白；标题逐字对齐节结构清单）。
const sectionLineRegex = (n: number, title: string): RegExp =>
  new RegExp(`^##\\s*${n}\\s+${escapeRegExp(title)}\\s*$`, 'm')

const missingSectionIssues = (sections: readonly string[], content: string, start: number, label: string): string[] =>
  sections
    .map((title, i) => ({ n: i + start, title }))
    .filter(({ n, title }) => !sectionLineRegex(n, title).test(content))
    .map(({ n, title }) => `${label}缺少节标题「## ${n} ${title}」`)

// 节文本切片（from 标题行 → 下一 `## ` 标题行前；无下一节 = 到文末）。
const sectionBody = (content: string, fromTitle: string): string => {
  const lines = content.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(fromTitle))
  if (start < 0) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n')
}

// ---------------------------------------------------------------------------
// W1 validate（853 §4.1：11 节标题齐全 / frontmatter 必填 / ≥100 行 / Results 含具体数字）
// ---------------------------------------------------------------------------

// frontmatter 必填面在插件语境 = LLM schema 必填槽位（title 经 zod 强制；此处复核非空——
// 「page 路径由 title 派生」的前置）。页路径/frontmatter 组装归核心（853 §3.3 页格式单源）。
export function validatePaperPage(page: { readonly title: string; readonly content: string }): ValidateResult {
  const issues: string[] = []
  if (page.title.trim() === '') issues.push('frontmatter 必填：title 为空')
  issues.push(...missingSectionIssues(PAPER_PAGE_SECTIONS, page.content, 1, '论文页'))
  const lineCount = page.content.split('\n').length
  if (lineCount < 100) issues.push(`论文页正文不足 100 行（当前 ${lineCount} 行）——须为完整精读笔记而非摘要`)
  const resultsBody = sectionBody(page.content, 'Results')
  if (!/[0-9]/.test(resultsBody)) issues.push('Results 节不含具体数字——每个 main claim 至少 1 个具体数字，禁「显著优于 baseline」类定性表述')
  return issues.length === 0 ? pass : failWith(issues)
}

// ---------------------------------------------------------------------------
// W2 validate¹（853 §4.2：extract 12 节节标题 checklist + 三态标注禁语扫描）
// ---------------------------------------------------------------------------

export function validateExtractDoc(content: string): ValidateResult {
  const issues = missingSectionIssues(EXTRACT_SECTIONS, content, 0, 'extract 文档')
  // 禁语扫描（audit 维度 4 同款黑名单）：提取文档只陈述论文说了什么，不做推测——
  // 规范用语「论文中未明确说明」不触发；critic 侧「合理推测，仍需验证」无「推测为」子串不误伤。
  for (const phrase of EXTRACT_BANNED_PHRASES) {
    if (content.includes(phrase)) issues.push(`extract 文档出现禁语「${phrase}」——三态标注只允许「论文报告 / 间接观察 / 未提供」，未提供信息写「论文中未明确说明」`)
  }
  return issues.length === 0 ? pass : failWith(issues)
}

// ---------------------------------------------------------------------------
// W2 validate²（853 §4.2：critic §0–§7 节齐全 + `category: critic` 机读标签 + 候选 2–4。
// 与 validate¹ 检查对象不同，分列不共享 schema 名。）
// ---------------------------------------------------------------------------

export interface CriticCandidate {
  readonly question: string
  readonly priority: 'high' | 'medium' | 'low'
  readonly evidence?: readonly string[]
}

export function validateCriticDoc(doc: {
  readonly content: string
  readonly candidates: readonly CriticCandidate[]
}): ValidateResult {
  const issues: string[] = []
  issues.push(...missingSectionIssues(CRITIC_SECTIONS, doc.content, 0, 'critic 文档'))
  if (!doc.content.includes(CRITIC_CATEGORY_TAG)) {
    issues.push(`critic 文档缺少机读标签 ${CRITIC_CATEGORY_TAG}（须在标题行下空一行）`)
  }
  if (doc.candidates.length < 2 || doc.candidates.length > 4) {
    issues.push(`验证候选问题须为 2–4 个（当前 ${doc.candidates.length} 个）`)
  }
  return issues.length === 0 ? pass : failWith(issues)
}

// ---------------------------------------------------------------------------
// paperPageSlug（wiki-conventions：小写 kebab-case、论文页 slug 匹配标题不带日期——
// 确定性派生，LLM 只给 title）
// ---------------------------------------------------------------------------

export const PAPER_SLUG_MAX_CHARS = 96
const SLUG_FALLBACK = 'untitled-paper'

export function paperPageSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PAPER_SLUG_MAX_CHARS)
    .replace(/-+$/g, '')
  return slug === '' ? SLUG_FALLBACK : slug
}

// ---------------------------------------------------------------------------
// evidenceGate 回查分类（853 §4.2：evidence 引用的 wiki 页/章节/上传件路径存在性回查；
// 分类先行——不同锚型不同回查通道，描述性引用无可回查锚放行）
// ---------------------------------------------------------------------------

export type EvidenceRef =
  | { readonly kind: 'wiki-page'; readonly path: string; readonly section?: string }
  | { readonly kind: 'lab-file'; readonly path: string }
  | { readonly kind: 'extract-node'; readonly section: number }
  | { readonly kind: 'descriptive' }

export function classifyEvidenceRef(ref: string): EvidenceRef {
  // extract 节锚：`extract §3` / `extract#§11` 形态（critic prompt 引导的内存中间产物引用）。
  const extractMatch = /^extract\s*#?\s*§?\s*(\d{1,2})/i.exec(ref.trim())
  if (extractMatch) return { kind: 'extract-node', section: Number(extractMatch[1]) }
  // lab 上传件锚：/lab/uploads/ 前缀（V1 形态校验——上传件存在性由 ingest 产物串联保证）。
  if (ref.startsWith('/lab/uploads/')) return { kind: 'lab-file', path: ref }
  // wiki 页/节锚：含 .md 的 wiki 相对路径；#节名 或 :节名 后缀 = 节锚。
  const mdIndex = ref.indexOf('.md')
  if (mdIndex >= 0 && !ref.startsWith('/lab/')) {
    const path = ref.slice(0, mdIndex + 3)
    const rest = ref.slice(mdIndex + 3)
    const section = rest.startsWith('#') || rest.startsWith(':') ? rest.slice(1).trim() : undefined
    return { kind: 'wiki-page', path, ...(section !== undefined && section !== '' ? { section } : {}) }
  }
  return { kind: 'descriptive' }
}
