// W4 experiment 调用①（方案设计图 · #912 · 853 §4.4–§5 · #848 §4 prompt 资产）：
//
//   resolveInputs → preflight → planEntry ─┬─ 短路 → summary
//                                         └─ design → validate¹ → spec → validate² → audit → persist → summary
//                                          (LLM；重试三源)   (映射校验泛化  (LLM；重试   (占位符   (①②④确定性+
//                                           K≤2 回边)      #868 D3)      三源 K≤2)   未填充)    ③⑤⑥ LLM；
//                                                                              blocking 非空 → fail 不进人审)
//
// 钉界（853 §4.4–§5.1）：输入 = critic 页 ∨ idea card 页至少其一（#868 D2）+ 实验意图
// （question/topic）；preflight 从 critic §4 / idea minimum_experiment 提取映射池；spec 落盘
// lab = 幂等短路点（spec.md 已存在且非修订轮 → 跳过 design/spec/audit LLM 直达 summary——
// resume 重放零 LLM 重调，853 §5.1）；修订模式 = 同图回 design（输入 = 上轮 spec + 用户理由，
// 零新图节点）。audit blocking 非空 → throw（该调用 fail）。调用②（执行段）非图——主 agent
// 按规格在沙箱执行；调用③（collect）归 collect.ts。
//
// 路径域：spec 落盘 /lab/specs/<slug>/{design,spec,audit}.md（experimentPlan.ts 派生单源）；
// 图内 wiki 读面经 wikiReadPathOf 换算（graph.ts 约定）。

import { END, START, StateGraph, Annotation, z } from '../../server/src/plugins/autofigureDeps'
import type { LangGraphRunnableConfig } from '../../server/src/plugins/autofigureDeps'
import type { PluginLabPort, PluginLlmPort, PluginWikiPort } from '../../server/src/plugins/api'
import { PAGE_DRAFT_MAX, SPEC_DELIVERABLES_MAX } from './values'
import { buildAuditPrompt, buildDesignPrompt, buildSpecPrompt, CRITIC_SECTIONS, headingAnchor } from './prompts'
import type { DesignExperimentSpec, SpecDeliverableSpec } from './prompts'
import {
  auditBannedPhrases,
  auditFieldsNonEmpty,
  auditStructureDesign,
  auditStructureSpec,
  validateDesignMapping,
  validateSpecPlaceholders,
} from './experimentValidate'
import { generateWithBoundedRetry } from './generate'
import { auditPathOf, deliverablesPathOf, designPathOf, specPathOf } from './experimentPlan'
import { compiledInvokeOptions, stageReporterOf, toWikiRelPath, wikiReadPathOf, WIKI_PAGE_PROBE_ANCHOR } from './graph'
import type { FlowGraphInvokeOptions, ResearchWorkflowRequest, WorkflowOutcome } from './graph'
import type { ClarifyResult } from './clarify'

// W4 计算端口（llm pin 由装配层包装；wiki 读面 + lab 读写面）。
export interface ExperimentPlanPorts {
  readonly llm: PluginLlmPort
  readonly wiki: Pick<PluginWikiPort, 'readPage'>
  readonly lab: Pick<PluginLabPort, 'read' | 'write'>
}

// LLM 产出 schema（与 experimentValidate 校验面同源消费：experiments/deliverables 结构化面）。
export const DESIGN_DOC_SCHEMA = z
  .object({
    content: z.string().min(1).max(PAGE_DRAFT_MAX.contentChars),
    experiments: z
      .array(
        z.object({
          name: z.string().min(1),
          validation_target: z.string(),
          expected_outcome: z.string(),
        }),
      )
      .max(16)
      .optional(),
  })
  .strict()

export const SPEC_DOC_SCHEMA = z
  .object({
    content: z.string().min(1).max(PAGE_DRAFT_MAX.contentChars),
    deliverables: z
      .array(
        z.object({
          path: z.string().min(1),
          success_criterion: z.string(),
        }),
      )
      .max(SPEC_DELIVERABLES_MAX)
      .optional(),
  })
  .strict()

