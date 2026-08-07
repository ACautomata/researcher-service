// seam: WikiView 页 —— issue #45 wiki 编辑页组装（spec §9.6）。
// 版面：顶部容器切换器 + 左文件树 + 中 Milkdown 编辑器 + 右图谱（可折叠）。
// 联动：点树/图谱节点 openPage；编辑器 update → store.edit（防抖自动保存）；切容器 switchContainer。
// store 用真 Pinia（api/wiki mock 替身）；子组件 stub 聚焦组装逻辑。
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/wiki', () => ({
  getTree: vi.fn(),
  readPage: vi.fn(),
  updatePage: vi.fn(),
  createPage: vi.fn(),
  deletePage: vi.fn(),
  getGraph: vi.fn(),
}))
vi.mock('@/api/containers', () => ({ listInstances: vi.fn() }))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn() },
    ElMessageBox: { prompt: vi.fn(), confirm: vi.fn() },
  }
})

import WikiView from '@/views/WikiView.vue'
import { useWikiStore } from '@/stores/wiki'
import { getGraph, getTree, readPage } from '@/api/wiki'
import { listInstances } from '@/api/containers'
import { ElMessage } from 'element-plus'

const INSTANCES = [
  { name: 'demo', port: 19000, status: 'running', health: 'healthy',
    image: 'img', container_id: 'c1', created_at: '', pairing: { status: 'paired' } },
  { name: 'other', port: 19001, status: 'running', health: 'healthy',
    image: 'img', container_id: 'c2', created_at: '', pairing: { status: 'paired' } },
]
const TREE = {
  groups: [
    { kind: 'concept', name: 'concepts', pages: [{ path: 'concepts/a.md', title: 'A' }] },
  ],
}
const GRAPH = { nodes: [{ id: 'concepts/a.md', title: 'A' }], edges: [] }

const stubs = {
  FileTree: {
    name: 'FileTree',
    props: ['groups', 'activePath'],
    template: '<div data-test="file-tree" />',
    emits: ['open', 'create', 'delete'],
  },
  MdEditor: {
    name: 'MdEditor',
    props: ['content'],
    template: '<div data-test="md-editor" />',
    emits: ['update'],
  },
  WikiGraph: {
    name: 'WikiGraph',
    props: ['graph', 'activePath'],
    template: '<div data-test="wiki-graph" />',
    emits: ['open'],
  },
}

function mountView() {
  return mount(WikiView, { global: { stubs } })
}

describe('WikiView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue(INSTANCES)
    ;(getTree as ReturnType<typeof vi.fn>).mockResolvedValue(TREE)
    ;(getGraph as ReturnType<typeof vi.fn>).mockResolvedValue(GRAPH)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/a.md', title: 'A', content: '# A',
    })
  })

  it('loads first container tree+graph on mount', async () => {
    mountView()
    await flushPromises()
    const s = useWikiStore()
    expect(s.current).toBe('demo')
    expect(getTree).toHaveBeenCalledWith('demo')
    expect(getGraph).toHaveBeenCalledWith('demo')
  })

  it('renders container switcher with all instances', async () => {
    const wrapper = mountView()
    await flushPromises()
    const options = wrapper.findAll('[data-test="container-switch"] option')
    expect(options.map((o) => o.text())).toEqual(['demo', 'other'])
  })

  it('opens a page when file tree emits open', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.findComponent({ name: 'FileTree' }).vm.$emit('open', 'concepts/a.md')
    await flushPromises()
    expect(readPage).toHaveBeenCalledWith('demo', 'concepts/a.md')
    expect(useWikiStore().activePath).toBe('concepts/a.md')
  })

  it('opens a page when graph emits open', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.findComponent({ name: 'WikiGraph' }).vm.$emit('open', 'concepts/a.md')
    await flushPromises()
    expect(useWikiStore().activePath).toBe('concepts/a.md')
  })

  it('shows an error when opening a page fails', async () => {
    const wrapper = mountView()
    await flushPromises()
    ;(readPage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('页面读取失败'))
    await wrapper.findComponent({ name: 'FileTree' }).vm.$emit('open', 'concepts/a.md')
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalledWith('页面读取失败')
  })

  it('routes editor update into store.edit (autosave)', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.findComponent({ name: 'FileTree' }).vm.$emit('open', 'concepts/a.md')
    await flushPromises()
    await wrapper.findComponent({ name: 'MdEditor' }).vm.$emit('update', '# A 改')
    expect(useWikiStore().draft).toBe('# A 改')
    expect(useWikiStore().dirty).toBe(true)
  })

  it('switches container via switcher', async () => {
    const wrapper = mountView()
    await flushPromises()
    const select = wrapper.find('[data-test="container-switch"]')
    await select.setValue('other')
    await flushPromises()
    expect(useWikiStore().current).toBe('other')
    expect(getTree).toHaveBeenCalledWith('other')
  })

  it('shows an error when switching container fails', async () => {
    const wrapper = mountView()
    await flushPromises()
    ;(getTree as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('容器切换失败'))
    await wrapper.find('[data-test="container-switch"]').setValue('other')
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalledWith('容器切换失败')
  })

  it('toggles graph panel collapsed', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="wiki-graph"]').exists()).toBe(true)
    await wrapper.find('[data-test="toggle-graph"]').trigger('click')
    expect(wrapper.find('[data-test="wiki-graph"]').exists()).toBe(false)
  })
})

describe('WikiView — codex PR #62 意见6 回归', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue(INSTANCES)
    ;(getTree as ReturnType<typeof vi.fn>).mockResolvedValue(TREE)
    ;(getGraph as ReturnType<typeof vi.fn>).mockResolvedValue(GRAPH)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/a.md', title: 'A', content: '# A',
    })
  })

  it('refreshes tree and graph after a successful autosave (意见6)', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.findComponent({ name: 'FileTree' }).vm.$emit('open', 'concepts/a.md')
    await flushPromises()
    ;(getTree as ReturnType<typeof vi.fn>).mockClear()
    ;(getGraph as ReturnType<typeof vi.fn>).mockClear()
    // 触发一次自动保存完成
    const s = useWikiStore()
    s.edit('# A 改了标题')
    await s._flush()
    await flushPromises()
    // 保存成功后树与图谱被刷新（title/wikilink 变更即时反映）
    expect(getTree).toHaveBeenCalled()
    expect(getGraph).toHaveBeenCalled()
  })
})
