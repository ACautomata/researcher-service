// wiki REST 契约测试（#335 · #315 §8 checklist 对 Express 实现重跑；#621 起经 serviceFor 注入
// 内存 fake WikiFileSystem，对齐 files.test.ts 的内存 Port 注入模式——存储适配器行为由
// wikiDockerFs.test.ts 单测覆盖，本文件钉 REST ↔ Port 接线：信封/错误映射/隔离/compile 时机）。
// #856（退役①）：owner 级端点 /api/v1/wiki/{tree,page,graph,categories,claims}，ownerId 直取
// 认证身份——容器行 20040 归属面随耦合退役，跨用户探测面结构性消失（隔离测试改为：
// 各用户寻址只达本人 fake 存储，他人页不可见）；path 校验先于 ensure（非法请求不触碰编排面）。
// 信封（#312）+ 错误映射（90002/30040/30041）。compile 经注入 fake 断言触发时机
// （POST/DELETE 触发、PUT 不触发），不碰真 docker。

import { createHash } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { FakeWikiFileSystem } from './fakes'
import { WikiService } from '../src/wiki/service'
import type { CompileTrigger } from '../src/wiki/compile'

// wiki fixture（页集对齐旧 makeWikiHome 真目录 fixture；空目录 entities 无法在内存 fake 表示，
// 「空目录不成组」由 entities 下无页自然成立）。
function wikiFixture(): Record<string, string> {
  return {
    'concepts/attention.md': '---\ntitle: Attention\n---\n# Attention\n见 [[self-attention]]。\n',
    'domains/cv/papers/resnet.md': '---\npaper:\n  title: ResNet\nrelated_pages: [attention]\n---\n# ResNet\n',
    'experiments/trial-1.md': '---\ntitle: Trial 1\n---\n# Trial 1\n',
    'thoughts/idea-1.md': '# First Idea\n\n`category: idea`\n\nIdea 摘录。\n',
    '.openclaw-wiki/cache.md': 'x',
    'index.md': '# INDEX',
    'root-note.md': '# Root Note\n\n`category: rootcat`\n\nRoot 摘录。\n',
  }
}

