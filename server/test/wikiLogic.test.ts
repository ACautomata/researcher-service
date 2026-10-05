// wiki 纯逻辑协作者单测（#335 · #315 §3）：FrontmatterParser / CategoryMarkerExtractor /
// WikilinkResolver 对假输入直测（无文件系统、无 DB）。契约锚点 = backend/wiki/tests/
// test_service_fake_fs.py + test_categories_api.py + test_graph_api.py 的行为断言。

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { CategoryMarkerExtractor, FrontmatterParser, WikilinkResolver, claimsDrift, claimsSidecarPath, markdownLinkTargets, okfBadge, parseClaimsSidecar, wikilinkTargets } from '../src/wiki/logic'

describe('FrontmatterParser', () => {
  it('解析标量键与行内列表；正文保留 frontmatter 之外内容', () => {
    const p = new FrontmatterParser()
    const { frontmatter, body } = p.parse('---\ntitle: Attention\nrelated_pages: [a, "b"]\n---\n# H\n')
    expect(frontmatter.title).toBe('Attention')
    expect(frontmatter.related_pages).toEqual(['a', 'b'])
    expect(body).toBe('# H')
  })

  it('嵌套键（paper:/claims: 无行内值）跳过；paper 子键 title 提到顶层', () => {
    const p = new FrontmatterParser()
    const { frontmatter } = p.parse('---\npaper:\n  title: ResNet\n---\n# R\n')
    // paper: 空值行跳过；`  title: ResNet` 剥缩进后以 title 键入库
    expect(frontmatter.title).toBe('ResNet')
    expect(frontmatter.paper).toBeUndefined()
  })

  it('平铺 paper.title 键也支持（插件官方 title schema）', () => {
    const p = new FrontmatterParser()
    const { frontmatter } = p.parse('---\npaper.title: Paper X\n---\nbody')
    expect(frontmatter['paper.title']).toBe('Paper X')
  })

  it('标量剥首尾引号（双引号与单引号）', () => {
    const p = new FrontmatterParser()
    expect(p.parse('---\ntitle: "Quoted"\n---\nx').frontmatter.title).toBe('Quoted')
    expect(p.parse("---\ntitle: 'Single'\n---\nx").frontmatter.title).toBe('Single')
  })

  it('空值 / 空字符串键不入库', () => {
    const p = new FrontmatterParser()
    const { frontmatter } = p.parse('---\nempty:\ntitle: ""\n---\nx')
    expect(frontmatter.empty).toBeUndefined()
    expect(frontmatter.title).toBeUndefined()
  })

  it('#315 §3 坑：content.find("---", 3) 会把正文里任意 `---`（含 `----` 分隔线）当 frontmatter 结束——原样保留此歧义', () => {
    const p = new FrontmatterParser()
    // 无独立关闭 `---`，正文里的 `---` 被 naive find 当作 frontmatter 结束（body 在它之后截断）
    const { frontmatter, body } = p.parse('---\ntitle: A\n正文 --- 混排\n')
    expect(frontmatter.title).toBe('A')
    expect(body).toBe('混排')
  })

  it('无 frontmatter 时 body = 全文', () => {
    const p = new FrontmatterParser()
    const { frontmatter, body } = p.parse('# 无 frontmatter\n')
    expect(frontmatter).toEqual({})
    expect(body).toBe('# 无 frontmatter\n')
  })
})

describe('CategoryMarkerExtractor', () => {
  const ex = new CategoryMarkerExtractor()

  it('提取 H1 之下、首个 ## 之前窗口内的整行标记；值小写归一', () => {
    const body = '# Title\n\n`category: Idea`\n\n正文\n'
    expect(ex.extractCategory(body)).toBe('idea')
  })

  it('窗口规则：无 H1 → null；标记在 H1 之前不抓；首个 ## 之后不抓', () => {
    expect(ex.extractCategory('`category: fake`\n\n# Title\n正文')).toBeNull() // H1 之前
    expect(ex.extractCategory('# Title\n\n## section\n\n`category: fake`')).toBeNull() // ## 之后
    expect(ex.extractCategory('无 H1\n\n`category: x`')).toBeNull() // 无 H1
  })

  it('大小写不敏感是全形态（CATEGORY/cAtEgOrY），值仍小写归一', () => {
    expect(ex.extractCategory('# U\n\n`CATEGORY: Idea`\n')).toBe('idea')
    expect(ex.extractCategory('# M\n\n`cAtEgOrY: Idea`\n')).toBe('idea')
  })

  it('行内混排的 `category:` 字样（非整行）不抓', () => {
    expect(ex.extractCategory('# M\n\n正文里说 `category: fake` 是混在行内的。\n')).toBeNull()
  })

  it('excerpt：剥掉 H1 标题行与 category 标记行，压缩空白', () => {
    const body = '# Title\n\n`category: idea`\n\nIdea 第一段摘录。\n\n## Detail\n\n`category: 误抓`\n'
    const s = ex.excerpt(body)
    expect(s).toContain('Idea 第一段摘录')
    expect(s).not.toContain('# Title')
    expect(s).not.toContain('category')
  })

  it('excerpt 截断 200 字符', () => {
    const body = `# T\n\n${'a'.repeat(250)}\n`
    expect(ex.excerpt(body).length).toBe(200)
  })
})

