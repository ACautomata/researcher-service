// W1 ingest 知识库深度构建七节点图（#910 · 853 §4.1 · #848 §1 prompt 资产）：
//
//   capture → extract → create → validate ─┐ 不过→回 create 重试 1 次（附诊断）
//    (确定性)  (ctx.docs) (LLM 11节) (确定性) │
//       ↓                ←───────────────────┘
//    persist → verify → summary
//    (幂等哨兵) (回读对账)  (≤1k)
//
// 纯函数工厂 + 全计算面端口注入（#909 入口图同构——S2 fake、图零直连 llm/docs/wiki）。
// 重试触发面三源（#906）：截断 ∨ 结构化解析失败（两者汇入 PluginLlmStructuredError）∨
// validate 拒——K≤2 有界（初次 + 至多一次协议修复），重试 prompt 附对应诊断回喂，只纠
// 格式不改生成语义。V1 单篇；URL 来源不收（capture 形态校验明示拒绝）。
//
// 确定性失败语义：capture/extract/persist/verify 失败与重试耗尽一律 throw Error（诊断
// 附消息）——工具面 catch 落 failed 事件 + reason；图内不吞错误。

import { END, START, StateGraph, Annotation, z } from '../../server/src/plugins/autofigureDeps'
import type { LangGraphRunnableConfig } from '../../server/src/plugins/autofigureDeps'
import type { PluginClaimDraft, PluginDocsPort, PluginLlmPort, PluginWikiPort } from '../../server/src/plugins/api'
import { PAGE_DRAFT_MAX } from './values'
import { paperPageSlug, validatePaperPage } from './pageValidate'
import { generateWithBoundedRetry } from './generate'
import type { ValidateResult } from './pageValidate'
import { buildCreatePaperPagePrompt, PAPER_PAGE_ANCHORS } from './prompts'
import { stageReporterOf } from './graph'
import type { ResearchWorkflowRequest, WorkflowOutcome } from './graph'

// 论文页 LLM 产出 schema（11 节正文 + 页 title + claims 结构化提交面）。claims 宽容缺省
//（LLM 不给 = 空——claims 由 persist 经 port 组装 OKF 块，缺 claims 合法；.optional() 而非
// .default()：zod Input=Output 单形，与 generateStructured 的 z.ZodType<T> 契约相容）。
// 数量/尺寸上限对齐 PAGE_DRAFT_MAX（port 边界同构，防失控值提前在图内拒绝省一轮 port 往返）。
export const PAPER_PAGE_SCHEMA = z
  .object({
    title: z.string().min(1).max(PAGE_DRAFT_MAX.titleChars),
    content: z.string().min(1).max(PAGE_DRAFT_MAX.contentChars),
    claims: z
      .array(
        z.object({
          statement: z.string().min(1),
          evidence: z.array(z.string().min(1)).max(PAGE_DRAFT_MAX.evidencePerClaim),
        }),
      )
      .max(PAGE_DRAFT_MAX.claims)
      .optional(),
  })
  .strict()

type PaperPageDraft = z.infer<typeof PAPER_PAGE_SCHEMA>

// W1 计算端口（ctx 增量件：docs/llm/wiki；llm 的 RESEARCH_MODEL pin 由装配层包装）。
export interface IngestPorts {
  readonly docs: Pick<PluginDocsPort, 'extractPdfText'>
  readonly llm: PluginLlmPort
  readonly wiki: Pick<PluginWikiPort, 'createPage' | 'readPage'>
}

// V1 单篇约束（853 §4.1「一次调用一篇」）。
const SOURCE_PATHS_V1_MAX = 1

