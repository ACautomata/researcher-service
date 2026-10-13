// research 流程 prompt 模板资产（#910 · 单一来源 = #848 决议 §1–§2，853 §4.1–§4.2 钉）。
//
// 移植纪律（853 §9）：prompt 验收 = 节结构 checklist 断言，非 golden 全文对照（LLM prompt
// 非确定性输出）。节结构清单（*_SECTIONS）是「模板 ↔ 确定性校验」共用单源——校验清单
//（pageValidate.ts）与模板正文（本文件）从同一数组渲染，防双表漂移。
//
// 注入形态对标 officialContent 两段式（模板正文 + 逐节填写规则分层）：单发节点无渐进披露
// 工具面（853 §10 宽口径否决——四流程中间节点全部维持单发），故两段合并一次性注入。
//
// 语言约定（#848 §0）：wiki 正文中文；论文元数据（标题/作者/DOI/arXiv/代码链接）保留原文。

import { CRITIC_CANDIDATES_MAX, CRITIC_CANDIDATES_MIN, IDEA_CANDIDATES_MAX, IDEA_CANDIDATES_MIN, PAPER_PAGE_MIN_LINES } from './values'
import type { BucketName } from './values'
import { BRIEF_FIELDS } from './contextPack'

// ---------------------------------------------------------------------------
// 节结构清单（校验 ↔ 模板单源）
// ---------------------------------------------------------------------------

// W1 11 节论文页（#848 §1.2：ingest/references/page-templates.md）。标题英文钉死（源模板
// 资产原文），正文中文。
export const PAPER_PAGE_SECTIONS = [
  'Citation',
  'One-Sentence Contribution',
  'Problem Setting',
  'Method',
  'Experiments',
  'Results',
  'Limitations',
  'Reusable Claims',
  'Connections',
  'Open Questions',
  'Provenance',
] as const

// W2 extract 12 节（#848 §2.1：##0 定位 … ##11 总结）。
export const EXTRACT_SECTIONS = [
  '文档定位',
  '实验目标与作者想验证的核心结论',
  '实验设置总览',
  '主结果提取',
  '消融实验提取',
  '参数敏感性与稳定性分析',
  '效率、复杂度与资源代价',
  '鲁棒性、泛化性与补充实验',
  '值得关注的实验现象',
  '证据充分性整理',
  '对后续问题发现最有价值的实验信息',
  '一段简短总结',
] as const

// W2 critic §0–§7（#848 §2.2）。
export const CRITIC_SECTIONS = [
  '文档定位',
  '方法机制、实验支撑与关键前提',
  '核心贡献声明与审稿式质疑',
  '潜在问题分析',
  '验证候选问题与优先级',
  '可能形成的研究空缺方向',
  '新增来源与 Wiki 回写建议',
  '简短结论',
] as const

// extract 三态标注（#848 §2：论文报告 / 间接观察 / 未提供）与规范用语。
export const EXTRACT_EVIDENCE_TERMS = '论文报告 / 间接观察 / 未提供'
export const EXTRACT_UNSTATED_PHRASE = '论文中未明确说明'
// 禁语（audit 维度 4 同款黑名单，853 §4.2 validate¹）。
export const EXTRACT_BANNED_PHRASES = ['可能是', '应该是', '推测为'] as const

// critic 证据强度三档（#848 §2.2）与审稿式质疑 9 类型。
export const CRITIC_STRENGTH_TIERS = '已有较强证据支持 / 实验间接暗示 / 仍需后续验证'
export const CRITIC_CHALLENGE_TYPES = [
  '创新性',
  '重要性',
  '证据充分性',
  'baseline',
  '消融',
  '泛化性',
  '鲁棒性',
  '效率与代价',
  '可复现性',
] as const

// Results 反模式锚句（#848 §1.2「禁『显著优于 baseline』类定性表述」——prompt 模板与
// validatePaperPage 诊断共用单源，PR #917 review S7 归口）。
export const QUALITATIVE_CLAIM_ANTIPATTERN = '显著优于 baseline'

