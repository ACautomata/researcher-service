// seam: FileTree 组件 —— wiki 目录树（#954：分组键 = frontmatter category 中文值，服务端
// 归组沉底；树面零目录名）。覆盖：分组标签 = g.name 中文值 + 页面计数、「未分类」沉底
// 默认折叠（点击组头切换）、当前页所在分组自动展开、点节点冒泡 open、当前页高亮、
// 新建/删除按钮冒泡事件。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FileTree from '@/components/FileTree.vue'
import type { WikiTreeGroupDTO } from '@/api/wiki'

// 契约形状（R1）：kind/name 同值 = category 中文值；「未分类」组沉底由服务端保证。
const GROUPS: WikiTreeGroupDTO[] = [
  {
    kind: '论文',
    name: '论文',
    pages: [
      { path: 'pages/attention.md', title: 'Attention' },
      { path: 'pages/bert.md', title: 'BERT' },
    ],
  },
  {
    kind: '假说',
    name: '假说',
    pages: [{ path: 'hypotheses/h1.md', title: 'H1' }],
  },
  {
    kind: '未分类',
    name: '未分类',
    pages: [
      { path: 'official/guide.md', title: '旧官方页' },
      { path: 'scratch/trial-1.md', title: 'Trial 1' },
    ],
  },
]

describe('FileTree', () => {
  it('renders groups and their pages', () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    const text = wrapper.text()
    expect(text).toContain('Attention')
    expect(text).toContain('BERT')
    expect(text).toContain('H1')
    // 「未分类」默认折叠：组在、页节点不渲染
    expect(wrapper.find('[data-test="group-未分类"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="node-official/guide.md"]').exists()).toBe(false)
  })

  it('#954：分组标签 = category 中文值 + 页面计数', () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    expect(wrapper.find('[data-test="group-论文"]').text()).toContain('论文')
    expect(wrapper.find('[data-test="group-论文"]').text()).toContain('(2)')
    expect(wrapper.find('[data-test="group-假说"]').text()).toContain('(1)')
    expect(wrapper.find('[data-test="group-未分类"]').text()).toContain('(2)')
  })

  it('#954：「未分类」默认折叠，点击组头展开/收起', async () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    const toggle = wrapper.find('[data-test="group-toggle-未分类"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-test="node-scratch/trial-1.md"]').exists()).toBe(false)
    await toggle.trigger('click')
    expect(wrapper.find('[data-test="group-toggle-未分类"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-test="node-official/guide.md"]').exists()).toBe(true)
    await wrapper.find('[data-test="group-toggle-未分类"]').trigger('click')
    expect(wrapper.find('[data-test="node-official/guide.md"]').exists()).toBe(false)
  })

  it('#954：普通分组默认展开', () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    expect(wrapper.find('[data-test="group-toggle-论文"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-test="node-pages/attention.md"]').exists()).toBe(true)
  })

  it('#954：当前页落入「未分类」时该组自动展开', () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: 'official/guide.md' } })
    expect(wrapper.find('[data-test="group-toggle-未分类"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-test="node-official/guide.md"]').exists()).toBe(true)
  })

  it('#954：当前页在已折叠组时用户可显式收起（自动展开不锁死）', async () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: 'official/guide.md' } })
    // 自动展开生效中
    expect(wrapper.find('[data-test="node-official/guide.md"]').exists()).toBe(true)
    // 用户显式收起 → 覆盖自动展开
    await wrapper.find('[data-test="group-toggle-未分类"]').trigger('click')
    expect(wrapper.find('[data-test="node-official/guide.md"]').exists()).toBe(false)
  })

  it('#954：收起后再导航到未分类页，该组重新自动展开（覆盖不永久击穿自动展开）', async () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: 'pages/attention.md' } })
    // 当前页不在未分类组：用户先展开再收起（覆盖记录为折叠）
    await wrapper.find('[data-test="group-toggle-未分类"]').trigger('click')
    expect(wrapper.find('[data-test="node-official/guide.md"]').exists()).toBe(true)
    await wrapper.find('[data-test="group-toggle-未分类"]').trigger('click')
    expect(wrapper.find('[data-test="node-official/guide.md"]').exists()).toBe(false)
    // 导航打开另一篇未分类页 → 自动展开重新生效
    await wrapper.setProps({ activePath: 'scratch/trial-1.md' })
    expect(wrapper.find('[data-test="node-official/guide.md"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="node-scratch/trial-1.md"]').exists()).toBe(true)
  })

  it('emits open with page path when a node is clicked', async () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    const node = wrapper.find('[data-test="node-pages/attention.md"]')
    expect(node.element.tagName).toBe('BUTTON')
    await node.trigger('click')
    expect(wrapper.emitted('open')).toEqual([['pages/attention.md']])
  })

  it('marks the active page node', () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: 'pages/bert.md' } })
    const active = wrapper.find('[data-test="node-pages/bert.md"]')
    expect(active.classes()).toContain('active')
  })

  it('emits create and delete', async () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    await wrapper.find('[data-test="create"]').trigger('click')
    expect(wrapper.emitted('create')).toBeTruthy()
    await wrapper.find('[data-test="group-toggle-未分类"]').trigger('click')
    await wrapper.find('[data-test="delete-official/guide.md"]').trigger('click')
    expect(wrapper.emitted('delete')).toEqual([['official/guide.md']])
  })

  it('uses native buttons for keyboard page and delete actions', () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: 'pages/attention.md' } })
    const node = wrapper.get('[data-test="node-pages/attention.md"]')
    const remove = wrapper.get('[data-test="delete-pages/attention.md"]')
    const toggle = wrapper.get('[data-test="group-toggle-论文"]')

    expect(node.element.tagName).toBe('BUTTON')
    expect(node.attributes('aria-current')).toBe('page')
    expect(remove.element.tagName).toBe('BUTTON')
    expect(toggle.element.tagName).toBe('BUTTON')
  })
})