// 产物指纹（FNV-1a 32 位 hex——确定性对账指纹落 summary 溯源，非密码学用途；plugins 树
// 零 npm 依赖约束下不引 node:crypto）。
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// 哈希规范化（verify 对账面）：剥空白与 # 标记——消除核心组装面（frontmatter/claims 块
// 追加）与 openwiki section 切分的空白差异，保留正文字符层面的全量比对强度。
function normalizeForHash(text: string): string {
  return text.replace(/[\s#]+/g, '')
}

// 论文页产物路径（wiki-conventions：论文页 slug 匹配标题不带日期，papers/ 组固定——
// slug 由 title 确定性派生，kebab-case 确定性检查 = 派生函数本体）。
export function paperPagePath(title: string): string {
  return `papers/${paperPageSlug(title)}.md`
}

// ---------------------------------------------------------------------------
// 状态面
// ---------------------------------------------------------------------------

interface IngestState {
  request: ResearchWorkflowRequest
  sourcePath: string | undefined
  pages: readonly string[] | undefined
  draft: PaperPageDraft | undefined
  diagnostics: string | undefined
  createAttempts: number
  validation: ValidateResult | undefined
  pagePath: string | undefined
  persistedCreated: boolean | undefined
  fingerprint: string | undefined
  summaryText: string | undefined
}

const IngestAnnotation = {
  request: Annotation<ResearchWorkflowRequest>,
  sourcePath: Annotation<string | undefined>,
  pages: Annotation<readonly string[] | undefined>,
  draft: Annotation<PaperPageDraft | undefined>,
  diagnostics: Annotation<string | undefined>,
  createAttempts: Annotation<number>,
  validation: Annotation<ValidateResult | undefined>,
  pagePath: Annotation<string | undefined>,
  persistedCreated: Annotation<boolean | undefined>,
  fingerprint: Annotation<string | undefined>,
  summaryText: Annotation<string | undefined>,
}

// ---------------------------------------------------------------------------
// 图工厂（纯函数——同 ports 必同拓扑）
// ---------------------------------------------------------------------------

export interface IngestGraphInvokeOptions {
  /** 阶段进度上报（裸节点名 = stage 白名单值；workflow 域字段由入口图分支节点附加）。 */
  readonly onStage?: (stage: string) => void
  readonly signal?: AbortSignal
}

export function createIngestGraph(ports: IngestPorts): {
  invoke(init: { request: ResearchWorkflowRequest }, options?: IngestGraphInvokeOptions): Promise<WorkflowOutcome>
} {
  // capture（确定性）：PDF ∈ /lab/uploads 前缀 + V1 单篇。URL 来源 V1 不收（明示降级，
  // 853 §4.1）——非前缀一律拒，幻觉路径确定性拒绝回喂（诊断附用法）。
  function captureNode(state: IngestState, config: LangGraphRunnableConfig | undefined): Partial<IngestState> {
    stageReporterOf(config)('capture')
    const paths = state.request.source_paths ?? []
    if (paths.length === 0) throw new Error('ingest 缺少 source_paths——请提供 /lab/uploads 下的 PDF 路径')
    if (paths.length > SOURCE_PATHS_V1_MAX) {
      throw new Error(`ingest V1 单篇：一次调用只处理一篇 PDF（收到 ${paths.length} 个路径），请逐篇发起`)
    }
    const p = paths[0]!
    if (!p.startsWith('/lab/uploads/')) {
      throw new Error(`PDF 路径必须在 /lab/uploads/ 前缀下（收到 ${p}）；请把文件上传到 /lab/uploads 后重试。URL 来源暂不支持`)
    }
    return { sourcePath: p }
  }

  // extract：ctx.docs.extractPdfText 按页数组。超限报错不静默截断由 port 承载（too_large）；
  // not_found（幻觉路径）/ extract_failed / sandbox_unavailable → 确定性失败不重试
  //（非格式问题，重试无收益）。
  async function extractNode(state: IngestState, config: LangGraphRunnableConfig | undefined): Promise<Partial<IngestState>> {
    stageReporterOf(config)('extract')
    const r = await ports.docs.extractPdfText({ sandboxPath: state.sourcePath! })
    if (!r.ok) throw new Error(`PDF 提取失败（${r.error.code}）：${r.error.message}`)
    return { pages: r.data.pages }
  }

  // create（LLM 11 节）：生成骨架（attempts 有界 + 三源诊断捕获）共享面见 generate.ts。
  // 三源诊断统一经 state.diagnostics 回喂：截断/解析失败 = PluginLlmStructuredError 诊断，
  // validate 拒 = 校验 issues 串。
  async function createNode(state: IngestState, config: LangGraphRunnableConfig | undefined): Promise<Partial<IngestState>> {
    stageReporterOf(config)('create')
    const r = await generateWithBoundedRetry<PaperPageDraft>({
      llm: ports.llm,
      schema: PAPER_PAGE_SCHEMA,
      prompt: buildCreatePaperPagePrompt(state.pages!, state.diagnostics),
      attemptsSoFar: state.createAttempts,
      diagnostics: state.diagnostics,
      nodeLabel: '论文页',
    })
    if (r.value === undefined) {
      return { createAttempts: r.attempts, diagnostics: r.diagnostics, draft: undefined, validation: undefined }
    }
    return { createAttempts: r.attempts, draft: r.value, diagnostics: undefined }
  }

  // validate（确定性）：11 节标题齐全 / title 非空（frontmatter 必填面）/ ≥100 行 /
  // Results 含具体数字。draft 缺失（上轮解析失败）→ 失败面 = 解析诊断（条件边据此回 create）。
  function validateNode(state: IngestState, config: LangGraphRunnableConfig | undefined): Partial<IngestState> {
    stageReporterOf(config)('validate')
    if (state.draft === undefined) {
      return { validation: { ok: false, issues: [state.diagnostics ?? '上一轮产出缺失'] } }
    }
    const validation = validatePaperPage(state.draft)
    return {
      validation,
      diagnostics: validation.ok ? undefined : validation.issues.join('；'),
    }
  }

  // 条件边：validation 过 → persist；不过 → create（create 进入时 attempts 超界即明确失败）。
  function routeAfterValidate(state: IngestState): 'persist' | 'create' {
    return state.validation?.ok ? 'persist' : 'create'
  }

  // persist：经 wiki 写 port（幂等哨兵——created:false = 重放窗口防重复建页，常态路径）。
  async function persistNode(state: IngestState, config: LangGraphRunnableConfig | undefined): Promise<Partial<IngestState>> {
    stageReporterOf(config)('persist')
    const draft = state.draft!
    const claims: readonly PluginClaimDraft[] = draft.claims ?? []
    const path = paperPagePath(draft.title)
    const r = await ports.wiki.createPage(
      { path, title: draft.title, type: 'paper', content: draft.content, claims },
      { workflow: 'ingest' },
    )
    if (!r.ok) throw new Error(`论文页写入失败（${r.error.code}）：${r.error.message}`)
    return { pagePath: path, persistedCreated: r.data.created }
  }

  // verify（确定性）：回读哈希对账——11 节锚全量回读后，写入正文与回读拼接做规范化
  //（剥空白与 heading # 标记——核心组装面在页首尾追加 frontmatter/claims 块，逐字比对
  // 恒不等；规范化哈希消除组装面与 section 切分的空白/标记差异，正文字符层面全量比对）
  // FNV-1a 对账，不等 = 明确失败；指纹落 summary 溯源（审计面可对账）。
  async function verifyNode(state: IngestState, config: LangGraphRunnableConfig | undefined): Promise<Partial<IngestState>> {
    stageReporterOf(config)('verify')
    const r = await ports.wiki.readPage(state.pagePath!, PAPER_PAGE_ANCHORS)
    if (!r.ok) throw new Error(`论文页回读失败（${r.error.code}）：${r.error.message}`)
    const fingerprint = fnv1aHex(normalizeForHash(state.draft!.content))
    const readback = fnv1aHex(normalizeForHash(r.data.sections.map((s) => s.content).join('\n')))
    if (fingerprint !== readback) {
      throw new Error(`回读哈希对账失败：页 ${state.pagePath} 写入指纹 ${fingerprint} ≠ 回读指纹 ${readback}——写入面与读面不一致`)
    }
    return { fingerprint }
  }

  // summary：≤1k + 产物路径（853 §4.1 summary 节点钉面）。
  function summaryNode(state: IngestState, config: LangGraphRunnableConfig | undefined): Partial<IngestState> {
    stageReporterOf(config)('summary')
    const created = state.persistedCreated === true
    const claimsCount = state.draft?.claims?.length ?? 0
    const lines = [
      `论文已入库：${state.pagePath}（${created ? '新建页面' : '页面已存在，幂等跳过'}）。`,
      `正文 ${state.draft!.content.split('\n').length} 行 · claims ${claimsCount} 条 · 产物指纹 ${state.fingerprint}。`,
      `来源：${state.sourcePath}`,
    ]
    const summary = lines.join('\n')
    return { summaryText: summary.length <= 1000 ? summary : `${summary.slice(0, 999)}…` }
  }

  const graph = new StateGraph({ stateSchema: Annotation.Root(IngestAnnotation) })
    .addNode('capture', captureNode)
    .addNode('extract', extractNode)
    .addNode('create', createNode)
    .addNode('validate', validateNode)
    .addNode('persist', persistNode)
    .addNode('verify', verifyNode)
    .addNode('summary', summaryNode)
    .addEdge(START, 'capture')
    .addEdge('capture', 'extract')
    .addEdge('extract', 'create')
    .addEdge('create', 'validate')
    .addConditionalEdges('validate', routeAfterValidate, { persist: 'persist', create: 'create' })
    .addEdge('persist', 'verify')
    .addEdge('verify', 'summary')
    .addEdge('summary', END)

  const compiled = graph.compile()

  return {
    async invoke(init, options) {
      const state = await compiled.invoke(
        { request: init.request, createAttempts: 0 },
        {
          ...(options?.signal ? { signal: options.signal } : {}),
          configurable: { onStage: options?.onStage },
        },
      )
      if (state.summaryText === undefined || state.pagePath === undefined || state.draft === undefined) {
        // 拓扑终局必有三分量（失败路径全部 throw 出图）——理论不可达的防御面。
        throw new Error('ingest graph finished without summary')
      }
      return {
        status: 'completed',
        summary: state.summaryText,
        artifactPages: [{ path: state.pagePath, title: state.draft.title }],
      }
    },
  }
}
