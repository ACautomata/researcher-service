// seam: wiki store —— issue #45 页核心逻辑（spec §9.6）。
// 覆盖：加载树、打开页进编辑器、编辑标脏+防抖自动保存(~800ms)落盘到对应容器、
// 容器切换前自动落盘。api/wiki 用 vi.mock 替身（数据层 seam），fake timers 控防抖。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/wiki', () => ({
  getTree: vi.fn(),
  readPage: vi.fn(),
  updatePage: vi.fn(),
  createPage: vi.fn(),
  deletePage: vi.fn(),
  getGraph: vi.fn(),
}))

import { useWikiStore } from '@/stores/wiki'
import { createPage, deletePage, getTree, readPage, updatePage } from '@/api/wiki'

const TREE = {
  groups: [
    { kind: 'concept', name: 'concepts', pages: [{ path: 'concepts/a.md', title: 'A' }] },
  ],
}

describe('wiki store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.clearAllMocks() // 隔离各用例的 mock 调用计数（防抖落盘计数断言依赖）
    ;(getTree as ReturnType<typeof vi.fn>).mockResolvedValue(TREE)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/a.md',
      title: 'A',
      content: '# A\n',
    })
    ;(updatePage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(createPage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(deletePage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads tree for current container', async () => {
    const s = useWikiStore()
    await s.loadTree('demo')
    expect(getTree).toHaveBeenCalledWith('demo')
    expect(s.current).toBe('demo')
    expect(s.groups).toEqual(TREE.groups)
  })

  it('opens a page into the editor', async () => {
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    expect(readPage).toHaveBeenCalledWith('demo', 'concepts/a.md')
    expect(s.activePath).toBe('concepts/a.md')
    expect(s.draft).toBe('# A\n')
    expect(s.dirty).toBe(false)
  })

  it('debounces autosave ~800ms after edit, writing to same container', async () => {
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('# A 改')
    expect(s.dirty).toBe(true)
    expect(updatePage).not.toHaveBeenCalled() // 防抖窗口内未落盘
    await vi.advanceTimersByTimeAsync(800)
    expect(updatePage).toHaveBeenCalledWith('demo', 'concepts/a.md', '# A 改')
    expect(s.dirty).toBe(false)
  })

  it('coalesces rapid edits into one save', async () => {
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('1')
    s.edit('12')
    s.edit('123')
    await vi.advanceTimersByTimeAsync(800)
    expect(updatePage).toHaveBeenCalledTimes(1)
    expect(updatePage).toHaveBeenCalledWith('demo', 'concepts/a.md', '123')
  })

  it('flushes pending save before switching container', async () => {
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('未落盘内容')
    // 切容器前先落盘当前脏页
    await s.switchContainer('other')
    expect(updatePage).toHaveBeenCalledWith('demo', 'concepts/a.md', '未落盘内容')
    expect(getTree).toHaveBeenCalledWith('other')
    expect(s.current).toBe('other')
    expect(s.activePath).toBe('') // 切后清空编辑器
  })

  it('flushes pending save before opening another page', async () => {
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('改动')
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/b.md',
      title: 'B',
      content: '# B',
    })
    await s.openPage('concepts/b.md')
    expect(updatePage).toHaveBeenCalledWith('demo', 'concepts/a.md', '改动')
    expect(s.activePath).toBe('concepts/b.md')
  })

  it('creates a page then refreshes tree', async () => {
    const s = useWikiStore()
    await s.loadTree('demo')
    ;(getTree as ReturnType<typeof vi.fn>).mockClear()
    await s.createPage('concepts/new.md', '# N')
    expect(createPage).toHaveBeenCalledWith('demo', 'concepts/new.md', '# N')
    expect(getTree).toHaveBeenCalledWith('demo') // 新建后刷新树
  })

  it('deletes a page then refreshes tree and clears editor if active', async () => {
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    ;(getTree as ReturnType<typeof vi.fn>).mockClear()
    await s.deletePage('concepts/a.md')
    expect(deletePage).toHaveBeenCalledWith('demo', 'concepts/a.md')
    expect(getTree).toHaveBeenCalledWith('demo')
    expect(s.activePath).toBe('')
    expect(s.draft).toBe('')
  })
})

describe('wiki store — codex PR #62 意见2/3 回归', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.clearAllMocks()
    ;(getTree as ReturnType<typeof vi.fn>).mockResolvedValue(TREE)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/a.md', title: 'A', content: '# A\n',
    })
    ;(updatePage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(createPage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(deletePage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })
  afterEach(() => { vi.useRealTimers() })

  it('flush during in-flight save waits and persists the newer draft (意见2)', async () => {
    let resolveFirst!: () => void
    ;(updatePage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((res) => { resolveFirst = res }),
    )
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('v1')
    await vi.advanceTimersByTimeAsync(800)        // 触发第一次保存（在飞）
    s.edit('v2 更新')                              // 在飞期间又编辑
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/b.md', title: 'B', content: '# B',
    })
    const openP = s.openPage('concepts/b.md')      // 切页 → 须等保存在飞完成并存 v2
    resolveFirst()                                  // 第一次保存返回
    await openP
    const contents = (updatePage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])
    expect(contents).toContain('v2 更新')
  })

  it('resetForContainer clears retained activePath/draft for remount (意见3)', async () => {
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('未保存')
    await s.resetForContainer('other')
    expect(s.activePath).toBe('')
    expect(s.draft).toBe('')
    expect(s.dirty).toBe(false)
    expect(s.current).toBe('other')
  })

  it('recovers the save chain after a failure and lets navigation retry the dirty draft', async () => {
    ;(updatePage as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('保存失败'))
      .mockResolvedValueOnce(undefined)
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('等待重试的内容')

    // 本次调用仍收到当前错误，供视图显示；内部 _saveChain 不保留 rejected 状态。
    await expect(s._flush()).rejects.toThrow('保存失败')
    expect(s.dirty).toBe(true)

    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/b.md', title: 'B', content: '# B',
    })
    await expect(s.openPage('concepts/b.md')).resolves.toBeUndefined()
    expect(updatePage).toHaveBeenCalledTimes(2)
    expect(updatePage).toHaveBeenLastCalledWith('demo', 'concepts/a.md', '等待重试的内容')
    expect(s.activePath).toBe('concepts/b.md')
    expect(s.dirty).toBe(false)
  })
})
