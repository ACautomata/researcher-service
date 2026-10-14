// W3 idea card 纯逻辑（#911 · 853 §4.3 · #848 §3 资产单源）：idea_dedup.py 与
// validate_idea_cards.py 的 TS 全量移植——零 IO 零 LLM，dedup/validate/persist 渲染三消费面。
// 移植纪律：规则判定与 py 逐项同构（norm 空白折叠 / 锚黑名单 / concrete 判据 / 痛点 marker /
// evidence 总长保留规则），诊断文案中文化（repo 校验面惯例，回喂 summary 不静默）。
//
// LLM 产出 schema（IDEA_CARD_SCHEMA）刻意宽容——15 字段全 optional（zod 只管类型与尺寸），
// 完整性质检归 validateIdeaCards 确定性面（W3 桶节点无重试协议——结构化宽容 + 确定性逐条拒
// 是「单桶失败 ≠ 整桶作废」的配套：单卡缺陷在 validate 淘汰，结构级失败才走 catch 降级）。

import { z } from '../../server/src/plugins/autofigureDeps'
import { IDEA_ANCHORS_MAX, IDEA_CANDIDATES_SCHEMA_MAX, MIN_EXPERIMENT_WARN_CHARS, PAGE_DRAFT_MAX, TARGET_PROBLEM_MIN_CHARS } from './values'
import { IDEA_CARD_FIELDS, IDEA_TYPE_TAG } from './prompts'
import { paperPageSlug } from './pageValidate'

// ---------------------------------------------------------------------------
// LLM 产出 schema（bucket 节点 generateStructured 面）
// ---------------------------------------------------------------------------

export const IDEA_CARD_SCHEMA = z
  .object({
    idea_id: z.string().max(64).optional(),
    title: z.string().max(PAGE_DRAFT_MAX.titleChars).optional(),
    one_sentence_hypothesis: z.string().optional(),
    anchor_sources: z.array(z.string().min(1)).max(IDEA_ANCHORS_MAX * 2).optional(),
    target_problem: z.string().optional(),
    mechanism: z.string().optional(),
    paper_insight_or_limitation: z.string().optional(),
    evidence_chain: z.array(z.string().min(1)).max(PAGE_DRAFT_MAX.evidencePerClaim).optional(),
    minimum_experiment: z.string().optional(),
    expected_metric_change: z.string().optional(),
    implementation_scope: z.string().optional(),
    risks: z.string().optional(),
    confidence: z.string().max(64).optional(),
    recommendation_reason: z.string().optional(),
    wiki_writeback: z.string().optional(),
  })
  .strict()

// 桶节点批量产出面（每桶 1–3 张候选卡；schema 宽容上限 = IDEA_CANDIDATES_SCHEMA_MAX——
// 超量不直拒，卡数上界由 hypothesize.dedupNode 的 CHALLENGE_CARDS_MAX 截断承载）。
export const IDEA_CARDS_SCHEMA = z
  .object({
    cards: z.array(IDEA_CARD_SCHEMA).max(IDEA_CANDIDATES_SCHEMA_MAX).optional(),
  })
  .strict()

// challenge 节点 verdict schema（853 §4.3 · brainstorm main 反驳门禁三字段——
// challenge / verdict: rejected|survived / verdict_reason；判据在 prompt，schema 只锁枚举）。
export const CHALLENGE_SCHEMA = z
  .object({
    challenge: z.string().min(1),
    verdict: z.enum(['rejected', 'survived']),
    verdict_reason: z.string().min(1),
  })
  .strict()

export type IdeaCard = z.infer<typeof IDEA_CARD_SCHEMA>

// ---------------------------------------------------------------------------
// dedup（idea_dedup.py 同构）
// ---------------------------------------------------------------------------

