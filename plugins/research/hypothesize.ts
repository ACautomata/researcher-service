// W3 hypothesize 科学假说自主生成八节点图（#911 · 853 §4.3 · #848 §3 prompt 资产 ·
// brainstorm 编排语义——curate/contextPack → Send[]×5–8 桶扇出 → 去重 → 反驳门禁 → 规则校验 → 整批落盘）：
//
//   resolveInputs → contextPack ──→⌗ Send[]×N → bucket×N → dedup → challenge → validate → persist → summary
//    (论文页路径      (检索+brief；    (5 固定+3 opt-in (LLM；节点内   (纯函数) (LLM 顺序  (规则全集 (survived
//     白名单+存在性     证据不足→END+      参数显式追加)    catch 降级)           逐卡)     逐条拒)   整批先渲染
//     回查)            clarify)                                                                 再逐页写)
//
// 钉界（853 §4.3）：桶档位 = 5 固定 + 3 opt-in（仅经参数显式追加，LLM 无自由裁量），BUCKETS_MAX=8；
// 桶节点不在长页生成五节点重试覆盖面（#906 口径注记）——结构化失败走节点内 catch 降级（{bucket,
// error} 记录不阻断其余桶），abort 等非结构化错误原样抛出。challenge 顺序逐卡（≤24 上界），
// rejected 判据 = 使核心假设/可行性/可检验性不成立的具体反驳（笼统不确定性不是）——语义去重并
// 入本节点（「已有工作已覆盖」含本批次实质重复）。persist 非原子风险 V1 明示接受（幂等哨兵使
// 重跑可续）；无 survived 时不写 wiki、summary 回复全部淘汰原因（含桶失败记录，不静默）。
//
// 图零直连 LLM/wiki（#909 端口注入铁律）；路径域约定同 W2（写面 rel 域，readPage 调用点换算）。

import { END, START, StateGraph, Annotation, Send } from '../../server/src/plugins/autofigureDeps'
import type { LangGraphRunnableConfig } from '../../server/src/plugins/autofigureDeps'
import type { PluginLlmPort, PluginWikiPort } from '../../server/src/plugins/api'
import { PluginLlmStructuredError } from '../../server/src/plugins/api'
import {
  BUCKETS_FIXED,
  BUCKETS_MAX,
  BUCKETS_OPT_IN,
  CHALLENGE_CARDS_MAX,
  CONTEXT_PACK_BUDGET_TOKENS,
  CONTEXT_PACK_SEARCH_LIMIT,
} from './values'
import type { BucketName } from './values'
import {
  CHALLENGE_SCHEMA,
  IDEA_CARDS_SCHEMA,
  dedupIdeaCards,
  ideaCardSlug,
  renderIdeaCardPage,
  validateIdeaCards,
} from './ideaCards'
import type { IdeaCard } from './ideaCards'
import {
  assembleContextPackText,
  briefBlockOf,
  BRIEF_SCHEMA,
  buildEvidenceContext,
  capEvidenceExcerpt,
  evidenceLevelOf,
  fillBriefAssumptions,
} from './contextPack'
import type { EvidenceEntry, IdeaBrief } from './contextPack'
import { buildBriefPrompt, buildBucketPrompt, buildChallengePrompt, PAPER_PAGE_ANCHORS } from './prompts'
import { compiledInvokeOptions, stageReporterOf, toWikiRelPath, wikiReadPathOf, WIKI_PAGE_PROBE_ANCHOR } from './graph'
import type { FlowGraphInvokeOptions, ResearchWorkflowRequest, WorkflowArtifactPage, WorkflowOutcome } from './graph'
import type { ClarifyResult } from './clarify'

// W3 计算端口（llm pin 由装配层包装；wiki 三方法 = 检索/读页/建页）。
export interface HypothesizePorts {
  readonly llm: PluginLlmPort
  readonly wiki: Pick<PluginWikiPort, 'search' | 'readPage' | 'createPage'>
}

// 桶扇出产物（Send 并行归并面）。
export interface BucketCards {
  readonly bucket: BucketName
  readonly cards: readonly IdeaCard[]
}

