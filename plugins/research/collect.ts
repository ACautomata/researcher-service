// W4 experiment 调用③（结果 collect 图 · #912 · 853 §4.4「collect 段」）：
//
//   collect → summarize → validate → persist → summary
//   (确定性：spec 读回 + 交付物声明对账)  (LLM 实验报告页)  (形状档)  (experiment-report
//    页落 wiki + related_pages 输入页集 + 「关联页面」节 markdown 相对链接)
//
// 钉界（853 §4.4 · #868 D2/D4）：collect 输入 = spec 路径（request.source_paths[0]——
// 主 agent 从调用①批准结果拿到引用后发起 phase='collect'）；交付物声明经 deliverables.json
// 旁车恢复（experiment.ts persist 面落——markdown 正文无法可靠恢复结构化面）；对账 = 逐件
// lab.read 存在性（缺件清单必进 summary 不静默）；报告页 frontmatter related_pages 记输入
// 页集 + 正文「关联页面」节相对链接 = #789 graph 派生边（WikiGraph 可见；idea card 页自身
// V1 不动，边单向从报告页指出）。实验报告页机读标签 category: experiment-report
// （critic/idea 页 category 标签同族先例）。

import { END, START, StateGraph, Annotation, z } from '../../server/src/plugins/autofigureDeps'
import type { LangGraphRunnableConfig } from '../../server/src/plugins/autofigureDeps'
import type { PluginLabPort, PluginLabPortErrorCode, PluginLlmPort, PluginWikiPort } from '../../server/src/plugins/api'
import { PAGE_DRAFT_MAX, RECKONING_EXCERPT_MAX_CHARS, SPEC_DELIVERABLES_MAX } from './values'
import { buildCollectSummaryPrompt, EXPERIMENT_REPORT_CATEGORY_TAG } from './prompts'
import type { SpecSidecar } from './experimentPlan'
import { compiledInvokeOptions, stageReporterOf } from './graph'
import type { FlowGraphInvokeOptions, ResearchWorkflowRequest, WorkflowArtifactPage, WorkflowOutcome } from './graph'
import type { ClarifyResult } from './clarify'

// W4 collect 计算端口（wiki 建页 + lab 读面；llm pin 由装配层包装）。
export interface ExperimentCollectPorts {
  readonly llm: PluginLlmPort
  readonly wiki: Pick<PluginWikiPort, 'createPage'>
  readonly lab: Pick<PluginLabPort, 'read'>
}

// collect 段 spec 路径面：request.source_paths[0]（/lab/specs/<slug>/spec.md——主 agent
// 从批准结果引用透传；不经 slug 派生——collect 调用不带 question/topic）。
const SPEC_PATH_RE = /^\/lab\/specs\/[0-9a-f]+\/r[0-9]+\/spec\.md$/

// 交付物声明旁车读回 schema（0 信任——旁车落 /lab/specs/ 但调用②执行段的沙箱 agent
// 理论可触该路径；读回必经 zod，坏形态/超件数明确 fail 不静默截断）。
export const SPEC_SIDECAR_SCHEMA = z
  .object({
    deliverables: z
      .array(
        z.object({
          path: z.string().min(1),
          success_criterion: z.string(),
        }),
      )
      .max(SPEC_DELIVERABLES_MAX),
    inputPages: z.array(z.string().min(1)).max(32),
  })
  .strict()

const sidecarPathOf = (specPath: string): string => `${specPath.slice(0, specPath.lastIndexOf('/'))}/deliverables.json`

// 对账单件结果（summarize 输入面 + summary 不静默面）。content = 就位件的 excerpt
//（RECKONING_EXCERPT_MAX_CHARS 截断——已读取内容的驻留面，#912 review P1）。
// 四态语义（R0 review P1-1 + R1 review P2-1 细化）：
//   true  = 就位（含 unread 就位未读取——too_large/binary：文件系统层判定过存在）；
//   false = 确认缺失（not_found——引导补跑）；
//   undefined = 无法核验（invalid_path/sandbox_unavailable——存在性不可知：非法路径引导
//               补跑无意义、容器不可达时存在性断言无效，不计就位也不判缺失）。
export interface DeliverableReckoning {
  readonly path: string
  readonly success_criterion: string
  readonly present: boolean | undefined
  /** 非缺失误读的原因码（present=true 且 content=undefined = 就位未读取；present=undefined
   *  = 无法核验）。 */
  readonly unread?: PluginLabPortErrorCode
  readonly content: string | undefined
}

