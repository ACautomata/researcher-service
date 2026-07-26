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

  // codex P2：快速连切容器时，过期响应不得覆盖最新选择（latest-wins）
  it('ignores a stale loadCategories response that resolves after a newer switch', async () => {
    let resolveDemo!: (v: unknown) => void
    ;(getCategories as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((res) => { resolveDemo = res }))
      .mockResolvedValueOnce({ x: [{ path: 'x.md', title: 'X', category: 'x', excerpt: '' }] })
    const s = useCategoriesStore()
    const p1 = s.loadCategories('demo') // 慢请求
    await s.loadCategories('other') // 快速完成的新请求
    resolveDemo(CATS) // 慢的旧请求最后才返回
    await p1
    // 旧响应被丢弃：保留最新选择与分组
    expect(s.current).toBe('other')
    expect(Object.keys(s.groups)).toEqual(['x'])
  })

  // codex P2：readPage 在飞期间切容器，过期正文不得回填到阅读区
  it('ignores a stale openItem response that resolves after switching container', async () => {
    let resolveRead!: (v: unknown) => void
    ;(readPage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((res) => { resolveRead = res }),
    )
    const s = useCategoriesStore()
    await s.loadCategories('demo')
    const p = s.openItem('a.md') // readPage 挂起
    await s.switchContainer('other') // 切走（清空选中）
    resolveRead({ path: 'a.md', title: 'A', content: '# 旧容器正文' })
    await p
    expect(s.current).toBe('other')
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
    await s.loadCategories('demo')
    const pa = s.openItem('a.md') // 慢
    await s.openItem('b.md') // 快，后点
    resolveA({ path: 'a.md', title: 'A', content: '# A 正文' })
    await pa
    expect(s.activePath).toBe('b.md')
    expect(s.content).toBe('# B 正文')
  })

  // codex P2（round2）：加载 other 在飞时又切回 demo，other 的过期响应不得覆盖最终选择 demo
  it('switching back to current container while a load is pending invalidates the pending one', async () => {
    let resolveOther!: (v: unknown) => void
    ;(getCategories as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(CATS) // demo 首载
      .mockImplementationOnce(() => new Promise((res) => { resolveOther = res })) // other 慢
      .mockResolvedValueOnce({ d: [{ path: 'd.md', title: 'D', category: 'd', excerpt: '' }] }) // demo 重载
    const s = useCategoriesStore()
    await s.loadCategories('demo')
    const pOther = s.switchContainer('other') // other 在飞
    await s.switchContainer('demo') // other 未回，又切回 demo
    resolveOther({ o: [{ path: 'o.md', title: 'O', category: 'o', excerpt: '' }] })
    await pOther
    // 最终选择是 demo：other 的过期响应被丢弃
    expect(s.current).toBe('demo')
    expect(Object.keys(s.groups)).toEqual(['d'])
  })

  // codex P2（round2）：目标 pending 时重复选同一容器不重复发请求
  it('treats selecting the pending container as a no-op (no duplicate request)', async () => {
    let resolveOther!: (v: unknown) => void
    ;(getCategories as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(CATS)
      .mockImplementationOnce(() => new Promise((res) => { resolveOther = res }))
    const s = useCategoriesStore()
    await s.loadCategories('demo')
    const p = s.switchContainer('other')
    await s.switchContainer('other') // other 已在飞 → 早退
    expect(getCategories).toHaveBeenCalledTimes(2) // demo + other 各一次
    resolveOther({ o: [] })
    await p
    expect(s.current).toBe('other')
  })
})
