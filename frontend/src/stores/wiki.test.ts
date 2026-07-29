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
})

// issue #202 问题2/3 回归（评审复现用例转正）：保存链中毒恢复 + saveError 可见。
// 修复前实测：一次 updatePage reject 后 _saveChain 永久 rejected——第二次 _flush 仍抛
// 第一次旧错误、updatePage 调用停在 1 次、dirty 永卡 true、openPage/switchContainer 被阻断。
describe('wiki store — issue #202 保存链中毒恢复回归', () => {
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

  it('recovers autosave after a failed save: 2nd flush persists, dirty cleared, saveError lifecycle', async () => {
    ;(updatePage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('401 瞬态'))
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('v1')
    // 第一次落盘失败：不抛出（链吸收），saveError 写入，dirty 保持（草稿不丢）
    await s._flush()
    expect(s.saveError).toBe('401 瞬态')
    expect(s.dirty).toBe(true)
    expect(s.saving).toBe(false)
    // 恢复后第二次 _flush：不抛第一次的旧错误、updatePage 再次被调、dirty 最终 false
    await s._flush()
    expect(updatePage).toHaveBeenCalledTimes(2)
    expect(updatePage).toHaveBeenLastCalledWith('demo', 'concepts/a.md', 'v1')
    expect(s.dirty).toBe(false)
    expect(s.saveError).toBe('') // 成功落盘后清掉失败提示
  })

  it('debounced autosave failure surfaces saveError without unhandled rejection', async () => {
    ;(updatePage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('网络抖动'))
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('v1')
    await vi.advanceTimersByTimeAsync(800) // 防抖触发 void _flush().catch——不得成为未处理 rejection
    expect(updatePage).toHaveBeenCalledTimes(1)
    expect(s.saveError).toBe('网络抖动')
    expect(s.dirty).toBe(true)
  })

  it('failed save does not block openPage/switchContainer (no poisoned chain)', async () => {
    ;(updatePage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('v1')
    await vi.advanceTimersByTimeAsync(800) // 自动保存失败一次
    expect(s.saveError).toBe('boom')
    // 导航不被旧异常阻断：openPage 前的 flush 顺带以剩余脏快照重试成功
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/b.md', title: 'B', content: '# B',
    })
    await s.openPage('concepts/b.md')
    expect(updatePage).toHaveBeenCalledTimes(2) // 恢复后重试落盘
    expect(s.activePath).toBe('concepts/b.md')
    expect(s.saveError).toBe('')
    // 切容器同样不被阻断
    await s.switchContainer('other')
    expect(s.current).toBe('other')
  })

  it('repeated failures keep saveError and dirty for manual retry', async () => {
    ;(updatePage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('后端 5xx'))
    const s = useWikiStore()
    await s.loadTree('demo')
    await s.openPage('concepts/a.md')
    s.edit('v1')
    await s._flush()
    await s._flush()
    expect(updatePage).toHaveBeenCalledTimes(2) // 链未中毒：每次 flush 都真实重试
    expect(s.saveError).toBe('后端 5xx')
    expect(s.dirty).toBe(true) // 草稿保留，供手动重试/恢复后落盘
  })
})