// 报告页产出 schema（H1 + 机读标签 + 结构化面——「关联页面」节由 persist 前确定性追加，
// LLM 不操持谱系格式）。
export const EXPERIMENT_REPORT_SCHEMA = z
  .object({
    title: z.string().min(1).max(512),
    content: z.string().min(1).max(PAGE_DRAFT_MAX.contentChars),
  })
  .strict()

type ExperimentReport = z.infer<typeof EXPERIMENT_REPORT_SCHEMA>

const COLLECT_CLARIFY_BAD_SPEC_PATH = (raw: string): ClarifyResult => ({
  status: 'clarify',
  candidates: [],
  question: `collect（结果对账）需要 spec 路径（/lab/specs/<slug>/r<N>/spec.md 形态——实验方案批准后工具返回的引用）；收到 ${raw}。请先完成实验方案设计与审批，再发起 collect。`,
})

const COLLECT_CLARIFY_SPEC_MISSING = (specPath: string): ClarifyResult => ({
  status: 'clarify',
  candidates: [],
  question: `spec 不存在或不可读：${specPath}。collect 对账以 spec 交付物声明为凭据——请确认实验方案已完成设计与审批（spec 落盘后再发起 collect）。`,
})

// ---------------------------------------------------------------------------
// 状态面
// ---------------------------------------------------------------------------

interface CollectState {
  request: ResearchWorkflowRequest
  specPath: string | undefined
  specContent: string | undefined
  sidecar: SpecSidecar | undefined
  reckonings: readonly DeliverableReckoning[]
  report: ExperimentReport | undefined
  clarify: ClarifyResult | undefined
  reportPage: WorkflowArtifactPage | undefined
  reportPagePreexisting: boolean | undefined
  summaryText: string | undefined
}

const CollectAnnotation = {
  request: Annotation<ResearchWorkflowRequest>,
  specPath: Annotation<string | undefined>,
  specContent: Annotation<string | undefined>,
  sidecar: Annotation<SpecSidecar | undefined>,
  reckonings: Annotation<readonly DeliverableReckoning[]>,
  report: Annotation<ExperimentReport | undefined>,
  clarify: Annotation<ClarifyResult | undefined>,
  reportPage: Annotation<WorkflowArtifactPage | undefined>,
  reportPagePreexisting: Annotation<boolean | undefined>,
  summaryText: Annotation<string | undefined>,
}

// 报告页 wiki 路径（experiment-reports/<specSlug>-<round>.md——spec 路径段派生确定性：
// /lab/specs/<slug>/r<N>/spec.md → slug = split[3]、round = split[4]；round 键控后人审
// 每轮修订各得其报告页，互不覆盖）。
export function experimentReportPathOf(specPath: string): string {
  const slug = specPath.split('/')[3]!
  const round = specPath.split('/')[4] ?? 'r1'
  return `experiment-reports/${slug}-${round}.md`
}

// ---------------------------------------------------------------------------
// 图工厂（纯函数——同 ports 必同拓扑）
// ---------------------------------------------------------------------------