// 机读标签（#848 §0：`# Title` 下空一行 inline code）。
export const CRITIC_CATEGORY_TAG = '`category: critic`'

// ---------------------------------------------------------------------------
// 论文页节锚（W1 verify 回读对账 + W2 load 读页的 readPage sections 锚）。
// 形态 = openwiki headingSlug（GitHub slug 同款：小写 / 删非字母数字下划线空白连字符 /
// 空格转 -）。节清单与模板同源派生——页形契约（模板 ↔ 校验 ↔ 锚）单一来源。
// ---------------------------------------------------------------------------

export const headingAnchor = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/ /g, '-')

export const PAPER_PAGE_ANCHORS = PAPER_PAGE_SECTIONS.map((s, i) => headingAnchor(`${i + 1} ${s}`))

const sectionLines = (sections: readonly string[], start: number): string =>
  sections.map((s, i) => `## ${i + start} ${s}`).join('\n')

const diagnosticsBlock = (diagnostics: string | undefined): string =>
  diagnostics === undefined
    ? ''
    : `\n\n---\n**上一轮产出未通过校验，请修复以下问题后重新生成（只纠格式与缺失，不改已正确的生成语义）：**\n${diagnostics}\n---\n`

// ---------------------------------------------------------------------------
// W1 create：11 节论文页生成（853 §4.1 · #848 §1）
// ---------------------------------------------------------------------------

// Experiments/Results 最低标准（#848 §1.2 原文规则，确定性校验项以 ★ 标注）。
export function buildCreatePaperPagePrompt(pages: readonly string[], diagnostics?: string): string {
  return `你是论文知识库的整页撰写者。根据给定的论文全文（按页切分），写一篇结构化论文笔记页。

## 输出结构（11 节，节标题逐字使用以下形态，正文中文）

${sectionLines(PAPER_PAGE_SECTIONS, 1)}

## 逐节填写规则

- **1 Citation**：论文元数据（标题/作者/年份/venue/DOI 或 arXiv/代码链接），保留原文。
- **2 One-Sentence Contribution**：一句话概括核心贡献。
- **3 Problem Setting**：问题设定、输入输出、与已有设定的差异。
- **4 Method**：方法机制，忠实原文，不推测。
- **5 Experiments**：最低标准——每个数据集含大小与 train/test split；每个 baseline 名称；训练设置（架构、backbone、优化器、lr、batch size、epoch、硬件）；评估协议（指标、聚合方式 mean±std over N runs）；消融（消融了什么/测了什么变体/揭示了什么）。缺失信息标「原文未报告」。
- **6 Results**：★ 每个 main claim 至少 1 个具体数字（如「AUROC 95.12% vs. MCM 86.05%」）；有表格时捕获关键行（最佳方法/最强 baseline/差距）；有消融时捕获完整性能差值（如「移除 L_reg 后 FPR95 从 8.56 升至 10.73」）；仅读到场次信息有限时注明已有最佳数字与缺失内容。反模式：不命名对比方法的差距表述、不列 benchmark 数字的「多个 benchmark 优越」、列数据集不说对比对象、空 Results——禁「${QUALITATIVE_CLAIM_ANTIPATTERN}」类无数字定性表述。
- **7 Limitations**：原文声明的局限 + 你观察到的局限（区分标注）。
- **8 Reusable Claims**：可复用的可证伪陈述清单（后续结构化提交）。
- **9 Connections**：与已知方法/数据集/任务的关系（仅基于论文内容）；引用 wiki 已有页时用相对 markdown 链接（如 [标题](papers/<slug>.md)），不写绝对路径。
- **10 Open Questions**：论文留下的开放问题。
- **11 Provenance**：本页信息来源说明（哪些页/节支撑了哪些论断）。

## wiki 约定（#848 §1.3 迁移面）

- 命名：页面 slug 由标题派生（小写 kebab-case，不带日期），由写入面确定性处理，无需在正文操作。
- 矛盾：与论文内部或已知知识的矛盾之处不得省略或抹平——用 Limitations / Open Questions 节显式记录，保留双方陈述。

## 硬性要求（确定性校验，不满足将被打回）

1. 11 节标题齐全且按上述形态逐字出现，顺序不变。
2. 整页正文不少于 ${PAPER_PAGE_MIN_LINES} 行。
3. Results 节内必须出现具体数字。
4. 不批判、不提出论文之外的新方法（阶段边界：ingest 只做忠实整理）。

输出格式约束：输出必须是且仅是一个 JSON 对象 {"title": "...", "content": "...", "claims": [{"statement": "...", "evidence": ["..."]}]}。title = 论文标题原文；content = 完整 11 节 markdown 正文；claims = 从 Reusable Claims 节提取的可证伪陈述数组（statement 一句话陈述，evidence = 支撑来源描述，如「论文 §5 Table 2」，可为空数组）。禁止输出 JSON 之外的任何文本或 markdown 围栏。

论文全文（按页）：
<paper>
${pages.join('\n\f\n')}
</paper>${diagnosticsBlock(diagnostics)}`
}

