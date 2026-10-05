// wiki 常驻检索工具单测（#789 · S2 接缝：Docker 原语注入 fake，零 daemon；openwiki 检索
// 是真实调用——镜像落地后 searchWiki/readWikiSections 在真临时目录上跑，兼作 deep-import
// dist 路径的契约测试，#725 §六风险项）。验收面（issue #789）：
//   - 常驻工具可真实检索 wiki 容器内容（镜像布局 <root>/openwiki/**、ref ↔ read round-trip）
//   - 模型面 schema 裁掉 root/wiki/workspace（键集锁定）
//   - 工具 Result 结构化 {ok}|{ok:false,error:{code,message,hint?}} 永不 throw
//   - SKIP 集过滤（镜像 = 面板 tree 同语义知识页视图）

import { afterAll, describe, expect, it } from 'vitest'
import { rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWikiRetrievalTools, pullWikiMirror, WikiMirrorUnavailableError } from '../src/runner/wikisearch'
import { fakePrimitives } from './runnerFakes'
import type { SandboxFilePrimitives } from '../src/runner/backend/primitives'

const WIKI = 'researcher-wiki-u1'
const cleanupDirs: string[] = []

afterAll(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true })
})

const enc = (s: string) => Buffer.from(s, 'utf8')

// fake wiki 容器树：两页 OKF 形态（H2 分节）+ 运行文件（应被 SKIP 过滤）
function seededPrimitives(): ReturnType<typeof fakePrimitives> {
  const fake = fakePrimitives()
  fake.trees.set(
    WIKI,
    new Map<string, Buffer | 'dir'>([
      ['/wiki', 'dir'],
      [
        '/wiki/concepts/attention.md',
        enc(
          '---\ntype: concept\ntitle: Attention\n---\n# Attention\n\n引言段。\n\n## 机制\n\n自注意力按 QK^T 缩放点积计算权重。\n\n## 复杂度\n\n序列长度平方复杂度。\n',
        ),
      ],
      ['/wiki/concepts/transformer.md', enc('---\ntitle: Transformer\n---\n# Transformer\n\n## 架构\n\n编码器-解码器结构。\n')],
      ['/wiki/index.md', enc('# INDEX\n')],
      ['/wiki/log.md', enc('# Log\n')],
      ['/wiki/INSTRUCTIONS.md', enc('# How\n')],
      ['/wiki/.git/x.md', enc('# Git\n')],
    ]),
  )
  return fake
}

function primitivesWithoutWiki(): SandboxFilePrimitives {
  return fakePrimitives().primitives
}

describe('pullWikiMirror（#789 落地镜像）', () => {
  it('容器 /wiki 树落地 <root>/openwiki/**；SKIP 集过滤；dispose 删目录', async () => {
    const fake = seededPrimitives()
    const mirror = await pullWikiMirror(fake.primitives, WIKI)
    cleanupDirs.push(mirror.root)
    expect(mirror.root.startsWith(join(tmpdir(), 'wiki-mirror-'))).toBe(true)
    const page = join(mirror.root, 'openwiki', 'concepts', 'attention.md')
    expect(statSync(page).isFile()).toBe(true)
    // SKIP：index.md / log.md / INSTRUCTIONS.md 不落地；隐藏段（.git 等）也不落地
    expect(() => statSync(join(mirror.root, 'openwiki', 'index.md'))).toThrow()
    expect(() => statSync(join(mirror.root, 'openwiki', 'log.md'))).toThrow()
    expect(() => statSync(join(mirror.root, 'openwiki', 'INSTRUCTIONS.md'))).toThrow()
    expect(() => statSync(join(mirror.root, 'openwiki', '.git', 'x.md'))).toThrow()
    await mirror.dispose()
    expect(() => statSync(mirror.root)).toThrow()
  })

  it('容器缺失（getArchive null）→ WikiMirrorUnavailableError', async () => {
    await expect(pullWikiMirror(primitivesWithoutWiki(), WIKI)).rejects.toBeInstanceOf(WikiMirrorUnavailableError)
  })
})

