// wiki 纯逻辑协作者单测（#335 · #315 §3）：FrontmatterParser / CategoryMarkerExtractor /
// WikilinkResolver 对假输入直测（无文件系统、无 DB）。契约锚点 = backend/wiki/tests/
// test_service_fake_fs.py + test_categories_api.py + test_graph_api.py 的行为断言。

import { describe, it, expect } from 'vitest'
import { CategoryMarkerExtractor, FrontmatterParser, WikilinkResolver, wikilinkTargets } from '../src/wiki/logic'

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