// ---------------------------------------------------------------------------
// W2 extract：12 节实验深度提取（853 §4.2 · #848 §2.1）
// ---------------------------------------------------------------------------

export function buildExtractPrompt(paperPageContent: string, diagnostics?: string): string {
  return `你是论文实验信息的深度提取者。基于给定的论文 wiki 页，产出结构化实验提取文档。

阶段边界：只做实验结果深化提取，不做问题挖掘、不提新方法、不下最终结论；不简单复述，提炼结构化、可比较、可复用信息。

## 输出结构（12 节，节标题逐字使用以下形态）

${sectionLines(EXTRACT_SECTIONS, 0)}

## 逐节填写规则

- **## 0 文档定位**：论文一句话定位与本档角色。
- **## 1 实验目标与作者想验证的核心结论**。
- **## 2 实验设置总览**：须含子节 2.1 数据集 / 2.2 任务·阶段划分方式 / 2.3 对比方法 / 2.4 评价指标 / 2.5 实现与训练相关设置。
- **## 3 主结果提取**：3.1 主结果结论 / 3.2 结果差异与模式 / 3.3 作者结论与主结果的对应关系。
- **## 4–## 7**：消融 / 参数敏感性 / 效率复杂度 / 鲁棒性泛化，逐项如实提取。
- **## 8 值得关注的实验现象**：3–6 个，**只描述不批判**。
- **## 9 证据充分性整理**：哪些结论证据充分、哪些薄弱。
- **## 10 对后续问题发现最有价值的实验信息**。
- **## 11 一段简短总结**：100–150 字。

## 领域特定关注（#848 §2.1：增量学习/持续学习/动态图/节点分类场景）

若论文涉及上述场景，额外关注并如实提取：阶段间性能变化；新旧知识保持与适应；任务顺序与结构变化强度；memory budget 敏感性；特定数据集退化；性能提升代价。不涉及则整段省略，不得硬凑。

## 三态标注规则（可信度的证据底座，确定性扫描）

每条提取信息须区分三态：**${EXTRACT_EVIDENCE_TERMS}**。论文未提供的信息一律写「${EXTRACT_UNSTATED_PHRASE}」，不得编造。

禁语：正文中禁止出现${EXTRACT_BANNED_PHRASES.map((p) => `「${p}」`).join('')}——提取文档只陈述论文说了什么，不做推测。需要表达不确定时使用规范用语「${EXTRACT_UNSTATED_PHRASE}」。

输出格式约束：输出必须是且仅是一个 JSON 对象 {"content": "..."}。content = 完整 12 节 markdown 正文。禁止输出 JSON 之外的任何文本或 markdown 围栏。

论文 wiki 页内容：
<paper-page>
${paperPageContent}
</paper-page>${diagnosticsBlock(diagnostics)}`
}

// ---------------------------------------------------------------------------
// W2 critic：审稿式问题分析（853 §4.2 · #848 §2.2）
// ---------------------------------------------------------------------------