export interface BucketFailure {
  readonly bucket: BucketName
  readonly error: string
}

// challenge 幸存卡（审计/溯源面：challenge/verdict_reason 随卡携带——ideate reviewed_cards
// 同款三字段语义，#848 §3）。
export interface ChallengedCard {
  readonly card: IdeaCard
  readonly challenge: string
  readonly verdictReason: string
}

// 淘汰记录（summary 不静默面：stage 区分反驳淘汰 / 规则拒 / 调用失败）。
export interface IdeaRejection {
  readonly title: string
  readonly stage: 'challenge' | 'validate'
  readonly reasons: readonly string[]
}

// 桶档位派生（853 §4.3）：5 固定 + 参数显式 opt-in（去重 + BUCKETS_MAX 截断——传输面 zod
// 已锁三值枚举，本函数纯防御兜底：枚举外值滤除不扇出）。入参放宽 string 面（S3 纯函数
// 单测锁，含枚举外值滤除断言）。
export function bucketsOfRequest(request: { readonly buckets?: readonly string[] }): BucketName[] {
  const optIn = [...new Set(request.buckets ?? [])].filter((b): b is BucketName =>
    (BUCKETS_OPT_IN as readonly string[]).includes(b),
  )
  return [...BUCKETS_FIXED, ...optIn].slice(0, BUCKETS_MAX)
}

// clarify 出口文案（面向主 agent 指令性引导；candidates 空 = 无流程候选可列，缺失的是证据材料）。
const notIngestedClarify = (missing: readonly string[]): ClarifyResult => ({
  status: 'clarify',
  candidates: [],
  question: `wiki 中未找到目标论文页：${missing.join('、')}。科学假说生成流程以已入库论文为证据材料——请先对目标 PDF 发起 /ingest 知识库深度构建流程，入库成功后再重新发起 hypothesize。`,
})

const HYPOTHESIZE_CLARIFY_NO_EVIDENCE: ClarifyResult = {
  status: 'clarify',
  candidates: [],
  question:
    '证据不足：给定论文页与集中检索在裁剪后未产生任何可引用证据条目（「证据不足」判定在裁剪后——CONTEXT_PACK_BUDGET_TOKENS 预算内零幸存）。科学假说生成要求证据可溯源，不生成泛化 idea。请先 /ingest 相关论文，或补充更具体的研究主题后重试。',
}

// ---------------------------------------------------------------------------
// 状态面
// ---------------------------------------------------------------------------

interface HypothesizeState {
  request: ResearchWorkflowRequest
  paperPaths: readonly string[] | undefined
  clarify: ClarifyResult | undefined
  brief: IdeaBrief | undefined
  packText: string | undefined
  // Send 注入：每个并行桶任务的档位。（通道名 bucketName 避让节点名 'bucket'——
  // LangGraph 禁同名 channel/node。）
  bucketName: BucketName | undefined
  bucketCards: BucketCards[]
  bucketFailures: BucketFailure[]
  cards: IdeaCard[]
  mergedCount: number
  cappedCount: number
  challenged: ChallengedCard[]
  rejected: IdeaRejection[]
  survived: IdeaCard[]
  warnings: string[]
  artifactPages: WorkflowArtifactPage[]
  summaryText: string | undefined
}

