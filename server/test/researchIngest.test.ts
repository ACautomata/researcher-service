// #910 S2：W1 ingest 七节点图 invoke 返回值面（Agreements「零新缝」——图 invoke + fake
// ports，四件 ctx 之一面注入；不测内部节点接线）。fake wiki = openwiki 保真（researchFixtures
// 共享件：读面路径域强制 openwiki/ 前缀 / 缺锚 invalid_input / 页缺失 not_found——PR #917
// review P0 fake 保真度修复，读面换算不做到即挂）。
// 覆盖（853 §4.1 / issue AC）：happy path 全链 + 读面路径域换算 / create 经
// generateStructured maxTokens / capture 前缀与 .pdf 形态与单篇约束 / docs 错误码确定性拒绝
//（幻觉路径 llm 零调用）/ validate 拒 → 重试 1 次附诊断 → 再拒明确失败（K≤2 有界）/
// PluginLlmStructuredError 诊断回喂 / 幂等哨兵 created:false（verify 跳过常态路径）/
// persist Result error 透传 / verify 回读对账失败 / stage 序列上报。
import { describe, expect, it, vi } from 'vitest'
import { createIngestGraph, PAPER_PAGE_SCHEMA } from '../../plugins/research/ingest'
import type { IngestPorts } from '../../plugins/research/ingest'
import type { PluginLlmPort } from '../src/plugins/api'
import { PluginLlmStructuredError } from '../src/plugins/api'
import { PAGE_OUTPUT_MAX_TOKENS } from '../../plugins/research/values'
import { createWikiFake, validPaperPage } from './researchFixtures'

const PAPER_REL = 'papers/robust-out-of-distribution-detection.md'

const request = { workflow: 'ingest' as const, source_paths: ['/lab/uploads/2026-01-01-robust.pdf'] }

const makePorts = (
  overrides: {
    page?: () => unknown
    extractPdf?: () => unknown
    createPage?: (draft: { path: string; content: string }) => Promise<unknown>
    readPageWrap?: (base: (page: string, sections: readonly string[]) => Promise<unknown>) => (page: string, sections: readonly string[]) => Promise<unknown>
    preseedPaper?: boolean
  } = {},
): IngestPorts & { llmCalls: { prompt: string; opts: Record<string, unknown> }[]; fake: ReturnType<typeof createWikiFake> } => {
  const llmCalls: { prompt: string; opts: Record<string, unknown> }[] = []
  const pageOf = overrides.page ?? validPaperPage
  const llm: PluginLlmPort = {
    generateMultimodal: vi.fn(async () => ({ text: '' })),
    generateStructured: vi.fn(async (opts: { schema: { parse: (v: unknown) => unknown }; contents: readonly unknown[] }) => {
      llmCalls.push({ prompt: String(opts.contents[0]), opts: opts as unknown as Record<string, unknown> })
      try {
        return opts.schema.parse(pageOf())
      } catch {
        throw new PluginLlmStructuredError('结构化输出未通过 schema 校验', 'schema mismatch', 'raw')
      }
    }),
  } as unknown as PluginLlmPort
  const docs = {
    extractPdfText: vi.fn(async () => overrides.extractPdf?.() ?? { ok: true as const, data: { pages: ['page 1 text', 'page 2 text'] } }),
  }
  const fake = createWikiFake(overrides.preseedPaper ? { [PAPER_REL]: '# 预置旧页\n\n## 1 Citation\n\n旧内容' } : {})
  const wiki = {
    createPage: fake.createPage as (draft: { path: string; content: string }, prov?: unknown) => Promise<unknown>,
    readPage: fake.readPage as (page: string, sections: readonly string[]) => Promise<unknown>,
  }
  if (overrides.createPage) wiki.createPage = overrides.createPage
  if (overrides.readPageWrap) wiki.readPage = overrides.readPageWrap(fake.readPage)
  return { llm, docs, wiki: wiki as unknown as IngestPorts['wiki'], llmCalls, fake } as unknown as IngestPorts & {
    llmCalls: { prompt: string; opts: Record<string, unknown> }[]
    fake: ReturnType<typeof createWikiFake>
  }
}

