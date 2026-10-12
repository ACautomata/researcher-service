// W2 discover 科学问题可信发现九节点图（#910 · 853 §4.2 · #848 §2 prompt 资产）：
//
//   resolveInputs → load → extract → validate¹ → critic → validate² → evidenceGate → persist → summary
//    (论文页定位,      (回读     (12 节)   (节checklist+   (§0–§7)  (候选2–4+     (引用存在性      (critic 页)
//     缺→clarify)      11节锚)            三态禁语)                category标签)  回查+剔除出口)
//
// 钉界（853 §4.2）：单论文 extract→critic 链；跨论文 gap 发现归 W3 contextPack。两个 validate
// 检查对象不同，分列不共享 schema 名。extract/critic 重试触发面三源扩展（#906，同 W1 create）：
// 截断 ∨ 结构化解析失败 ∨ validate 拒 → 回生成节点重试 1 次附诊断，K≤2 有界。
//
// clarify 出口（产物串联）：论文页缺失/形态不符 → clarify 提示先 ingest（853 §1.3 同款
// Result 回喂形态，零新 interrupt 机制）。确定性失败语义（evidenceGate 后的 persist/verify
// 面）同 W1：throw Error 出图 → 工具面 failed。

import { END, START, StateGraph, Annotation, z } from '../../server/src/plugins/autofigureDeps'
import type { LangGraphRunnableConfig } from '../../server/src/plugins/autofigureDeps'
import type { PluginLlmPort, PluginWikiPort } from '../../server/src/plugins/api'
import { PAGE_DRAFT_MAX } from './values'
import { validateExtractDoc, validateCriticDoc, classifyEvidenceRef } from './pageValidate'
import type { CriticCandidate } from './pageValidate'
import { buildCriticPrompt, buildExtractPrompt, headingAnchor, PAPER_PAGE_ANCHORS } from './prompts'
import { generateWithBoundedRetry } from './generate'
import { stageReporterOf } from './graph'
import type { ResearchWorkflowRequest, WorkflowOutcome, WorkflowArtifactPage } from './graph'
import type { ClarifyResult } from './clarify'

// extract 12 节文档产出 schema（content 单槽；12 节 checklist 归 validate¹ 确定性面——zod
// 层不锁节数，拒时由校验清单出精确诊断回喂）。
export const EXTRACT_DOC_SCHEMA = z.object({ content: z.string().min(1).max(PAGE_DRAFT_MAX.contentChars) }).strict()

// critic §0–§7 产出 schema（content + 候选问题结构化面 = critic→design 边上传输 schema，
// 853 §4.2「带优先级」）。candidates 数量 2–4 归 validate² 确定性面（zod 层宽容——LLM 给 5
// 个时 zod 直拒无针对性诊断，校验层出「须 2–4」诊断重试可修）；.optional() 同 W1（与
// z.ZodType<T> 契约相容），消费面 ?? []。
export const CRITIC_DOC_SCHEMA = z
  .object({
    content: z.string().min(1).max(PAGE_DRAFT_MAX.contentChars),
    candidates: z
      .array(
        z.object({
          question: z.string().min(1),
          priority: z.enum(['high', 'medium', 'low']),
          evidence: z.array(z.string().min(1)).max(PAGE_DRAFT_MAX.evidencePerClaim).optional(),
        }),
      )
      .max(10)
      .optional(),
  })
  .strict()

type CriticDoc = z.infer<typeof CRITIC_DOC_SCHEMA>

// W2 计算端口（llm pin 由装配层包装；wiki 三方法 = 定位/读页/建页）。
export interface DiscoverPorts {
  readonly llm: PluginLlmPort
  readonly wiki: Pick<PluginWikiPort, 'search' | 'readPage' | 'createPage'>
}

// extract/critic 两条重试链各自独立计数（K≤2 有界面见 values.PAGE_GENERATE_MAX_ATTEMPTS，
// 生成骨架共享面见 generate.ts）。

