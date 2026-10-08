// WikiService 聚合逻辑单测（#335 · 对 fake WikiFileSystem 直测，不碰磁盘/DB）。
// 契约锚点 = backend/wiki/tests/test_service_fake_fs.py + test_graph_api.py。
// 验证：CRUD 域错误映射、buildGraph 节点/边/ghost/不 dedup。
// fake 自 #621 起共享于 ./fakes（REST 契约测试 wiki.test.ts 同用）。

import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { WikiInvalidPath, WikiPageExists, WikiPageNotFound } from '../src/wiki/errors'
import { WikiService } from '../src/wiki/service'
import { FakeWikiFileSystem } from './fakes'

function fixtureFs(): FakeWikiFileSystem {
  return new FakeWikiFileSystem({
    'concepts/attention.md': '---\ntitle: Attention\n---\n# Attention\n见 [[self-attention]]。\n',
    'concepts/transformer.md': '---\ntitle: Transformer\n---\n# T\n',
    'domains/cv/papers/resnet.md': '---\npaper:\n  title: ResNet\nrelated_pages: [attention]\n---\n# ResNet\n',
    'experiments/trial-1.md': '---\ntitle: Trial 1\n---\n# Trial 1\n',
  })
}

describe('WikiService CRUD（fake FS）', () => {
  it('build_tree：按页面真实顶层目录分组，未知目录也成组；无页目录不成组', async () => {
    const svc = new WikiService(fixtureFs())
    const tree = await svc.buildTree()
    const kinds = tree.groups.map((g) => g.kind)
    expect(kinds).toEqual(expect.arrayContaining(['concepts', 'domains', 'experiments']))
    expect(kinds).not.toContain('concept')
    expect(kinds).not.toContain('entities')
    const experiments = tree.groups.find((g) => g.kind === 'experiments')!
    expect(experiments.name).toBe('experiments')
    expect(experiments.pages.map((p) => p.path)).toEqual(['experiments/trial-1.md'])
  })

  it('read_page：原文 + frontmatter title', async () => {
    const svc = new WikiService(fixtureFs())
    const page = await svc.readPage('concepts/attention.md')
    expect(page.path).toBe('concepts/attention.md')
    expect(page.title).toBe('Attention')
    expect(page.content).toContain('# Attention')
  })

  it('read_page 缺失 → WikiPageNotFound', async () => {
    await expect(new WikiService(fixtureFs()).readPage('concepts/nope.md')).rejects.toBeInstanceOf(WikiPageNotFound)
  })

  it('write_page 覆写；缺失 → WikiPageNotFound', async () => {
    const svc = new WikiService(fixtureFs())
    await svc.writePage('concepts/attention.md', '# 已编辑\n')
    expect((await svc.readPage('concepts/attention.md')).content).toBe('# 已编辑\n')
    await expect(svc.writePage('concepts/nope.md', 'x')).rejects.toBeInstanceOf(WikiPageNotFound)
  })

  it('create_page 新建；已存在 → WikiPageExists', async () => {
    const svc = new WikiService(fixtureFs())
    await svc.createPage('concepts/new.md', '# New\n')
    expect((await svc.readPage('concepts/new.md')).content).toBe('# New\n')
    await expect(svc.createPage('concepts/attention.md', 'x')).rejects.toBeInstanceOf(WikiPageExists)
  })

  it('delete_page 删除；缺失 → WikiPageNotFound', async () => {
    const svc = new WikiService(fixtureFs())
    await svc.deletePage('concepts/attention.md')
    await expect(svc.readPage('concepts/attention.md')).rejects.toBeInstanceOf(WikiPageNotFound)
    await expect(svc.deletePage('concepts/nope.md')).rejects.toBeInstanceOf(WikiPageNotFound)
  })

  it('路径越权（穿越/managed 目录/managed 文件）在 CRUD 全路径上抛 WikiInvalidPath', async () => {
    const svc = new WikiService(fixtureFs())
    const cases: Array<() => Promise<unknown>> = [
      () => svc.readPage('../../evil.md'),
      () => svc.readPage('_attachments/evil.md'),
      () => svc.readPage('concepts/index.md'),
      () => svc.writePage('../../evil.md', 'x'),
      () => svc.createPage('_attachments/evil.md', 'x'),
      () => svc.createPage('concepts/index.md', 'x'),
      () => svc.deletePage('../../evil.md', ),
      () => svc.deletePage('_attachments/evil.md'),
    ]
    for (const fn of cases) {
      await expect(fn()).rejects.toBeInstanceOf(WikiInvalidPath)
    }
  })
})

