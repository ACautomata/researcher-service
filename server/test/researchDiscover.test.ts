// #910 S2：W2 discover 九节点图 invoke 返回值面（Agreements「零新缝」——图 invoke + fake
// ports）。覆盖（853 §4.2 / issue AC）：happy path / resolveInputs 检索定位与缺失 clarify
//（产物串联出口）/ load 论文页缺失 clarify / validate¹ 禁语拒 → 重试附诊断 / validate² 候选
// 数拒 → 重试 → 再拒明确失败 / evidenceGate 引用回查剔除（清单进 summary 不静默）/ stage 序列。
import { describe, expect, it, vi } from 'vitest'
import { createDiscoverGraph, CRITIC_DOC_SCHEMA, EXTRACT_DOC_SCHEMA } from '../../plugins/research/discover'
import type { DiscoverPorts } from '../../plugins/research/discover'
import type { PluginLlmPort } from '../../server/src/plugins/api'
import { PAPER_PAGE_SECTIONS, CRITIC_SECTIONS, EXTRACT_SECTIONS } from '../../plugins/research/prompts'

const PAPER_PATH = 'papers/robust-out-of-distribution-detection.md'

const validExtract = (): { content: string } => ({
  content: EXTRACT_SECTIONS.map((s, i) => `## ${i} ${s}\n\n论文报告：主结果 AUROC 95.12%。论文中未明确说明处如实标注。`).join('\n\n'),
})

const validCritic = (candidates: { question: string; priority: 'high' | 'medium' | 'low'; evidence?: string[] }[] = [
  { question: '消融是否覆盖核心组件？', priority: 'high', evidence: [`${PAPER_PATH}#6 Results`, 'extract §3'] },
  { question: '跨模态泛化证据是否充分？', priority: 'medium', evidence: ['extract §7'] },
]) => ({
  content: ['# 某论文审稿式问题分析', '', '`category: critic`', '', ...CRITIC_SECTIONS.map((s, i) => `## ${i} ${s}\n\n已有较强证据支持：具体质疑。`)].join('\n'),
  candidates,
})

type DiscoverFakePorts = DiscoverPorts & {
  llmCalls: { slot: 'extract' | 'critic'; prompt: string }[]
  wiki: { createPage: ReturnType<typeof vi.fn>; readPage: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> }
}

const makePorts = (overrides: {
  extract?: () => unknown
  critic?: () => unknown
  readPageOk?: boolean
  searchResults?: () => { ok: true; data: { results: { kind: string; ref: string[]; content: string }[] } }
} = {}): DiscoverFakePorts => {
  const llmCalls: { slot: 'extract' | 'critic'; prompt: string }[] = []
  const llm: PluginLlmPort = {
    generateMultimodal: vi.fn(async () => ({ text: '' })),
    generateStructured: vi.fn(async (opts: { schema: { parse: (v: unknown) => unknown; shape?: Record<string, unknown> }; contents: readonly unknown[] }) => {
      // slot 按 schema 形状判定（CRITIC_DOC_SCHEMA 有 candidates 键）——对重试链正确。
      const slot = opts.schema.shape?.candidates !== undefined ? ('critic' as const) : ('extract' as const)
      llmCalls.push({ slot, prompt: String(opts.contents[0]) })
      const value = slot === 'extract' ? (overrides.extract?.() ?? validExtract()) : (overrides.critic?.() ?? validCritic())
      return opts.schema.parse(value)
    }),
  } as unknown as PluginLlmPort
  const wiki = {
    search: vi.fn(async () => overrides.searchResults?.() ?? { ok: true as const, data: { results: [{ kind: 'section', ref: [`${PAPER_PATH}#1 citation`], content: '…' }] } }),
    readPage: vi.fn(async (page: string, sections: readonly string[]) => {
      if (overrides.readPageOk === false) {
        return { ok: false as const, error: { code: 'not_found', message: 'The requested wiki page does not exist.' } }
      }
      return { ok: true as const, data: { page, sections: sections.map((s, i) => ({ section: s, content: `## ${i + 1} ${PAPER_PAGE_SECTIONS[i]}\n\n内容` })) } }
    }),
    createPage: vi.fn(async () => ({ ok: true as const, data: { created: true } })),
  }
  return { llm, wiki, llmCalls } as unknown as DiscoverFakePorts
}

