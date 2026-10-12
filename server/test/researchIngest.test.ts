// #910 S2：W1 ingest 七节点图 invoke 返回值面（Agreements「零新缝」——图 invoke + fake
// ports，四件 ctx 之一面注入；不测内部节点接线）。
// 覆盖（853 §4.1 / issue AC）：happy path 全链 / capture 前缀与单篇约束 / docs 错误码
// 确定性拒绝（幻觉路径 llm 零调用）/ validate 拒 → 重试 1 次附诊断 → 再拒明确失败（K≤2
// 有界）/ PluginLlmStructuredError 诊断回喂 / 幂等哨兵 created:false 常态路径 / verify
// 回读对账失败 → 明确失败 / stage 序列上报。
import { describe, expect, it, vi } from 'vitest'
import { createIngestGraph, PAPER_PAGE_SCHEMA } from '../../plugins/research/ingest'
import type { IngestPorts } from '../../plugins/research/ingest'
import type { PluginLlmPort } from '../../server/src/plugins/api'
import { PluginLlmStructuredError } from '../../server/src/plugins/api'
import { PAPER_PAGE_SECTIONS } from '../../plugins/research/prompts'
import { PAGE_OUTPUT_MAX_TOKENS } from '../../plugins/research/values'

const validPage = () => ({
  title: 'Robust Out-of-Distribution Detection',
  content: [
    ...PAPER_PAGE_SECTIONS.map((s, i) => `## ${i + 1} ${s}\n\n第 ${i + 1} 节。AUROC 95.12% vs. MCM 86.05%，FPR95 8.56。`),
    ...Array.from({ length: 100 }, (_, i) => `填充行 ${i}：实验设置与结论细节。`),
  ].join('\n\n'),
  claims: [{ statement: '该方法在 CIFAR-100 上 AUROC 达 95.12%', evidence: ['论文 §6 Table 2'] }],
})

const makePorts = (overrides: {
  page?: () => unknown
  createPageResult?: () => { ok: true; data: { created: boolean } } | { ok: false; error: { code: string; message: string } }
  readPageSections?: (sections: readonly string[]) => { section: string; content: string }[]
} = {}): IngestPorts & { llmCalls: { prompt: string; opts: Record<string, unknown> }[] } => {
  const llmCalls: { prompt: string; opts: Record<string, unknown> }[] = []
  const pageOf = overrides.page ?? validPage
  // verify 真哈希对账面：createPage 捕获写入正文，readPage 按节标题行切分原样回读
  //（模拟 openwiki section raw = 原 heading + 正文的切片行为）。
  let persistedContent: string | undefined
  const splitBySectionHeading = (content: string): string[] => {
    const lines = content.split('\n')
    const heads = lines.map((l, i) => (l.startsWith('## ') ? i : -1)).filter((i) => i >= 0)
    return heads.map((start, k) => lines.slice(start, k + 1 < heads.length ? heads[k + 1]! : lines.length).join('\n'))
  }
  const llm: PluginLlmPort = {
    generateMultimodal: vi.fn(async () => ({ text: '' })),
    generateStructured: vi.fn(async (opts: { schema: { parse: (v: unknown) => unknown }; contents: readonly unknown[] }) => {
      llmCalls.push({ prompt: String(opts.contents[0]), opts: opts as unknown as Record<string, unknown> })
      try {
        return opts.schema.parse(pageOf())
      } catch (e) {
        throw new PluginLlmStructuredError('结构化输出未通过 schema 校验', 'schema mismatch', 'raw')
      }
    }),
  } as unknown as PluginLlmPort
  const docs = {
    extractPdfText: vi.fn(async () => ({ ok: true as const, data: { pages: ['page 1 text', 'page 2 text'] } })),
  }
  const wiki = {
    createPage: vi.fn(async (draft: { content: string }) => {
      persistedContent = draft.content
      return overrides.createPageResult?.() ?? { ok: true as const, data: { created: true } }
    }),
    readPage: vi.fn(async (_page: string, sections: readonly string[]) => {
      if (overrides.readPageSections) {
        return { ok: true as const, data: { page: 'papers/robust-out-of-distribution-detection.md', sections: overrides.readPageSections(sections) } }
      }
      const slices = splitBySectionHeading(persistedContent ?? '')
      return {
        ok: true as const,
        data: {
          page: 'papers/robust-out-of-distribution-detection.md',
          sections: sections.map((s, i) => ({ section: s, content: slices[i] ?? '' })),
        },
      }
    }),
  }
  return { llm, docs, wiki, llmCalls } as unknown as IngestPorts & { llmCalls: { prompt: string; opts: Record<string, unknown> }[] }
}