// paperPath 注入（PR #917 review Spec#4）：evidenceGate 引用回查以真实论文页路径为锚——
// 不注入则 LLM 只能虚构引用路径，自页节锚回查结构性不可达。
export function buildCriticPrompt(
  paperPageContent: string,
  extractDoc: string,
  paperPath: string,
  diagnostics?: string,
): string {
  return `你是审稿式问题分析师。基于论文 wiki 页与实验提取文档，产出审稿式问题分析。

工作原则：围绕「贡献 claim → 方法机制 → 实验现象 → 审稿式质疑 → 潜在研究空缺」展开；质疑必须具体（对象、依据、可能影响）；优先保留「具体、重要、紧迫、可验证」的问题；证据强度三档（${CRITIC_STRENGTH_TIERS}），结论强度与证据强度匹配，不强推断；推测标明「合理推测，仍需验证」，材料不足标明「现有材料不足以确认，但值得后续验证」。

质疑 9 类型（供 §2/§3 组织视角）：${CRITIC_CHALLENGE_TYPES.join('、')}。

## 输出结构（正文中文；第一行 = 「# <分析标题>」唯一 H1，之下空一行写机读标签，再接 §0–§7 八节，节标题逐字使用以下形态）

${sectionLines(CRITIC_SECTIONS, 0)}

## 逐节填写规则

- **## 0 文档定位**：本档角色与输入材料说明。
- **## 1 方法机制、实验支撑与关键前提**：1.1 方法与实验的整体对应关系 / 1.2 方法可能依赖的关键前提。
- **## 2 核心贡献声明与审稿式质疑**：3–5 个 claim，每个 claim 附质疑与依据。
- **## 3 潜在问题分析**：按重要性/紧迫性/可验证性排序。
- **## 4 验证候选问题与优先级**：筛选 ${CRITIC_CANDIDATES_MIN}–${CRITIC_CANDIDATES_MAX} 个最值得优先验证的候选问题（与结构化 candidates 字段一致）。
- **## 5–## 6**：研究空缺方向 / 新增来源与 wiki 回写建议。
- **## 7 简短结论**：150–200 字。

## 机读标签（确定性校验）

第一行 H1 标题之下空一行，独占一行写 inline code 标签：${CRITIC_CATEGORY_TAG}

## evidence 引用指引（evidenceGate 逐条存在性回查，不可溯源即剔除）

candidates 的 evidence 引用须可溯源，形态：
- 本论文页节锚（首选）：\`${paperPath}#<节标题>\`——节标题用页内真实标题（如 \`${paperPath}#6 Results\`）。
- lab 上传件：/lab/uploads/<文件名>.pdf。
- 描述性引用（如「论文 §5 Table 2」）无可回查锚，放行但证据力弱——关键质疑优先用页节锚。
禁止引用不存在的 wiki 页路径、不得虚构节标题。

输出格式约束：输出必须是且仅是一个 JSON 对象 {"content": "...", "candidates": [{"question": "...", "priority": "high|medium|low", "evidence": ["..."]}]}。content = 完整 markdown 正文（第一行 H1 标题 + 机读标签行 + §0–§7 八节）；candidates = §4 的候选问题结构化面（${CRITIC_CANDIDATES_MIN}–${CRITIC_CANDIDATES_MAX} 个；question 具体可验证；priority 为验证优先级；evidence = 支撑该问题的证据引用，可为空数组）。禁止输出 JSON 之外的任何文本或 markdown 围栏。

论文 wiki 页内容：
<paper-page>
${paperPageContent}
</paper-page>

实验提取文档：
<extract-doc>
${extractDoc}
</extract-doc>${diagnosticsBlock(diagnostics)}`
}

// ---------------------------------------------------------------------------
// W3 hypothesize prompt 资产（#911 · 853 §4.3 · 单一来源 = #848 §3）：
// Brief 模板 10 字段 / Idea Card 15 字段 / 7+1 生成策略（按桶注入）/ 质量检查清单
// （output-spec「Required Quality Checks」）/ challenge 反驳判据（brainstorm main 反驳门禁）。
// ---------------------------------------------------------------------------