describe('W1 ingest 图 invoke（S2 端口注入 fake）', () => {
  it('happy path：七节点全链 → completed + artifactPages + summary 含产物路径与指纹', async () => {
    const ports = makePorts()
    const result = await createIngestGraph(ports).invoke({ request })

    expect(result.status).toBe('completed')
    expect(result.clarify).toBeUndefined()
    expect(result.artifactPages).toEqual([
      { path: PAPER_REL, title: 'Robust Out-of-Distribution Detection' },
    ])
    expect(result.summary).toContain(PAPER_REL)
    expect(result.summary.length).toBeLessThanOrEqual(1000)

    expect(ports.fake.createPage).toHaveBeenCalledTimes(1)
    const [draft, provenance] = ports.fake.createPage.mock.calls[0] as unknown as [
      { path: string; title: string; type: string; content: string; claims: unknown[] },
      { workflow: string },
    ]
    expect(draft.path).toBe(PAPER_REL)
    expect(draft.type).toBe('paper')
    expect(draft.claims).toHaveLength(1)
    expect(provenance).toEqual({ workflow: 'ingest' })
  })

  it('verify 读面路径域换算：readPage 收 openwiki/ 前缀形态（P0#1 锁定）', async () => {
    const ports = makePorts()
    await createIngestGraph(ports).invoke({ request })
    expect(ports.fake.readPage).toHaveBeenCalledWith(`openwiki/${PAPER_REL}`, expect.anything())
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

  it('capture：非 .pdf 形态（.txt）→ capture 即明确失败（不漏到 extract）', async () => {
    const ports = makePorts()
    await expect(
      createIngestGraph(ports).invoke({ request: { workflow: 'ingest', source_paths: ['/lab/uploads/a.txt'] } }),
    ).rejects.toThrow(/\.pdf/)
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
    const bad = validPaperPage()
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
    // 断言诊断特有子串（校验 issue 文案）——「## 4 Method」在模板恒在，不作判据（PR #917 review S3）。
    expect(ports.llmCalls[1]!.prompt).toContain('缺少节标题「## 4 Method」')
  })

  it('重试再拒 → 明确失败（llm 恰 2 次调用，有界）', async () => {
    const bad = validPaperPage()
    const ports = makePorts({ page: () => ({ ...bad, content: bad.content.replace('## 6 Results', '## 6 Result') }) })
    await expect(createIngestGraph(ports).invoke({ request })).rejects.toThrow(/重试耗尽/)
    expect(ports.llmCalls).toHaveLength(2)
  })

  it('结构化解析失败（PluginLlmStructuredError）→ 重试附原始诊断回喂', async () => {
    let n = 0
    const ports = makePorts()
    ;(ports.llm.generateStructured as ReturnType<typeof vi.fn>).mockImplementation(async (opts: { schema: { parse: (v: unknown) => unknown }; contents: readonly unknown[] }) => {
      n += 1
      ports.llmCalls.push({ prompt: String(opts.contents[0]), opts: opts as unknown as Record<string, unknown> })
      if (n === 1) throw new PluginLlmStructuredError('结构化输出解析失败：JSON 语法错误', 'JSON 语法错误: unexpected end', 'raw')
      return opts.schema.parse(validPaperPage())
    })
    const result = await createIngestGraph(ports).invoke({ request })

    expect(result.status).toBe('completed')
    expect(ports.llmCalls).toHaveLength(2)
    expect(ports.llmCalls[1]!.prompt).toContain('JSON 语法错误')
  })

  it('幂等哨兵：页已存在 → created:false → verify 跳过 + 正常完成 + summary 说明页已存在', async () => {
    const ports = makePorts({ preseedPaper: true })
    const result = await createIngestGraph(ports).invoke({ request })

    expect(result.status).toBe('completed')
    expect(result.summary).toContain('已存在')
    expect(result.artifactPages).toHaveLength(1)
    // 幂等跳过路径 verify 对旧页不做哈希对账（旧页 ≠ 本次草稿）——readPage 零调用（Spec#5）。
    expect(ports.fake.readPage).not.toHaveBeenCalled()
  })

  it('persist Result error（mirror_unavailable）→ 明确失败透传诊断', async () => {
    const ports = makePorts({
      createPage: async () => ({ ok: false, error: { code: 'mirror_unavailable', message: 'wiki 不可用' } }),
    })
    await expect(createIngestGraph(ports).invoke({ request })).rejects.toThrow(/mirror_unavailable|wiki/)
  })

  it('verify 回读缺节（对账失败）→ 明确失败', async () => {
    const ports = makePorts({
      readPageWrap:
        (base) =>
        async (page, sections) => {
          const r = (await base(page, sections)) as { ok: boolean; data?: { page: string; sections: { section: string; content: string }[] } }
          if (!r.ok) return r
          return { ...r, data: { ...r.data!, sections: r.data!.sections.slice(0, 10) } }
        },
    })
    await expect(createIngestGraph(ports).invoke({ request })).rejects.toThrow(/哈希对账/)
  })

  it('verify 哈希对账：回读内容与写入正文不一致（篡改）→ 明确失败', async () => {
    const ports = makePorts({
      readPageWrap:
        (base) =>
        async (page, sections) => {
          const r = (await base(page, sections)) as { ok: boolean; data?: { page: string; sections: { section: string; content: string }[] } }
          if (!r.ok) return r
          return {
            ...r,
            data: {
              ...r.data!,
              sections: r.data!.sections.map((s, i) => (i === 0 ? { ...s, content: `${s.content.split('\n')[0]}\n\n被篡改的引用信息。` } : s)),
            },
          }
        },
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
