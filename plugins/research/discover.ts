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
//
// 路径域约定（PR #917 review P0）：图内状态（paperPath/artifactPages/evidence 引用）一律
// 写面 rel 域（papers/x.md）；readPage 调用点经 wikiReadPathOf 换算读面虚拟前缀——见 graph.ts。

import { END, START, StateGraph, Annotation, z } from '../../server/src/plugins/autofigureDeps'
import type { LangGraphRunnableConfig } from '../../server/src/plugins/autofigureDeps'
import type { PluginLlmPort, PluginWikiPort } from '../../server/src/plugins/api'
import { RESOLVE_INPUTS_SEARCH_LIMIT, SOURCE_PATHS_V1_MAX } from './values'
import {
  EXTRACT_DOC_SCHEMA,
  CRITIC_DOC_SCHEMA,
  validateExtractDoc,
  validateCriticDoc,
  classifyEvidenceRef,
  escapeRegExp,
} from './pageValidate'
import type { CriticCandidate, CriticDoc } from './pageValidate'
import { buildCriticPrompt, buildExtractPrompt, headingAnchor, PAPER_PAGE_ANCHORS } from './prompts'
import { generateWithBoundedRetry } from './generate'
import { compiledInvokeOptions, stageReporterOf, toWikiRelPath, wikiReadPathOf } from './graph'
import type { FlowGraphInvokeOptions, ResearchWorkflowRequest, WorkflowOutcome, WorkflowArtifactPage } from './graph'
import type { ClarifyResult } from './clarify'

// W2 计算端口（llm pin 由装配层包装；wiki 三方法 = 定位/读页/建页）。
export interface DiscoverPorts {
  readonly llm: PluginLlmPort
  readonly wiki: Pick<PluginWikiPort, 'search' | 'readPage' | 'createPage'>
}

// discover 单论文钉界（853 §4.2）——与 W1 V1 单篇同口径（同值派生自 values.SOURCE_PATHS_V1_MAX
// 防双表漂移，PR #917 review r1 S 新1；按 W2 输入是论文页非上传件另立名防语义混用）。
const SOURCE_PATHS_DISCOVER_MAX = SOURCE_PATHS_V1_MAX

// extract/critic 两条重试链各自独立计数（K≤2 有界面见 values.PAGE_GENERATE_MAX_ATTEMPTS，
// 生成骨架共享面见 generate.ts）。

// clarify 出口文案（面向主 agent 的指令性引导，853 §1.3 同形态——candidates 空 = 无流程
// 候选可列，缺失的是输入产物：提示先 ingest）。
const DISCOVER_CLARIFY_NOT_INGESTED =
  'wiki 中未找到目标论文页（或论文页不是 11 节论文页形态）。科研问题发现流程以已入库论文为输入——请先对目标 PDF 发起 /ingest 知识库深度构建流程，入库成功后再重新发起 discover。'

const notIngestedClarify = (): ClarifyResult => ({
  status: 'clarify',
  candidates: [],
  question: DISCOVER_CLARIFY_NOT_INGESTED,
})

// 论文页 slug（papers/<slug>.md 的 slug 段——critic 页路径派生）。
function paperSlugOf(paperPath: string): string {
  const base = paperPath.split('/').pop()!
  return base.replace(/\.md$/i, '')
}

// critic 页标题：critic 文档 H1 行提取（#848 critic 模板首行 `# Title`）；缺 → fallback。
function criticTitleOf(content: string, fallback: string): string {
  const h1 = /^#\s+(.+)$/m.exec(content)
  return h1 ? h1[1]!.trim() : fallback
}

// 节标题行精确匹配（`^## <text>` 行级——includes 子串弱匹配会误放正文对节名的提及）。
function sectionHeadingLine(doc: string, headingText: string): boolean {
  return new RegExp(`^##\\s*${escapeRegExp(headingText)}`, 'm').test(doc)
}

