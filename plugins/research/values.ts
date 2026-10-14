// 科研工作流插件（research）常量表归口（853 §7.1 · #908 建此文件 · #909 落齐七件）。
// 对齐 plugins/autofigure/pipeline/values.ts 先例：纯常量零 import（插件包铁律——plugins/ 树
// 禁裸包名 import）。字面值由 server/test/researchValues.test.ts 两层锁定（approval values
// 先例：纯逻辑导入断言 + 字面数字行为锁定），改值须连测试一并改、随发版走；其中
// GENERATED_STALE_AFTER_MS 另有 wikiPluginPage.test.ts 消费面双锁（两处测试同步改）。
// 归口注记：GENERATED_STALE_AFTER_MS 与 PAGE_DRAFT_MAX 已自 server/src/wiki/pluginPage.ts
// 迁入本表（#908 复审 B3/B5 拍板、853 §7.1 点名归口）——pluginPage.ts 反向 import 本表，
// server → plugins/research/values 引用先例 = runner/docsToolPort.ts。

// 意图分类放行阈值（853 §1.2 · #866 实测定标）：confidence < 本值 → clarify 兜底。40 条中文
// 科研 bad case × 3 轮 MiniMax M3 实测——τ≤0.55 出现坏放行、τ≥0.60 坏放行归零且正确误拦最小化；
// 多意图条目置信天然 0.55–0.65，恰由兜底接住。
export const MIN_CONFIDENCE = 0.6

// W3 contextPack 检索预算（853 §4.3）：构建时裁一次（2 chars/token 口径 ≈32k 中文字符；
// judge 8k 的 2 倍——多页引用场景）。evidence 按证据等级降序 + 页级节选 + Brief 恒保全。
export const CONTEXT_PACK_BUDGET_TOKENS = 16_000

// 长页输出单次生成上限（853 §7.1）：盖五节点——W1 create / W2 extract+critic / W4 design+spec，
// 经 generateStructured maxTokens 传入。否决对齐 autofigure 50k（超多数 provider output cap）、
// 否决两过式分段生成。
export const PAGE_OUTPUT_MAX_TOKENS = 32_000

// 生成兜底重试次数（853 §7.1 · #906 修订触发面，值与覆盖面不动）：**截断 ∨ 结构化解析/validate
// 失败**（finish_reason=length 检出 / generateStructured zod 解析不过 / 确定性校验拒）→ 回生成
// 节点重试 1 次附对应诊断回喂。覆盖面 = 长页生成五节点（W1 create / W2 extract+critic /
// W4 design+spec）。边界：无工具面、无 LLM 自由裁量、K≤2 有界（初次生成 + 至多一次修复）、
// 输入不变无检索——只纠格式不改生成语义（#850「一次性生成语义足够」不被触及），系「单发 +
// 至多一次协议修复」形态（#899 图 #904 拍板；critic gate 56%→100% 实测归因）。classify 与
// W3 扇出不在覆盖面（#904 口径注记：拓扑调用数推导不含重试）。
export const PAGE_GENERATE_MAX_RETRIES = 1

// 生成节点进入次数上界 = 初次 + PAGE_GENERATE_MAX_RETRIES 次协议修复（K≤2 有界，
// 853 §7.1）。ingest/discover 生成节点共享的进入判定常数（重试耗尽 = 明确失败落点）。
export const PAGE_GENERATE_MAX_ATTEMPTS = 1 + PAGE_GENERATE_MAX_RETRIES

// W3 扇出 cap（853 §4.3 · #869 D7）：5 固定桶（gap/contradiction/failure/transfer/constraint）
// + 3 opt-in（ablation/metric/assumption-challenge，仅经参数显式追加——非 LLM 自由裁量）。
export const BUCKETS_MAX = 8

// W3 桶档位（853 §4.3 · brainstorm 五固定桶 + 三 opt-in 桶）：固定桶每跑必在；opt-in 桶
// 仅经 research_workflow 参数显式追加（工具 schema 枚举锁定三值，LLM 无自由裁量面）。
export const BUCKETS_FIXED = ['gap', 'contradiction', 'failure', 'transfer', 'constraint'] as const
export const BUCKETS_OPT_IN = ['ablation', 'metric', 'assumption-challenge'] as const
export type BucketName = (typeof BUCKETS_FIXED)[number] | (typeof BUCKETS_OPT_IN)[number]
// 全桶并集（固定 + opt-in 序——扇出序与策略表遍历序单源）。
export const BUCKETS_ALL = [...BUCKETS_FIXED, ...BUCKETS_OPT_IN] as const

// W3 每桶候选卡数量面（853 §4.3「每桶 LLM 生成 1–3 张候选卡」· ideate candidate_only 同款
// 1–3 钉面）：schema 层宽容上限 = 5（LLM 给 4–5 张不直拒——多卡非质差，挑战阶段自然筛选；
// 消费面 = ideaCards.IDEA_CARDS_SCHEMA）。
export const IDEA_CANDIDATES_MIN = 1
export const IDEA_CANDIDATES_MAX = 3
export const IDEA_CANDIDATES_SCHEMA_MAX = 5

// W3 challenge 逐卡上界（853 §4.3 ≤35 次 LLM/run 口径面：classify 1 + brief 1 + 桶 ≤8 +
// challenge ≤24 ≈ 34）——消费面 = hypothesize.dedupNode 截断（schema 宽容上限下 8 桶×5 卡
// 可越界：上界靠拓扑 + 本截断成立，截断数进 summary 不静默）。
export const CHALLENGE_CARDS_MAX = BUCKETS_MAX * IDEA_CANDIDATES_MAX

