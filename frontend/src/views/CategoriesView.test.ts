// seam: CategoriesView 页 —— issue #85 Categories 栏目组装（spec #75 前端）。
// 版面：顶部容器切换器 + 左按 category 动态分组（可折叠 chip+名称+计数）+ 右只读正文。
// store 用真 Pinia（api/wiki、api/containers mock 替身）；MdEditor stub 聚焦组装逻辑。
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/wiki', () => ({
  getCategories: vi.fn(),
  readPage: vi.fn(),
}))
vi.mock('@/api/containers', () => ({ listInstances: vi.fn() }))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  }
})

import CategoriesView from '@/views/CategoriesView.vue'
import { useCategoriesStore } from '@/stores/categories'
import { getCategories, readPage } from '@/api/wiki'
import { listInstances } from '@/api/containers'

const INSTANCES = [
  { name: 'demo', port: 19000, status: 'running', health: 'healthy',
    image: 'img', container_id: 'c1', created_at: '', pairing: { status: 'paired' } },
  { name: 'other', port: 19001, status: 'running', health: 'healthy',
    image: 'img', container_id: 'c2', created_at: '', pairing: { status: 'paired' } },
]
const CATS = {
  idea: [
    { path: 'a.md', title: 'Alpha', category: 'idea', excerpt: '甲摘要' },
    { path: 'b.md', title: 'Beta', category: 'idea', excerpt: '乙摘要' },
  ],
  critic: [{ path: 'c.md', title: 'Gamma', category: 'critic', excerpt: '丙摘要' }],
  // 未知 category 值：不预设词表，自动成组
  'x-novel': [{ path: 'd.md', title: 'Delta', category: 'x-novel', excerpt: '丁摘要' }],
}

const stubs = {
  MdEditor: {
    name: 'MdEditor',
    props: ['content', 'readonly'],
    template: '<div data-test="md-editor" />',
  },
}

function mountView() {
  return mount(CategoriesView, { global: { stubs } })
}

describe('CategoriesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue(INSTANCES)
    ;(getCategories as ReturnType<typeof vi.fn>).mockResolvedValue(CATS)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'a.md', title: 'Alpha', content: '# Alpha 正文',
    })
  })

  it('loads first container categories on mount', async () => {
    mountView()
    await flushPromises()
    const s = useCategoriesStore()
    expect(s.current).toBe('demo')
    expect(getCategories).toHaveBeenCalledWith('demo')
  })

  it('builds one collapsible group per category key, incl. unknown values', async () => {
    const wrapper = mountView()
    await flushPromises()
    const groups = wrapper.findAll('[data-test="cat-group"]')
    // 遍历响应键动态建组：idea/critic/未知 x-novel 各一组
    expect(groups).toHaveLength(3)
    const names = wrapper.findAll('[data-test="cat-name"]').map((n) => n.text())
    expect(names).toEqual(['idea', 'critic', 'x-novel'])
  })

  it('shows per-group count and hash-colored chip', async () => {
    const wrapper = mountView()
    await flushPromises()
    const counts = wrapper.findAll('[data-test="cat-count"]').map((c) => c.text())
    expect(counts).toEqual(['2', '1', '1'])
    // 每组一个着色 chip（hash 取色，无需预设调色板）
    const chips = wrapper.findAll('[data-test="cat-chip"]')
    expect(chips).toHaveLength(3)
    for (const chip of chips) {
      expect(chip.attributes('style')).toContain('background')
    }
  })

  it('lists item title and excerpt within a group', async () => {
    const wrapper = mountView()
    await flushPromises()
    const items = wrapper.findAll('[data-test="cat-item"]')
    expect(items).toHaveLength(4)
    expect(wrapper.text()).toContain('Alpha')
    expect(wrapper.text()).toContain('甲摘要')
  })

  it('clicking an item opens read-only full content via readPage', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="cat-item"]').trigger('click')
    await flushPromises()
    expect(readPage).toHaveBeenCalledWith('demo', 'a.md')
    const s = useCategoriesStore()
    expect(s.activePath).toBe('a.md')
    // 右侧只读编辑器收到全文，且 readonly=true
    const ed = wrapper.findComponent({ name: 'MdEditor' })
    expect(ed.props('content')).toBe('# Alpha 正文')
    expect(ed.props('readonly')).toBe(true)
  })

  it('collapses and expands a group', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.findAll('[data-test="cat-item"]')).toHaveLength(4)
    // 折叠 idea 组 → 其 2 条隐藏
    await wrapper.find('[data-test="cat-toggle"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-test="cat-item"]')).toHaveLength(2)
    // 再展开
    await wrapper.find('[data-test="cat-toggle"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-test="cat-item"]')).toHaveLength(4)
  })

  it('switches container via switcher and reloads categories', async () => {
    const wrapper = mountView()
    await flushPromises()
    const select = wrapper.find('[data-test="container-switch"]')
    await select.setValue('other')
    await flushPromises()
    expect(useCategoriesStore().current).toBe('other')
    expect(getCategories).toHaveBeenCalledWith('other')
  })

  // codex P2：category 是开放词表，__proto__ 也能正常折叠/展开（不能用普通对象存折叠态）
  it('toggles a group named __proto__ (open-vocabulary safe collapse map)', async () => {
    // 用 JSON.parse 构造真实自有键 `__proto__`（对象字面量 `{__proto__: x}` 会走原型 setter，本身不含自有键）
    ;(getCategories as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.parse('{"__proto__":[{"path":"p.md","title":"P","category":"__proto__","excerpt":""}]}'),
    )
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.findAll('[data-test="cat-item"]')).toHaveLength(1)
    await wrapper.find('[data-test="cat-toggle"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-test="cat-item"]')).toHaveLength(0)
    await wrapper.find('[data-test="cat-toggle"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-test="cat-item"]')).toHaveLength(1)
  })
})

// issue #202 问题3 回归：onSwitch/onOpen 失败须 ElMessage.error 可见（对齐 onCreate/onDelete
// 的既有约定），不得成为未处理 Promise rejection。
describe('CategoriesView — issue #202 异步交互错误处理回归', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue(INSTANCES)
    ;(getCategories as ReturnType<typeof vi.fn>).mockResolvedValue(CATS)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'a.md', title: 'Alpha', content: '# Alpha 正文',
    })
  })

  it('onOpen failure surfaces ElMessage.error instead of unhandled rejection', async () => {
    ;(readPage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('读取失败'))
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="cat-item"]').trigger('click')
    await flushPromises()
    const { ElMessage } = await import('element-plus')
    expect(ElMessage.error).toHaveBeenCalledWith('读取失败')
  })

  it('onSwitch failure surfaces ElMessage.error instead of unhandled rejection', async () => {
    const wrapper = mountView()
    await flushPromises()
    ;(getCategories as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('切换失败'))
    await wrapper.find('[data-test="container-switch"]').setValue('other')
    await flushPromises()
    const { ElMessage } = await import('element-plus')
    expect(ElMessage.error).toHaveBeenCalledWith('切换失败')
  })
})
