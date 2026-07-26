// seam: categories store —— issue #85 Categories 栏目状态单例（spec #75 前端）。
// 对齐 stores/wiki.ts：api/wiki 用 vi.mock 替身（数据层 seam）。覆盖：
// 加载聚合（current/groups 动态键）、选中条目只读取全文（readPage）、切容器清选中并重载、
// 未知 category 值原样成组（开放词表）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/wiki', () => ({
  getCategories: vi.fn(),
  readPage: vi.fn(),
}))

import { useCategoriesStore } from '@/stores/categories'
import { getCategories, readPage } from '@/api/wiki'

const CATS = {
  idea: [
    { path: 'a.md', title: 'A', category: 'idea', excerpt: '甲' },
    { path: 'b.md', title: 'B', category: 'idea', excerpt: '乙' },
  ],
  // 未知/未来 category 值：后端扫到什么返回什么，store 原样成组
  'x-new': [{ path: 'c.md', title: 'C', category: 'x-new', excerpt: '丙' }],
}

describe('categories store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(getCategories as ReturnType<typeof vi.fn>).mockResolvedValue(CATS)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'a.md',
      title: 'A',
      content: '# A 正文',
    })
  })

  it('loads categories for current container, grouping dynamic keys as-is', async () => {
    const s = useCategoriesStore()
    await s.loadCategories('demo')
    expect(getCategories).toHaveBeenCalledWith('demo')
    expect(s.current).toBe('demo')
    // 开放词表：响应键原样成组（含未知值 x-new），计数 = 每组条目数
    expect(Object.keys(s.groups)).toEqual(['idea', 'x-new'])
    expect(s.groups.idea).toHaveLength(2)
    expect(s.groups['x-new']).toHaveLength(1)
  })

  it('opens an item read-only via readPage full content', async () => {
    const s = useCategoriesStore()
    await s.loadCategories('demo')
    await s.openItem('a.md')
    expect(readPage).toHaveBeenCalledWith('demo', 'a.md')
    expect(s.activePath).toBe('a.md')
    expect(s.content).toBe('# A 正文')
  })

  it('switchContainer clears selection and reloads target container', async () => {
    const s = useCategoriesStore()
    await s.loadCategories('demo')
    await s.openItem('a.md')
    await s.switchContainer('other')
    expect(getCategories).toHaveBeenCalledWith('other')
    expect(s.current).toBe('other')
    expect(s.activePath).toBe('')
    expect(s.content).toBe('')
  })

  it('resetForContainer clears retained selection before loading (remount)', async () => {
    const s = useCategoriesStore()
    await s.loadCategories('demo')
    await s.openItem('a.md')
    await s.resetForContainer('other')
    expect(s.activePath).toBe('')
    expect(s.content).toBe('')
    expect(s.current).toBe('other')
  })
})
