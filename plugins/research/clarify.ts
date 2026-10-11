// clarify Result 两形态模板（853 §1.3 · #866 §6 交付文本面 · #909 生产化）。
// 分类 none 或 confidence < MIN_CONFIDENCE → 工具返回 {status:'clarify', candidates,
// question} 作 content 回喂主 agent，主 agent 自然语言反问；零新 interrupt 机制。
// question 面向主 agent 指令性引导（最终用户文案由主 agent 组织）；命令路径恒带 workflow
// 永不触发兜底（seed 透传面，853 §1.3）。

import { MIN_CONFIDENCE } from './values'

// 四流程目录（candidates 元素准据）：ingest 知识库深度构建 / discover 科学问题可信发现 /
// hypothesize 科学假说自主生成 / experiment 实验自主设计与执行（853 §1.3 拍板文案）。
export const WORKFLOW_CATALOG = [
  { label: 'ingest', name: '知识库深度构建', fit: '把论文/文档精读整理入库 wiki' },
  { label: 'discover', name: '科学问题可信发现', fit: '从一篇已有论文审稿式找出问题与研究缺口' },
  { label: 'hypothesize', name: '科学假说自主生成', fit: '生成新的研究想法、方向与假说' },
  { label: 'experiment', name: '实验自主设计与执行', fit: '为明确的问题/想法设计验证实验并真实执行' },
] as const

export type WorkflowLabel = (typeof WORKFLOW_CATALOG)[number]['label']

// 拒识出口（853 §1.2）：与前四者并列进 5 值分类枚举，但不属流程目录。
export const INTENT_LABELS = ['ingest', 'discover', 'hypothesize', 'experiment', 'none'] as const
export type IntentLabel = (typeof INTENT_LABELS)[number]

export const CLARIFY_QUESTION_LOW_CONFIDENCE =
  '用户的请求语义不够明确。请向用户列出以下候选工作流（名称 + 适用场景），请其选择其一或补充说明需求：'

export const CLARIFY_QUESTION_NONE =
  '用户的请求不属于科研工作流工具支持的四个流程（知识库深度构建 / 科学问题可信发现 / 科学假说自主生成 / 实验自主设计与执行）。请如实告知用户这一点，请其改述需求，或直接在对话中回答其问题。'

export interface ClarifyCandidate {
  readonly label: WorkflowLabel
  readonly name: string
  readonly fit: string
}

export interface ClarifyResult {
  readonly status: 'clarify'
  readonly candidates: readonly ClarifyCandidate[]
  readonly question: string
}

// 分类产物面（classifier.ts INTENT_SCHEMA 的 zod 产物同形）。
export interface IntentVerdict {
  readonly label: IntentLabel
  readonly confidence: number
  /** 分类器的次可能标签（853 §1.3 Top-2 的第二名 · #850 D17 多意图后续面）：低置信 =
   *  clarify Top-2 候选第二名；高置信 = 多意图尾注信号。省略 = 目录中非主选首项兜底。 */
  readonly secondaryIntent?: WorkflowLabel
}

const catalogOf = (label: WorkflowLabel): ClarifyCandidate => {
  const entry = WORKFLOW_CATALOG.find((c) => c.label === label)
  // secondaryIntent 枚举已锁四流程值；本分支理论不可达（防御类型收窄）。
  if (!entry) throw new Error(`workflow catalog missing label: ${label}`)
  return { label: entry.label, name: entry.name, fit: entry.fit }
}

// 两形态模板构造：none = 空候选 + 如实拒识；低置信 = Top-2 候选 + 指令性引导。阈值判定
// 与 none 判定在图内 classifyNode（isAccepted，S3 单测锁），本函数只管形态。
// 降级形态：分类器未给 secondaryIntent 时如实出 Top-1 单候选——不硬凑第二个「候选」
//（853 §1.3「置信 Top-2」的前提是分类器的次可能输出，缺数据不伪造）。
export function buildClarifyResult(verdict: IntentVerdict): ClarifyResult {
  if (verdict.label === 'none') {
    return { status: 'clarify', candidates: [], question: CLARIFY_QUESTION_NONE }
  }
  const primary = catalogOf(verdict.label)
  const candidates =
    verdict.secondaryIntent !== undefined ? [primary, catalogOf(verdict.secondaryIntent)] : [primary]
  return { status: 'clarify', candidates, question: CLARIFY_QUESTION_LOW_CONFIDENCE }
}

// 放行判定（853 §1.2 阈值语义单点）：label ≠ none 且 conf ≥ MIN_CONFIDENCE 才路由分支；
// type guard 兼做窄化（分类产物 → 四流程 label）。图内 classifyNode 与测试共用。
export function isAccepted(
  verdict: Pick<IntentVerdict, 'label' | 'confidence'>,
): verdict is IntentVerdict & { readonly label: WorkflowLabel } {
  return verdict.label !== 'none' && verdict.confidence >= MIN_CONFIDENCE
}