// clarify 出口文案（面向主 agent 的指令性引导，853 §1.3 同形态——candidates 空 = 无流程
// 候选可列，缺失的是输入产物：提示先 ingest）。
export const DISCOVER_CLARIFY_NOT_INGESTED =
  'wiki 中未找到目标论文页（或论文页不是 11 节论文页形态）。科研问题发现流程以已入库论文为输入——请先对目标 PDF 发起 /ingest 知识库深度构建流程，入库成功后再重新发起 discover。'

const notIngestedClarify = (): ClarifyResult => ({
  status: 'clarify',
  candidates: [],
  question: DISCOVER_CLARIFY_NOT_INGESTED,
})

// 论文页 slug（papers/<slug>.md 的 slug 段——critic 页路径派生）。
function paperSlugOf(paperPath: string): string {
  const base = paperPath.split('/').pop() ?? paperPath
  return base.replace(/\.md$/i, '')
}

// critic 页标题：critic 文档 H1 行提取（#848 critic 模板首行 `# Title`）；缺 → fallback。
function criticTitleOf(content: string, fallback: string): string {
  const h1 = /^#\s+(.+)$/m.exec(content)
  return h1 ? h1[1]!.trim() : fallback
}

// 节标题行精确匹配（`^## <text>` 行级——includes 子串弱匹配会误放正文对节名的提及）。
function sectionHeadingLine(doc: string, headingText: string): boolean {
  return new RegExp(`^##\\s*${headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(doc)
}

// ---------------------------------------------------------------------------
// 状态面
// ---------------------------------------------------------------------------

interface DiscoverState {
  request: ResearchWorkflowRequest
  paperPath: string | undefined
  paperContent: string | undefined
  extractDoc: string | undefined
  extractAttempts: number
  criticDoc: CriticDoc | undefined
  criticAttempts: number
  diagnostics: string | undefined
  clarify: ClarifyResult | undefined
  culled: readonly string[] | undefined
  criticPagePath: string | undefined
  persistedCreated: boolean | undefined
  summaryText: string | undefined
}

const DiscoverAnnotation = {
  request: Annotation<ResearchWorkflowRequest>,
  paperPath: Annotation<string | undefined>,
  paperContent: Annotation<string | undefined>,
  extractDoc: Annotation<string | undefined>,
  extractAttempts: Annotation<number>,
  criticDoc: Annotation<CriticDoc | undefined>,
  criticAttempts: Annotation<number>,
  diagnostics: Annotation<string | undefined>,
  clarify: Annotation<ClarifyResult | undefined>,
  culled: Annotation<readonly string[] | undefined>,
  criticPagePath: Annotation<string | undefined>,
  persistedCreated: Annotation<boolean | undefined>,
  summaryText: Annotation<string | undefined>,
}

export interface DiscoverGraphInvokeOptions {
  readonly onStage?: (stage: string) => void
  readonly signal?: AbortSignal
}

export function createDiscoverGraph(ports: DiscoverPorts): {
  invoke(init: { request: ResearchWorkflowRequest }, options?: DiscoverGraphInvokeOptions): Promise<WorkflowOutcome>
} {
  // resolveInputs（确定性）：论文页定位——source_paths 钉定（.md 论文页形态）或检索定位
  //（question/topic → wiki search top hit）。定位不出 → clarify 出口（产物串联：提示先
  // ingest）。
  async function resolveInputsNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Promise<Partial<DiscoverState>> {
    stageReporterOf(config)('resolveInputs')
    const given = state.request.source_paths
    if (given !== undefined && given.length > 0) {
      const p = given[0]!
      if (!p.endsWith('.md')) {
        return {
          clarify: {
            status: 'clarify',
            candidates: [],
            question: `discover 的输入是已入库论文的 wiki 页（.md 路径，如 papers/<slug>.md）；收到 ${p}。若尚未入库，请先对该 PDF 发起 /ingest。`,
          },
        }
      }
      return { paperPath: p }
    }
    const query = state.request.question ?? state.request.topic ?? ''
    if (query.trim() === '') {
      return { clarify: notIngestedClarify() }
    }
    const r = await ports.wiki.search(query, { limit: 5 })
    if (!r.ok || r.data.results.length === 0) {
      return { clarify: notIngestedClarify() }
    }
    // ref 形态 = "<page>.md#<anchor>"（openwiki 检索契约，wikisearch 同语义）——页路径取 # 前。
    const page = (r.data.results[0]!.ref[0] ?? '').split('#')[0]!
    if (page === '') return { clarify: notIngestedClarify() }
    return { paperPath: page }
  }

  function routeAfterResolve(state: DiscoverState): 'load' | 'end' {
    return state.clarify !== undefined ? 'end' : 'load'
  }

  // load：11 节锚全量回读（W1 页形契约——W2 消费 W1 产物，产物串联）。失败（不存在/
  // 形态不符）→ clarify 出口，不重试不 throw（缺输入是用户动作面问题，非流程故障）。
  async function loadNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Promise<Partial<DiscoverState>> {
    stageReporterOf(config)('load')
    const r = await ports.wiki.readPage(state.paperPath!, PAPER_PAGE_ANCHORS)
    if (!r.ok || r.data.sections.length < PAPER_PAGE_ANCHORS.length) {
      return { clarify: notIngestedClarify() }
    }
    return { paperContent: r.data.sections.map((s) => s.content).join('\n\n') }
  }

  function routeAfterLoad(state: DiscoverState): 'extract' | 'end' {
    return state.clarify !== undefined ? 'end' : 'extract'
  }

  // extract（LLM 12 节）：生成骨架（attempts 有界 + 三源诊断捕获）共享面见 generate.ts；
  // 三源诊断（截断/解析失败/validate¹ 拒）统一经 state.diagnostics 回喂。
  async function extractNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Promise<Partial<DiscoverState>> {
    stageReporterOf(config)('extract')
    const r = await generateWithBoundedRetry<z.infer<typeof EXTRACT_DOC_SCHEMA>>({
      llm: ports.llm,
      schema: EXTRACT_DOC_SCHEMA,
      prompt: buildExtractPrompt(state.paperContent!, state.diagnostics),
      attemptsSoFar: state.extractAttempts,
      diagnostics: state.diagnostics,
      nodeLabel: 'extract 文档',
    })
    if (r.value === undefined) {
      return { extractAttempts: r.attempts, extractDoc: undefined, diagnostics: r.diagnostics }
    }
    return { extractAttempts: r.attempts, extractDoc: r.value.content }
  }

  // validate¹（确定性）：extract 12 节节标题 checklist + 三态标注禁语扫描。与 validate²
  // 检查对象不同，分列不共享 schema 名（853 §4.2）。
  function validate1Node(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Partial<DiscoverState> {
    stageReporterOf(config)('validate')
    const doc = state.extractDoc
    const validation = doc === undefined ? { ok: false as const, issues: [state.diagnostics ?? '上一轮 extract 产出缺失'] } : validateExtractDoc(doc)
    return { diagnostics: validation.ok ? undefined : validation.issues.join('；') }
  }

  function routeAfterValidate1(state: DiscoverState): 'critic' | 'extract' {
    return state.diagnostics === undefined ? 'critic' : 'extract'
  }

  // critic（LLM §0–§7）：输入 = 论文页 + extract 文档；产出 = 分析正文 + 候选问题结构化面。
  async function criticNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Promise<Partial<DiscoverState>> {
    stageReporterOf(config)('critic')
    const r = await generateWithBoundedRetry<CriticDoc>({
      llm: ports.llm,
      schema: CRITIC_DOC_SCHEMA,
      prompt: buildCriticPrompt(state.paperContent!, state.extractDoc!, state.diagnostics),
      attemptsSoFar: state.criticAttempts,
      diagnostics: state.diagnostics,
      nodeLabel: 'critic 文档',
    })
    if (r.value === undefined) {
      return { criticAttempts: r.attempts, criticDoc: undefined, diagnostics: r.diagnostics }
    }
    return { criticAttempts: r.attempts, criticDoc: r.value, diagnostics: undefined }
  }

  // validate²（确定性）：critic §0–§7 节齐全 + `category: critic` 机读标签 + 候选 2–4。
  function validate2Node(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Partial<DiscoverState> {
    stageReporterOf(config)('validate')
    const doc = state.criticDoc
    const validation =
      doc === undefined
        ? { ok: false as const, issues: [state.diagnostics ?? '上一轮 critic 产出缺失'] }
        : validateCriticDoc({ content: doc.content, candidates: doc.candidates ?? [] })
    return { diagnostics: validation.ok ? undefined : validation.issues.join('；') }
  }

  function routeAfterValidate2(state: DiscoverState): 'evidenceGate' | 'critic' {
    return state.diagnostics === undefined ? 'evidenceGate' : 'critic'
  }

  // evidenceGate（确定性）：候选问题 evidence 引用存在性回查（853 §4.2）——wiki 页/节锚
  //（输入论文页已在 load 确认，节锚按节标题行精确匹配；他页经 search 页存在性 + readPage
  // 节锚回查）、lab 上传件锚（形态校验——上传件存在性探针不在插件数据口面［#752 窄域钉］，
  // 由 ingest 产物串联保证，V1 边界）、extract 节锚（内存文档节标题行检查）；描述性引用
  // 无可回查锚放行。剔除 = 溯源信息，清单必进 summary（「剔除条目清单必进 summary——剔除
  // 本身就是溯源信息」）；evidence 剔空 → 整条候选不进 claims 提交面（整条剔除单独记录）。
  async function evidenceGateNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Promise<Partial<DiscoverState>> {
    stageReporterOf(config)('evidenceGate')
    const culled: string[] = []
    // survivors 元素 = CriticDoc candidates 同形（evidence mutable——zod 产物面）。
    const survivors: { question: string; priority: CriticCandidate['priority']; evidence: string[] }[] = []
    for (const candidate of state.criticDoc!.candidates ?? []) {
      const keptEvidence: string[] = []
      for (const ref of candidate.evidence ?? []) {
        const parsed = classifyEvidenceRef(ref)
        let alive = true
        let reason = ''
        if (parsed.kind === 'wiki-page') {
          if (parsed.path === state.paperPath) {
            if (parsed.section !== undefined && !sectionHeadingLine(state.paperContent!, parsed.section)) {
              alive = false
              reason = '论文页中不存在该节'
            }
          } else {
            const hit = await ports.wiki.search(parsed.path, { paths: [parsed.path], limit: 1 })
            if (!hit.ok || hit.data.results.length === 0) {
              alive = false
              reason = '引用的 wiki 页不存在'
            } else if (parsed.section !== undefined) {
              const sec = await ports.wiki.readPage(parsed.path, [headingAnchor(parsed.section)])
              if (!sec.ok || sec.data.sections.length === 0) {
                alive = false
                reason = '引用的 wiki 页中不存在该节'
              }
            }
          }
        } else if (parsed.kind === 'lab-file') {
          if (!parsed.path.startsWith('/lab/uploads/') || !parsed.path.endsWith('.pdf')) {
            alive = false
            reason = '上传件路径形态非法（须 /lab/uploads/*.pdf）'
          }
        } else if (parsed.kind === 'extract-node') {
          if (!sectionHeadingLine(state.extractDoc!, `${parsed.section} `)) {
            alive = false
            reason = 'extract 文档中不存在该节'
          }
        }
        if (alive) keptEvidence.push(ref)
        else culled.push(`${ref}（${candidate.question}）：${reason}`)
      }
      if (keptEvidence.length > 0 || (candidate.evidence ?? []).length === 0) {
        survivors.push({ question: candidate.question, priority: candidate.priority, evidence: keptEvidence })
      } else {
        culled.push(`候选「${candidate.question}」整条剔除：全部证据引用不可溯源`)
      }
    }
    return { culled, criticDoc: { ...state.criticDoc!, candidates: survivors } }
  }

  // persist：critic 页（type='critic'）+ claims（候选问题结构化面 → port 组装 OKF 块）；
  // provenance.relatedPages 记输入论文页（产物串联的图面）。
  async function persistNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Promise<Partial<DiscoverState>> {
    stageReporterOf(config)('persist')
    const doc = state.criticDoc!
    const slug = paperSlugOf(state.paperPath!)
    const path = `critics/${slug}.md`
    const claims = (doc.candidates ?? []).map((c) => ({ statement: c.question, evidence: c.evidence ?? [] }))
    const r = await ports.wiki.createPage(
      {
        path,
        title: criticTitleOf(doc.content, `论文评审：${slug}`),
        type: 'critic',
        content: doc.content,
        claims,
      },
      { workflow: 'discover', relatedPages: [state.paperPath!] },
    )
    if (!r.ok) throw new Error(`critic 页写入失败（${r.error.code}）：${r.error.message}`)
    return { criticPagePath: path, persistedCreated: r.data.created }
  }

  // summary：≤1k + 产物路径 + 候选存活数 + 剔除清单（不静默）。
  function summaryNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Partial<DiscoverState> {
    stageReporterOf(config)('summary')
    const created = state.persistedCreated === true
    const survived = (state.criticDoc!.candidates ?? []).length
    const lines = [
      `审稿式问题分析已产出：${state.criticPagePath}（${created ? '新建页面' : '页面已存在，幂等跳过'}）。`,
      `输入论文页：${state.paperPath} · 验证候选问题 ${survived} 条（已入 claims）。`,
    ]
    if (state.culled !== undefined && state.culled.length > 0) {
      lines.push(`evidenceGate 剔除 ${state.culled.length} 条证据引用：${state.culled.join('；')}`)
    }
    const summary = lines.join('\n')
    return { summaryText: summary.length <= 1000 ? summary : `${summary.slice(0, 999)}…` }
  }

  const graph = new StateGraph({ stateSchema: Annotation.Root(DiscoverAnnotation) })
    .addNode('resolveInputs', resolveInputsNode)
    .addNode('load', loadNode)
    .addNode('extract', extractNode)
    .addNode('validate1', validate1Node)
    .addNode('critic', criticNode)
    .addNode('validate2', validate2Node)
    .addNode('evidenceGate', evidenceGateNode)
    .addNode('persist', persistNode)
    .addNode('summary', summaryNode)
    .addEdge(START, 'resolveInputs')
    .addConditionalEdges('resolveInputs', routeAfterResolve, { load: 'load', end: END })
    .addConditionalEdges('load', routeAfterLoad, { extract: 'extract', end: END })
    .addEdge('extract', 'validate1')
    .addConditionalEdges('validate1', routeAfterValidate1, { critic: 'critic', extract: 'extract' })
    .addEdge('critic', 'validate2')
    .addConditionalEdges('validate2', routeAfterValidate2, { evidenceGate: 'evidenceGate', critic: 'critic' })
    .addEdge('evidenceGate', 'persist')
    .addEdge('persist', 'summary')
    .addEdge('summary', END)

  const compiled = graph.compile()

  return {
    async invoke(init, options) {
      const state = await compiled.invoke(
        { request: init.request, extractAttempts: 0, criticAttempts: 0 },
        {
          ...(options?.signal ? { signal: options.signal } : {}),
          configurable: { onStage: options?.onStage },
        },
      )
      if (state.clarify !== undefined) {
        return { status: 'clarify', summary: '', artifactPages: [], clarify: state.clarify }
      }
      if (state.summaryText === undefined || state.criticPagePath === undefined || state.criticDoc === undefined) {
        throw new Error('discover graph finished without summary')
      }
      const artifactPage: WorkflowArtifactPage = {
        path: state.criticPagePath,
        title: criticTitleOf(state.criticDoc.content, `论文评审：${paperSlugOf(state.paperPath!)}`),
      }
      return { status: 'completed', summary: state.summaryText, artifactPages: [artifactPage] }
    },
  }
}
