// seam: FileTree 组件 —— wiki 文件树（issue #45 验收 1 + issue #83 物理化）。
// 覆盖：按分组渲染 pages（任意目录分组，含开放 domain 与未知目录）、点节点冒泡 open 进编辑器、
// 当前页高亮、新建/删除按钮冒泡事件。组标签直接渲染 g.name（不写死中文映射）。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FileTree from '@/components/FileTree.vue'
import type { WikiTreeGroupDTO } from '@/api/wiki'

const GROUPS: WikiTreeGroupDTO[] = [
  {
    kind: 'concept', // 旧五分类键：组件改动前会被 KIND_LABELS 映射成「概念」→ 本断言应变红
    name: 'concepts',
    pages: [
      { path: 'concepts/a.md', title: 'Attention' },
      { path: 'concepts/b.md', title: 'BERT' },
    ],
  },
  {
    kind: 'domain', // 旧键：改动前映射成「领域」
    name: 'domains',
    pages: [{ path: 'domains/cv/papers/resnet.md', title: 'ResNet' }],
  },
  {
    kind: 'experiments', // 未知目录：任何实现下都应照实显示目录名
    name: 'experiments',
    pages: [{ path: 'experiments/trial-1.md', title: 'Trial 1' }],
  },
]

describe('FileTree', () => {
  it('renders groups and their pages', () => {
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    const text = wrapper.text()
    expect(text).toContain('Attention')
    expect(text).toContain('BERT')
    expect(text).toContain('ResNet')
    expect(text).toContain('Trial 1')
  })

  it('renders group label from g.name for any dir (no hardcoded map)', () => {
    // issue #83：任意目录都照实显示 g.name，不再经 KIND_LABELS 映射成固定中文标签
    const wrapper = mount(FileTree, { props: { groups: GROUPS, activePath: '' } })
    expect(wrapper.find('[data-test="group-experiments"] .group-name').text()).toBe('experiments')
    expect(wrapper.find('[data-test="group-concept"] .group-name').text()).toBe('concepts')
    expect(wrapper.find('[data-test="group-domain"] .group-name').text()).toBe('domains')
    // 不写死中文映射：概念/领域 等旧标签不再出现
    expect(wrapper.text()).not.toContain('概念')
    expect(wrapper.text()).not.toContain('领域')
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