describe('WikiService buildGraph（fake FS）', () => {
  it('节点 = tree 全部页；wikilink 不可解析 → ghost 节点', async () => {
    const graph = await new WikiService(fixtureFs()).buildGraph()
    const nodeIds = graph.nodes.map((n) => n.id)
    expect(nodeIds).toEqual(expect.arrayContaining(['concepts/attention.md', 'domains/cv/papers/resnet.md']))
    const ghost = graph.nodes.find((n) => n.id === 'self-attention')
    expect(ghost).toMatchObject({ id: 'self-attention', title: 'self-attention', ghost: true })
    expect(graph.edges).toContainEqual({ from: 'concepts/attention.md', to: 'self-attention' })
  })

  it('related_pages（字符串/列表）出边；stem 解析到真实节点', async () => {
    const graph = await new WikiService(fixtureFs()).buildGraph()
    expect(graph.edges).toContainEqual({ from: 'domains/cv/papers/resnet.md', to: 'concepts/attention.md' })
  })

  it('边不 dedup：同页多次引用同一目标产生多条同 from/to 边', async () => {
    const fs = new FakeWikiFileSystem({
      'a/x.md': '# X\n\n[[y]]\n\n再引 [[y]]\n',
    })
    const graph = await new WikiService(fs).buildGraph()
    const dup = graph.edges.filter((e) => e.from === 'a/x.md' && e.to === 'y')
    expect(dup.length).toBe(2)
  })

  it('同一 from→to 先 resolve 真节点与 ghost 并存（wikiLink 别名/related 混用）', async () => {
    const fs = new FakeWikiFileSystem({
      'a/p.md': '---\nrelated_pages: [b/t.md]\n---\n# P\n\n[[b/t]]\n',
      'b/t.md': '# T\n',
    })
    const graph = await new WikiService(fs).buildGraph()
    const edges = graph.edges.filter((e) => e.from === 'a/p.md')
    // [[b/t]] 的 stem `t` 匹配 b/t.md → 真节点；related_pages 整串 b/t.md → 真节点。两条同 to。
    expect(edges.every((e) => e.to === 'b/t.md')).toBe(true)
    expect(edges.length).toBe(2)
  })

  it('单页读不出 → 跳过该页的边，不 500', async () => {
    const fs = new FakeWikiFileSystem({ 'a/x.md': '# X\n\n[[y]]\n' })
    const original = fs.readPage.bind(fs)
    fs.readPage = async (rel) => {
      if (rel === 'a/x.md') throw new Error('read boom')
      return original(rel)
    }
    const graph = await new WikiService(fs).buildGraph()
    expect(graph.nodes).toHaveLength(1)
    expect(graph.edges).toHaveLength(0)
  })

  it('wikilink 目标为 Object.prototype 成员名（constructor）→ ghost 节点仍建', async () => {
    const fs = new FakeWikiFileSystem({ 'a/x.md': '# X\n\n[[constructor]]\n' })
    const graph = await new WikiService(fs).buildGraph()
    const ghost = graph.nodes.find((n) => n.id === 'constructor')
    expect(ghost).toMatchObject({ id: 'constructor', title: 'constructor', ghost: true })
    expect(graph.edges).toContainEqual({ from: 'a/x.md', to: 'constructor' })
  })

  it('wikilink 目标为 __proto__ → ghost 节点仍建（codex PR#346）', async () => {
    const fs = new FakeWikiFileSystem({ 'a/x.md': '# X\n\n[[__proto__]]\n' })
    const graph = await new WikiService(fs).buildGraph()
    const ghost = graph.nodes.find((n) => n.id === '__proto__')
    expect(ghost).toMatchObject({ id: '__proto__', title: '__proto__', ghost: true })
    expect(graph.edges).toContainEqual({ from: 'a/x.md', to: '__proto__' })
  })
})

// ---------------------------------------------------------------------------
// #789 OKF 适配（wiki 域）：markdown 相对链接边 / SKIP 集扩充 / okf 徽章 / claims 只读面。
// ---------------------------------------------------------------------------