// 裸页引用（无节锚）存在性回查哨兵锚（PR #917 review Spec#8）：openwiki readPage 需
// ≥1 节锚（空锚即拒）——用「合法且理论必不存在」的锚探页存在性：not_found = 页不存在；
// Unknown sections（invalid_input）= 页存在、哨兵节缺失 → 放行。
const BARE_PAGE_PROBE_ANCHOR = 'evidence-gate-page-existence-probe'

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
  criticPageTitle: string | undefined
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
  criticPageTitle: Annotation<string | undefined>,
  persistedCreated: Annotation<boolean | undefined>,
  summaryText: Annotation<string | undefined>,
}

export function createDiscoverGraph(ports: DiscoverPorts): {
  invoke(init: { request: ResearchWorkflowRequest }, options?: FlowGraphInvokeOptions): Promise<WorkflowOutcome>
} {
  // resolveInputs（确定性）：论文页定位——source_paths 钉定（papers/*.md 论文页形态白名单，
  // 853 §4 横切「路径前缀白名单」；V1 单篇与 W1 capture 同口径 throw）或检索定位
  //（question/topic → wiki search，结果按 papers/ 前缀过滤——FTS OR 匹配无页型过滤，
  // critic 页/杂页可混入，PR #917 review Spec#6）。定位不出 → clarify 出口（产物串联：
  // 提示先 ingest）。
  async function resolveInputsNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Promise<Partial<DiscoverState>> {
    stageReporterOf(config)('resolveInputs')
    const given = state.request.source_paths
    if (given !== undefined && given.length > 0) {
      if (given.length > SOURCE_PATHS_DISCOVER_MAX) {
        throw new Error(`discover 单论文链（V1 单篇）：一次调用只处理一篇论文页（收到 ${given.length} 个路径），请逐篇发起`)
      }
      const p = toWikiRelPath(given[0]!)
      // 段检查与 evidenceGate 同款（`..`/`.` 穿越形态拒）——白名单防御对称，PR #917
      // review r1 S 新3。
      const malformed =
        !p.startsWith('papers/') ||
        !p.endsWith('.md') ||
        p.split('/').some((seg) => seg === '.' || seg === '..')
      if (malformed) {
        return {
          clarify: {
            status: 'clarify',
            candidates: [],
            question: `discover 的输入是已入库论文的 wiki 页（papers/<slug>.md 形态）；收到 ${given[0]}。若尚未入库，请先对该 PDF 发起 /ingest。`,
          },
        }
      }
      return { paperPath: p }
    }
    const query = state.request.question ?? state.request.topic ?? ''
    if (query.trim() === '') {
      return { clarify: notIngestedClarify() }
    }
    const r = await ports.wiki.search(query, { limit: RESOLVE_INPUTS_SEARCH_LIMIT })
    if (!r.ok) {
      return { clarify: notIngestedClarify() }
    }
    // ref 形态 = "openwiki/<page>.md#<anchor>"（检索镜像虚拟前缀，openwiki 检索契约）——
    // 归一化到写面 rel 域后按 papers/ 前缀过滤，取首条可信命中。
    const paperHit = r.data.results
      .map((hit) => toWikiRelPath((hit.ref[0] ?? '').split('#')[0]!))
      .find((page) => page.startsWith('papers/') && page.endsWith('.md'))
    if (paperHit === undefined) return { clarify: notIngestedClarify() }
    return { paperPath: paperHit }
  }

  function routeAfterResolve(state: DiscoverState): 'load' | 'end' {
    return state.clarify !== undefined ? 'end' : 'load'
  }

  // load：11 节锚全量回读（W1 页形契约——W2 消费 W1 产物，产物串联）。失败（不存在/
  // 形态不符）→ clarify 出口，不重试不 throw（缺输入是用户动作面问题，非流程故障）。
  async function loadNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Promise<Partial<DiscoverState>> {
    stageReporterOf(config)('load')
    const r = await ports.wiki.readPage(wikiReadPathOf(state.paperPath!), PAPER_PAGE_ANCHORS)
    // openwiki readWikiSections 缺锚即 throw（ok:true 时 sections 与锚恒等长）——无长度
    // 防御位（PR #917 review r1 S 新2：不可达防御移除，与 ingest verifyNode 同形）。
    if (!r.ok) {
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
    return { extractAttempts: r.attempts, extractDoc: r.value.content, diagnostics: undefined }
  }

  // validate¹（确定性）：extract 12 节节标题 checklist + 三态标注禁语扫描。与 validate²
  // 检查对象不同，分列不共享 schema 名（853 §4.2）。
  function validate1Node(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Partial<DiscoverState> {
    stageReporterOf(config)('validate')
    const doc = state.extractDoc
    // extractDoc 缺失（上轮解析失败）→ 诊断面 = 失败诊断（该路径 diagnostics 必已定义——图不变量）。
    const validation = doc === undefined ? { ok: false as const, issues: [state.diagnostics!] } : validateExtractDoc(doc)
    return { diagnostics: validation.ok ? undefined : validation.issues.join('；') }
  }

  function routeAfterValidate1(state: DiscoverState): 'critic' | 'extract' {
    return state.diagnostics === undefined ? 'critic' : 'extract'
  }

  // critic（LLM §0–§7）：输入 = 论文页 + extract 文档 + 真实论文页路径（evidence 引用
  // 指引锚——PR #917 review Spec#4）；产出 = 分析正文 + 候选问题结构化面。
  async function criticNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Promise<Partial<DiscoverState>> {
    stageReporterOf(config)('critic')
    const r = await generateWithBoundedRetry<CriticDoc>({
      llm: ports.llm,
      schema: CRITIC_DOC_SCHEMA,
      prompt: buildCriticPrompt(state.paperContent!, state.extractDoc!, state.paperPath!, state.diagnostics),
      attemptsSoFar: state.criticAttempts,
      diagnostics: state.diagnostics,
      nodeLabel: 'critic 文档',
    })
    if (r.value === undefined) {
      return { criticAttempts: r.attempts, criticDoc: undefined, diagnostics: r.diagnostics }
    }
    return { criticAttempts: r.attempts, criticDoc: r.value, diagnostics: undefined }
  }

  // validate²（确定性）：critic §0–§7 节齐全 + `category: critic` 机读标签（H1 下独占行）
  // + 候选 2–4。
  function validate2Node(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Partial<DiscoverState> {
    stageReporterOf(config)('validate')
    const doc = state.criticDoc
    const validation =
      doc === undefined
        ? { ok: false as const, issues: [state.diagnostics!] }
        : validateCriticDoc({ content: doc.content, candidates: doc.candidates ?? [] })
    return { diagnostics: validation.ok ? undefined : validation.issues.join('；') }
  }

  function routeAfterValidate2(state: DiscoverState): 'evidenceGate' | 'critic' {
    return state.diagnostics === undefined ? 'evidenceGate' : 'critic'
  }

  // evidenceGate（确定性）：候选问题 evidence 引用存在性回查（853 §4.2 钉三类）——
  // ① 输入论文页节锚（load 已确认页存在，节锚按节标题行精确匹配）；② 他 wiki 页（存在性
  // 唯一可靠通道 = readPage not_found——FTS search 的 paths 参数是 ranking hint 非过滤器，
  // 不作存在性判据，PR #917 review Spec#8；节锚回查 readPage([headingAnchor(section)])）；
  // ③ lab 上传件锚（形态校验——上传件存在性探针不在插件数据口面［#752 窄域钉］，由 ingest
  // 产物串联保证，V1 明示降级）。描述性引用（含 extract 文档内容引用——内存中间产物非
  // wiki 页，PR #917 review Spec#14）无可回查锚放行。剔除 = 溯源信息，清单必进 summary
  //（「剔除条目清单必进 summary——剔除本身就是溯源信息」）；evidence 剔空 → 整条候选不进
  // claims 提交面（整条剔除单独记录）。
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
          const rel = toWikiRelPath(parsed.path)
          if (rel.split('/').some((seg) => seg === '.' || seg === '..')) {
            alive = false
            reason = '引用的 wiki 页路径形态非法'
          } else if (rel === state.paperPath) {
            if (parsed.section !== undefined && !sectionHeadingLine(state.paperContent!, parsed.section)) {
              alive = false
              reason = '论文页中不存在该节'
            }
          } else if (parsed.section !== undefined) {
            const sec = await ports.wiki.readPage(wikiReadPathOf(rel), [headingAnchor(parsed.section)])
            if (!sec.ok && (sec.error.code === 'not_found' || sec.error.code === 'invalid_input')) {
              alive = false
              // not_found = 页不存在；invalid_input = 页存在但该节缺失（openwiki Unknown
              // sections 契约）。其余错误码（mirror_unavailable/internal 等临时故障）fail-open
              // 放行——剔除断言不能建立在检索面临时故障上，与裸页探针同方向（PR #917
              // review r1 Spec 新1）。
              reason = sec.error.code === 'not_found' ? '引用的 wiki 页不存在' : '引用的 wiki 页中不存在该节'
            }
          } else {
            const probe = await ports.wiki.readPage(wikiReadPathOf(rel), [BARE_PAGE_PROBE_ANCHOR])
            if (!probe.ok && probe.error.code === 'not_found') {
              alive = false
              reason = '引用的 wiki 页不存在'
            }
          }
        } else if (parsed.kind === 'lab-file') {
          if (!parsed.path.toLowerCase().endsWith('.pdf')) {
            alive = false
            reason = '上传件路径形态非法（须 /lab/uploads/*.pdf）'
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

  // persist：critic 页（type='critic'）+ claims（候选问题结构化面 → port 组装 OKF 块）。
  // provenance 仅 workflow——related_pages 钉给 W4 报告页（853 §3.3/#868 D2，PR #917
  // review Spec#20 收敛）。
  async function persistNode(state: DiscoverState, config: LangGraphRunnableConfig | undefined): Promise<Partial<DiscoverState>> {
    stageReporterOf(config)('persist')
    const doc = state.criticDoc!
    const slug = paperSlugOf(state.paperPath!)
    const path = `critics/${slug}.md`
    const title = criticTitleOf(doc.content, `论文评审：${slug}`)
    const claims = (doc.candidates ?? []).map((c) => ({ statement: c.question, evidence: c.evidence ?? [] }))
    const r = await ports.wiki.createPage(
      {
        path,
        title,
        type: 'critic',
        content: doc.content,
        claims,
      },
      { workflow: 'discover' },
    )
    if (!r.ok) throw new Error(`critic 页写入失败（${r.error.code}）：${r.error.message}`)
    return { criticPagePath: path, criticPageTitle: title, persistedCreated: r.data.created }
  }

  // summary：产物路径 + 候选存活数 + 剔除清单（不静默）。无 ≤1k 截断——「剔除清单必进
  // summary」优先（853 §4.1 的 ≤1k 只钉 W1，PR #917 review Spec#9）。
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
    return { summaryText: lines.join('\n') }
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
        compiledInvokeOptions(options),
      )
      if (state.clarify !== undefined) {
        return { status: 'clarify', summary: '', artifactPages: [], clarify: state.clarify }
      }
      if (
        state.summaryText === undefined ||
        state.criticPagePath === undefined ||
        state.criticPageTitle === undefined ||
        state.criticDoc === undefined
      ) {
        throw new Error('discover graph finished without summary')
      }
      const artifactPage: WorkflowArtifactPage = {
        path: state.criticPagePath,
        title: state.criticPageTitle,
      }
      return { status: 'completed', summary: state.summaryText, artifactPages: [artifactPage] }
    },
  }
}