// audit 产出（③⑤⑥ LLM 三维 + 7 节报告；blocking 并集确定性 issues = 必须修复项）。
export const AUDIT_VERDICT_SCHEMA = z
  .object({
    report: z.string().min(1).max(PAGE_DRAFT_MAX.contentChars),
    blocking: z.array(z.string().min(1)).max(64).optional(),
    suggestions: z.array(z.string().min(1)).max(64).optional(),
  })
  .strict()

export type DesignDoc = z.infer<typeof DESIGN_DOC_SCHEMA>
export type SpecDoc = z.infer<typeof SPEC_DOC_SCHEMA>
export type AuditVerdict = z.infer<typeof AUDIT_VERDICT_SCHEMA>

// 调用①图终态（WorkflowOutcome 扩展面——工具边界经此构造 plan 载荷与批准后续面）。
export interface ExperimentPlanOutcome {
  readonly status: WorkflowOutcome['status']
  readonly summary: string
  readonly artifactPages: readonly WorkflowOutcome['artifactPages'][number][]
  readonly clarify: ClarifyResult | undefined
  readonly experiment: {
    readonly specContent: string
    readonly specRef: string
    readonly designContent: string
    readonly auditReport: string
    readonly deliverables: readonly SpecDeliverableSpec[]
  } | undefined
}

// 输入页形态白名单（853 §4.4：critic 页 ∨ idea card 页至少其一；双输入允许双映射——
// V1 各至多一篇，##3 核心 3–6 个钉面天然有界）。
const CRITIC_PAGE_RE = /^critics\/[^/]+\.md$/
const IDEA_CARD_PAGE_RE = /^idea-cards\/[^/]+\.md$/

const isInputPage = (p: string): boolean => CRITIC_PAGE_RE.test(p) || IDEA_CARD_PAGE_RE.test(p)

// critic 页 §4 节锚（W2 页形契约——critic 页 ##0–§7 形态）与 idea card 页字段节锚
//（#912 补钉——renderIdeaCardPage `## Idea Card Fields`）。
const CRITIC_SECTION4_ANCHOR = headingAnchor(`4 ${CRITIC_SECTIONS[4]}`)
const IDEA_FIELDS_ANCHOR = headingAnchor('Idea Card Fields')

// clarify 文案（candidates 空 = 无流程候选可列，缺失的是输入产物——同 W2/W3 形态）。
const missingInputsClarify = (missing: readonly string[]): ClarifyResult => ({
  status: 'clarify',
  candidates: [],
  question: `实验设计流程需要 critic 问题分析页（critics/<slug>.md，先跑 /discover）或 idea card 假说页（idea-cards/<slug>.md，先跑 /hypothesize）至少其一。缺失：${missing.join('、')}。请先生成对应产物后重跑（重跑幂等，已生成的设计不会重复计费）。`,
})

const EXPERIMENT_CLARIFY_NO_INTENT: ClarifyResult = {
  status: 'clarify',
  candidates: [],
  question:
    '实验设计流程需要明确的实验意图：请用 question/topic 描述要验证的问题或想法（可附 critic 页或 idea card 页路径）。',
}

// idea card 页 minimum_experiment 行提取（渲染面 `minimum_experiment: <值>` 行级锚）。
const minimumExperimentOf = (pageBody: string): string | undefined =>
  /^minimum_experiment:\s*(.+)$/m.exec(pageBody)?.[1]?.trim() || undefined

// ---------------------------------------------------------------------------
// 状态面
// ---------------------------------------------------------------------------

interface ExperimentState {
  request: ResearchWorkflowRequest
  round: number
  revisionReason: string | undefined
  inputPages: readonly string[]
  pageBodies: readonly string[]
  mappingTargets: readonly string[]
  designDoc: DesignDoc | undefined
  designAttempts: number
  specDoc: SpecDoc | undefined
  specAttempts: number
  diagnostics: string | undefined
  auditReport: string | undefined
  auditSuggestions: readonly string[]
  shortCircuited: boolean
  clarify: ClarifyResult | undefined
  summaryText: string | undefined
}