describe('WikiService buildGraph markdown 相对链接边（#789 story 43）', () => {
  it('OKF 相对链接出边，解析复用 stem/title/整串链', () => {
    const fs = new FakeWikiFileSystem({
      'concepts/attention.md': '# A\n见 [Transformer](../concepts/transformer.md)。\n',
      'concepts/transformer.md': '# T\n[反向](attention.md)。\n',
    })
    const graph = new WikiService(fs).buildGraph()
    return graph.then((g) => {
      expect(g.edges).toContainEqual({ from: 'concepts/attention.md', to: 'concepts/transformer.md' })
      expect(g.edges).toContainEqual({ from: 'concepts/transformer.md', to: 'concepts/attention.md' })
    })
  })

  it('不可解析的 markdown 链接 → ghost 节点（复用 ghost 机制）', () => {
    const fs = new FakeWikiFileSystem({
      'a/x.md': '# X\n[缺失](missing/target.md)。\n',
    })
    return new WikiService(fs).buildGraph().then((g) => {
      expect(g.nodes).toContainEqual({ id: 'missing/target.md', title: 'missing/target.md', ghost: true })
      expect(g.edges).toContainEqual({ from: 'a/x.md', to: 'missing/target.md' })
    })
  })

  it('外链/图片/锚点不出边（只收 .md 相对目标）', () => {
    const fs = new FakeWikiFileSystem({
      'a/x.md': '# X\n[外](https://a.com/b.md) [图](img.png) [锚](#s) [绝](/b.md)\n',
    })
    return new WikiService(fs).buildGraph().then((g) => {
      expect(g.edges).toHaveLength(0)
    })
  })
})

describe('SKIP 集扩充（#789：log.md/INSTRUCTIONS.md/.claims）', () => {
  it('SKIP 文件与 .claims 不进树；写侧拒绝（managed 黑名单）', async () => {
    const fs = new FakeWikiFileSystem({
      'log.md': '# Log\n',
      'INSTRUCTIONS.md': '# How\n',
      '.claims/a.json': '{}',
      'concepts/a.md': '# A\n',
    })
    const svc = new WikiService(fs)
    const tree = await svc.buildTree()
    const paths = tree.groups.flatMap((g) => g.pages.map((p) => p.path))
    expect(paths).toEqual(['concepts/a.md'])
    await expect(svc.writePage('log.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(svc.createPage('INSTRUCTIONS.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
  })
})

describe('WikiService okf 徽章与 claims 只读面（#789 story 41/42 数据面）', () => {
  const OKF_PAGE = [
    '---',
    'type: concept',
    'title: Attention',
    'status: stable',
    'stale_after: 2026-12-01T00:00:00+00:00',
    'generated: {by: openwiki, at: 2026-09-30T12:00:00Z}',
    '---',
    '# Attention',
    '',
    '正文。',
  ].join('\n')

  function okfFs(): FakeWikiFileSystem {
    return new FakeWikiFileSystem({ 'concepts/attention.md': OKF_PAGE, 'concepts/plain.md': '# Plain\n' })
  }

  it('readPage 附带 okf 徽章（status/staleAfter/generatedAt）；非 OKF 页无 okf 字段', async () => {
    const svc = new WikiService(okfFs())
    const page = await svc.readPage('concepts/attention.md')
    expect(page.okf).toEqual({
      status: 'stable',
      staleAfter: '2026-12-01T00:00:00+00:00',
      generatedAt: '2026-09-30T12:00:00Z',
    })
    const plain = await svc.readPage('concepts/plain.md')
    expect(plain.okf).toBeUndefined()
  })

  it('readClaims：旁车存在 → claims + 漂移状态（页未动 fresh，页动过 drifted）', async () => {
    const fs = okfFs()
    // 旁车 pageVersion = 当前页字节哈希（openwiki hashPage 同源）→ fresh
    const hash = createHash('sha256').update(Buffer.from(OKF_PAGE, 'utf8')).digest('hex')
    fs.claims.set('.claims/concepts/attention.json', JSON.stringify({
      schemaVersion: 1,
      pageVersion: `sha256:${hash}`,
      claims: [{ id: 'claim_a', statement: '论断', evidence: [{ resource: 'repo://x.ts#L1-L2', version: 'repo-lines-v1:s:h:f' }] }],
    }))
    const svc = new WikiService(fs)
    const claims = await svc.readClaims('concepts/attention.md')
    expect(claims.schemaVersion).toBe(1)
    expect(claims.pageVersion).toBe(`sha256:${hash}`)
    expect(claims.drift).toBe('fresh')
    expect(claims.claims[0]!.evidence[0]!.resource).toBe('repo://x.ts#L1-L2')

    await svc.writePage('concepts/attention.md', OKF_PAGE + '\n追加。')
    const drifted = await svc.readClaims('concepts/attention.md')
    expect(drifted.drift).toBe('drifted')
  })

  it('readClaims：旁车缺失 → drift null + 空 claims；页缺失 → 30040 语义不变', async () => {
    const svc = new WikiService(okfFs())
    const none = await svc.readClaims('concepts/plain.md')
    expect(none).toEqual({ schemaVersion: null, pageVersion: null, drift: null, claims: [] })
    await expect(svc.readClaims('concepts/nope.md')).rejects.toBeInstanceOf(WikiPageNotFound)
  })
})
