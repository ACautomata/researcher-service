// seam: FileTree 组件 —— wiki 文件树（issue #45 验收 1）。
// 覆盖：按分组渲染 pages（五核心分类 + domains 子树）、点节点冒泡 open 进编辑器、
// 当前页高亮、新建/删除按钮冒泡事件。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FileTree from '@/components/FileTree.vue'
import type { WikiTreeGroupDTO } from '@/api/wiki'

const GROUPS: WikiTreeGroupDTO[] = [
  {
    kind: 'concept',
    name: 'concepts',
    pages: [
      { path: 'concepts/a.md', title: 'Attention' },
      { path: 'concepts/b.md', title: 'BERT' },
    ],
  },
  {
    kind: 'domain',
    name: 'domains',
    pages: [{ path: 'domains/cv/papers/resnet.md', title: 'ResNet' }],
  },
]

describe('FileTree', () => {
  it('renders groups and their pages', () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    const text = wrapper.text()
    expect(text).toContain('Attention')
    expect(text).toContain('BERT')
    expect(text).toContain('ResNet')
  })

  it('emits open with page path when a node is clicked', async () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    await wrapper.find('[data-test="node-concepts/a.md"]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['concepts/a.md']])
  })

  it('marks the active page node', () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: 'concepts/b.md' } })
    const active = wrapper.find('[data-test="node-concepts/b.md"]')
    expect(active.classes()).toContain('active')
  })

  it('emits create and delete', async () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    await wrapper.find('[data-test="create"]').trigger('click')
    expect(wrapper.emitted('create')).toBeTruthy()
    await wrapper.find('[data-test="delete-concepts/a.md"]').trigger('click')
    expect(wrapper.emitted('delete')).toEqual([['concepts/a.md']])
  })
})
