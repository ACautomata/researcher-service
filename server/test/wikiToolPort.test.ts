// #908 S3 + port 行为（零新缝——fake 原语外部行为，沿 #873 已确认测试缝）：
// PluginWikiPort 读面（与主 agent wikisearch 同封装同行为）+ createPage 幂等哨兵 +
// SKIP 集 assertNotManaged + 路径校验 + owner 级进程内锁（并发 probe→put 竞态窗关闭）+
// ensure 前置 + source/toolCallId 盖章。fakePrimitives MemFs = S2 既有接缝，不新造。

import { describe, it, expect } from 'vitest'
import { createTarTree } from '../src/files/tar'
import { WIKI_ROOT } from '../src/wikiContainers/values'
import { createPluginWikiPort, PluginWikiPortError } from '../src/runner/wikiToolPort'
import { runWithToolCallContext } from '../src/runner/filejournal/context'
import { fakePrimitives } from './runnerFakes'

const OWNER = 'u1'
const CONTAINER = 'researcher-wiki-u1'
const NOW = Date.parse('2026-10-11T08:00:00Z')

const DRAFT = {
  path: 'papers/attention.md',
  title: 'Attention',
  type: 'paper' as const,
  content: '# Attention\n\n正文。',
}

function makePort(mem: ReturnType<typeof fakePrimitives>, extra: Record<string, unknown> = {}) {
  const ensured: string[] = []
  const port = createPluginWikiPort({
    ownerId: OWNER,
    container: CONTAINER,
    primitives: mem.primitives,
    ensure: async () => {
      ensured.push('ensure')
    },
    source: 'research',
    now: () => NOW,
    ...extra,
  })
  return { port, ensured }
}

function seed(mem: ReturnType<typeof fakePrimitives>) {
  // 直接落树（wikisearch.test.ts 同款范式——/wiki 根本身须为 'dir' 条目，getArchive 目录分支才命中）
  mem.trees.set(
    CONTAINER,
    new Map<string, Buffer | 'dir'>([
      [WIKI_ROOT, 'dir'],
      [`${WIKI_ROOT}/concepts`, 'dir'],
      [
        `${WIKI_ROOT}/concepts/attention.md`,
        Buffer.from('---\ntitle: Attention\n---\n# Attention\n\nScaled dot-product attention 机制。\n'),
      ],
      [`${WIKI_ROOT}/log.md`, Buffer.from('# 运行日志\n\nSECRETTERM 只出现在 SKIP 文件里。\n')],
    ]),
  )
}

describe('读面：与主 agent wikisearch 同一套检索（SKIP 集过滤镜像）', () => {
  it('search 命中种子页；SKIP 集文件（log.md）不进检索面', async () => {
    const mem = fakePrimitives()
    await seed(mem)
    const { port } = makePort(mem)
    const found = await port.search('attention 机制')
    expect(found.results.length).toBeGreaterThan(0)
    const refs = found.results.flatMap((r) => r.ref)
    expect(refs.some((r) => r.startsWith('openwiki/concepts/attention.md'))).toBe(true)
    const leak = await port.search('SECRETTERM')
    expect(leak.results).toEqual([])
  })

  it('readPage 读回页内 section（与 openwiki_read 同参数面 page+sections）', async () => {
    const mem = fakePrimitives()
    await seed(mem)
    const { port } = makePort(mem)
    const res = await port.readPage('openwiki/concepts/attention.md', ['attention'])
    expect(res.page).toContain('concepts/attention.md')
    expect(res.sections.length).toBeGreaterThan(0)
    expect(res.sections[0]!.content).toContain('Scaled dot-product attention')
  })
})