// Idea Card 15 字段（#848 §3 idea-card-template.md 全量——wiki_writeback 为条件必填：
// 锚含 wiki 源时必填，validate 规则 6 联动）。
export const IDEA_CARD_FIELDS = [
  'idea_id',
  'title',
  'one_sentence_hypothesis',
  'anchor_sources',
  'target_problem',
  'mechanism',
  'paper_insight_or_limitation',
  'evidence_chain',
  'minimum_experiment',
  'expected_metric_change',
  'implementation_scope',
  'risks',
  'confidence',
  'recommendation_reason',
  'wiki_writeback',
] as const

// idea card 页机读标签（#848 §0 约定——同 critic 页 category 标签先例；页渲染由
// ideaCards.renderIdeaCardPage 确定性写入，LLM 不操持格式）。
export const IDEA_CATEGORY_TAG = '`category: idea`'

// 生成策略（#848 §3 generation-strategies.md 七段全量 + assumption-challenge 自撰段——
// brainstorm 固定桶档位，策略按桶注入对应段）。assumption-challenge 源 skill 无独立策略
// 文档，语义取自 brainstorm 反驳门禁（挑战核心前提 → 可区分假设的最小实验）。
export const BUCKET_STRATEGIES: Record<BucketName, string> = {
  gap: 'Gap-driven（缺口驱动）：从来源材料中显式声明的局限、未来工作信号与开放问题生成想法——每个想法必须锚定材料中可指认的缺口表述。',
  contradiction:
    'Contradiction-driven（矛盾驱动）：从跨论文/跨实验的矛盾结论、不一致数字或相互冲突的 claim 生成想法——想法须指出矛盾双方，并给出可检验的调和/裁决实验。',
  failure:
    'Failure-driven（失败驱动）：从已知失败实验、负结果与薄弱现象生成想法——诊断「缺了什么」，想法须说明补哪一环、为何这次能成。',
  transfer:
    'Transfer-driven（迁移驱动）：把相近任务、模态或 benchmark 上的方法机制迁移到当前任务——须指明源域方法与本任务设定的不匹配点及适配假设。',
  ablation:
    'Ablation-driven（消融驱动）：从当前 baseline 的可控变化生成想法——每次只动一个组件/超参/流程环节，想法须预测该变化的定向效应。',
  metric:
    'Metric-driven（指标驱动）：从当前指标弱点、失败区间或权衡（如 AUROC 高但 FPR95 差）生成想法——想法须点名要改善的 metric 与可观测的改善判据。',
  constraint:
    'Constraint-driven（约束驱动）：在 Brief 的数据/算力/实现/时间约束内生成想法——约束不是脚注，是想法的构造条件；超约束想法直接不合格。',
  'assumption-challenge':
    'Assumption-challenge（假设挑战）：挑战来源材料方法依赖的核心前提——提出使该前提不成立或必须重新验证的替代机制/数据分布/评测设定，想法须包含能区分原假设与替代假设的最小实验。',
}

// 质量检查清单（#848 §3 output-spec.md「Required Quality Checks」迁移面——bucket prompt
// 输出前自检段；validate_idea_cards.py 是同一清单的确定性执行，双表同源语义）。
export const IDEA_QUALITY_CHECKS = [
  'anchor_sources 点名具体论文/wiki 页（1 个或同型集群 2–4 个），禁泛化领域标签（如 "related work"）',
  '弱支撑（evidence_chain 为空）必须标 low-confidence',
  '每卡一个 minimum_experiment（可执行的最小验证，非「进一步研究」式空话）',
  '每卡至少一个预期指标（expected_metric_change 点名具体 metric 与方向）',
  '尊重 Brief 的数据/代码/算力/时间/风险约束（hard_constraints 与 desired_risk_level）',
  'open question 不默默填死——confidence 与 risks 如实反映证据强度',
] as const

