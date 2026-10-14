// #959 轮次产物卡片 T1 朴素卡面 + #960 T2 下载/截断（视觉定稿归 T4/#962——本票验收以行为
// 正确为准）。seam：组件 props-in 渲染面；下载点击 IO 经 api/attachments mock（readAttachmentBlob
// 是既有认证字节通道——JWT 在 Authorization 头，裸 <a href> 不可行）。

import { describe, expect, it, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import TurnFilesCard from '@/components/chat/TurnFilesCard.vue'
import type { TurnFileRow } from '@/api/sessions'
import { readAttachmentBlob } from '@/api/attachments'

vi.mock('@/api/attachments', () => ({ readAttachmentBlob: vi.fn() }))

const rows: TurnFileRow[] = [
  { path: 'notes/new.md', op: 'created' },
  { path: 'notes/edited.md', op: 'modified' },
  { path: 'notes/gone.md', op: 'deleted' },
]

// T2 物化回填后的行（attachmentId/fileName/size 齐）
const materialized: TurnFileRow[] = [
  { path: 'notes/new.md', op: 'created', attachmentId: 'att-1', fileName: 'new.md', size: 5 },
  { path: 'notes/edited.md', op: 'modified', attachmentId: 'att-2', fileName: 'edited.md', size: 7 },
  { path: 'notes/gone.md', op: 'deleted' },
]

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('TurnFilesCard（#959 轮次产物卡片）', () => {
  it('头 = 「本轮产物」+ 弱色计数；逐行 = 变更类型 + 路径', () => {
    const w = mount(TurnFilesCard, { props: { files: rows } })
    expect(w.get('[data-test="turn-files-head"]').text()).toContain('本轮产物')
    expect(w.get('[data-test="turn-files-count"]').text()).toBe('3 个文件')
    const lines = w.findAll('[data-test="turn-file-row"]')
    expect(lines).toHaveLength(3)
    expect(lines[0]!.text()).toContain('新建')
    expect(lines[0]!.text()).toContain('notes/new.md')
    expect(lines[1]!.text()).toContain('修改')
    expect(lines[2]!.text()).toContain('删除')
    // 变更类型可定位（data-op 三值——T4 视觉定稿的样式钩子）
    expect(lines.map((l) => l.attributes('data-op'))).toEqual(['created', 'modified', 'deleted'])
  })

  it('空数组不渲染（v-if 由调用方守门，组件自身兜底不渲染行）', () => {
    const w = mount(TurnFilesCard, { props: { files: [] } })
    expect(w.findAll('[data-test="turn-file-row"]')).toHaveLength(0)
  })
})

describe('TurnFilesCard（#960 下载与截断）', () => {
  it('非 delete 行有「下载」文字链；deleted 行显示「已删除」且无链接', () => {
    const w = mount(TurnFilesCard, { props: { files: materialized } })
    const lines = w.findAll('[data-test="turn-file-row"]')
    expect(lines).toHaveLength(3)
    expect(lines[0]!.get('[data-test="turn-file-download"]').text()).toBe('下载')
    expect(lines[1]!.get('[data-test="turn-file-download"]').text()).toBe('下载')
    // deleted 行：无字节无链接（D2——恢复语义归 rewind 不归卡片）
    expect(lines[2]!.find('[data-test="turn-file-download"]').exists()).toBe(false)
    expect(lines[2]!.get('[data-test="turn-file-deleted"]').text()).toBe('已删除')
  })

  it('物化失败行（无 attachmentId 的 created/modified）不出下载链也不出「已删除」', () => {
    const w = mount(TurnFilesCard, {
      props: { files: [{ path: 'notes/broken.md', op: 'created' }] },
    })
    const line = w.get('[data-test="turn-file-row"]')
    expect(line.find('[data-test="turn-file-download"]').exists()).toBe(false)
    expect(line.find('[data-test="turn-file-deleted"]').exists()).toBe(false)
  })

  it('头计数 = filesTotal（缺省 files.length）', () => {
    const w = mount(TurnFilesCard, { props: { files: materialized } })
    expect(w.get('[data-test="turn-files-count"]').text()).toBe('3 个文件')
    const w2 = mount(TurnFilesCard, { props: { files: materialized, filesTotal: 25 } })
    expect(w2.get('[data-test="turn-files-count"]').text()).toBe('25 个文件')
  })

  it('截断：filesTotal > 列出数 → 行尾「等 N 个文件」计数行（N = total - 列出数）', () => {
    const listed: TurnFileRow[] = Array.from({ length: 20 }, (_, i) => ({
      path: `bulk/f${i}.md`, op: 'created', attachmentId: `att-${i}`, fileName: `f${i}.md`, size: 1,
    }))
    const w = mount(TurnFilesCard, { props: { files: listed, filesTotal: 25 } })
    expect(w.findAll('[data-test="turn-file-row"]')).toHaveLength(20)
    expect(w.get('[data-test="turn-files-more"]').text()).toBe('等 5 个文件')
    // 无截断 → 无计数行
    const w2 = mount(TurnFilesCard, { props: { files: listed, filesTotal: 20 } })
    expect(w2.find('[data-test="turn-files-more"]').exists()).toBe(false)
  })

  it('点击下载：readAttachmentBlob(attachmentId) → blob URL + a[download] 触发保存', async () => {
    const blob = new Blob(['x'], { type: 'application/octet-stream' })
    vi.mocked(readAttachmentBlob).mockResolvedValue(blob)
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const w = mount(TurnFilesCard, { props: { files: materialized } })
    await w.get('[data-test="turn-file-row"] [data-test="turn-file-download"]').trigger('click')
    expect(vi.mocked(readAttachmentBlob)).toHaveBeenCalledWith('att-1')
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(click).toHaveBeenCalled()
  })
})

describe('TurnFilesCard（#961 exec 提示行——D6 动态提示）', () => {
  it('hasExec → 卡底渲染一行「本轮含 Shell 调用，其文件副作用不在此列」（D6 定稿文案）', () => {
    const w = mount(TurnFilesCard, { props: { files: rows, hasExec: true } })
    const hint = w.get('[data-test="turn-files-exec"]')
    expect(hint.text()).toBe('本轮含 Shell 调用，其文件副作用不在此列')
  })

  it('无标记（缺省）→ 无提示行（不含 execute 轮卡底干净）', () => {
    const w = mount(TurnFilesCard, { props: { files: rows } })
    expect(w.find('[data-test="turn-files-exec"]').exists()).toBe(false)
  })
})

describe('TurnFilesCard（#962 视觉定稿——A3 变体 B 分组卡）', () => {
  // 独立真源 = #951 D9 视觉规格 / A3 #929 实物定稿：按 op 三节分组（空缺节跳过），
  // 节标签「新建 · N」；行 = 药丸徽标 + 目录 rtl-ellipsis 弱化 + 文件名 mono + 下载链。
  it('按 op 分组三节：节标签「新建 · N」，行序 = 组序（created→modified→deleted）× 组内原序', () => {
    const mixed: TurnFileRow[] = [
      { path: 'a/m1.md', op: 'modified', attachmentId: 'att-m1', fileName: 'm1.md', size: 1 },
      { path: 'a/c1.md', op: 'created', attachmentId: 'att-c1', fileName: 'c1.md', size: 1 },
      { path: 'b/c2.md', op: 'created', attachmentId: 'att-c2', fileName: 'c2.md', size: 1 },
      { path: 'b/d1.md', op: 'deleted' },
      { path: 'a/m2.md', op: 'modified', attachmentId: 'att-m2', fileName: 'm2.md', size: 1 },
    ]
    const w = mount(TurnFilesCard, { props: { files: mixed } })
    const groups = w.findAll('[data-test="turn-files-group"]')
    expect(groups.map((g) => g.attributes('data-op'))).toEqual(['created', 'modified', 'deleted'])
    const labels = w.findAll('[data-test="turn-files-glabel"]')
    expect(labels.map((l) => l.text())).toEqual(['新建 · 2', '修改 · 2', '删除 · 1'])
    // 行序 = 组序 × 组内原序（created 保持 c1→c2，modified 保持 m1→m2）
    const lines = w.findAll('[data-test="turn-file-row"]')
    expect(lines.map((l) => l.attributes('data-path'))).toEqual([
      'a/c1.md', 'b/c2.md', 'a/m1.md', 'a/m2.md', 'b/d1.md',
    ])
  })

  it('空缺节跳过：只有 modified 时不出 created/deleted 节', () => {
    const w = mount(TurnFilesCard, {
      props: { files: [{ path: 'a/m1.md', op: 'modified', attachmentId: 'att-m1', fileName: 'm1.md', size: 1 }] },
    })
    const groups = w.findAll('[data-test="turn-files-group"]')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.attributes('data-op')).toBe('modified')
    expect(groups[0]!.get('[data-test="turn-files-glabel"]').text()).toBe('修改 · 1')
  })

  it('行 = 药丸徽标（op 文案）+ 目录弱化 + 文件名 mono 主文本', () => {
    const w = mount(TurnFilesCard, { props: { files: materialized } })
    const line = w.get('[data-test="turn-file-row"][data-op="created"]')
    expect(line.get('[data-test="turn-file-badge"]').text()).toBe('新建')
    expect(line.get('[data-test="turn-file-dir"]').text()).toBe('notes')
    expect(line.get('[data-test="turn-file-name"]').text()).toBe('new.md')
    // 目录与文件名拼回完整路径（既有断言行 text 含全路径的兼容基础）
    expect(line.text()).toContain('notes/new.md')
  })

  it('无目录文件：只渲染文件名，不出目录段', () => {
    const w = mount(TurnFilesCard, {
      props: { files: [{ path: 'README.md', op: 'created', attachmentId: 'att-r', fileName: 'README.md', size: 1 }] },
    })
    const line = w.get('[data-test="turn-file-row"]')
    expect(line.find('[data-test="turn-file-dir"]').exists()).toBe(false)
    expect(line.get('[data-test="turn-file-name"]').text()).toBe('README.md')
  })

  it('路径 title 提示：有 size → 「path · N B」；无 size → path', () => {
    const w = mount(TurnFilesCard, { props: { files: materialized } })
    expect(w.get('[data-test="turn-file-row"][data-path="notes/new.md"] [data-test="turn-file-path"]').attributes('title')).toBe('notes/new.md · 5 B')
    const noSize = mount(TurnFilesCard, {
      props: { files: [{ path: 'x.md', op: 'created', attachmentId: 'att-x', fileName: 'x.md' }] },
    })
    expect(noSize.get('[data-test="turn-file-path"]').attributes('title')).toBe('x.md')
  })
})