describe('createPage 幂等哨兵与写面纪律', () => {
  it('新页：ensure 前置 → put 落树 → created:true；frontmatter 组装产物可读回', async () => {
    const mem = fakePrimitives()
    const { port, ensured } = makePort(mem)
    const r = await runWithToolCallContext({ toolCallId: 'tc-wiki-1', threadId: 's1' }, () =>
      port.createPage(DRAFT, { workflow: 'ingest', relatedPages: ['concepts/attention.md'] }),
    )
    expect(r).toEqual({ created: true })
    expect(ensured).toEqual(['ensure'])
    const stored = mem.trees.get(CONTAINER)?.get(`${WIKI_ROOT}/papers/attention.md`)
    expect(stored).toBeDefined()
    const md = stored!.toString('utf8')
    expect(md).toContain('type: paper')
    expect(md).toContain('toolCallId: "tc-wiki-1"')
    expect(md).toContain('workflow: "ingest"')
    expect(md).toContain('related_pages: ["concepts/attention.md"]')
    expect(md).toContain('source: "research"')
    expect(md).toContain('# Attention\n\n正文。')
  })

  it('页已存在：created:false 不抛错、不覆盖、不再 put（重放窗口常态路径）', async () => {
    const mem = fakePrimitives()
    await seed(mem)
    const { port } = makePort(mem)
    let puts = 0
    const put = mem.primitives.putArchive.bind(mem.primitives)
    mem.primitives.putArchive = async (...args) => {
      puts += 1
      return put(...args)
    }
    const r = await port.createPage({ ...DRAFT, path: 'concepts/attention.md', content: '# 覆盖' })
    expect(r).toEqual({ created: false })
    expect(puts).toBe(0)
    expect(mem.trees.get(CONTAINER)?.get(`${WIKI_ROOT}/concepts/attention.md`)?.toString()).toContain('Scaled dot-product')
  })

  it('SKIP 集 assertNotManaged：.claims 旁车/ _attachments/ log.md 等托管路径拒写', async () => {
    const mem = fakePrimitives()
    const { port } = makePort(mem)
    for (const bad of ['.claims/x.md', 'papers/.claims/x.md', '_attachments/a.md', 'log.md', 'concepts/index.md', 'INSTRUCTIONS.md']) {
      await expect(port.createPage({ ...DRAFT, path: bad })).rejects.toMatchObject({
        name: 'PluginWikiPortError', code: 'managed_path',
      })
    }
  })

  it('路径校验：绝对/穿越/反斜杠/非 .md 拒写（normalizeRelPath 同款纪律）', async () => {
    const mem = fakePrimitives()
    const { port } = makePort(mem)
    for (const bad of ['/abs.md', '../up.md', 'a/../b.md', 'a\\b.md', 'notes.txt', 'a/b.md/c']) {
      await expect(port.createPage({ ...DRAFT, path: bad })).rejects.toMatchObject({ code: 'invalid_path' })
    }
  })

  it('目录占位页路径：path_occupied 明确报错（不静默跳过）', async () => {
    const mem = fakePrimitives()
    await seed(mem)
    const { port } = makePort(mem)
    await expect(port.createPage({ ...DRAFT, path: 'concepts' })).rejects.toMatchObject({ code: 'invalid_path' })
    // 目录形态占位（.md 名但实为目录）→ occupied
    await mem.primitives.putArchive(CONTAINER, WIKI_ROOT, createTarTree([
      { name: 'papers', type: 'directory', modeOctal: '0000755' },
      { name: 'papers/dir.md', type: 'directory', modeOctal: '0000755' },
    ]))
    await expect(port.createPage({ ...DRAFT, path: 'papers/dir.md' })).rejects.toMatchObject({ code: 'path_occupied' })
  })

  it('DTO 畸形输入（空 title/type 越集）：invalid_draft 明确报错', async () => {
    const mem = fakePrimitives()
    const { port } = makePort(mem)
    await expect(port.createPage({ ...DRAFT, title: '' })).rejects.toMatchObject({ code: 'invalid_draft' })
    await expect(port.createPage({ ...DRAFT, type: 'blog' as never })).rejects.toMatchObject({ code: 'invalid_draft' })
  })
})

describe('owner 级进程内锁：并发同路径 probe→put 竞态窗关闭', () => {
  it('两个并发 createPage 同路径：仅一次 put、恰好一个 created:true', async () => {
    const mem = fakePrimitives()
    // 延迟原语：probe 与 put 间给对偶调用创造重叠窗口——无锁实现两个都会 probe 到「不存在」
    let putCalls = 0
    const base = mem.primitives
    const delayed: typeof base = {
      ...base,
      async getArchive(...args) {
        await new Promise((r) => setTimeout(r, 30))
        return base.getArchive(...args)
      },
      async putArchive(...args) {
        putCalls += 1
        await new Promise((r) => setTimeout(r, 30))
        return base.putArchive(...args)
      },
    }
    const { port } = makePort({ ...mem, primitives: delayed })
    const [r1, r2] = await Promise.all([
      port.createPage(DRAFT),
      port.createPage({ ...DRAFT, content: '# 另一个' }),
    ])
    expect([r1.created, r2.created].sort()).toEqual([false, true])
    expect(putCalls).toBe(1)
  })

  it('锁 key 含 ownerId：不同 owner 同路径互不阻塞（put 区间重叠）', async () => {
    const mem = fakePrimitives()
    const events: string[] = []
    const base = mem.primitives
    const delayed: typeof base = {
      ...base,
      async putArchive(...args) {
        events.push('start')
        await new Promise((r) => setTimeout(r, 30))
        events.push('end')
        return base.putArchive(...args)
      },
    }
    const mk = (owner: string, container: string) =>
      createPluginWikiPort({ ownerId: owner, container, primitives: delayed, source: 'research', now: () => NOW })
    await Promise.all([mk('u1', 'researcher-wiki-u1').createPage(DRAFT), mk('u2', 'researcher-wiki-u2').createPage(DRAFT)])
    // per-owner 锁：两次 put 区间重叠（start,start,end,end）；全局锁则 start,end,start,end
    expect(events).toEqual(['start', 'start', 'end', 'end'])
  })
})

describe('错误面', () => {
  it('PluginWikiPortError 携带稳定 code', () => {
    const e = new PluginWikiPortError('managed_path', 'x')
    expect(e.code).toBe('managed_path')
    expect(e).toBeInstanceOf(Error)
  })
})