// W3 contextPack 集中检索条数（853 §4.3「集中检索」）：单次 search 拉取上限——evidence
// 池主源（source_paths 钉定论文页 + 检索命中），按证据等级降序入裁剪。
export const CONTEXT_PACK_SEARCH_LIMIT = 10

// W3 证据条目页级节选上限（853 §4.3「页级节选（非全文）」）：每条 evidence excerpt 的
// 确定性字符 cap——节选先行，再做预算裁剪（两层序：先节选定条目尺寸，再按预算整条目取舍）。
export const EVIDENCE_EXCERPT_MAX_CHARS = 4_000

// W3 idea card validate 阈值（validate_idea_cards.py 字面迁移，853 §4.3 / #848 §3.3）：
// target_problem 痛点具体度（≥30 字符 + CONCRETE_PROBLEM_MARKERS 命中）/ minimum_experiment
// 过短 warning（非 error）/ anchor_sources 同型集群 2–4 上限。
export const TARGET_PROBLEM_MIN_CHARS = 30
export const MIN_EXPERIMENT_WARN_CHARS = 20
export const IDEA_ANCHORS_MAX = 4

// W4 方案人审修订上限（853 §5.1 · #852）：deny → 回 design 修订模式，第 3 轮 deny →
// plan_review_exhausted 终局（run completed 非 failed）。轮次随 escalation.plan.round 透传；
// 卡面轮次显示与第 2/3 轮「最后一轮」提示归 [#873·7]（#913）前端 PlanApprovalCard 渲染。
export const PLAN_REVIEW_MAX_ROUNDS = 3

// W4 方案人审载荷上限（853 §5.1：escalation.plan 全文内联「几 KB 载荷」——审批卡
// MarkdownRenderer 渲染面，超truncate 由 buildExperimentPlan 截断面执行；单卡无独立拉取面）。
export const PLAN_TEXT_MAX_CHARS = 16_000

// W4 spec 交付物声明件数上限（schema 层宽容硬上限——LLM 多给不直拒；对账面逐件处理，
// 上限防失控值。消费面 = experiment.ts SPEC_DOC_SCHEMA）。
export const SPEC_DELIVERABLES_MAX = 20

// W4 collect 对账条目内容 excerpt 上限（#912 review P1：对账面存节选不全文驻留——内存
// 放大面实际由 lab read 的 16MiB 护栏兜底（too_large 拒读，R0 review P1-1 后超限件不进
// 内容面、标 unread 如实记录）；本截断面作用于已读取内容。消费面 = buildCollectSummaryPrompt）。
export const RECKONING_EXCERPT_MAX_CHARS = 4_000

// extractPdfText 字符上限（853 §7.1 拍板 1_000_000 · #851 D10）：PDF 提取全文上限，超限明确
// 报错不静默截断——截断致 extract 缺节 → validate 拒 → 重试循环浪费 token（§3.2#2 原文）。
// 消费面 = 核心 docs port（runner/docsToolPort.ts 缺省引用本表）。
export const PDF_EXTRACT_MAX_CHARS = 1_000_000

// 生成页陈旧地平线（853 §7.1 · #908 复审 B3 拍板追认）：stale_after = 生成时刻 + 180 天——
// 生成页进治理检索面，徽章面过期标记由此驱动（wiki/pluginPage.ts frontmatter 组装消费）。
export const GENERATED_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000

// W1/W2 V1 单篇约束（853 §4.1「一次调用一篇」）：capture/resolveInputs 共享判定常数。
// 与 server.ts SOURCE_PATHS_MAX（传输面数组上限，W3/W4 预留）分属两层——V1 流程语义在
// 本值，传输上限在 server.ts（名近义分层，PR #917 review S8/#22 归口）。
export const SOURCE_PATHS_V1_MAX = 1

// W1 summary 截断上限（853 §4.1 summary「≤1k」钉面，只钉 W1）。W2 无此钉——「剔除清单
// 必进 summary 不静默」（853 §4 横切）优先于截断，W2 不截断（PR #917 review Spec#9）。
export const SUMMARY_MAX_CHARS = 1000

// W2 validate² 候选问题数量面：确定性钉 2–4（853 §4.2 / #848 §2.2）；schema 层另设宽容
// 硬上限（LLM 给超量时 zod 不直拒——校验层出「须为 2–4」诊断重试可修）。
export const CRITIC_CANDIDATES_MIN = 2
export const CRITIC_CANDIDATES_MAX = 4
export const CRITIC_CANDIDATES_SCHEMA_MAX = 10

// W2 resolveInputs 检索定位拉取条数（按 papers/ 前缀过滤后取首条；拉 5 弃 4 容忍 critic
// 页/杂页混入排前——FTS OR 匹配无页型过滤，PR #917 review Spec#6）。
export const RESOLVE_INPUTS_SEARCH_LIMIT = 5

// W1 validate 论文页行数门禁（853 §4.1 / #848 §1.2 完成门禁「≥100 行」——完整精读笔记
// 而非摘要；prompt 模板与校验清单同源渲染，PR #917 review S4 归口）。
export const PAPER_PAGE_MIN_LINES = 100

// PageDraft DTO 尺寸上限（853 §7.1 拍板追认，#908 复审 B5）：zod 边界防失控值。
// path 上限不在本表——wiki/paths.ts PATH_MAX 是 wiki 域单源（pluginPage 组合消费）。
export const PAGE_DRAFT_MAX = {
  titleChars: 512,
  contentChars: 2_000_000,
  claims: 100,
  evidencePerClaim: 20,
} as const