const ExperimentAnnotation = {
  request: Annotation<ResearchWorkflowRequest>,
  round: Annotation<number>,
  revisionReason: Annotation<string | undefined>,
  inputPages: Annotation<readonly string[]>,
  pageBodies: Annotation<readonly string[]>,
  mappingTargets: Annotation<readonly string[]>,
  designDoc: Annotation<DesignDoc | undefined>,
  designAttempts: Annotation<number>,
  specDoc: Annotation<SpecDoc | undefined>,
  specAttempts: Annotation<number>,
  diagnostics: Annotation<string | undefined>,
  auditReport: Annotation<string | undefined>,
  auditSuggestions: Annotation<readonly string[]>,
  shortCircuited: Annotation<boolean>,
  clarify: Annotation<ClarifyResult | undefined>,
  summaryText: Annotation<string | undefined>,
}

// ---------------------------------------------------------------------------
// 图工厂（纯函数——同 ports 必同拓扑）
// ---------------------------------------------------------------------------

export function createExperimentPlanGraph(ports: ExperimentPlanPorts): {
  invoke(
    init: { request: ResearchWorkflowRequest; revisionReason?: string; round?: number },
    options?: FlowGraphInvokeOptions,
  ): Promise<ExperimentPlanOutcome>
} {
  const intentOf = (request: ResearchWorkflowRequest): string =>
    (request.question ?? request.topic ?? '').trim()

  // resolveInputs（确定性）：输入页形态白名单 + 存在性哨兵回查 + 实验意图必填。
  async function resolveInputsNode(
    state: ExperimentState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<ExperimentState>> {
    stageReporterOf(config)('resolveInputs')
    const given = (state.request.source_paths ?? []).map(toWikiRelPath)
    const malformed = given.find((p) => !isInputPage(p) || p.split('/').some((seg) => seg === '.' || seg === '..'))
    if (malformed !== undefined) {
      return {
        clarify: {
          status: 'clarify',
          candidates: [],
          question: `experiment 的输入是 critic 问题分析页（critics/<slug>.md）或 idea card 假说页（idea-cards/<slug>.md）；收到 ${malformed}。`,
        },
      }
    }
    if (intentOf(state.request) === '') return { clarify: EXPERIMENT_CLARIFY_NO_INTENT }
    const missing: string[] = []
    for (const p of given) {
      const probe = await ports.wiki.readPage(wikiReadPathOf(p), [WIKI_PAGE_PROBE_ANCHOR])
      if (!probe.ok && probe.error.code === 'not_found') {
        missing.push(p)
        continue
      }
      if (!probe.ok && probe.error.code !== 'invalid_input') {
        throw new Error(`输入页存在性回查失败（${probe.error.code}）：${probe.error.message}`)
      }
    }
    if (given.length === 0) {
      return { clarify: missingInputsClarify(['critic 页与 idea card 页（两者皆无）']) }
    }
    if (missing.length > 0) return { clarify: missingInputsClarify(missing) }
    return { inputPages: given }
  }

  function routeAfterResolve(state: ExperimentState): 'preflight' | 'end' {
    return state.clarify !== undefined ? 'end' : 'preflight'
  }

  // preflight（材料清单 + 映射池构建）：读输入页内容——critic 页提取 §4 候选节（整块入
  // 池——LLM target 命中节内问题行即过双向子串）；idea card 页提取 minimum_experiment 精确值。
  // 读失败（not_found 竞态窗口）→ clarify 列缺失清单（幂等重跑便宜，853 §4.4）。
  async function preflightNode(
    state: ExperimentState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<ExperimentState>> {
    stageReporterOf(config)('preflight')
    const pageBodies: string[] = []
    const mappingTargets: string[] = []
    const missing: string[] = []
    for (const p of state.inputPages) {
      const anchors = CRITIC_PAGE_RE.test(p) ? [CRITIC_SECTION4_ANCHOR] : [IDEA_FIELDS_ANCHOR]
      const r = await ports.wiki.readPage(wikiReadPathOf(p), anchors)
      if (!r.ok) {
        if (r.error.code === 'not_found') {
          missing.push(p)
          continue
        }
        if (r.error.code === 'invalid_input') {
          // 页存在但消费锚缺失（critic 页无 §4 节 / idea card 页无字段节）= 材料形态
          // 不符（853 §4.4 材料缺失口径）——clarify 列缺失清单引导重跑上游流程。
          return {
            clarify: {
              status: 'clarify',
              candidates: [],
              question: `输入页形态不符（${p}）：critic 页须含「## 4 验证候选问题与优先级」节（先跑 /discover 重新生成），idea card 页须含「## Idea Card Fields」节（先跑 /hypothesize 重新生成）。请修复后重跑。`,
            },
          }
        }
        throw new Error(`输入页回读失败（${r.error.code}）：${r.error.message}`)
      }
      const body = r.data.sections.map((s) => s.content).join('\n\n')
      pageBodies.push(body)
      if (CRITIC_PAGE_RE.test(p)) {
        mappingTargets.push(body)
      } else {
        const minExp = minimumExperimentOf(body)
        if (minExp !== undefined) mappingTargets.push(minExp)
      }
    }
    if (missing.length > 0) return { clarify: missingInputsClarify(missing) }
    if (mappingTargets.length === 0) {
      throw new Error('输入页不含可映射的验证目标（critic §4 候选节 / idea minimum_experiment 均缺失）——输入页形态不符')
    }
    return { pageBodies, mappingTargets }
  }

  // planEntry（幂等短路点判定）：本 round spec 已落盘 → 短路（零 LLM 直达 summary）。
  // round 键控（experimentPlan.ts 头注）：首轮/重放历史轮/重放当前挂起轮——凡产物已落盘
  // 即短路（含修订轮——resume 重放不再重生成历史修订内容）；未落盘 = 首次进入该轮 →
  // 正常生成链。短路读回 audit.md（同轮同目录）供 summary/审计面。
  async function planEntryNode(
    state: ExperimentState,
    _config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<ExperimentState>> {
    const specRef = specPathOf(state.request, state.round)
    const spec = await ports.lab.read({ path: specRef })
    if (!spec.ok) {
      if (spec.error.code === 'not_found') return {}
      throw new Error(`spec 短路点读面失败（${spec.error.code}）：${spec.error.message}`)
    }
    const audit = await ports.lab.read({ path: auditPathOf(state.request, state.round) })
    return {
      shortCircuited: true,
      specDoc: { content: spec.data.content, deliverables: [] },
      auditReport: audit.ok ? audit.data.content : undefined,
    }
  }

  function routeAfterPlanEntry(state: ExperimentState): 'summary' | 'design' {
    return state.shortCircuited ? 'summary' : 'design'
  }

  // design（LLM · 长页生成五节点重试覆盖面 #906 三源）：10 节 + 结构化实验面；
  // 修订模式输入 = 上轮 spec（lab 读回）+ 用户理由。
  async function designNode(
    state: ExperimentState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<ExperimentState>> {
    stageReporterOf(config)('design')
    const intent = intentOf(state.request)
    let revision: { priorSpec: string; reason: string } | undefined
    if (state.revisionReason !== undefined) {
      // 修订输入 = 上轮（round-1）spec + 用户理由（853 §5.1）——round 键控后上轮产物
      // 永不被本轮覆盖，内容即用户上轮所审。
      if (state.round <= 1) throw new Error('修订模式要求 round ≥ 2（上轮 spec 引用）——图不变量违反')
      const prior = await ports.lab.read({ path: specPathOf(state.request, state.round - 1) })
      if (!prior.ok) {
        throw new Error(`修订模式读上轮 spec 失败（${prior.error.code}）：${prior.error.message}`)
      }
      revision = { priorSpec: prior.data.content, reason: state.revisionReason }
    }
    const prompt = buildDesignPrompt({
      intent,
      pageBodies: state.pageBodies,
      mappingTargets: state.mappingTargets,
      ...(revision !== undefined ? { revision } : {}),
      ...(state.diagnostics !== undefined ? { diagnostics: state.diagnostics } : {}),
    })
    const r = await generateWithBoundedRetry<DesignDoc>({
      llm: ports.llm,
      schema: DESIGN_DOC_SCHEMA,
      prompt,
      attemptsSoFar: state.designAttempts,
      diagnostics: state.diagnostics,
      nodeLabel: 'design 文档',
    })
    return r.value !== undefined
      ? { designDoc: r.value, designAttempts: r.attempts, diagnostics: undefined }
      : { designAttempts: r.attempts, diagnostics: r.diagnostics, designDoc: undefined }
  }

  // validate¹（确定性 · 映射校验泛化 #868 D3）：不过 → 诊断回 design（K≤2 由 design
  // 节点 attempts 计数保证——回边重入超界 throw）。
  function validate1Node(state: ExperimentState, config: LangGraphRunnableConfig | undefined): Partial<ExperimentState> {
    stageReporterOf(config)('validate')
    const r = validateDesignMapping(state.designDoc?.experiments ?? [], state.mappingTargets)
    return { diagnostics: r.ok ? undefined : r.issues.join('\n') }
  }

  function routeAfterValidate1(state: ExperimentState): 'spec' | 'design' {
    return state.diagnostics === undefined ? 'spec' : 'design'
  }

  // spec（LLM · 长页生成五节点重试覆盖面）：9 段 + 交付物声明；论文基础 Wiki 标识
  // 正确值注入（输入页——可推断占位符出现即拒的回喂锚，validate²）。
  async function specNode(
    state: ExperimentState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<ExperimentState>> {
    stageReporterOf(config)('spec')
    const prompt = buildSpecPrompt({
      intent: intentOf(state.request),
      pageBodies: state.pageBodies,
      designContent: state.designDoc!.content,
      wikiIdentity: state.inputPages.join('、'),
      ...(state.diagnostics !== undefined ? { diagnostics: state.diagnostics } : {}),
    })
    const r = await generateWithBoundedRetry<SpecDoc>({
      llm: ports.llm,
      schema: SPEC_DOC_SCHEMA,
      prompt,
      attemptsSoFar: state.specAttempts,
      diagnostics: state.diagnostics,
      nodeLabel: 'spec 文档',
    })
    return r.value !== undefined
      ? { specDoc: r.value, specAttempts: r.attempts, diagnostics: undefined }
      : { specAttempts: r.attempts, diagnostics: r.diagnostics, specDoc: undefined }
  }

  // validate²（确定性 · 占位符未填充检查）：可推断占位符出现即拒（重试回喂正确值）。
  function validate2Node(state: ExperimentState, config: LangGraphRunnableConfig | undefined): Partial<ExperimentState> {
    stageReporterOf(config)('validate')
    const r = validateSpecPlaceholders(state.specDoc?.content ?? '')
    return { diagnostics: r.ok ? undefined : r.issues.join('\n') }
  }

  function routeAfterValidate2(state: ExperimentState): 'audit' | 'spec' {
    return state.diagnostics === undefined ? 'audit' : 'spec'
  }

  // audit（①②④ 确定性 + ③⑤⑥ LLM）：blocking 并集非空 → throw（必须修复项非空 →
  // 该调用 fail 不进人审——853 §4.4）。报告 7 节落 audit.md（persist 面）。
  // **不在长页生成五节点重试覆盖面**（853 §7.1 覆盖面 = W1 create / W2 extract+critic /
  // W4 design+spec；#906 口径注记同 W3 bucket/challenge 豁免先例）——audit 是质量门非
  // 生成节点，结构化失败即该调用 fail（重试无协议修复面）。
  async function auditNode(
    state: ExperimentState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<ExperimentState>> {
    stageReporterOf(config)('audit')
    const design = state.designDoc!
    const spec = state.specDoc!
    const deterministic = [
      ...auditStructureDesign(design.content),
      ...auditStructureSpec(spec.content),
      ...auditFieldsNonEmpty({
        experiments: (design.experiments ?? []) as readonly DesignExperimentSpec[],
        deliverables: (spec.deliverables ?? []) as readonly SpecDeliverableSpec[],
      }),
      ...auditBannedPhrases(design.content, spec.content),
    ]
    const verdict = await ports.llm.generateStructured({
      schema: AUDIT_VERDICT_SCHEMA,
      contents: [
        buildAuditPrompt({ designContent: design.content, specContent: spec.content, deterministicIssues: deterministic }),
      ],
    })
    const blocking = [...deterministic, ...(verdict.blocking ?? [])]
    if (blocking.length > 0) {
      throw new Error(`方案审计未通过（必须修复项 ${blocking.length} 条，不进人审）：\n${blocking.map((b) => `- ${b}`).join('\n')}`)
    }
    return { auditReport: verdict.report, auditSuggestions: verdict.suggestions ?? [] }
  }

  // persist（lab 落盘 · 幂等短路点写面）：三件产物 + collect 对账旁车同目录写——spec.md =
  // 哨兵（重放检测），deliverables.json = collect 确定性对账的结构化消费面（markdown 正文
  // 无法可靠恢复结构化面）。修订轮覆盖（同路径再写 = 内容替换）。
  async function persistNode(
    state: ExperimentState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<ExperimentState>> {
    stageReporterOf(config)('persist')
    const sidecar = JSON.stringify({
      deliverables: state.specDoc!.deliverables ?? [],
      inputPages: state.inputPages,
    })
    const writes: ReadonlyArray<readonly [string, string]> = [
      [designPathOf(state.request, state.round), state.designDoc!.content],
      [specPathOf(state.request, state.round), state.specDoc!.content],
      [auditPathOf(state.request, state.round), state.auditReport ?? ''],
      [deliverablesPathOf(state.request, state.round), sidecar],
    ]
    for (const [path, content] of writes) {
      const r = await ports.lab.write({ path, content })
      if (!r.ok) throw new Error(`方案产物落盘失败（${r.error.code}）：${r.error.message}`)
    }
    return {}
  }

  // summary：spec 路径 + awaiting_review（调用①终态语义——人审闸门在工具边界，图内只
  // 产出方案与引用；批准/终局语义归 planReview 循环）。建议项不静默。
  function summaryNode(state: ExperimentState, config: LangGraphRunnableConfig | undefined): Partial<ExperimentState> {
    stageReporterOf(config)('summary')
    const specRef = specPathOf(state.request, state.round)
    const suggestions =
      state.auditSuggestions.length > 0 ? `\n审计建议改进项（不阻塞）：${state.auditSuggestions.join('；')}` : ''
    const text = state.shortCircuited
      ? `方案已生成并落盘（待审批）：${specRef}${suggestions}`
      : `实验方案已生成（spec 落盘 ${specRef}），等待人工审批后进执行段。${suggestions}`
    return { summaryText: text }
  }

  const graph = new StateGraph({ stateSchema: Annotation.Root(ExperimentAnnotation) })
    .addNode('resolveInputs', resolveInputsNode)
    .addNode('preflight', preflightNode)
    .addNode('planEntry', planEntryNode)
    .addNode('design', designNode)
    .addNode('validate1', validate1Node)
    .addNode('spec', specNode)
    .addNode('validate2', validate2Node)
    .addNode('audit', auditNode)
    .addNode('persist', persistNode)
    .addNode('summary', summaryNode)
    .addEdge(START, 'resolveInputs')
    .addConditionalEdges('resolveInputs', routeAfterResolve, { preflight: 'preflight', end: END })
    .addEdge('preflight', 'planEntry')
    .addConditionalEdges('planEntry', routeAfterPlanEntry, { summary: 'summary', design: 'design' })
    .addEdge('design', 'validate1')
    .addConditionalEdges('validate1', routeAfterValidate1, { spec: 'spec', design: 'design' })
    .addEdge('spec', 'validate2')
    .addConditionalEdges('validate2', routeAfterValidate2, { audit: 'audit', spec: 'spec' })
    .addEdge('audit', 'persist')
    .addEdge('persist', 'summary')
    .addEdge('summary', END)

  const compiled = graph.compile()

  return {
    async invoke(init, options) {
      const state = await compiled.invoke(
        {
          request: init.request,
          round: init.round ?? 1,
          revisionReason: init.revisionReason,
          inputPages: [],
          pageBodies: [],
          mappingTargets: [],
          designAttempts: 0,
          specAttempts: 0,
          auditSuggestions: [],
          shortCircuited: false,
        },
        compiledInvokeOptions(options),
      )
      if (state.clarify !== undefined) {
        return {
          status: 'clarify',
          summary: '',
          artifactPages: [],
          clarify: state.clarify,
          experiment: undefined,
        }
      }
      if (state.summaryText === undefined || state.specDoc === undefined) {
        throw new Error('experiment plan graph finished without plan result')
      }
      return {
        status: 'completed',
        summary: state.summaryText,
        artifactPages: [],
        clarify: undefined,
        experiment: {
          specContent: state.specDoc.content,
          specRef: specPathOf(init.request, init.round ?? 1),
          designContent: state.designDoc?.content ?? '',
          auditReport: state.auditReport ?? '',
          deliverables: state.specDoc.deliverables ?? [],
        },
      }
    },
  }
}
