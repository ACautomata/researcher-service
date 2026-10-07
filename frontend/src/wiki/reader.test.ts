// S3：OKF 预览与应用内导航，输入取自 OKF v0.2 文档。
import { describe, expect, it } from 'vitest'
import { parseWikiDocument, resolveWikiLink } from './reader'

describe('wiki reader', () => {
  it('renders only reader metadata and strips provenance from the body', () => {
    const doc = parseWikiDocument('---\ntype: concept\ntitle: "知识页"\ndescription: >-\n  多行\n  简介\ntags: [知识, "安全"]\nsources: [secret]\nverified: hidden\n---\n# 正文', 'Fallback')
    expect(doc).toEqual({ type: 'concept', title: '知识页', description: '多行 简介', tags: ['知识', '安全'], body: '# 正文' })
  })
  it('keeps ordinary markdown and tolerates malformed frontmatter', () => {
    expect(parseWikiDocument('# 普通页', '普通').body).toBe('# 普通页')
    expect(parseWikiDocument('---\ntags: [\n---\n正文', '普通').body).toBe('正文')
  })
  it('resolves encoded relative markdown links with anchors without escaping the wiki', () => {
    expect(resolveWikiLink('concepts/a.md', '../notes/%E4%B8%AD.md#section')).toEqual({ path: 'notes/中.md', anchor: 'section' })
    for (const href of ['https://example.com/a.md', '//evil/a.md', '../../x.md', 'javascript:alert(1)', '/x.md']) {
      expect(resolveWikiLink('concepts/a.md', href)).toBeNull()
    }
  })
})