// norm：小写 + 空白折叠（py " ".join(str.lower().split()) 同语义）。
export const normKeyPart = (v: unknown): string =>
  String(v ?? '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((s) => s !== '')
    .join(' ')

// 键 = (norm(title), norm(mechanism), norm(minimum_experiment))——853 §4.3 钉面。
export const ideaDedupKey = (card: IdeaCard): string =>
  JSON.stringify([normKeyPart(card.title), normKeyPart(card.mechanism), normKeyPart(card.minimum_experiment)])

// evidence_chain 总长（py evidence_len：list = Σlen(str(x))；其他 = len(str(v or ''))）。
export function evidenceChainLen(card: IdeaCard): number {
  const ev = card.evidence_chain
  if (Array.isArray(ev)) return ev.reduce((sum, x) => sum + String(x).length, 0)
  return ev == null ? 0 : String(ev).length
}

// 同键保留 evidence_chain 总长更长者；等长保留先到者（py `>` 严格大于语义）；输出序 =
// 首现插入序（py dict 语义——值替换不移位）。语义去重不在本函数（并入 challenge 输入，
// 853 §4.3「语义去重并入 challenge 输入」——反驳门禁含「已有工作已覆盖」判据）。
export function dedupIdeaCards(cards: readonly IdeaCard[]): IdeaCard[] {
  const byKey = new Map<string, IdeaCard>()
  for (const card of cards) {
    const key = ideaDedupKey(card)
    const prev = byKey.get(key)
    if (prev === undefined || evidenceChainLen(card) > evidenceChainLen(prev)) {
      byKey.set(key, card)
    }
  }
  return [...byKey.values()]
}

// ---------------------------------------------------------------------------
// validate（validate_idea_cards.py 规则全集逐条迁移 · #848 §3.3）
// ---------------------------------------------------------------------------

// 14 必填（py REQUIRED_FIELDS——wiki_writeback 为第 15 条件字段，不在列）。
// 单源派生：IDEA_CARD_FIELDS（prompts.ts，15 字段模板）− wiki_writeback——校验清单与
// prompt 模板同源，防双表漂移（W2 *_SECTIONS 先例同构）。
export const IDEA_REQUIRED_FIELDS = IDEA_CARD_FIELDS.filter((f) => f !== 'wiki_writeback')

const isEmptyValue = (v: unknown): boolean => {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  return false
}

// 泛化锚黑名单（py GENERIC_ANCHOR_TERMS 精确匹配集）。
const GENERIC_ANCHOR_TERMS = new Set([
  'paper',
  'papers',
  'wiki',
  'literature',
  'related work',
  'survey',
  'domain',
  'field',
  'area',
  'federated learning literature',
  'related literature',
  'prior work',
])

// 泛化 fragment（含混即拒，除非带 concrete marker——py 双条件同构）。
const GENERIC_ANCHOR_FRAGMENTS = ['literature', 'related work', 'prior work', 'field', 'domain', 'area']

// concrete 判据 marker（命中即具体锚）。
const CONCRETE_ANCHOR_MARKERS = ['/', '.md', '.pdf', 'arxiv', 'doi', 'http', 'wiki/', 'paper:', 'title:']

// 类标题词表：全部词都落入该集 ≠ 标题（py looks_like_title 反例面）。
const CONCRETE_ANCHOR_WORDS = new Set(['paper', 'wiki', 'arxiv', 'doi', 'title'])

// P 编号锚（py PAPER_ID_RE ^p\d{1,3}$ ignorecase）。
const PAPER_ID_RE = /^p\d{1,3}$/i

// 痛点具体度 marker（py CONCRETE_PROBLEM_MARKERS 全量：机制/评测/局限双语面）。
const CONCRETE_PROBLEM_MARKERS = [
  'mechanism',
  'module',
  'dataset',
  'metric',
  'baseline',
  'ablation',
  'setting',
  'split',
  'boundary',
  'failure',
  'limitation',
  'claim',
  'experiment',
  'benchmark',
  'evaluation',
  'noise',
  'robust',
  '泛化',
  '鲁棒',
  '基准',
  '指标',
  '数据集',
  '机制',
  '模块',
  '消融',
  '边界',
  '失败',
  '限制',
  '实验',
]

// anchor_items（py 同构）：list 取非空 trim 项；单字符串非空 → 单项；其余空。
function anchorItems(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((s) => s !== '')
  if (typeof v === 'string' && v.trim() !== '') return [v.trim()]
  return []
}

function hasGenericAnchor(anchors: readonly string[]): boolean {
  for (const anchor of anchors) {
    const normalized = normKeyPart(anchor)
    if (GENERIC_ANCHOR_TERMS.has(normalized)) return true
    if (
      GENERIC_ANCHOR_FRAGMENTS.some((f) => normalized.includes(f)) &&
      !CONCRETE_ANCHOR_MARKERS.some((m) => normalized.includes(m))
    ) {
      return true
    }
  }
  return false
}

// py \W+ 分词 unicode 语义（\w = 字母/数字/下划线，CJK 算词字符）。
const splitWords = (s: string): string[] => s.trim().split(/[^\p{L}\p{N}_]+/u).filter((w) => w !== '')

function looksLikeTitle(anchor: string): boolean {
  const words = splitWords(anchor)
  if (words.length < 3) return false
  return !words.every((w) => CONCRETE_ANCHOR_WORDS.has(w.toLowerCase()))
}

function isConcreteAnchor(anchor: string): boolean {
  const lowered = anchor.toLowerCase()
  return PAPER_ID_RE.test(anchor.trim()) || CONCRETE_ANCHOR_MARKERS.some((m) => lowered.includes(m)) || looksLikeTitle(anchor)
}

function hasWikiAnchor(anchors: readonly string[]): boolean {
  return anchors.some((a) => {
    const lowered = a.toLowerCase()
    return (
      lowered.includes('wiki') ||
      lowered.endsWith('.md') ||
      // 本仓库写面 rel 域无前导斜杠（graph.ts toWikiRelPath 约定）——papers/ 前缀锚同属
      // wiki 源（py 原判据 '/papers/' 覆盖带斜杠形态，前缀判据补本仓库路径域）。
      lowered.includes('/papers/') ||
      lowered.startsWith('papers/') ||
      lowered.includes('/domains/')
    )
  })
}

function describesConcreteProblem(text: string): boolean {
  const lowered = text.toLowerCase()
  return text.length >= TARGET_PROBLEM_MIN_CHARS && CONCRETE_PROBLEM_MARKERS.some((m) => lowered.includes(m))
}

export interface IdeaCardValidation {
  readonly cardIndex: number
  /** 非空 = 该卡淘汰（validate 阶段拒因，进 summary 不静默）。 */
  readonly errors: readonly string[]
  /** 非空不阻断（记录进 summary）。 */
  readonly warnings: readonly string[]
}

// 规则全集逐条（py validate 同构；诊断 = `${idea_id}: <中文规则文案>`，label 缺省 idea[i]）。
export function validateIdeaCards(cards: readonly IdeaCard[]): readonly IdeaCardValidation[] {
  return cards.map((card, idx) => {
    const errors: string[] = []
    const warnings: string[] = []
    const label = card.idea_id?.trim() !== '' && card.idea_id !== undefined ? card.idea_id! : `idea[${idx + 1}]`
    const pushError = (msg: string) => errors.push(`${label}: ${msg}`)

    for (const field of IDEA_REQUIRED_FIELDS) {
      if (!(field in card) || isEmptyValue(card[field as keyof IdeaCard])) {
        pushError(`缺少必填字段 ${field}（14 必填全量之一，validate_idea_cards.py 规则 1）`)
      }
    }

    // 规则 2：evidence_chain 空须 low-confidence（py `is_empty(evidence) and "low" not in confidence`）。
    const confidence = String(card.confidence ?? '').toLowerCase()
    if (isEmptyValue(card.evidence_chain) && !confidence.includes('low')) {
      pushError('evidence_chain 为空时必须标记 low-confidence（弱支撑明示义务）')
    }

    const anchors = anchorItems(card.anchor_sources)
    if (anchors.length === 0) {
      pushError('anchor_sources 必须点名具体论文/wiki 来源（不得为空）')
    }
    if (anchors.length > IDEA_ANCHORS_MAX) {
      pushError(`anchor_sources 须为 1 个来源或同型集群 2–4 个来源（当前 ${anchors.length} 个）`)
    }
    if (hasGenericAnchor(anchors)) {
      pushError('anchor_sources 不得为泛化领域标签（GENERIC_ANCHOR_TERMS/FRAGMENTS 黑名单命中且无可判定 marker）')
    }
    if (anchors.length > 0 && !anchors.every(isConcreteAnchor)) {
      pushError('anchor_sources 每项必须是具体锚：P 编号 / 含路径·DOI·arXiv·http marker / 类标题短语')
    }
    if (hasWikiAnchor(anchors) && isEmptyValue(card.wiki_writeback)) {
      pushError('锚含 wiki 源（wiki/.md//papers/）时必须填写 wiki_writeback（回写义务）')
    }

    const targetProblem = String(card.target_problem ?? '').trim()
    if (!describesConcreteProblem(targetProblem)) {
      pushError(
        `target_problem 必须描述具体机制/评测/局限痛点（≥${TARGET_PROBLEM_MIN_CHARS} 字符且命中 CONCRETE_PROBLEM_MARKERS 之一）`,
      )
    }

    // 规则 8：minimum_experiment 过短 = warning（py warnings 面，非 error）。
    if (String(card.minimum_experiment ?? '').length < MIN_EXPERIMENT_WARN_CHARS) {
      warnings.push(`${label}: minimum_experiment 疑似过短（<${MIN_EXPERIMENT_WARN_CHARS} 字符）——须可执行的最小验证`)
    }

    return { cardIndex: idx, errors, warnings }
  })
}

// ---------------------------------------------------------------------------
// persist 渲染面（页格式单源：模板 ↔ 校验同源渲染先例，prompts.ts checklist 锁节结构）
// ---------------------------------------------------------------------------

// idea card 页 slug（wiki-conventions kebab-case 单源 = paperPageSlug；换名防语义混用）。
export const ideaCardSlug = (title: string): string => paperPageSlug(title)

// 卡 → wiki 页正文（15 字段模板渲染；首行 H1 = 卡标题，之下空一行机读标签——#848 §0
// 「`type: hypothesis` 独占一行」约定，同 critic 页机读标签先例）。
// 字段区包 `## Idea Card Fields` H2 节（#912 补钉——openwiki 读面契约：页须 ≥1 节锚
// 才可 readPage 读内容；无节页消费断链（W4 preflight 提取 minimum_experiment 入映射池、
// design/spec prompt 输入材料）。W3 页形断言（H1 开头/标签位置）不受影响。
export function renderIdeaCardPage(card: IdeaCard): string {
  const field = (name: string, v: unknown): string => {
    if (Array.isArray(v)) return `${name}:\n${v.map((x) => `  - ${x}`).join('\n')}`
    return `${name}: ${String(v ?? '')}`
  }
  return [
    `# ${card.title ?? '未命名假说'}`,
    '',
    IDEA_TYPE_TAG,
    '',
    '## Idea Card Fields',
    '',
    field('idea_id', card.idea_id),
    field('one_sentence_hypothesis', card.one_sentence_hypothesis),
    field('anchor_sources', card.anchor_sources ?? []),
    field('target_problem', card.target_problem),
    field('mechanism', card.mechanism),
    field('paper_insight_or_limitation', card.paper_insight_or_limitation),
    field('evidence_chain', card.evidence_chain ?? []),
    field('minimum_experiment', card.minimum_experiment),
    field('expected_metric_change', card.expected_metric_change),
    field('implementation_scope', card.implementation_scope),
    field('risks', card.risks),
    field('confidence', card.confidence),
    field('recommendation_reason', card.recommendation_reason),
    field('wiki_writeback', card.wiki_writeback ?? ''),
    '',
  ].join('\n')
}