export function createExperimentCollectGraph(ports: ExperimentCollectPorts): {
  invoke(init: { request: ResearchWorkflowRequest }, options?: FlowGraphInvokeOptions): Promise<WorkflowOutcome>
} {
  // collect（确定性）：spec 路径白名单 + 读回 spec 与旁车 + 逐件交付物对账。
  async function collectNode(
    state: CollectState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<CollectState>> {
    stageReporterOf(config)('collect')
    const raw = state.request.source_paths?.[0] ?? ''
    if (!SPEC_PATH_RE.test(raw)) return { clarify: COLLECT_CLARIFY_BAD_SPEC_PATH(raw) }
    const spec = await ports.lab.read({ path: raw })
    if (!spec.ok) {
      if (spec.error.code === 'not_found') return { clarify: COLLECT_CLARIFY_SPEC_MISSING(raw) }
      throw new Error(`spec 读回失败（${spec.error.code}）：${spec.error.message}`)
    }
    const sidecar = await ports.lab.read({ path: sidecarPathOf(raw) })
    if (!sidecar.ok) {
      throw new Error(`交付物声明旁车缺失（${sidecar.error.code}）——spec 目录被外部改动，无法确定性对账：${sidecar.error.message}`)
    }
    let sidecarJson: unknown
    try {
      sidecarJson = JSON.parse(sidecar.data.content)
    } catch {
      throw new Error('交付物声明旁车 JSON 解析失败——spec 目录被外部改动，无法确定性对账')
    }
    const parsed = SPEC_SIDECAR_SCHEMA.safeParse(sidecarJson)
    if (!parsed.success) {
      throw new Error(`交付物声明旁车校验失败——spec 目录被外部改动，无法确定性对账：${parsed.error.issues.map((i) => i.message).join('；')}`)
    }
    const deliverables = parsed.data.deliverables
    const reckonings: DeliverableReckoning[] = []
    for (const d of deliverables) {
      const r = await ports.lab.read({ path: d.path })
      if (r.ok) {
        reckonings.push({
          path: d.path,
          success_criterion: d.success_criterion,
          present: true,
          content: r.data.content.slice(0, RECKONING_EXCERPT_MAX_CHARS),
        })
      } else if (r.error.code === 'not_found') {
        reckonings.push({ path: d.path, success_criterion: d.success_criterion, present: false, content: undefined })
      } else if (r.error.code === 'invalid_path' || r.error.code === 'sandbox_unavailable') {
        // 无法核验（R1 review P2-1）：存在性不可知——非法路径（spec LLM 偶发声明非 /lab/
        // 前缀路径，无确定性校验面）引导补跑无意义，容器瞬态时「就位」断言无效。
        reckonings.push({ path: d.path, success_criterion: d.success_criterion, present: undefined, unread: r.error.code, content: undefined })
      } else {
        // 就位但读不回（too_large 16MiB 护栏 / binary——文件系统层判定过存在，R0 review
        // P1-1：20MB 实验产物是真交付物，误报「缺失请补跑」会误导重跑）。
        reckonings.push({
          path: d.path,
          success_criterion: d.success_criterion,
          present: true,
          unread: r.error.code,
          content: undefined,
        })
      }
    }
    return { specPath: raw, specContent: spec.data.content, sidecar: parsed.data, reckonings }
  }

  function routeAfterCollect(state: CollectState): 'summarize' | 'end' {
    return state.clarify !== undefined ? 'end' : 'summarize'
  }

  // summarize（LLM）：对账结果 + spec → 实验报告页（H1 + 标签由节点确定性组装——
  // LLM 产正文段，机读标签/谱系节格式零知识，critic/idea 渲染先例）。
  // **不在长页生成五节点重试覆盖面**（853 §7.1 覆盖面 = W1 create / W2 extract+critic /
  // W4 design+spec；同 W3 bucket/challenge 豁免先例——#906 口径注记）；报告页结构化
  // 失败即该调用 fail。
  async function summarizeNode(
    state: CollectState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<CollectState>> {
    stageReporterOf(config)('summarize')
    const value = await ports.llm.generateStructured({
      schema: EXPERIMENT_REPORT_SCHEMA,
      contents: [
        buildCollectSummaryPrompt({
          specContent: state.specContent!,
          reckonings: state.reckonings,
        }),
      ],
    })
    return { report: value }
  }

  // validate（确定性形状档）：首行 = ## 实验目标（prompt 钉的首节——H1/机读标签归
  // persist 面统一组装，「关联页面」节归确定性追加，均不在 LLM 契约内）。
  function validateNode(state: CollectState, config: LangGraphRunnableConfig | undefined): Partial<CollectState> {
    stageReporterOf(config)('validate')
    const firstLine = state.report!.content.split('\n')[0] ?? ''
    if (!/^##\s+实验目标\s*$/.test(firstLine)) {
      throw new Error('实验报告页校验失败：content 首行须为「## 实验目标」节标题（H1 与机读标签由写入面组装）')
    }
    return {}
  }

  // persist：报告页落 wiki——「关联页面」节确定性追加（markdown 相对链接到输入页集，
  // #789 graph 派生边消费面）；related_pages frontmatter 记输入页集（provenance 面，
  // #868 D2）。createPage 幂等哨兵（重放窗口防重复建页）。
  async function persistNode(
    state: CollectState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<CollectState>> {
    stageReporterOf(config)('persist')
    const inputPages = state.sidecar!.inputPages ?? []
    const relatedSection =
      inputPages.length > 0
        ? `\n\n## 关联页面\n\n${inputPages.map((p) => `- [${p}](${p})`).join('\n')}\n`
        : ''
    const path = experimentReportPathOf(state.specPath!)
    const r = await ports.wiki.createPage(
      {
        path,
        title: state.report!.title,
        type: 'report',
        content: `# ${state.report!.title}\n\n${EXPERIMENT_REPORT_CATEGORY_TAG}\n\n${state.report!.content}${relatedSection}`,
      },
      { workflow: 'experiment', ...(inputPages.length > 0 ? { relatedPages: inputPages } : {}) },
    )
    if (!r.ok) throw new Error(`实验报告页写入失败（${r.error.code}）：${r.error.message}`)
    return { reportPage: { path, title: state.report!.title }, reportPagePreexisting: !r.data.created }
  }

  // summary：报告页路径 + 对账结果（缺件清单必进不静默；无法核验与幂等跳过如实标注）。
  function summaryNode(state: CollectState, config: LangGraphRunnableConfig | undefined): Partial<CollectState> {
    stageReporterOf(config)('summary')
    const missing = state.reckonings.filter((r) => r.present === false)
    const unread = state.reckonings.filter((r) => r.present === true && r.unread !== undefined)
    const unverifiable = state.reckonings.filter((r) => r.present === undefined)
    const lines = [
      `实验报告已落 wiki：${state.reportPage!.path}${state.reportPagePreexisting ? '（页面已存在，幂等跳过——现有内容未覆盖）' : ''}。`,
      `交付物对账：${state.reckonings.length - missing.length - unverifiable.length}/${state.reckonings.length} 件就位。`,
    ]
    if (unread.length > 0) {
      lines.push(
        `其中 ${unread.length} 件就位但内容未能读取（${unread.map((r) => `${r.path}：${r.unread}`).join('；')}），报告页如实记录、未读取不视为缺失。`,
      )
    }
    if (unverifiable.length > 0) {
      lines.push(
        `其中 ${unverifiable.length} 件无法核验（${unverifiable.map((r) => `${r.path}：${r.unread}`).join('；')}）——不计入就位也不判缺失，请检查 spec 交付物声明路径与沙箱可用性。`,
      )
    }
    if (missing.length > 0) {
      lines.push(
        `缺失交付物 ${missing.length} 件（报告页已如实记录；请补跑执行段后重新 collect——报告页为幂等不覆盖，重 collect 后最新对账以本次 summary 为准）：`,
      )
      for (const m of missing) lines.push(`- ${m.path}（成功判据：${m.success_criterion}）`)
    }
    return { summaryText: lines.join('\n') }
  }

  const graph = new StateGraph({ stateSchema: Annotation.Root(CollectAnnotation) })
    .addNode('collect', collectNode)
    .addNode('summarize', summarizeNode)
    .addNode('validate', validateNode)
    .addNode('persist', persistNode)
    .addNode('summary', summaryNode)
    .addEdge(START, 'collect')
    .addConditionalEdges('collect', routeAfterCollect, { summarize: 'summarize', end: END })
    .addEdge('summarize', 'validate')
    .addEdge('validate', 'persist')
    .addEdge('persist', 'summary')
    .addEdge('summary', END)

  const compiled = graph.compile()

  return {
    async invoke(init, options) {
      const state = await compiled.invoke(
        { request: init.request, reckonings: [] },
        compiledInvokeOptions(options),
      )
      if (state.clarify !== undefined) {
        return { status: 'clarify', summary: '', artifactPages: [], clarify: state.clarify }
      }
      if (state.summaryText === undefined || state.reportPage === undefined) {
        throw new Error('experiment collect graph finished without report page')
      }
      return { status: 'completed', summary: state.summaryText, artifactPages: [state.reportPage] }
    },
  }
}
