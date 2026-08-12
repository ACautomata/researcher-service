// seam: fileTabs store —— workspace 树数据 + 只读 tab 状态机（#626 T1 / #618 规格 §3）。
// T1 子集直测：loadTree（成功/失败/截断/空容器名/中途切容器丢弃）、openFromTree（新建/复用只切 active/
// binary/oversized/error/中途关 tab）、closeTab（删 active 切相邻）、closeAll（保留 tree）、reset（清 tree）。
// 仅测外部状态转移，mock api/files（信封解包由 api/ 单测覆盖，此处不重复）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { useFileTabsStore } from '@/stores/fileTabs'
import type { FileEntry, FileReading } from '@/api/files'
import * as filesApi from '@/api/files'

vi.mock('@/api/files', () => ({
  listWorkspaceTree: vi.fn(),
  readWorkspaceFile: vi.fn(),
}))

const dir = (files: FileEntry[] = [], truncated = false) => ({
  kind: 'dir' as const,
  path: '',
  files,
  truncated,
})

const file = (path: string, over: Partial<FileReading> = {}): FileReading => ({
  kind: 'file',
  path,
  content: '# hi\n',
  size: 5,
  modified: '2026-08-12T00:00:00Z',
  binary: false,
  oversized: false,
  ...over,
})