// W3 contextPack brief：10 字段归一化（缺失字段下游确定性填 ASSUMPTION，LLM 留空即可）。
export function buildBriefPrompt(requestText: string, evidenceText: string): string {
  return `你是科研工作流的研究背景归一化器。基于用户请求与检索到的证据材料，归一化出 Idea Generation Brief。

## Brief 字段（10 字段，JSON 键名逐字如下）

${BRIEF_FIELDS.map((f) => `- ${f}`).join('\n')}

## 填写规则

- 字段值从用户请求与证据材料提取；证据未覆盖的字段留空（下游确定性填 ASSUMPTION: 未提供——缺失不阻塞，不要编造）。
- research_topic 必填（用户研究主题原文）。
- desired_risk_level ∈ low-risk / medium-risk / exploratory。

输出格式约束：输出必须是且仅是一个 JSON 对象 {"research_topic": "...", ..., "desired_risk_level": "..."}（10 键，允许空串值）。禁止输出 JSON 之外的任何文本或 markdown 围栏。

用户请求：
<request>
${requestText}
</request>

证据材料（页级节选）：
<evidence>
${evidenceText}
</evidence>`
}

// W3 bucket：每桶扇出生成（策略段按桶注入 + 质量清单自检 + Context Pack 全量——
// 不分桶裁剪，#869 D3）。候选数量钉 1–3 张（ideate candidate_only 同款面）。
export function buildBucketPrompt(bucket: BucketName, packText: string): string {
  return `你是科研假说生成器，负责一个机会桶的候选 Idea Card 生成。

## 你的机会桶：${bucket}

${BUCKET_STRATEGIES[bucket]}

## Idea Card 15 字段（每卡全字段填写，JSON 键名逐字如下）

${IDEA_CARD_FIELDS.map((f) => `- ${f}`).join('\n')}

- anchor_sources：具体论文/wiki 页（1 个或同型集群 2–4 个）；锚含 wiki 源时 wiki_writeback 必填（回写内容建议）。
- evidence_chain：支撑该想法的证据引用（页路径/节锚/论文位置），至少 2 条为宜；确无则留空并把 confidence 标 low-confidence。

## 质量检查清单（输出前逐条自检，确定性校验会逐条执行）

${IDEA_QUALITY_CHECKS.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## 候选数量

本桶产出 ${IDEA_CANDIDATES_MIN}–${IDEA_CANDIDATES_MAX} 张高信号候选卡（宁少勿滥，弱卡不出）。

输出格式约束：输出必须是且仅是一个 JSON 对象 {"cards": [{...15 字段...}, ...]}。禁止输出 JSON 之外的任何文本或 markdown 围栏。

## Context Pack（Brief + 证据节选——全部卡的唯一生成依据，不得引用包外材料）

<context-pack>
${packText}
</context-pack>`
}

// W3 challenge：顺序逐卡反驳（brainstorm main 反驳门禁语义——只有使核心假设/可行性/
// 可检验性不成立的具体反驳才是 rejected；笼统不确定性不是）。语义去重并入本节点：
// 「已有工作已覆盖」判据含本批次其他候选（实质重复归并）。
export function buildChallengePrompt(packText: string, cardJson: string, peerTitles: readonly string[]): string {
  return `你是假说反驳者。基于 Context Pack 对给定 Idea Card 尝试提出致命反驳。

## verdict 判据（唯一依据）

只有使核心假设、可行性或可检验性不成立的具体反驳才是 rejected，有效反驳类型：
- 核心 claim 无来源支撑；
- 已有工作已覆盖（含与本批次其他候选实质重复——语义去重在此裁决）；
- 违反 Brief 硬约束（数据/代码/算力/边界）；
- minimum_experiment 不能区分竞争解释，或 expected_metric_change 不可检验；
- risks 使关键假设不可执行。
笼统的不确定性不是反驳——「仍需验证」「可能不work」类表述不构成 rejected，该给 survived。

## 输出（JSON）

{"challenge": "<具体反驳；未找到则写「未找到基于现有证据和约束的致命反驳」>", "verdict": "rejected|survived", "verdict_reason": "<反驳成立/未成立的理由>"}

## Context Pack

<context-pack>
${packText}
</context-pack>

## 本批次其他候选标题（语义去重面）

<peers>
${peerTitles.join('\n')}
</peers>

## 待反驳卡

<card>
${cardJson}
</card>`
}