const HypothesizeAnnotation = {
  request: Annotation<ResearchWorkflowRequest>,
  paperPaths: Annotation<readonly string[] | undefined>,
  clarify: Annotation<ClarifyResult | undefined>,
  brief: Annotation<IdeaBrief | undefined>,
  packText: Annotation<string | undefined>,
  bucketName: Annotation<BucketName | undefined>,
  bucketCards: Annotation<BucketCards[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  bucketFailures: Annotation<BucketFailure[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  cards: Annotation<IdeaCard[]>,
  mergedCount: Annotation<number>,
  cappedCount: Annotation<number>,
  challenged: Annotation<ChallengedCard[]>,
  rejected: Annotation<IdeaRejection[]>,
  survived: Annotation<IdeaCard[]>,
  warnings: Annotation<string[]>,
  artifactPages: Annotation<WorkflowArtifactPage[]>,
  summaryText: Annotation<string | undefined>,
}

// ---------------------------------------------------------------------------
// 图工厂（纯函数——同 ports 必同拓扑）
// ---------------------------------------------------------------------------

export function createHypothesizeGraph(ports: HypothesizePorts): {
  invoke(init: { request: ResearchWorkflowRequest }, options?: FlowGraphInvokeOptions): Promise<WorkflowOutcome>
} {
  // resolveInputs（确定性）：论文页路径前缀白名单 + 存在性回查（W2 同款哨兵探——not_found =
  // 缺页 clarify 提示先 ingest；invalid_input = 页存在哨兵节缺失 → 放行；其余错误码 = 流程故障
  // throw）。W3 跨论文语义——source_paths 多篇合法（V1 至传输面上限）。主题与路径双缺 → clarify
  // （brief-template：无主题且无证据材料才反问）。
  async function resolveInputsNode(
    state: HypothesizeState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<HypothesizeState>> {
    stageReporterOf(config)('resolveInputs')
    const given = state.request.source_paths ?? []
    const paperPaths: string[] = []
    const missing: string[] = []
    for (const raw of given) {
      const p = toWikiRelPath(raw)
      const malformed =
        !p.startsWith('papers/') || !p.endsWith('.md') || p.split('/').some((seg) => seg === '.' || seg === '..')
      if (malformed) {
        return {
          clarify: {
            status: 'clarify',
            candidates: [],
            question: `hypothesize 的输入是已入库论文的 wiki 页（papers/<slug>.md 形态，可多篇）；收到 ${raw}。若尚未入库，请先对该 PDF 发起 /ingest。`,
          },
        }
      }
      const probe = await ports.wiki.readPage(wikiReadPathOf(p), [WIKI_PAGE_PROBE_ANCHOR])
      if (!probe.ok && probe.error.code === 'not_found') {
        missing.push(p)
        continue
      }
      if (!probe.ok && probe.error.code !== 'invalid_input') {
        throw new Error(`论文页存在性回查失败（${probe.error.code}）：${probe.error.message}`)
      }
      paperPaths.push(p)
    }
    if (missing.length > 0) return { clarify: notIngestedClarify(missing) }
    const hasTopic = (state.request.topic ?? state.request.question ?? '').trim() !== ''
    if (paperPaths.length === 0 && !hasTopic) {
      return {
        clarify: {
          status: 'clarify',
          candidates: [],
          question:
            'hypothesize 需要研究主题（topic/question）或已入库论文页（source_paths）至少其一：主题为集中检索提供查询面，论文页为证据底座。请补充研究主题，或先对目标 PDF 发起 /ingest 后提供 papers/<slug>.md 路径。',
        },
      }
    }
    return { paperPaths }
  }

  function routeAfterResolve(state: HypothesizeState): 'contextPack' | 'end' {
    return state.clarify !== undefined ? 'end' : 'contextPack'
  }

  // contextPack（检索 + brief）：证据池 = 显式论文页（11 节锚全量回读 + 页级节选）+ 集中检索
  // 命中（按页去重、hit.content 即页级节选）。**判定在裁剪后**（853 §4.3）：预算全额先给证据
  // 做整条目裁剪，零幸存 → END+clarify（零 LLM 消耗，不生成泛化 idea）；幸存 → brief LLM
  // （10 字段，缺失下游 ASSUMPTION 填充）+ 合包。search 面故障（!ok）静默降级为 explicit-only
  // ——显式路径在 = 证据仍足，全无则不足判足走 clarify（用户可行动面，同 W2 先例）。
  async function contextPackNode(
    state: HypothesizeState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<HypothesizeState>> {
    stageReporterOf(config)('contextPack')
    const entries: EvidenceEntry[] = []
    for (const [rank, p] of (state.paperPaths ?? []).entries()) {
      const r = await ports.wiki.readPage(wikiReadPathOf(p), PAPER_PAGE_ANCHORS)
      if (!r.ok) throw new Error(`论文页回读失败（${r.error.code}）：${r.error.message}`)
      entries.push({ path: p, level: evidenceLevelOf(p), excerpt: capEvidenceExcerpt(r.data.sections.map((s) => s.content).join('\n\n')), rank })
    }
    const query = (state.request.topic ?? state.request.question ?? '').trim()
    if (query !== '') {
      const r = await ports.wiki.search(query, { limit: CONTEXT_PACK_SEARCH_LIMIT })
      if (r.ok) {
        const seen = new Set(entries.map((e) => e.path))
        for (const hit of r.data.results) {
          const ref = (hit.ref[0] ?? '').split('#')[0] ?? ''
          const path = toWikiRelPath(ref)
          if (path === '' || !path.endsWith('.md') || seen.has(path)) continue
          seen.add(path)
          entries.push({ path, level: evidenceLevelOf(path), excerpt: capEvidenceExcerpt(hit.content), rank: entries.length })
        }
      }
    }
    const core = buildEvidenceContext(entries, CONTEXT_PACK_BUDGET_TOKENS)
    if (!core.sufficient) return { clarify: HYPOTHESIZE_CLARIFY_NO_EVIDENCE }
    const evidencePreview = core.evidence.map((e) => `## ${e.path}\n${e.excerpt}`).join('\n\n')
    const brief = await ports.llm.generateStructured({
      schema: BRIEF_SCHEMA,
      contents: [buildBriefPrompt(query, evidencePreview)],
    })
    const briefBlock = briefBlockOf(fillBriefAssumptions(brief))
    return { brief, packText: assembleContextPackText(briefBlock, core.evidence) }
  }

  // 扇出边（853 §4.3 ⌗ Send[]×N）：证据不足 → END；否则按桶档位派 Send[]——每个 Send 的
  // args 合入该任务状态拷贝（fanoutGraph.ts 验证件同款），桶实例并行互不踩踏，fan-in 经
  // reducer 归并。W3 图内并行不占 run 名额（单次 execute 内，瞬时 5–8 路并发接受）。
  function routeAfterPack(state: HypothesizeState): Send[] | typeof END {
    if (state.clarify !== undefined) return END
    const packText = state.packText!
    return bucketsOfRequest(state.request).map((bucket) => new Send('bucket', { packText, bucketName: bucket }))
  }

  // bucket（LLM，Send 并行实例）：每桶产 1–3 张候选卡（策略段按桶注入，prompt 资产 #848 §3）。
  // 节点内 catch 降级（853 §4.3）：结构化失败 → {bucket, error} 记录不阻断其余桶（不在长页
  // 五节点重试覆盖面，#906 口径注记）；abort 等非结构化错误原样抛出。
  async function bucketNode(
    state: HypothesizeState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<HypothesizeState>> {
    stageReporterOf(config)('bucket')
    const bucket = state.bucketName!
    try {
      const value = await ports.llm.generateStructured({
        schema: IDEA_CARDS_SCHEMA,
        contents: [buildBucketPrompt(bucket, state.packText!)],
      })
      return { bucketCards: [{ bucket, cards: value.cards ?? [] }] }
    } catch (e) {
      if (e instanceof PluginLlmStructuredError) {
        return { bucketFailures: [{ bucket, error: `结构化输出${e.message}：${e.diagnostics}` }] }
      }
      throw e
    }
  }

  // dedup（纯函数）：机制去重键 = (norm(title), norm(mechanism), norm(minimum_experiment))，
  // 同键保留 evidence_chain 总长更长者；语义去重不在本节点（并入 challenge「已有工作已覆盖」
  // 判据，853 §4.3 补钉）。CHALLENGE_CARDS_MAX 上界在此消费（853 §4.3 ≤35 口径面——schema
  // 宽容上限下 8 桶×5 卡可越界）：dedup 后超界确定性截断，截断数进 summary 不静默。
  // 全桶空产 → 空管穿流（persist 零写、summary 回复原因，拓扑不变）。
  function dedupNode(state: HypothesizeState, config: LangGraphRunnableConfig | undefined): Partial<HypothesizeState> {
    stageReporterOf(config)('dedup')
    const all = state.bucketCards.flatMap((r) => r.cards)
    const deduped = dedupIdeaCards(all)
    const cards = deduped.slice(0, CHALLENGE_CARDS_MAX)
    return { cards, mergedCount: all.length - deduped.length, cappedCount: deduped.length - cards.length }
  }

  // challenge（LLM 顺序逐卡，≤24 上界）：verdict schema——只有使核心假设/可行性/可检验性
  // 不成立的具体反驳才是 rejected（笼统不确定性不是——prompt 判据边界，S3 锁）。结构化失败
  // 如实记淘汰原因（challenge 阶段失败），不中断其余卡；abort 原样抛出。
  async function challengeNode(
    state: HypothesizeState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<HypothesizeState>> {
    stageReporterOf(config)('challenge')
    const peers = state.cards.map((c) => c.title ?? '未命名')
    const challenged: ChallengedCard[] = []
    const rejected: IdeaRejection[] = []
    for (const card of state.cards) {
      const title = card.title ?? '未命名'
      try {
        const verdict = await ports.llm.generateStructured({
          schema: CHALLENGE_SCHEMA,
          contents: [buildChallengePrompt(state.packText!, JSON.stringify(card), peers)],
        })
        if (verdict.verdict === 'survived') {
          challenged.push({ card, challenge: verdict.challenge, verdictReason: verdict.verdict_reason })
        } else {
          rejected.push({ title, stage: 'challenge', reasons: [verdict.verdict_reason] })
        }
      } catch (e) {
        if (e instanceof PluginLlmStructuredError) {
          rejected.push({ title, stage: 'challenge', reasons: [`challenge 阶段失败：结构化输出${e.message}：${e.diagnostics}`] })
        } else {
          throw e
        }
      }
    }
    return { challenged, rejected }
  }

  // validate（确定性，规则全集）：validate_idea_cards.py TS 移植逐条——error 卡淘汰（拒因进
  // summary 不静默），warning 卡保留（提醒进 summary）。
  function validateNode(state: HypothesizeState, config: LangGraphRunnableConfig | undefined): Partial<HypothesizeState> {
    stageReporterOf(config)('validate')
    const survived: IdeaCard[] = []
    const rejected = [...state.rejected]
    const warnings: string[] = []
    const validations = validateIdeaCards(state.challenged.map((c) => c.card))
    state.challenged.forEach((c, i) => {
      const v = validations[i]!
      if (v.errors.length > 0) {
        rejected.push({ title: c.card.title ?? '未命名', stage: 'validate', reasons: [...v.errors] })
      } else {
        survived.push(c.card)
        warnings.push(...v.warnings)
      }
    })
    return { survived, rejected, warnings }
  }

  // persist：survived 整批**先生成**（全量页 draft 渲染，纯函数先行）**再逐页写**（顺序
  // createPage）；非原子风险 V1 明示接受——幂等哨兵使重跑可续（页已存在 = 跳过不覆盖）。
  // 无 survived → 零写（不写 wiki 语义由空批天然成立）。路径撞车确定性消歧（同题卡
  // slug 冲突 → 追加 idea_id 派生段）。
  async function persistNode(
    state: HypothesizeState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<HypothesizeState>> {
    stageReporterOf(config)('persist')
    const seen = new Set<string>()
    const drafts = state.survived.map((card) => {
      const base = ideaCardSlug(card.title ?? 'untitled-idea')
      let path = `idea-cards/${base}.md`
      if (seen.has(path)) path = `idea-cards/${base}--${ideaCardSlug(card.idea_id ?? 'dup')}.md`
      seen.add(path)
      return {
        path,
        title: card.title ?? '未命名假说',
        content: renderIdeaCardPage(card),
        claims: [{ statement: card.one_sentence_hypothesis ?? '', evidence: [...(card.evidence_chain ?? [])] }],
      }
    })
    const artifactPages: WorkflowArtifactPage[] = []
    for (const d of drafts) {
      const r = await ports.wiki.createPage(
        { path: d.path, title: d.title, type: 'idea-card', content: d.content, claims: d.claims },
        { workflow: 'hypothesize' },
      )
      if (!r.ok) throw new Error(`idea card 页写入失败（${r.error.code}）：${r.error.message}`)
      artifactPages.push({ path: d.path, title: d.title })
    }
    return { artifactPages }
  }

  // summary：计数链（候选 → dedup 合并 → 幸存）+ 产物路径 / 无幸存明示 + 桶失败记录 +
  // 全部淘汰原因 + 校验提醒——不静默不截断（W2 先例：拒因清单优先于 ≤1k）。
  function summaryNode(state: HypothesizeState, config: LangGraphRunnableConfig | undefined): Partial<HypothesizeState> {
    stageReporterOf(config)('summary')
    const total = state.bucketCards.reduce((n, r) => n + r.cards.length, 0)
    const lines = [`候选卡 ${total} 张 → dedup 合并 ${state.mergedCount} 张 → challenge 幸存 ${state.survived.length} 张。`]
    if (state.cappedCount > 0) {
      lines.push(`challenge 卡数上界截断 ${state.cappedCount} 张（CHALLENGE_CARDS_MAX=${CHALLENGE_CARDS_MAX}，853 §4.3 ≤35 次 LLM/run 口径面）。`)
    }
    if (state.survived.length > 0) {
      lines.push(`假说生成完成：幸存 ${state.survived.length} 张假说卡已落 wiki（idea card 页 + claims）：`)
      state.artifactPages.forEach((p, i) => lines.push(`${i + 1}. ${p.path}`))
    } else {
      lines.push('无幸存假说卡：未写入 wiki。全部淘汰原因如下：')
    }
    if (state.bucketFailures.length > 0) {
      lines.push(
        `桶执行失败 ${state.bucketFailures.length} 个（其余桶不受影响）：${state.bucketFailures
          .map((f) => `${f.bucket}（${f.error}）`)
          .join('；')}`,
      )
    }
    if (state.rejected.length > 0) {
      lines.push('淘汰明细：')
      for (const r of state.rejected) {
        lines.push(`- ${r.title}（${r.stage === 'challenge' ? 'challenge 反驳成立' : 'validate 规则拒'}）：${r.reasons.join('；')}`)
      }
    }
    if (state.warnings.length > 0) lines.push(`校验提醒：${state.warnings.join('；')}`)
    return { summaryText: lines.join('\n') }
  }

  const graph = new StateGraph({ stateSchema: Annotation.Root(HypothesizeAnnotation) })
    .addNode('resolveInputs', resolveInputsNode)
    .addNode('contextPack', contextPackNode)
    .addNode('bucket', bucketNode)
    .addNode('dedup', dedupNode)
    .addNode('challenge', challengeNode)
    .addNode('validate', validateNode)
    .addNode('persist', persistNode)
    .addNode('summary', summaryNode)
    .addEdge(START, 'resolveInputs')
    .addConditionalEdges('resolveInputs', routeAfterResolve, { contextPack: 'contextPack', end: END })
    .addConditionalEdges('contextPack', routeAfterPack)
    .addEdge('bucket', 'dedup')
    .addEdge('dedup', 'challenge')
    .addEdge('challenge', 'validate')
    .addEdge('validate', 'persist')
    .addEdge('persist', 'summary')
    .addEdge('summary', END)

  const compiled = graph.compile()

  return {
    async invoke(init, options) {
      const state = await compiled.invoke(
        { request: init.request, bucketCards: [], bucketFailures: [] },
        compiledInvokeOptions(options),
      )
      if (state.clarify !== undefined) {
        return { status: 'clarify', summary: '', artifactPages: [], clarify: state.clarify }
      }
      if (state.summaryText === undefined) {
        throw new Error('hypothesize graph finished without summary')
      }
      return { status: 'completed', summary: state.summaryText, artifactPages: state.artifactPages }
    },
  }
}
