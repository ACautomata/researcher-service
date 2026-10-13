// W3 contextPack 纯逻辑（#911 · 853 §4.3 · #869 D3）：集中检索证据的组装/分级/预算裁剪——
// 零 IO 零 LLM（Brief 的 LLM 生成在图内，本文件只管确定性构建面）。S3 测试锁裁剪顺序：
// evidence 按证据等级降序 + 页级节选（非全文）+ Brief 恒保全 + 「证据不足」判定在裁剪后。
//
// 证据分级口径（解读落点）：插件检索契约（PluginWikiSearchHit）不带 researcher wiki 的
// frontmatter evidence_level 面——确定性代理 = 页组：papers/ = W1 精读论文页（full-paper
// 等价，最高级）/ critics/ = 二级审稿分析 / 其他 = 0。等级只在排序降序消费，不入诊断文案。

import { z } from '../../server/src/plugins/autofigureDeps'
import { EVIDENCE_EXCERPT_MAX_CHARS } from './values'
import { JUDGE_CHARS_PER_TOKEN, truncateToTokenBudget } from '../../server/src/utils/tokenBudget'

// ---------------------------------------------------------------------------
// Brief 10 字段（#848 §3 brief-template.md 单源 · 853 §4.3「字段缺失不阻塞写 ASSUMPTION 继续」）
// ---------------------------------------------------------------------------

export const BRIEF_FIELDS = [
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
] as const

// LLM 产出面：10 字段全 optional——缺失/空归确定性 ASSUMPTION 填充（放宽到 schema 层会让
// generateStructured 提前抛结构化错误，与「字段缺失不阻塞」语义相悖）。
export const BRIEF_SCHEMA = z
  .object({
    research_topic: z.string().optional(),
    target_task: z.string().optional(),
    current_baseline: z.string().optional(),
    available_data: z.string().optional(),
    available_code: z.string().optional(),
    available_compute: z.string().optional(),
    preferred_metrics: z.string().optional(),
    hard_constraints: z.string().optional(),
    known_failures: z.string().optional(),
    desired_risk_level: z.string().optional(),
  })
  .strict()

export type IdeaBrief = z.infer<typeof BRIEF_SCHEMA>

// ASSUMPTION 填充（brief-template「write ASSUMPTION: and continue」确定性面）：缺失/空白
// 字段一律填 'ASSUMPTION: 未提供'——产出恒为 10 字段全非空（Brief 恒保全的完整性前提）。
export function fillBriefAssumptions(brief: IdeaBrief): Record<(typeof BRIEF_FIELDS)[number], string> {
  return Object.fromEntries(
    BRIEF_FIELDS.map((f) => {
      const v = brief[f]
      return [f, typeof v === 'string' && v.trim() !== '' ? v : 'ASSUMPTION: 未提供']
    }),
  ) as Record<(typeof BRIEF_FIELDS)[number], string>
}

// Brief 块渲染（包内恒保全块——10 字段逐行，字段名与 brief-template 同形）。
export function briefBlockOf(filled: Record<(typeof BRIEF_FIELDS)[number], string>): string {
  return ['# Idea Generation Brief', '', ...BRIEF_FIELDS.map((f) => `${f}: ${filled[f]}`)].join('\n')
}

// ---------------------------------------------------------------------------
// 证据条目：分级 + 页级节选 + 排序
// ---------------------------------------------------------------------------

export interface EvidenceEntry {
  /** 写面 rel 路径（papers/x.md——graph.ts 路径域约定）。 */
  readonly path: string
  /** 证据等级（页组派生——见文件头注记；2 > 1 > 0）。 */
  readonly level: 0 | 1 | 2
  /** 页级节选（非全文——capEvidenceExcerpt 已裁）。 */
  readonly excerpt: string
  /** 检索/输入序（同级排序稳定锚）。 */
  readonly rank: number
}

export function evidenceLevelOf(path: string): 0 | 1 | 2 {
  const p = path.toLowerCase()
  if (p.startsWith('papers/')) return 2
  if (p.startsWith('critics/')) return 1
  return 0
}

// 页级节选（853 §4.3「页级节选（非全文）」）：换算口径复用共享 truncateToTokenBudget
// （JUDGE_CHARS_PER_TOKEN=2 单源——2000 tokens × 2 = 4000 字符 cap）。
export function capEvidenceExcerpt(text: string): string {
  return truncateToTokenBudget(text, EVIDENCE_EXCERPT_MAX_CHARS / JUDGE_CHARS_PER_TOKEN)
}

// 排序 = 等级降序 + 同级 rank 升序（Array.prototype.sort 稳定——同级保持检索序）。
export function sortEvidenceEntries<T extends Pick<EvidenceEntry, 'level' | 'rank'>>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => b.level - a.level || a.rank - b.rank)
}

// ---------------------------------------------------------------------------
// 预算裁剪（构建时裁一次 · Send[] 分发全量拷贝不分桶裁——#869 D3）
// ---------------------------------------------------------------------------

// 证据条目块（序列化单源——预算记账与最终拼接同形，防双写漂移）。
const evidenceBlockOf = (e: EvidenceEntry): string => `## ${e.path}\n\n${e.excerpt}`

// 证据条目预算裁剪（字符面——整条目取舍：装不下即停，不中途截断条目；等级降序）。
// 图内唯一消费面 = hypothesize.contextPackNode：全额预算给证据做裁剪，「证据不足」判定
// 在裁剪后（幸存 0 → END+clarify 零 LLM 消耗）；Brief 在合包时恒保全前置，不占证据预算
//（853 §4.3「Brief 恒保全」= 恒完整先于证据，非与证据分账）。
export function trimEvidenceToBudgetChars(entries: readonly EvidenceEntry[], budgetChars: number): EvidenceEntry[] {
  const kept: EvidenceEntry[] = []
  let used = 0
  for (const entry of sortEvidenceEntries(entries)) {
    const extra = evidenceBlockOf(entry).length + 2 // '\n\n' 分隔面同口径记账
    if (used + extra > Math.max(0, budgetChars)) break
    kept.push(entry)
    used += extra
  }
  return kept
}

// 证据上下文（图内消费面）：裁剪 + 「证据不足」判定（在裁剪后——幸存 0 = insufficient）。
export interface EvidenceContext {
  readonly evidence: readonly EvidenceEntry[]
  readonly sufficient: boolean
}

export function buildEvidenceContext(entries: readonly EvidenceEntry[], budgetTokens: number): EvidenceContext {
  // token → 字符换算复用 JUDGE_CHARS_PER_TOKEN 单源（853 §4.3「换算口径复用」钉面）。
  const evidence = trimEvidenceToBudgetChars(entries, Math.max(0, budgetTokens) * JUDGE_CHARS_PER_TOKEN)
  return { evidence, sufficient: evidence.length > 0 }
}

// Brief 块 + 证据条目合包（assemble 单源——Brief 恒保全前置：verbatim 完整块不受预算裁剪）。
export function assembleContextPackText(briefBlock: string, evidence: readonly EvidenceEntry[]): string {
  return evidence.length === 0 ? briefBlock : `${briefBlock}\n\n${evidence.map(evidenceBlockOf).join('\n\n')}`
}
