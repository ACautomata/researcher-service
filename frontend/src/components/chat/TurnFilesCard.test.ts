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
