// seam: categories store —— issue #85 Categories 栏目状态单例（spec #75 前端）。
// 对齐 stores/wiki.ts：api/wiki 用 vi.mock 替身（数据层 seam）。覆盖：
// 加载聚合（groups 动态键）、选中条目只读取全文（readPage）、reset 清选中并重载、
// 未知 category 值原样成组（开放词表）。
// #856：owner 级——store 无容器切换面（current/pending 随耦合退役），latest-wins 序号守卫保留。
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

  it('loads categories, grouping dynamic keys as-is', async () => {
    const s = useCategoriesStore()
    await s.loadCategories()
    // 开放词表：响应键原样成组（含未知值 x-new），计数 = 每组条目数
    expect(Object.keys(s.groups)).toEqual(['idea', 'x-new'])
    expect(s.groups.idea).toHaveLength(2)
    expect(s.groups['x-new']).toHaveLength(1)
  })

  it('opens an item read-only via readPage full content', async () => {
    const s = useCategoriesStore()
    await s.loadCategories()
    await s.openItem('a.md')
    expect(readPage).toHaveBeenCalledWith('a.md')
    expect(s.activePath).toBe('a.md')
    expect(s.content).toBe('# A 正文')
  })

  it('reset clears retained selection and reloads groups (remount)', async () => {
    const s = useCategoriesStore()
    await s.loadCategories()
    await s.openItem('a.md')
    ;(getCategories as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      o: [{ path: 'o.md', title: 'O', category: 'o', excerpt: '' }],
    })
    await s.reset()
    expect(s.activePath).toBe('')
    expect(s.content).toBe('')
    expect(Object.keys(s.groups)).toEqual(['o'])
  })

  // codex P2：过期响应不得覆盖最新选择（latest-wins）
  it('ignores a stale loadCategories response that resolves after a newer one', async () => {
    let resolveSlow!: (v: unknown) => void
    ;(getCategories as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((res) => { resolveSlow = res }))
      .mockResolvedValueOnce({ x: [{ path: 'x.md', title: 'X', category: 'x', excerpt: '' }] })
    const s = useCategoriesStore()
    const p1 = s.loadCategories() // 慢请求
    await s.loadCategories() // 快速完成的新请求
    resolveSlow(CATS) // 慢的旧请求最后才返回
    await p1
    // 旧响应被丢弃：保留最新分组
    expect(Object.keys(s.groups)).toEqual(['x'])
  })

  // codex P2：readPage 在飞期间 reset，过期正文不得回填到阅读区
  it('ignores a stale openItem response that resolves after reset', async () => {
    let resolveRead!: (v: unknown) => void
    ;(readPage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((res) => { resolveRead = res }),
    )
    const s = useCategoriesStore()
    await s.loadCategories()
    const p = s.openItem('a.md') // readPage 挂起
    await s.reset() // 清空选中并使在飞响应失效
    resolveRead({ path: 'a.md', title: 'A', content: '# 旧正文' })
    await p
    expect(s.activePath).toBe('')
    expect(s.content).toBe('')
  })

  // codex P2：连点两条目，旧正文不得覆盖后点的那条
  it('shows only the most recently clicked item content (latest read wins)', async () => {
    let resolveA!: (v: unknown) => void
    ;(readPage as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((res) => { resolveA = res }))
      .mockResolvedValueOnce({ path: 'b.md', title: 'B', content: '# B 正文' })
    const s = useCategoriesStore()
    await s.loadCategories()
    const pa = s.openItem('a.md') // 慢
    await s.openItem('b.md') // 快，后点
    resolveA({ path: 'a.md', title: 'A', content: '# A 正文' })
    await pa
    expect(s.activePath).toBe('b.md')
    expect(s.content).toBe('# B 正文')
  })

  it('failed load propagates and a retry succeeds', async () => {
    ;(getCategories as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ o: [{ path: 'o.md', title: 'O', category: 'o', excerpt: '' }] })
    const s = useCategoriesStore()
    await expect(s.loadCategories()).rejects.toThrow('network')
    await s.loadCategories()
    expect(getCategories).toHaveBeenCalledTimes(2)
    expect(Object.keys(s.groups)).toEqual(['o'])
  })
})