describe('W2 discover 图 invoke（S2 端口注入 fake）', () => {
  it('happy path（source_paths 钉定论文页）→ completed + critic 页 artifactPages + claims/provenance 组装', async () => {
    const ports = makePorts()
    const result = await createDiscoverGraph(ports).invoke({
      request: { workflow: 'discover', question: '这篇论文有哪些问题', source_paths: [PAPER_PATH] },
    })

    expect(result.status).toBe('completed')
    expect(result.clarify).toBeUndefined()
    expect(result.artifactPages).toEqual([{ path: 'critics/robust-out-of-distribution-detection.md', title: '某论文审稿式问题分析' }])
    expect(result.summary).toContain('critics/robust-out-of-distribution-detection.md')
    expect(result.summary.length).toBeLessThanOrEqual(1000)

    const [draft, provenance] = (ports.wiki.createPage as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      { path: string; title: string; type: string; content: string; claims: { statement: string; evidence: string[] }[] },
      { workflow: string; relatedPages: string[] },
    ]
    expect(draft.path).toBe('critics/robust-out-of-distribution-detection.md')
    expect(draft.type).toBe('critic')
    expect(draft.claims).toHaveLength(2)
    expect(draft.claims[0]!.evidence).toEqual([`${PAPER_PATH}#6 Results`, 'extract §3'])
    expect(provenance.workflow).toBe('discover')
    expect(provenance.relatedPages).toEqual([PAPER_PATH])
  })

  it('resolveInputs：无 source_paths → search 定位论文页（ref split #）', async () => {
    const ports = makePorts()
    const result = await createDiscoverGraph(ports).invoke({ request: { workflow: 'discover', question: '找 robust detection 的问题' } })

    expect(ports.wiki.search).toHaveBeenCalled()
    expect(result.status).toBe('completed')
    const readPagePage = (ports.wiki.readPage as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(readPagePage).toBe(PAPER_PATH)
  })

  it('resolveInputs：search 无命中 → clarify 出口（提示先 ingest，产物串联）', async () => {
    const ports = makePorts({ searchResults: () => ({ ok: true, data: { results: [] } }) })
    const result = await createDiscoverGraph(ports).invoke({ request: { workflow: 'discover', question: '找不到的论文' } })

    expect(result.status).toBe('clarify')
    expect(result.summary).toBe('')
    expect(result.artifactPages).toEqual([])
    expect(result.clarify?.candidates).toEqual([])
    expect(result.clarify?.question).toContain('ingest')
  })

  it('load：论文页不存在（readPage not_found）→ clarify 出口（提示先 ingest）', async () => {
    const ports = makePorts({ readPageOk: false })
    const result = await createDiscoverGraph(ports).invoke({
      request: { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] },
    })

    expect(result.status).toBe('clarify')
    expect(result.clarify?.question).toContain('ingest')
  })

  it('resolveInputs：source_paths 非 .md 论文页形态 → clarify（形态诊断）', async () => {
    const ports = makePorts()
    const result = await createDiscoverGraph(ports).invoke({
      request: { workflow: 'discover', question: 'q', source_paths: ['/lab/uploads/a.pdf'] },
    })
    expect(result.status).toBe('clarify')
    expect(result.clarify?.question).toContain('.md')
  })

  it('validate¹ 拒（三态禁语）→ 回 extract 重试附诊断；重试过 → completed', async () => {
    let n = 0
    const ports = makePorts({
      extract: () => {
        n += 1
        return n === 1 ? { content: `${validExtract().content}\n\n这一现象可能是过拟合。` } : validExtract()
      },
    })
    const result = await createDiscoverGraph(ports).invoke({
      request: { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] },
    })

    expect(result.status).toBe('completed')
    const extractCalls = ports.llmCalls.filter((c) => c.slot === 'extract')
    expect(extractCalls).toHaveLength(2)
    expect(extractCalls[1]!.prompt).toContain('上一轮产出未通过校验')
    expect(extractCalls[1]!.prompt).toContain('可能是')
  })

  it('validate² 拒（候选 1 个 < 2）→ 回 critic 重试附诊断；重试过 → completed', async () => {
    let n = 0
    const ports = makePorts({
      critic: () => {
        n += 1
        return n === 1 ? validCritic([{ question: '仅一个', priority: 'high' }]) : validCritic()
      },
    })
    const result = await createDiscoverGraph(ports).invoke({
      request: { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] },
    })

    expect(result.status).toBe('completed')
    const criticCalls = ports.llmCalls.filter((c) => c.slot === 'critic')
    expect(criticCalls).toHaveLength(2)
    expect(criticCalls[1]!.prompt).toContain('上一轮产出未通过校验')
    expect(criticCalls[1]!.prompt).toContain('2–4')
  })

  it('validate² 再拒 → 明确失败（critic 恰 2 次，K≤2 有界）', async () => {
    const ports = makePorts({ critic: () => validCritic([]) })
    await expect(
      createDiscoverGraph(ports).invoke({ request: { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] } }),
    ).rejects.toThrow()
    expect(ports.llmCalls.filter((c) => c.slot === 'critic')).toHaveLength(2)
  })

  it('evidenceGate：引用不存在的 extract 节 → 剔除该 evidence；剔除清单进 summary 不静默', async () => {
    const ports = makePorts({
      critic: () =>
        validCritic([
          { question: '消融是否充分？', priority: 'high', evidence: ['extract §3', 'extract §99'] },
          { question: '泛化证据？', priority: 'medium', evidence: [PAPER_PATH] },
        ]),
    })
    const result = await createDiscoverGraph(ports).invoke({
      request: { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] },
    })

    expect(result.status).toBe('completed')
    expect(result.summary).toContain('剔除')
    expect(result.summary).toContain('extract §99')
    const [draft] = (ports.wiki.createPage as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      { claims: { statement: string; evidence: string[] }[] },
    ]
    expect(draft.claims[0]!.evidence).toEqual(['extract §3'])
  })

  it('evidenceGate：evidence 全部剔除 → 整条 claim 不进 persist（claims 提交面）', async () => {
    const ports = makePorts({
      critic: () =>
        validCritic([
          { question: '证据全缺的候选', priority: 'high', evidence: ['extract §99'] },
          { question: '正常候选', priority: 'medium', evidence: ['extract §3'] },
        ]),
    })
    const result = await createDiscoverGraph(ports).invoke({
      request: { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] },
    })

    expect(result.status).toBe('completed')
    expect(result.summary).toContain('整条剔除')
    const [draft] = (ports.wiki.createPage as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      { claims: { statement: string; evidence: string[] }[] },
    ]
    expect(draft.claims.map((c) => c.statement)).toEqual(['正常候选'])
  })

  it('stage 序列：resolveInputs → load → extract → validate → critic → validate → evidenceGate → persist → summary', async () => {
    const ports = makePorts()
    const stages: string[] = []
    await createDiscoverGraph(ports).invoke(
      { request: { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] } },
      { onStage: (s) => stages.push(s) },
    )
    expect(stages).toEqual(['resolveInputs', 'load', 'extract', 'validate', 'critic', 'validate', 'evidenceGate', 'persist', 'summary'])
  })

  it('schema 面：EXTRACT_DOC_SCHEMA 单 content；CRITIC_DOC_SCHEMA candidates 可省略（宽容缺省，消费侧 ?? []）', () => {
    expect(EXTRACT_DOC_SCHEMA.parse({ content: 'x' })).toEqual({ content: 'x' })
    const parsed = CRITIC_DOC_SCHEMA.parse({ content: 'x' })
    expect(parsed.candidates).toBeUndefined()
  })
})
