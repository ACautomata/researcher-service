// S4：reader 行为快照（真实消毒 markdown 出口）。
// #954 C3 四件套：category eyebrow（未分类灰显）/ type 行首描边 chip（旧词形原样）/
// status 中文徽标（数据层英文值不可动，仅显示层映射）。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import WikiPreview from './WikiPreview.vue'
import type { WikiPageContentDTO } from '@/api/wiki'

function pageWith(frontmatter: string, okf?: WikiPageContentDTO['okf']): WikiPageContentDTO {
  return {
    path: 'pages/critique.md', title: 'A',
    content: `---\n${frontmatter}\n---\n[另一页](../b.md#段落)\n\n[外链](https://example.com/b.md)\n\n<script>alert(1)</script>`,
    okf,
  }
}
const page = pageWith(
  'type: critic\ntitle: 知识页\ndescription: 简介\ncategory: 科学问题\ntags: [知识]\nsources: [private-source]\nverified: hidden-provenance',
  { status: 'stable', staleAfter: '2026-10-10T00:00:00Z', generatedAt: '2026-10-01T00:00:00Z' },
)
function reader(p: WikiPageContentDTO = page) {
  return mount(WikiPreview, {
    props: { page: p, claimsError: false,
      claims: { schemaVersion: 1, pageVersion: 'sha256:x', drift: 'drifted', claims: [{ id: 'c', statement: '可验证论断', evidence: [{ resource: 'repo://src/a.ts#L1-L9' }] }] },
      graph: { nodes: [{ id: 'b.md', title: '引用页' }], edges: [{ from: 'b.md', to: p.path }] },
    },
    // stub 镜像真实 el-tag 的 round/plain → class 映射（Boolean 类型声明：无值 attr 传参与真实 el-tag 同规则转为 true）：徽标形态（round plain）丢失时断言即红
    global: { stubs: { ElTag: { props: { round: Boolean, plain: Boolean }, template: '<span class="el-tag" :class="{ \'is-round\': round, \'is-plain\': plain }"><slot /></span>' } } },
  })
}
describe('wiki preview', () => {
  it('shows structured fields, badges, drift and source line locators without provenance or editable controls', () => {
    const wrapper = reader()
    for (const text of ['知识页', '简介', '知识', '2026-10-10', '2026-10-01', '已漂移', '可验证论断', 'repo://src/a.ts#L1-L9']) expect(wrapper.text()).toContain(text)
    for (const text of ['private-source', 'hidden-provenance']) expect(wrapper.text()).not.toContain(text)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('textarea,[contenteditable="true"]').exists()).toBe(false)
  })
  it('#954：category 升 eyebrow 位（type 让位）', () => {
    const wrapper = reader()
    expect(wrapper.find('.eyebrow').text()).toBe('科学问题')
    expect(wrapper.find('.eyebrow').text()).not.toBe('critic')
  })
  it('#954：「未分类」eyebrow 灰显（含越界 category 读面归未分类）', () => {
    expect(reader(pageWith('type: paper\ntitle: 知识页\ncategory: concepts')).find('.eyebrow').classes()).toContain('muted')
    expect(reader(pageWith('type: paper\ntitle: 知识页\ncategory: concepts')).find('.eyebrow').text()).toBe('未分类')
    expect(reader(pageWith('type: paper\ntitle: 知识页\ncategory: 论文')).find('.eyebrow').classes()).not.toContain('muted')
  })
  it('#954：type 降级 chips 行首描边 chip，存量旧词形原样显示', () => {
    const wrapper = reader()
    const typeChip = wrapper.find('[data-test="type-chip"]')
    expect(typeChip.exists()).toBe(true)
    expect(typeChip.text()).toBe('critic')
    expect(typeChip.classes()).toContain('type-chip')
    // 行首：tags chips 行的第一个 chip 是 type，其后才是 tags
    const chips = wrapper.find('.tags').findAll('.chip')
    expect(chips[0].attributes('data-test')).toBe('type-chip')
    expect(chips.map((c) => c.text())).toContain('知识')
  })
  it('#954：status 中文徽标内联 h1 右侧，英文枚举值不泄漏', () => {
    const wrapper = reader()
    const badge = wrapper.find('h1 [data-test="status-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('稳定')
    expect(badge.classes()).toContain('el-tag')
    expect(badge.classes()).toContain('is-round')
    expect(badge.classes()).toContain('is-plain')
    expect(wrapper.text()).not.toContain('stable')
  })
  it('#954：status 显示层映射草稿/已弃用；未知值原样显示（数据层不可动，读面宽松）', () => {
    expect(reader(pageWith('type: paper\ntitle: 知识页', { status: 'draft' })).find('[data-test="status-badge"]').text()).toBe('草稿')
    expect(reader(pageWith('type: paper\ntitle: 知识页', { status: 'deprecated' })).find('[data-test="status-badge"]').text()).toBe('已弃用')
    expect(reader(pageWith('type: paper\ntitle: 知识页', { status: 'weird' })).find('[data-test="status-badge"]').text()).toBe('weird')
    // okf 无 status → 无徽标
    expect(reader(pageWith('type: paper\ntitle: 知识页', { staleAfter: '2026-10-10T00:00:00Z' })).find('[data-test="status-badge"]').exists()).toBe(false)
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