describe('WikilinkResolver', () => {
  const pages = [
    { path: 'concepts/attention.md', title: 'Attention' },
    { path: 'domains/cv/papers/resnet.md', title: 'ResNet' },
  ]

  it('整串 id → stem（末段去 .md）→ title → null（ghost）三级解析', () => {
    const r = new WikilinkResolver(pages)
    expect(r.resolve('concepts/attention.md')).toBe('concepts/attention.md') // 整串 id
    expect(r.resolve('attention.md')).toBe('concepts/attention.md') // stem（含 .md）
    expect(r.resolve('attention')).toBe('concepts/attention.md') // stem
    expect(r.resolve('ResNet')).toBe('domains/cv/papers/resnet.md') // title
    expect(r.resolve('ghost-target')).toBeNull() // 不可解析 → ghost
  })

  it('先见者优先：重复 stem/title 不覆盖', () => {
    const dup = [
      { path: 'a/first.md', title: 'Same' },
      { path: 'b/second.md', title: 'Same' },
      { path: 'c/dup.md', title: 'Dup' },
      { path: 'd/dup.md', title: 'Dup2' },
    ]
    const r = new WikilinkResolver(dup)
    expect(r.resolve('Same')).toBe('a/first.md') // 先见 title 优先
    expect(r.resolve('dup')).toBe('c/dup.md') // 先见 stem 优先
  })

  it('wikilinkTargets：[[target]] 与 [[target|别名]] 取 `|` 前并 strip', () => {
    expect(wikilinkTargets('见 [[self-attention]] 和 [[x | 别名]]。')).toEqual(['self-attention', 'x'])
  })
})

// ---------------------------------------------------------------------------
// #789 OKF 适配（wiki 域）：markdown 相对链接边 / OKF 徽章 / claims 旁车解析。
// 依据 = docs/research/725-openwiki-embedding-okf.md §二/§三 + #747 G 节 wiki 三通道。
// ---------------------------------------------------------------------------

describe('markdownLinkTargets（#789 story 43）', () => {
  it('提取 markdown 相对链接目标，剥 # 片段与标题后缀', () => {
    const body = [
      '见 [Attention](concepts/attention.md) 与 [T](./transformer.md#相关)。',
      '带标题：[T](b/t.md "title")。',
    ].join('\n')
    expect(markdownLinkTargets(body)).toEqual(['concepts/attention.md', 'transformer.md', 'b/t.md'])
  })

  it('只收 .md 相对目标：http/mailto/绝对路径/锚点/图片/非 md 不收', () => {
    const body = [
      '[外链](https://a.com/x.md) 不收',
      '[邮件](mailto:a@b.c) 不收',
      '[绝对](/concepts/a.md) 不收',
      '[纯锚](#sec) 不收',
      '[图](img.png) 不收',
      '[页](concepts/a.md) 收',
    ].join('\n')
    expect(markdownLinkTargets(body)).toEqual(['concepts/a.md'])
  })

  it('无链接正文 → 空数组', () => {
    expect(markdownLinkTargets('# T\n\n正文无链接。\n')).toEqual([])
  })
})

describe('okfBadge（#789 story 41 数据面）', () => {
  it('完整 OKF front matter：status/stale_after/generated.at 三字段', () => {
    const content = [
      '---',
      'type: concept',
      'title: Attention',
      'status: stable',
      'stale_after: 2026-12-01T00:00:00+00:00',
      'generated: {by: openwiki, at: 2026-09-30T12:00:00Z}',
      '---',
      '# Attention',
    ].join('\n')
    expect(okfBadge(content)).toEqual({
      status: 'stable',
      staleAfter: '2026-12-01T00:00:00+00:00',
      generatedAt: '2026-09-30T12:00:00Z',
    })
  })

  it('部分字段缺失 → 只回有的；无 OKF 字段 → undefined', () => {
    expect(okfBadge('---\ntitle: T\nstatus: draft\n---\n# T\n')).toEqual({ status: 'draft' })
    expect(okfBadge('# 无 frontmatter')).toBeUndefined()
    expect(okfBadge('---\ntitle: T\n---\n# T\n')).toBeUndefined()
  })

  it('generated 行内 flow 的 at 值剥引号', () => {
    const content = '---\ntype: t\ngenerated: {by: "openwiki", at: "2026-09-30T12:00:00Z"}\n---\n# T\n'
    expect(okfBadge(content)).toMatchObject({ generatedAt: '2026-09-30T12:00:00Z' })
  })
})

describe('claimsSidecarPath / parseClaimsSidecar / claimsDrift（#789 story 42 数据面）', () => {
  it('claimsSidecarPath：页路径 → .claims 镜像同名 .json', () => {
    expect(claimsSidecarPath('concepts/attention.md')).toBe('.claims/concepts/attention.json')
    expect(claimsSidecarPath('a.md')).toBe('.claims/a.json')
  })

  it('parseClaimsSidecar：结构化提取 claims/evidence；畸形 JSON → null', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      pageVersion: 'sha256:' + 'a'.repeat(64),
      claims: [
        {
          id: 'claim_' + '0'.repeat(32),
          statement: 'frontmatter 校验强制 type 必填',
          evidence: [{ resource: 'repo://src/okf/frontmatter.ts#L118-L183', version: 'repo-lines-v1:sha256:x:y' }],
        },
      ],
    })
    const parsed = parseClaimsSidecar(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.schemaVersion).toBe(1)
    expect(parsed!.pageVersion).toBe('sha256:' + 'a'.repeat(64))
    expect(parsed!.claims[0]!.statement).toContain('type 必填')
    expect(parsed!.claims[0]!.evidence[0]!.resource).toContain('frontmatter.ts')
    expect(parseClaimsSidecar('not json')).toBeNull()
  })

  it('claimsDrift：pageVersion 哈希对上 → fresh，对不上 → drifted，缺 pageVersion → null', () => {
    const content = '# Attention\n正文\n'
    const hash = 'sha256:' + createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
    expect(claimsDrift(hash, content)).toBe('fresh')
    expect(claimsDrift('sha256:' + 'b'.repeat(64), content)).toBe('drifted')
    expect(claimsDrift(null, content)).toBeNull()
  })
})
