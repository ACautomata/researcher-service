// research 测试共享件（PR #917 review S14/S26 归口）：合法产物 fixture + openwiki 保真
// wiki fake + schema 形状判定 llm fake。
//
// wiki fake 锁真实检索契约（openwiki 0.6.1 语义，PR #917 review P0 fake 保真度修复）：
// - readPage 路径域强制 openwiki/ 前缀 + .md 后缀（否则 invalid_input——normalizeWikiPagePath）；
// - 页缺失 → not_found（ClaimsPageMissingError 映射）；缺节锚 → invalid_input（Unknown sections）；
// - 空 sections 数组 → invalid_input（Provide at least one section anchor）；
// - section content = 自 heading 行起的 raw 切片；createPage 吃写面 rel 路径直存（页已存在
//   → created:false 幂等哨兵）；search ref 带 openwiki/ 虚拟前缀。
import { vi } from 'vitest'
import { headingAnchor, PAPER_PAGE_SECTIONS, EXTRACT_SECTIONS, CRITIC_SECTIONS, DESIGN_SECTIONS, SPEC_SECTIONS } from '../../plugins/research/prompts'
import type { PluginLlmPort, PluginWikiPort } from '../src/plugins/api'

// ---------------------------------------------------------------------------
// wiki fake（openwiki 保真）
// ---------------------------------------------------------------------------