describe('openwiki_search / openwiki_read 常驻工具（#789 S2 真实检索）', () => {
  it('search：真实检索 wiki 容器内容，ref 带 # 锚；命中 H2 分节', async () => {
    const [search] = createWikiRetrievalTools({ primitives: seededPrimitives().primitives, wikiContainer: WIKI })
    const raw = await search.invoke({ query: '自注意力 复杂度' })
    const result = JSON.parse(raw) as { ok: boolean; data?: { results: Array<{ ref: string[]; content: string }> } }
    expect(result.ok).toBe(true)
    expect(result.data!.results.length).toBeGreaterThan(0)
    const ref = result.data!.results[0]!.ref[0]!
    expect(ref).toMatch(/^openwiki\/concepts\/attention\.md#/)
    expect(result.data!.results[0]!.content.length).toBeGreaterThan(0)
  }, 30_000)

  it('search ↔ read round-trip：按 ref 拆 page#anchor 精确读节', async () => {
    const [search, read] = createWikiRetrievalTools({ primitives: seededPrimitives().primitives, wikiContainer: WIKI })
    const searchRaw = await search.invoke({ query: '编码器 解码器' })
    const searchResult = JSON.parse(searchRaw) as { ok: boolean; data?: { results: Array<{ ref: string[] }> } }
    expect(searchResult.ok).toBe(true)
    const [page, anchor] = searchResult.data!.results[0]!.ref[0]!.split('#')
    const readRaw = await read.invoke({ page: page!, sections: [anchor!] })
    const readResult = JSON.parse(readRaw) as {
      ok: boolean
      data?: { page: string; sections: Array<{ section: string; content: string }> }
    }
    expect(readResult.ok).toBe(true)
    expect(readResult.data!.page).toBe('openwiki/concepts/transformer.md')
    expect(readResult.data!.sections[0]!.section).toBe(anchor)
    expect(readResult.data!.sections[0]!.content).toContain('编码器-解码器')
  }, 30_000)

  it('Result 结构化永不 throw：未知节/未知页/越界查询/镜像不可用 → ok:false 归类错误', async () => {
    const [, read] = createWikiRetrievalTools({ primitives: seededPrimitives().primitives, wikiContainer: WIKI })
    // 未知 section：schema 通过、openwiki 校验抛 → invalid_input
    const unknownSection = JSON.parse(
      await read.invoke({ page: 'openwiki/concepts/attention.md', sections: ['不存在的节'] }),
    ) as { ok: boolean; error: { code: string; message: string } }
    expect(unknownSection.ok).toBe(false)
    expect(unknownSection.error.code).toBe('invalid_input')
    expect(unknownSection.error.message.length).toBeGreaterThan(0)

    // 未知页 → invalid_input（ClaimsPageMissingError 归类）
    const unknownPage = JSON.parse(
      await read.invoke({ page: 'openwiki/concepts/nope.md', sections: ['任意'] }),
    ) as { ok: boolean; error: { code: string; hint?: string } }
    expect(unknownPage.ok).toBe(false)
    expect(unknownPage.error.code).toBe('invalid_input')
    expect(unknownPage.error.hint).toBeDefined()

    // 越界查询（>2000 字符）→ invalid_input（searchWiki 边界校验）
    const [search] = createWikiRetrievalTools({ primitives: seededPrimitives().primitives, wikiContainer: WIKI })
    const oversize = JSON.parse(await search.invoke({ query: '长'.repeat(2001) })) as {
      ok: boolean
      error: { code: string }
    }
    expect(oversize.ok).toBe(false)
    expect(oversize.error.code).toBe('invalid_input')

    // 容器缺失 → invalid_state
    const [missing] = createWikiRetrievalTools({ primitives: primitivesWithoutWiki(), wikiContainer: WIKI })
    const unavailable = JSON.parse(await missing.invoke({ query: '任意' })) as {
      ok: boolean
      error: { code: string }
    }
    expect(unavailable.ok).toBe(false)
    expect(unavailable.error.code).toBe('invalid_state')
  }, 30_000)

  it('空 wiki 容器（零初始化）→ ok:true 空 results（不报错）', async () => {
    const fake = fakePrimitives()
    fake.trees.set(WIKI, new Map<string, Buffer | 'dir'>([['/wiki', 'dir']]))
    const [search] = createWikiRetrievalTools({ primitives: fake.primitives, wikiContainer: WIKI })
    const raw = await search.invoke({ query: '任意' })
    const result = JSON.parse(raw) as { ok: boolean; data?: { results: unknown[] } }
    expect(result.ok).toBe(true)
    expect(result.data!.results).toEqual([])
  }, 30_000)

  it('模型面 schema 裁掉 root/wiki/workspace（键集锁定，#747 G 节）', () => {
    const [search, read] = createWikiRetrievalTools({ primitives: seededPrimitives().primitives, wikiContainer: WIKI })
    const searchShape = search.schema as unknown as { shape: Record<string, unknown> }
    const readShape = read.schema as unknown as { shape: Record<string, unknown> }
    expect(Object.keys(searchShape.shape).sort()).toEqual(['limit', 'paths', 'query'])
    expect(Object.keys(readShape.shape).sort()).toEqual(['page', 'sections'])
  })
})