const request = { workflow: 'ingest' as const, source_paths: ['/lab/uploads/2026-01-01-robust.pdf'] }

describe('W1 ingest 图 invoke（S2 端口注入 fake）', () => {
  it('happy path：七节点全链 → completed + artifactPages + summary 含产物路径与指纹', async () => {
    const ports = makePorts()
    const result = await createIngestGraph(ports).invoke({ request })

    expect(result.status).toBe('completed')
    expect(result.clarify).toBeUndefined()
    expect(result.artifactPages).toEqual([
      { path: 'papers/robust-out-of-distribution-detection.md', title: 'Robust Out-of-Distribution Detection' },
    ])
    expect(result.summary).toContain('papers/robust-out-of-distribution-detection.md')
    expect(result.summary.length).toBeLessThanOrEqual(1000)

    const wiki = ports.wiki as unknown as { createPage: ReturnType<typeof vi.fn> }
    expect(wiki.createPage).toHaveBeenCalledTimes(1)
    const [draft, provenance] = wiki.createPage.mock.calls[0] as unknown as [
      { path: string; title: string; type: string; content: string; claims: unknown[] },
      { workflow: string },
    ]
    expect(draft.path).toBe('papers/robust-out-of-distribution-detection.md')
    expect(draft.type).toBe('paper')
    expect(draft.claims).toHaveLength(1)
    expect(provenance.workflow).toBe('ingest')
  })

  it('create 经 generateStructured：maxTokens = PAGE_OUTPUT_MAX_TOKENS 传入', async () => {
    const ports = makePorts()
    await createIngestGraph(ports).invoke({ request })
    expect(ports.llmCalls[0]?.opts.maxTokens).toBe(PAGE_OUTPUT_MAX_TOKENS)
  })

  it('capture：非 /lab/uploads 前缀 → 明确失败（幻觉路径确定性拒绝），llm 零调用', async () => {
    const ports = makePorts()
    await expect(
      createIngestGraph(ports).invoke({ request: { workflow: 'ingest', source_paths: ['/lab/other/a.pdf'] } }),
    ).rejects.toThrow(/lab\/uploads/)
    expect(ports.llmCalls).toHaveLength(0)
  })

  it('capture：多篇 → V1 单篇明确失败（853 §4.1 钉）', async () => {
    const ports = makePorts()
    await expect(
      createIngestGraph(ports).invoke({ request: { workflow: 'ingest', source_paths: ['/lab/uploads/a.pdf', '/lab/uploads/b.pdf'] } }),
    ).rejects.toThrow(/单篇/)
  })

  it('extract：docs not_found（幻觉路径）→ 明确失败，llm 零调用', async () => {
    const ports = makePorts()
    ;(ports.docs.extractPdfText as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: { code: 'not_found', message: 'PDF 不存在' },
    })
    await expect(createIngestGraph(ports).invoke({ request })).rejects.toThrow(/not_found|PDF/)
    expect(ports.llmCalls).toHaveLength(0)
  })

  it('validate 拒（缺节）→ 回 create 重试 1 次附诊断；重试过 → completed（K≤2）', async () => {
    const bad = validPage()
    const pages = { n: 0 }
    const ports = makePorts({
      page: () => {
        pages.n += 1
        if (pages.n === 1) return { ...bad, content: bad.content.split('\n').filter((l) => !l.startsWith('## 4 ')).join('\n') }
        return bad
      },
    })
    const result = await createIngestGraph(ports).invoke({ request })

    expect(result.status).toBe('completed')
    expect(ports.llmCalls).toHaveLength(2)
    expect(ports.llmCalls[1]!.prompt).toContain('上一轮产出未通过校验')
    expect(ports.llmCalls[1]!.prompt).toContain('## 4 Method')
  })

  it('重试再拒 → 明确失败（llm 恰 2 次调用，有界）', async () => {
    const bad = validPage()
    const ports = makePorts({ page: () => ({ ...bad, content: bad.content.replace('## 6 Results', '## 6 Result') }) })
    await expect(createIngestGraph(ports).invoke({ request })).rejects.toThrow()
    expect(ports.llmCalls).toHaveLength(2)
  })

  it('结构化解析失败（PluginLlmStructuredError）→ 重试附原始诊断回喂', async () => {
    let n = 0
    const ports = makePorts()
    ;(ports.llm.generateStructured as ReturnType<typeof vi.fn>).mockImplementation(async (opts: { schema: { parse: (v: unknown) => unknown }; contents: readonly unknown[] }) => {
      n += 1
      ports.llmCalls.push({ prompt: String(opts.contents[0]), opts: opts as unknown as Record<string, unknown> })
      if (n === 1) throw new PluginLlmStructuredError('结构化输出解析失败：JSON 语法错误', 'JSON 语法错误: unexpected end', 'raw')
      return opts.schema.parse(validPage())
    })
    const result = await createIngestGraph(ports).invoke({ request })

    expect(result.status).toBe('completed')
    expect(ports.llmCalls).toHaveLength(2)
    expect(ports.llmCalls[1]!.prompt).toContain('JSON 语法错误')
  })

  it('幂等哨兵：createPage → created:false（重放窗口）→ 正常完成 + summary 说明页已存在', async () => {
    const ports = makePorts({ createPageResult: () => ({ ok: true, data: { created: false } }) })
    const result = await createIngestGraph(ports).invoke({ request })

    expect(result.status).toBe('completed')
    expect(result.summary).toContain('已存在')
    expect(result.artifactPages).toHaveLength(1)
  })

  it('persist Result error（mirror_unavailable）→ 明确失败透传诊断', async () => {
    const ports = makePorts({ createPageResult: () => ({ ok: false, error: { code: 'mirror_unavailable', message: 'wiki 不可用' } }) })
    await expect(createIngestGraph(ports).invoke({ request })).rejects.toThrow(/mirror_unavailable|wiki/)
  })

  it('verify 回读缺节（对账失败）→ 明确失败', async () => {
    const ports = makePorts({ readPageSections: (sections) => sections.slice(0, 10).map((s) => ({ section: s, content: `## ${s}\n\n内容` })) })
    await expect(createIngestGraph(ports).invoke({ request })).rejects.toThrow(/回读|对账/)
  })

  it('verify 哈希对账：回读内容与写入正文不一致（篡改）→ 明确失败', async () => {
    const ports = makePorts({
      readPageSections: (sections) =>
        sections.map((s, i) => ({ section: s, content: i === 0 ? '## 1 Citation\n\n被篡改的引用信息。' : `## ${s}\n\n原样内容。` })),
    })
    await expect(createIngestGraph(ports).invoke({ request })).rejects.toThrow(/哈希对账/)
  })

  it('stage 序列：capture → extract → create → validate → persist → verify → summary', async () => {
    const ports = makePorts()
    const stages: string[] = []
    await createIngestGraph(ports).invoke({ request }, { onStage: (s) => stages.push(s) })
    expect(stages).toEqual(['capture', 'extract', 'create', 'validate', 'persist', 'verify', 'summary'])
  })

  it('PAPER_PAGE_SCHEMA：claims 可省略（宽容缺省面，消费侧 ?? []）', () => {
    const parsed = PAPER_PAGE_SCHEMA.parse({ title: 'T', content: 'x' })
    expect(parsed.claims).toBeUndefined()
  })
})