// markdown 正文 → H2 节锚表（headingSections GitHub slug 同语义简化：`## <标题>` 行起至
// 下一 heading 行，锚 = headingAnchor(标题文本)；H1 行只作边界不作节）。
export function sectionsOf(body: string): Map<string, string> {
  const lines = body.split('\n')
  const heads = lines.map((l, i) => (l.startsWith('#') ? i : -1)).filter((i) => i >= 0)
  const sections = new Map<string, string>()
  heads.forEach((start, k) => {
    if (!lines[start]!.startsWith('## ')) return
    const heading = lines[start]!.replace(/^##\s*/, '')
    const end = k + 1 < heads.length ? heads[k + 1]! : lines.length
    sections.set(headingAnchor(heading), lines.slice(start, end).join('\n'))
  })
  return sections
}

export interface WikiFake {
  readonly wiki: PluginWikiPort
  /** 写面 rel 路径 → 正文（createPage 直存 draft.content）；测试预置页面/断言写入两用。 */
  readonly pages: Map<string, string>
  readonly createPage: ReturnType<typeof vi.fn>
  readonly readPage: ReturnType<typeof vi.fn>
  readonly search: ReturnType<typeof vi.fn>
}

export function createWikiFake(initial: Record<string, string> = {}): WikiFake {
  const pages = new Map(Object.entries(initial))
  const search = vi.fn(async (_query: string, _opts?: { limit?: number; paths?: readonly string[] }) => ({
    ok: true as const,
    data: {
      results: [...pages.entries()].map(([rel, body]) => {
        const [anchor, raw] = [...sectionsOf(body).entries()][0] ?? ['', '']
        return { kind: 'section' as const, ref: [`openwiki/${rel}#${anchor}`], content: raw.slice(0, 200) }
      }),
    },
  }))
  const readPage = vi.fn(async (page: string, sections: readonly string[]) => {
    if (!page.startsWith('openwiki/') || !page.endsWith('.md')) {
      return {
        ok: false as const,
        error: { code: 'invalid_input' as const, message: 'Page must be a non-structural Markdown path below openwiki/.' },
      }
    }
    const body = pages.get(page.slice('openwiki/'.length))
    if (body === undefined) {
      return { ok: false as const, error: { code: 'not_found' as const, message: 'The requested wiki page does not exist.' } }
    }
    if (sections.length === 0) {
      return { ok: false as const, error: { code: 'invalid_input' as const, message: 'Provide at least one section anchor.' } }
    }
    const available = sectionsOf(body)
    const missing = sections.filter((s) => !available.has(s))
    if (missing.length > 0) {
      return { ok: false as const, error: { code: 'invalid_input' as const, message: `Unknown sections: ${missing.join(', ')}` } }
    }
    return {
      ok: true as const,
      data: { page, sections: sections.map((s) => ({ section: s, content: available.get(s)! })) },
    }
  })
  const createPage = vi.fn(async (draft: { path: string; content: string }) => {
    if (pages.has(draft.path)) return { ok: true as const, data: { created: false } }
    pages.set(draft.path, draft.content)
    return { ok: true as const, data: { created: true } }
  })
  return { wiki: { search, readPage, createPage } as unknown as PluginWikiPort, pages, createPage, readPage, search }
}

// ---------------------------------------------------------------------------
// llm fake（extract/critic slot 按 schema 形状判定——CRITIC_DOC_SCHEMA 有 candidates 键，
// 对重试链正确；#911 增 brief/bucket/challenge 三 slot：research_topic / cards / verdict 键）
// ---------------------------------------------------------------------------

export type SlotName = 'extract' | 'critic' | 'brief' | 'bucket' | 'challenge' | 'design' | 'spec' | 'audit' | 'report'
export interface SlotLlm extends PluginLlmPort {
  readonly calls: { slot: SlotName; prompt: string }[]
}

const slotOf = (shape: Record<string, unknown> | undefined): SlotName => {
  if (shape?.verdict !== undefined) return 'challenge'
  if (shape?.cards !== undefined) return 'bucket'
  if (shape?.research_topic !== undefined) return 'brief'
  if (shape?.report !== undefined) return 'audit'
  if (shape?.deliverables !== undefined) return 'spec'
  if (shape?.experiments !== undefined) return 'design'
  if (shape?.title !== undefined && shape?.content !== undefined) return 'report'
  return shape?.candidates !== undefined ? 'critic' : 'extract'
}

export function createSlotLlm(handlers: {
  extract?: () => unknown
  critic?: () => unknown
  brief?: () => unknown
  /** bucket 名可从 prompt 的「你的机会桶：<bucket>」行提取（per-bucket 行为用例）。 */
  bucket?: (prompt: string) => unknown
  /** 待反驳卡 JSON 在 prompt 的 <card> 块内。 */
  challenge?: (prompt: string) => unknown
  /** W4 design：修订模式输入在 <revision> 块（上轮 spec + 用户理由）。 */
  design?: (prompt: string) => unknown
  spec?: (prompt: string) => unknown
  audit?: (prompt: string) => unknown
  /** W4 collect 报告页：{title, content} 形状。 */
  report?: (prompt: string) => unknown
}): SlotLlm {
  const calls: { slot: SlotName; prompt: string }[] = []
  const generateMultimodal = vi.fn(async () => ({ text: '' }))
  const generateStructured = vi.fn(
    async (opts: { schema: { parse: (v: unknown) => unknown; shape?: Record<string, unknown> }; contents: readonly unknown[] }) => {
      const slot = slotOf(opts.schema.shape)
      const prompt = String(opts.contents[0])
      calls.push({ slot, prompt })
      const value =
        slot === 'challenge'
          ? (handlers.challenge?.(prompt) ?? { challenge: '未找到基于现有证据和约束的致命反驳', verdict: 'survived', verdict_reason: '核心假设可检验且证据可追溯。' })
          : slot === 'bucket'
            ? (handlers.bucket?.(prompt) ?? { cards: [] })
            : slot === 'brief'
              ? (handlers.brief?.() ?? validBrief())
              : slot === 'audit'
                ? (handlers.audit?.(prompt) ?? validAuditVerdict())
                : slot === 'report'
                  ? (handlers.report?.(prompt) ?? validExperimentReport())
                  : slot === 'spec'
                  ? (handlers.spec?.(prompt) ?? validSpecDoc())
                  : slot === 'design'
                    ? (handlers.design?.(prompt) ?? validDesignDoc())
                    : slot === 'critic'
                      ? (handlers.critic?.() ?? validCriticDoc())
                      : (handlers.extract?.() ?? validExtractDoc())
      return opts.schema.parse(value)
    },
  )
  return { generateMultimodal, generateStructured, calls } as unknown as SlotLlm
}

// ---------------------------------------------------------------------------
// 合法产物 fixture（跨测试文件单源，PR #917 review S26）
// ---------------------------------------------------------------------------

export const PAPER_PATH = 'papers/robust-out-of-distribution-detection.md'

// 11 节论文页正文（无行数门禁压力的骨架形——load/verify 消费面）。
export const paperPageBody = (): string =>
  PAPER_PAGE_SECTIONS.map((s, i) => `## ${i + 1} ${s}\n\n第 ${i + 1} 节。AUROC 95.12% vs. MCM 86.05%，FPR95 8.56。`).join('\n\n')

// ≥100 行合法论文页（validate 门禁通过形）。
export const validPaperPage = (): {
  title: string
  content: string
  claims: { statement: string; evidence: string[] }[]
} => ({
  title: 'Robust Out-of-Distribution Detection',
  content: [
    ...PAPER_PAGE_SECTIONS.map((s, i) => `## ${i + 1} ${s}\n\n第 ${i + 1} 节。AUROC 95.12% vs. MCM 86.05%，FPR95 8.56。`),
    ...Array.from({ length: 100 }, (_, i) => `填充行 ${i}：实验设置与结论细节。`),
  ].join('\n\n'),
  claims: [{ statement: '该方法在 CIFAR-100 上 AUROC 达 95.12%', evidence: ['论文 §6 Table 2'] }],
})

export const validExtractDoc = (): { content: string } => ({
  content: EXTRACT_SECTIONS.map((s, i) => `## ${i} ${s}\n\n论文报告：主结果 AUROC 95.12%。论文中未明确说明处如实标注。`).join('\n\n'),
})

export const defaultCriticCandidates = (paperPath: string = PAPER_PATH) => [
  { question: '消融是否覆盖核心组件？', priority: 'high' as const, evidence: [`${paperPath}#6 Results`] },
  { question: '跨模态泛化证据是否充分？', priority: 'medium' as const, evidence: [`${paperPath}#7 Limitations`] },
]

export const validCriticDoc = (
  candidates: { question: string; priority: 'high' | 'medium' | 'low'; evidence?: string[] }[] = defaultCriticCandidates(),
) => ({
  content: ['# 某论文审稿式问题分析', '', '`category: critic`', '', ...CRITIC_SECTIONS.map((s, i) => `## ${i} ${s}\n\n已有较强证据支持：具体质疑。`)].join('\n'),
  candidates,
})

// ---------------------------------------------------------------------------
// W3 合法产物 fixture（#911）：Brief 10 字段（全填，免 ASSUMPTION 面噪声）+ idea card
// 全字段合法卡（每 validate 规则恰好通过的边界形，同 researchIdeaCards.test 口径）。
// ---------------------------------------------------------------------------

export const validBrief = () => ({
  research_topic: '分布外检测（OOD detection）',
  target_task: '图像分类的 OOD 检测',
  current_baseline: 'MCM',
  available_data: 'CIFAR-10/100，ImageNet-200',
  available_code: 'baseline 官方实现可改推理侧',
  available_compute: '单卡 A100，24h 预算',
  preferred_metrics: 'AUROC / FPR95',
  hard_constraints: '不动训练流程',
  known_failures: '温度缩放在 OOD 样本上失效',
  desired_risk_level: 'medium-risk',
})

export const validIdeaCard = (over: Record<string, unknown> = {}) => ({
  idea_id: 'P01-G1',
  title: '基于能量分数的 OOD 判据改进',
  one_sentence_hypothesis: '用能量分数替代 softmax 置信度可提升 OOD 检测的 AUROC。',
  anchor_sources: ['papers/robust-out-of-distribution-detection.md#7 Limitations'],
  target_problem: '现有方法的置信度校准机制在分布外样本上显著失效，导致误判率升高',
  mechanism: '引入能量函数重新打分并校准阈值。',
  paper_insight_or_limitation: '论文指出温度缩放对 OOD 样本不适用。',
  evidence_chain: ['papers/robust-out-of-distribution-detection.md#7 Limitations', '论文 §6 Table 2'],
  minimum_experiment: '在 CIFAR-100 上复现 baseline 并替换打分函数，对比 AUROC/FPR95。',
  expected_metric_change: 'AUROC +2.0，FPR95 −1.5。',
  implementation_scope: '仅改推理打分与阈值选择，不动训练。',
  risks: '能量分数对超参敏感，可能需要重新调温。',
  confidence: 'medium',
  recommendation_reason: '动机直接来自论文 limitation，实验改动小。',
  wiki_writeback: 'papers/robust-out-of-distribution-detection.md#7 Limitations 可补记该改进方向。',
  ...over,
})

// ---------------------------------------------------------------------------
// W4 合法产物 fixture（#912）：design 10 节 + spec 9 段边界形（校验清单恰好通过的
// 骨架——节标题逐字、字段非空、无禁语、无可推断占位符）。
// ---------------------------------------------------------------------------

export const DESIGN_EXPERIMENTS = [
  { name: '消融覆盖审计', validation_target: '消融是否覆盖核心组件？', expected_outcome: '定位核心组件贡献。' },
  { name: '跨模态验证', validation_target: '跨模态泛化证据是否充分？', expected_outcome: '获得跨模态 AUROC。' },
]

export const SPEC_DELIVERABLES = [
  { path: '/lab/results/ablation.json', success_criterion: '含各组件消融 AUROC 数字' },
  { path: '/lab/results/cross-modal.csv', success_criterion: '每行一个模态的评估结果' },
]

const designSectionsBody = () =>
  [
    ...DESIGN_SECTIONS.map((s, i) => `## ${i} ${s}\n\n实验设计内容，服务明确的验证目标。`),
  ].join('\n')

const specSectionsBody = () =>
  [
    ...SPEC_SECTIONS.map((s, i) => `## ${i + 1} ${s}\n\n规格内容，工程化可执行。`),
  ].join('\n')

export const validDesignDoc = (): { content: string; experiments: typeof DESIGN_EXPERIMENTS } => ({
  content: designSectionsBody(),
  experiments: DESIGN_EXPERIMENTS,
})

export const validSpecDoc = (): { content: string; deliverables: typeof SPEC_DELIVERABLES } => ({
  content: specSectionsBody(),
  deliverables: SPEC_DELIVERABLES,
})

// W4 audit LLM 三维（③边界遵守/⑤证据分级/⑥跨阶段一致性）合法产出——blocking 空
// （必须修复项非空 → 该调用 fail 不进人审的反向面）。
export const validAuditVerdict = (over: Record<string, unknown> = {}) => ({
  report: ['# 方案审计报告', '', ...['评估元信息', '总览', '逐阶段详细评估', '跨阶段一致性问题', '必须修复项', '建议改进项', '总体评估'].map((s, i) => `## ${i} ${s}\n\n评估内容。`)].join('\n'),
  blocking: [] as string[],
  suggestions: [] as string[],
  ...over,
})

// ---------------------------------------------------------------------------
// W4 输入页 fixture（#912）：critic 页（## 节形态——preflight 提取 §4 候选问题入映射池）
// 与 idea card 页（## Idea Card Fields 节——提取 minimum_experiment 行）。
// ---------------------------------------------------------------------------

export const CRITIC_PATH = 'critics/robust-out-of-distribution-detection.md'
export const IDEA_CARD_PATH = 'idea-cards/energy-score-ood.md'

export const validCriticPage = (over: Record<string, unknown> = {}) =>
  renderCriticPage({ candidates: defaultCriticCandidates(), ...over })

// critic 页正文 = H1 + 机读标签 + §0–§7 节（§4 候选问题列表——W4 映射池消费面）。
function renderCriticPage(input: { candidates: { question: string; priority: string; evidence: string[] }[] }): string {
  const sec4 = [
    '## 4 验证候选问题与优先级',
    '',
    ...input.candidates.map((c, i) => `${i + 1}. **${c.question}**（优先级：${c.priority}）——依据：${c.evidence.join('、') || '见前文分析'}`),
  ].join('\n')
  return [
    '# 某论文审稿式问题分析',
    '',
    '`category: critic`',
    '',
    ...CRITIC_SECTIONS.map((s, i) => (i === 4 ? sec4 : `## ${i} ${s}\n\n具体分析内容。`)),
  ].join('\n\n')
}

// idea card 页正文（renderIdeaCardPage 同款渲染的最小合法形——fields 节 + minimum_experiment 行）。
export const validIdeaCardPage = (): string =>
  [
    '# 基于能量分数的 OOD 判据改进',
    '',
    '`category: idea`',
    '',
    '## Idea Card Fields',
    '',
    'idea_id: P01-G1',
    'minimum_experiment: 在 CIFAR-100 上复现 baseline 并替换打分函数，对比 AUROC/FPR95。',
    'confidence: medium',
    '',
  ].join('\n')

// W4 collect 段合法产出（#912）：实验报告页 {title, content}（content 从 ## 实验目标
// 开始——H1/机读标签归 persist 面确定性组装）。
export const validExperimentReport = (over: Record<string, unknown> = {}) => ({
  title: '实验报告：验证能量分数判据',
  content: [
    '## 实验目标',
    '',
    '验证能量分数判据对 OOD 检测 AUROC 的提升。',
    '## 执行摘要',
    '',
    '复现 baseline 并替换打分函数。',
    '## 交付物对账',
    '',
    '逐件对账记录。',
    '## 结果与观察',
    '',
    'AUROC 95.12 → 96.83。',
    '## 结论与建议',
    '',
    '验证目标成立，建议扩大样本。',
  ].join('\n'),
  ...over,
})

// lab port fake（W4 短路点/落盘/persist 消费面）：files = 沙箱绝对路径表；
export interface LabFake {
  readonly lab: import('../src/plugins/api').PluginLabPort
  readonly files: Map<string, string>
  readonly write: ReturnType<typeof vi.fn>
  readonly read: ReturnType<typeof vi.fn>
}

export function createLabFake(initial: Record<string, string> = {}): LabFake {
  const files = new Map(Object.entries(initial))
  const write = vi.fn(async (input: { path: string; content: string }) => {
    if (!input.path.startsWith('/lab/specs/')) {
      return { ok: false as const, error: { code: 'invalid_path' as const, message: 'lab write 仅允许 /lab/specs/ 前缀路径' } }
    }
    files.set(input.path, input.content)
    return { ok: true as const, data: { written: true as const } }
  })
  const read = vi.fn(async (input: { path: string }) => {
    if (!input.path.startsWith('/lab/')) {
      return { ok: false as const, error: { code: 'invalid_path' as const, message: '须为 /lab/ 前缀路径' } }
    }
    const content = files.get(input.path)
    if (content === undefined) {
      return { ok: false as const, error: { code: 'not_found' as const, message: `文件不存在: ${input.path}` } }
    }
    return { ok: true as const, data: { content } }
  })
  return { lab: { read, write } as unknown as import('../src/plugins/api').PluginLabPort, files, write, read }
}