describe('wiki REST（接缝 #2 信封 + #335；#856 owner 级）', () => {
  let ctx: TestContext
  const compileCalls: string[] = []
  // 每用户一个内存 fake WikiFileSystem（ownerId 键控，#856）；serviceFor 按 ownerId 查，未注册
  // 给空 fake（对齐「账号存在但无 wiki 数据 → 空树」的降级语义）。
  const fss = new Map<string, FakeWikiFileSystem>()
  const BASE = '/api/v1/wiki'

  beforeAll(async () => {
    const fakeCompile: CompileTrigger = { trigger: (owner) => { compileCalls.push(owner) } }
    ctx = await setupTestApp({
      wiki: {
        compile: fakeCompile,
        serviceFor: (ownerId) => new WikiService(fss.get(ownerId) ?? new FakeWikiFileSystem()),
      },
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // 建用户并为其注册满配 wiki fake（name/id 全局唯一，跨测试不得复用）；返回登录态与 ownerId。
  async function seedWikiUser(username: string): Promise<{ token: string; ownerId: string }> {
    const u = await seedUser(ctx.prisma, username, `pw-${username}-secure`)
    fss.set(u.id, new FakeWikiFileSystem(wikiFixture()))
    const l = await login(ctx.request, username, `pw-${username}-secure`)
    return { token: l.access!, ownerId: u.id }
  }

  // ---------------------------- 认证 / 隔离（#856 owner 级公共前置）----------------------------

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(`${BASE}/tree`)
    expect(res.body.code).toBe(10001)
  })

  it('owner 隔离：同 path 各读本人 wiki——B 永远看不到 A 的页（跨用户探测面结构性消失）', async () => {
    const a = await seedWikiUser('uiso-a')
    const b = await seedWikiUser('uiso-b')
    const fb = fss.get(b.ownerId)!
    fb.pages.set('concepts/attention.md', '---\ntitle: B-only\n---\n# B 版本\n')

    const ra = await ctx.request.get(`${BASE}/page?path=${encodeURIComponent('concepts/attention.md')}`).set(bearer(a.token))
    expect(ra.body.code).toBe(0)
    expect(ra.body.data.title).toBe('Attention') // A 读到 A 的版本
    const rb = await ctx.request.get(`${BASE}/page?path=${encodeURIComponent('concepts/attention.md')}`).set(bearer(b.token))
    expect(rb.body.code).toBe(0)
    expect(rb.body.data.title).toBe('B-only') // B 读到 B 的版本，非 A 的
  })

  it('owner 隔离：B 缺页 → 30040，不泄露 A 同名页存在性（同码防探测承接）', async () => {
    await seedWikiUser('uiso2-a')
    const bUser = await seedUser(ctx.prisma, 'uiso2-b', 'pw-uiso2-b-secure')
    fss.set(bUser.id, new FakeWikiFileSystem()) // B 空 wiki，无同名页
    const lb = await login(ctx.request, 'uiso2-b', 'pw-uiso2-b-secure')
    const res = await ctx.request.get(`${BASE}/page?path=${encodeURIComponent('domains/cv/papers/resnet.md')}`).set(bearer(lb.access!))
    expect(res.body.code).toBe(30040)
    expect(res.body.data).toBeNull()
  })

  // ---------------------------- GET /tree ----------------------------

  it('tree：真实子目录分组、未知目录成组、空目录不成组、跳过插件私有/占位/非 .md、title 走 frontmatter', async () => {
    const u = await seedWikiUser('utree')
    const res = await ctx.request.get(`${BASE}/tree`).set(bearer(u.token))
    expect(res.body.code).toBe(0)
    const groups = res.body.data.groups as Array<{ kind: string; name: string; pages: Array<{ path: string; title: string }> }>
    const kinds = new Set(groups.map((g) => g.kind))
    expect(kinds).toEqual(expect.objectContaining(new Set(['concepts', 'domains', 'experiments', 'thoughts'])))
    expect(kinds).not.toContain('entities') // 空目录不成组
    expect(kinds).not.toContain('.openclaw-wiki')
    const all = groups.flatMap((g) => g.pages)
    expect(all.some((p) => p.path.includes('.openclaw-wiki'))).toBe(false)
    expect(all.some((p) => p.path === 'index.md')).toBe(false)
    expect(all.some((p) => p.path === 'root-note.md')).toBe(false) // 顶层散落页不收
    const concepts = groups.find((g) => g.kind === 'concepts')!
    const att = concepts.pages.find((p) => p.path === 'concepts/attention.md')!
    expect(att.title).toBe('Attention')
  })

  it('tree：未注册 wiki 的账号 → 空树合法初态（零初始化）', async () => {
    await seedUser(ctx.prisma, 'utree-empty', 'pw-utree-empty-secure')
    const l = await login(ctx.request, 'utree-empty', 'pw-utree-empty-secure')
    const res = await ctx.request.get(`${BASE}/tree`).set(bearer(l.access!))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ groups: [] })
  })

  // ---------------------------- GET /page ----------------------------

  it('page：返回原文全文 + title', async () => {
    const u = await seedWikiUser('upage')
    const res = await ctx.request
      .get(`${BASE}/page?path=${encodeURIComponent('concepts/attention.md')}`)
      .set(bearer(u.token))
    expect(res.body.code).toBe(0)
    expect(res.body.data.path).toBe('concepts/attention.md')
    expect(res.body.data.title).toBe('Attention')
    expect(res.body.data.content).toContain('# Attention')
  })

  it('page 不存在 → 30040；空 path / path 注入 → 90002 + data.path', async () => {
    const u = await seedWikiUser('upage2')
    const missing = await ctx.request
      .get(`${BASE}/page?path=${encodeURIComponent('concepts/nope.md')}`)
      .set(bearer(u.token))
    expect(missing.body.code).toBe(30040)
    const bad = ['../../../etc/passwd.md', '..%2F..%2Fsecret.md', '/etc/passwd.md', 'concepts\\..\\secret.md', 'concepts/attention']
    for (const p of bad) {
      const res = await ctx.request.get(`${BASE}/page?path=${p}`).set(bearer(u.token))
      expect(res.body.code, `path 注入未被拒: ${p}`).toBe(90002)
      expect(res.body.data).toHaveProperty('path')
    }
    const empty = await ctx.request.get(`${BASE}/page?path=`).set(bearer(u.token))
    expect(empty.body.code).toBe(90002)
  })

  // ---------------------------- PUT /page ----------------------------

  it('PUT：byte-exact 覆写已存在页（首尾空白/尾换行保留）；返回 {path}；不触发 compile', async () => {
    const u = await seedWikiUser('uput')
    compileCalls.length = 0
    const res = await ctx.request
      .put(`${BASE}/page`)
      .set(bearer(u.token))
      .send({ path: 'concepts/attention.md', content: '  # 已编辑  \n\n' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ path: 'concepts/attention.md' })
    expect(compileCalls).toEqual([]) // PUT 不触发 compile
    const read = await ctx.request
      .get(`${BASE}/page?path=${encodeURIComponent('concepts/attention.md')}`)
      .set(bearer(u.token))
    expect(read.body.data.content).toBe('  # 已编辑  \n\n')
  })

  it('PUT 页不存在 → 30040；managed 路径 → 90002', async () => {
    const u = await seedWikiUser('uput2')
    const missing = await ctx.request
      .put(`${BASE}/page`).set(bearer(u.token)).send({ path: 'concepts/nope.md', content: 'x' })
    expect(missing.body.code).toBe(30040)
    for (const managed of ['index.md', 'AGENTS.md', 'concepts/index.md', '.openclaw-wiki/cache/foo.md']) {
      const res = await ctx.request
        .put(`${BASE}/page`).set(bearer(u.token)).send({ path: managed, content: 'x' })
      expect(res.body.code, `managed 路径写入未被拒: ${managed}`).toBe(90002)
    }
  })

  // ---------------------------- POST /page ----------------------------

  it('POST：新建页落盘 + 触发 compile；返回 {path}', async () => {
    const u = await seedWikiUser('upost')
    compileCalls.length = 0
    const res = await ctx.request
      .post(`${BASE}/page`)
      .set(bearer(u.token))
      .send({ path: 'concepts/transformer.md', content: '---\ntitle: Transformer\n---\n# T\n' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ path: 'concepts/transformer.md' })
    expect(compileCalls).toEqual([u.ownerId]) // 新建触发 compile（#856 起去抖键 = ownerId）
  })

  it('POST 已存在 → 30041；path 注入 / managed → 90002 且不触发 compile', async () => {
    const u = await seedWikiUser('upost2')
    compileCalls.length = 0
    const exists = await ctx.request
      .post(`${BASE}/page`).set(bearer(u.token)).send({ path: 'concepts/attention.md', content: 'x' })
    expect(exists.body.code).toBe(30041)
    const inject = await ctx.request
      .post(`${BASE}/page`).set(bearer(u.token)).send({ path: '../../evil.md', content: 'x' })
    expect(inject.body.code).toBe(90002)
    const managed = await ctx.request
      .post(`${BASE}/page`).set(bearer(u.token)).send({ path: '.openclaw-wiki/evil.md', content: 'x' })
    expect(managed.body.code).toBe(90002)
    expect(compileCalls).toEqual([])
  })

  // ---------------------------- DELETE /page ----------------------------

  it('DELETE：删页 + 触发 compile；成功 data null', async () => {
    const u = await seedWikiUser('udel')
    compileCalls.length = 0
    const res = await ctx.request
      .delete(`${BASE}/page?path=${encodeURIComponent('concepts/attention.md')}`)
      .set(bearer(u.token))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toBeNull()
    expect(compileCalls).toEqual([u.ownerId])
  })

  it('DELETE 页不存在 → 30040；path 注入 → 90002 且不触发 compile', async () => {
    const u = await seedWikiUser('udel2')
    compileCalls.length = 0
    const missing = await ctx.request
      .delete(`${BASE}/page?path=${encodeURIComponent('concepts/nope.md')}`)
      .set(bearer(u.token))
    expect(missing.body.code).toBe(30040)
    const inject = await ctx.request.delete(`${BASE}/page?path=../../secret.md`).set(bearer(u.token))
    expect(inject.body.code).toBe(90002)
    const managed = await ctx.request.delete(`${BASE}/page?path=index.md`).set(bearer(u.token))
    expect(managed.body.code).toBe(90002)
    expect(compileCalls).toEqual([])
  })

  // ---------------------------- NUL / body limit（codex PR#346）----------------------------

  it('path 含 NUL 字节 → 90002 + data.path（GET query 与 POST/PUT body 一致，codex PR#346）', async () => {
    const u = await seedWikiUser('unul')
    const nulPath = 'concepts/a\u0000.md'
    const g = await ctx.request
      .get(`${BASE}/page?path=${encodeURIComponent(nulPath)}`)
      .set(bearer(u.token))
    expect(g.body.code).toBe(90002)
    expect(g.body.data).toHaveProperty('path')
    const p = await ctx.request
      .post(`${BASE}/page`).set(bearer(u.token)).send({ path: nulPath, content: 'x' })
    expect(p.body.code).toBe(90002)
    expect(p.body.data).toHaveProperty('path')
    const put = await ctx.request
      .put(`${BASE}/page`).set(bearer(u.token)).send({ path: nulPath, content: 'x' })
    expect(put.body.code).toBe(90002)
    expect(put.body.data).toHaveProperty('path')
  })

  it('PUT 大页面（>256kb 通用 body limit）保存成功：wiki 走独立大 limit（codex PR#346）', async () => {
    const u = await seedWikiUser('ubig')
    const big = `# Big\n\n${'x'.repeat(300_000)}\n`
    const res = await ctx.request
      .put(`${BASE}/page`)
      .set(bearer(u.token))
      .send({ path: 'concepts/attention.md', content: big })
    expect(res.body.code).toBe(0)
    const read = await ctx.request
      .get(`${BASE}/page?path=${encodeURIComponent('concepts/attention.md')}`)
      .set(bearer(u.token))
    expect(read.body.data.content).toHaveLength(big.length)
  })

  it('body 超限（非 wiki 端点仍受 256kb）→ 90002，非 90000（entity.too.large 显式映射）', async () => {
    const res = await ctx.request
      .post('/api/v1/auth/login')
      .send({ username: 'x'.repeat(300_000), password: 'y'.repeat(300_000) })
    expect(res.body.code).toBe(90002)
  })

  // ---------------------------- GET /graph ----------------------------

  it('graph：节点来自 tree；wikilink 不可解析 → ghost 节点；related_pages 出边', async () => {
    const u = await seedWikiUser('ugraph')
    const res = await ctx.request.get(`${BASE}/graph`).set(bearer(u.token))
    expect(res.body.code).toBe(0)
    const nodeIds = new Set(res.body.data.nodes.map((n: { id: string }) => n.id))
    expect(nodeIds).toEqual(expect.objectContaining(new Set(['concepts/attention.md', 'domains/cv/papers/resnet.md'])))
    const edges = res.body.data.edges as Array<{ from: string; to: string }>
    expect(edges).toContainEqual({ from: 'concepts/attention.md', to: 'self-attention' })
    expect(edges).toContainEqual({ from: 'domains/cv/papers/resnet.md', to: 'concepts/attention.md' })
    const ghost = res.body.data.nodes.find((n: { id: string }) => n.id === 'self-attention')
    expect(ghost).toMatchObject({ id: 'self-attention', title: 'self-attention', ghost: true })
  })

  // ---------------------------- GET /categories ----------------------------

  it('categories：按 category 分组（含顶层散落页）、开放词表、条目含 path/title/category/excerpt', async () => {
    const u = await seedWikiUser('ucat')
    const res = await ctx.request.get(`${BASE}/categories`).set(bearer(u.token))
    expect(res.body.code).toBe(0)
    const data = res.body.data as Record<string, Array<{ path: string; title: string; category: string; excerpt: string }>>
    expect(Object.keys(data).sort()).toEqual(['idea', 'rootcat'])
    expect(data.idea.map((i) => i.path)).toEqual(['thoughts/idea-1.md'])
    expect(data.idea[0].title).toBe('First Idea') // 无 frontmatter → H1
    expect(data.idea[0].category).toBe('idea')
    expect(data.idea[0].excerpt).toContain('Idea 摘录')
    expect(data.rootcat.map((i) => i.path)).toEqual(['root-note.md']) // 顶层散落页进 categories
    const allPaths = Object.values(data).flat().map((i) => i.path)
    expect(allPaths).not.toContain('concepts/attention.md') // 无标记页不进
  })

  // ---------------------------- GET /claims（#789 story 42 数据面） ----------------------------

  it('claims：旁车存在 → claims/drift fresh；旁车缺失 → drift null 空 claims；页缺失 → 30040', async () => {
    const u = await seedWikiUser('uclaims')
    const fs = fss.get(u.ownerId)!
    const content = fs.pages.get('concepts/attention.md')!
    const hash = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
    fs.claims.set('.claims/concepts/attention.json', JSON.stringify({
      schemaVersion: 1,
      pageVersion: `sha256:${hash}`,
      claims: [{ id: 'claim_1', statement: '论断', evidence: [{ resource: 'repo://x.ts#L1-L2' }] }],
    }))
    const res = await ctx.request.get(`${BASE}/claims?path=concepts/attention.md`).set(bearer(u.token))
    expect(res.body.code).toBe(0)
    expect(res.body.data.drift).toBe('fresh')
    expect(res.body.data.pageVersion).toBe(`sha256:${hash}`)
    expect(res.body.data.claims).toHaveLength(1)
    expect(res.body.data.claims[0].evidence[0].resource).toBe('repo://x.ts#L1-L2')

    const none = await ctx.request.get(`${BASE}/claims?path=thoughts/idea-1.md`).set(bearer(u.token))
    expect(none.body.code).toBe(0)
    expect(none.body.data).toMatchObject({ schemaVersion: null, pageVersion: null, drift: null, claims: [] })

    const missing = await ctx.request.get(`${BASE}/claims?path=concepts/nope.md`).set(bearer(u.token))
    expect(missing.body.code).toBe(30040)

    const invalid = await ctx.request.get(`${BASE}/claims?path=../evil.md`).set(bearer(u.token))
    expect(invalid.body.code).toBe(90002)
  })
})
