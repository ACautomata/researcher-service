// S4：reader 行为快照（真实消毒 markdown 出口）。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import WikiPreview from './WikiPreview.vue'
const page = {
  path: 'concepts/a.md', title: 'A',
  content: '---\ntype: concept\ntitle: 知识页\ndescription: 简介\ntags: [知识]\nsources: [private-source]\nverified: hidden-provenance\n---\n[另一页](../b.md#段落)\n\n[外链](https://example.com/b.md)\n\n<script>alert(1)</script>',
  okf: { status: 'stable', staleAfter: '2026-10-10T00:00:00Z', generatedAt: '2026-10-01T00:00:00Z' },
}
function reader() {
  return mount(WikiPreview, { props: { page, claimsError: false,
    claims: { schemaVersion: 1, pageVersion: 'sha256:x', drift: 'drifted', claims: [{ id: 'c', statement: '可验证论断', evidence: [{ resource: 'repo://src/a.ts#L1-L9' }] }] },
    graph: { nodes: [{ id: 'b.md', title: '引用页' }], edges: [{ from: 'b.md', to: page.path }] },
  } })
}
describe('wiki preview', () => {
  it('shows structured fields, badges, drift and source line locators without provenance or editable controls', () => {
    const wrapper = reader()
    expect(wrapper.find('.eyebrow').text()).toBe('concept')
    for (const text of ['知识页', '简介', '知识', 'stable', '2026-10-10', '2026-10-01', '已漂移', '可验证论断', 'repo://src/a.ts#L1-L9']) expect(wrapper.text()).toContain(text)
    for (const text of ['private-source', 'hidden-provenance']) expect(wrapper.text()).not.toContain(text)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('textarea,[contenteditable="true"]').exists()).toBe(false)
  })
  it('navigates relative markdown links and backlinks inside the reader, retaining external links', async () => {
    const wrapper = reader()
    await wrapper.find('a').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['b.md', '段落'])
    await wrapper.find('[data-test="backlinks"] button').trigger('click')
    expect(wrapper.emitted('open')?.[1]).toEqual(['b.md'])
    expect(wrapper.find('a[href="https://example.com/b.md"]').attributes('target')).toBe('_blank')
  })
})