describe('fileTabs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(filesApi.listWorkspaceTree).mockReset()
    vi.mocked(filesApi.readWorkspaceFile).mockReset()
  })

  // ---- loadTree ----
  it('loadTree：成功落 tree + treeTruncated，清 treeLoading', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.listWorkspaceTree).mockResolvedValue(dir([{ path: 'a.md', type: 'file', size: 1, modified: '' }], false))
    const ft = useFileTabsStore()
    await ft.loadTree()
    expect(ft.tree?.files).toHaveLength(1)
    expect(ft.treeTruncated).toBe(false)
    expect(ft.treeLoading).toBe(false)
    expect(ft.treeError).toBeNull()
  })

  it('loadTree：truncated 标志透传', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.listWorkspaceTree).mockResolvedValue(dir([], true))
    const ft = useFileTabsStore()
    await ft.loadTree()
    expect(ft.treeTruncated).toBe(true)
  })

  it('loadTree：失败落 treeError + tree=null，不抛', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.listWorkspaceTree).mockRejectedValue(new Error('boom'))
    const ft = useFileTabsStore()
    await expect(ft.loadTree()).resolves.toBeUndefined()
    expect(ft.tree).toBeNull()
    expect(ft.treeError).toBe('boom')
    expect(ft.treeLoading).toBe(false)
  })

  it('loadTree：无选中容器早退（不发请求）', async () => {
    const ft = useFileTabsStore()
    await ft.loadTree()
    expect(filesApi.listWorkspaceTree).not.toHaveBeenCalled()
  })

  it('loadTree：中途切容器丢弃迟到响应', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('a')
    vi.mocked(filesApi.listWorkspaceTree).mockResolvedValue(dir([{ path: 'a.md', type: 'file', size: 1, modified: '' }]))
    const ft = useFileTabsStore()
    const p = ft.loadTree()
    chat.setSelectedContainer('b') // await 前切走
    await p
    expect(ft.tree).toBeNull() // 旧容器响应被丢弃
  })

  // ---- openFromTree ----
  it('openFromTree：新文件 → 新 loaded tab + active，lineMarks 空（无高亮）', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.readWorkspaceFile).mockResolvedValue(file('notes/a.md'))
    const ft = useFileTabsStore()
    await ft.openFromTree('notes/a.md')
    expect(ft.tabs).toHaveLength(1)
    expect(ft.tabs[0]).toMatchObject({ path: 'notes/a.md', state: 'loaded', lineMarks: [], binary: false, oversized: false })
    expect(ft.tabs[0].content).toBe('# hi\n')
    expect(ft.activePath).toBe('notes/a.md')
  })

  it('openFromTree：同路径复用 → 仅切 active，不重拉不新开', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.readWorkspaceFile).mockResolvedValue(file('notes/a.md'))
    const ft = useFileTabsStore()
    await ft.openFromTree('notes/a.md')
    await ft.openFromTree('notes/a.md') // 复用
    expect(ft.tabs).toHaveLength(1)
    expect(filesApi.readWorkspaceFile).toHaveBeenCalledTimes(1)
    expect(ft.activePath).toBe('notes/a.md')
  })

  it('openFromTree：多文件各开各 tab，active 切到最后开的', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.readWorkspaceFile).mockImplementation(async (_n, p) => file(p))
    const ft = useFileTabsStore()
    await ft.openFromTree('a.md')
    await ft.openFromTree('b.md')
    expect(ft.tabs.map((t) => t.path)).toEqual(['a.md', 'b.md'])
    expect(ft.activePath).toBe('b.md')
  })

  it('openFromTree：binary 文件 → loaded + content:null + binary 标志', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.readWorkspaceFile).mockResolvedValue(file('out.bin', { content: null, binary: true, size: 9999 }))
    const ft = useFileTabsStore()
    await ft.openFromTree('out.bin')
    expect(ft.tabs[0]).toMatchObject({ state: 'loaded', binary: true, content: null })
  })

  it('openFromTree：oversized 文件 → loaded + content:null + oversized 标志', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.readWorkspaceFile).mockResolvedValue(file('big.log', { content: null, oversized: true, size: 5_000_000 }))
    const ft = useFileTabsStore()
    await ft.openFromTree('big.log')
    expect(ft.tabs[0]).toMatchObject({ state: 'loaded', oversized: true, content: null })
  })

  it('openFromTree：fetch 失败 → error 态 + errorMessage，不抛', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.readWorkspaceFile).mockRejectedValue(new Error('不存在'))
    const ft = useFileTabsStore()
    await expect(ft.openFromTree('x.md')).resolves.toBeUndefined()
    expect(ft.tabs[0]).toMatchObject({ state: 'error', errorMessage: '不存在' })
    expect(ft.tabs[0].content).toBeNull()
  })

  it('openFromTree：await 中途用户关掉 tab → 不崩（回填找不到 tab 静默）', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.readWorkspaceFile).mockResolvedValue(file('a.md'))
    const ft = useFileTabsStore()
    const p = ft.openFromTree('a.md')
    ft.closeTab('a.md') // fetch 完成前关闭
    await p
    expect(ft.tabs).toHaveLength(0) // 回填静默丢弃，不留空 tab
  })

  // ---- closeTab ----
  it('closeTab：删非 active 不改 active', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.readWorkspaceFile).mockImplementation(async (_n, p) => file(p))
    const ft = useFileTabsStore()
    await ft.openFromTree('a.md')
    await ft.openFromTree('b.md')
    ft.closeTab('a.md') // active 是 b.md
    expect(ft.tabs.map((t) => t.path)).toEqual(['b.md'])
    expect(ft.activePath).toBe('b.md')
  })

  it('closeTab：删 active → 切前一个相邻', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.readWorkspaceFile).mockImplementation(async (_n, p) => file(p))
    const ft = useFileTabsStore()
    await ft.openFromTree('a.md')
    await ft.openFromTree('b.md')
    await ft.openFromTree('c.md')
    ft.closeTab('c.md') // active 是末位
    expect(ft.activePath).toBe('b.md')
  })

  it('closeTab：删唯一 active tab → active 为 null', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.readWorkspaceFile).mockResolvedValue(file('a.md'))
    const ft = useFileTabsStore()
    await ft.openFromTree('a.md')
    ft.closeTab('a.md')
    expect(ft.tabs).toHaveLength(0)
    expect(ft.activePath).toBeNull()
  })

  // ---- closeAll / reset ----
  it('closeAll：清 tab + active，保留 tree', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.listWorkspaceTree).mockResolvedValue(dir([{ path: 'a.md', type: 'file', size: 1, modified: '' }]))
    vi.mocked(filesApi.readWorkspaceFile).mockResolvedValue(file('a.md'))
    const ft = useFileTabsStore()
    await ft.loadTree()
    await ft.openFromTree('a.md')
    ft.closeAll()
    expect(ft.tabs).toHaveLength(0)
    expect(ft.activePath).toBeNull()
    expect(ft.tree?.files).toHaveLength(1) // 树保留（切会话语义）
  })

  it('reset：清 tab + active + tree + treeTruncated + treeError（切容器语义）', async () => {
    const chat = useChatStore()
    chat.setSelectedContainer('demo')
    vi.mocked(filesApi.listWorkspaceTree).mockResolvedValue(dir([{ path: 'a.md', type: 'file', size: 1, modified: '' }], true))
    vi.mocked(filesApi.readWorkspaceFile).mockResolvedValue(file('a.md'))
    const ft = useFileTabsStore()
    await ft.loadTree()
    await ft.openFromTree('a.md')
    ft.reset()
    expect(ft.tabs).toHaveLength(0)
    expect(ft.activePath).toBeNull()
    expect(ft.tree).toBeNull()
    expect(ft.treeTruncated).toBe(false)
    expect(ft.treeError).toBeNull()
  })
})
