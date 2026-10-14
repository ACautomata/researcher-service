// 轮次产物卡片 T1（施工票 #959）聚合纯函数单测：fileJournal 行 → turn.files 卡片行。
// 口径（#951「实现位」+ findings 927 §3.1）：op 映射 write∧beforeSha256=null→created /
// write·edit∧beforeSha256≠null→modified / delete→deleted；toolCallId 带 ingest-/media-
// 前缀的物化旁路行（用户上传物化 / D9 媒体物化）不进卡——否则用户上传被误报为本轮修改。
// T1 行形状 = D8 契约子集 { path, op }（attachmentId/fileName/size 由 T2 物化回填）。

import { describe, it, expect } from 'vitest'
import type { FileJournal } from '../src/generated/prisma/client'
import { turnFileRowsFromJournal } from '../src/runner/filejournal/turnFiles'

type JournalRow = Pick<FileJournal, 'op' | 'path' | 'beforeSha256' | 'toolCallId'>

function row(over: Partial<JournalRow> = {}): JournalRow {
  return { op: 'write', path: 'notes/a.md', beforeSha256: null, toolCallId: 'call-1', ...over }
}

describe('turnFileRowsFromJournal（#959 聚合纯函数）', () => {
  it('op 映射：write∧前像空→created；write·edit∧前像非空→modified；delete→deleted', () => {
    const rows = turnFileRowsFromJournal([
      row({ path: 'new.md', op: 'write', beforeSha256: null }),
      row({ path: 'overwritten.md', op: 'write', beforeSha256: 'aaa' }),
      row({ path: 'edited.md', op: 'edit', beforeSha256: 'bbb' }),
      row({ path: 'gone.md', op: 'delete', beforeSha256: 'ccc' }),
    ])
    expect(rows).toEqual([
      { path: 'new.md', op: 'created' },
      { path: 'overwritten.md', op: 'modified' },
      { path: 'edited.md', op: 'modified' },
      { path: 'gone.md', op: 'deleted' },
    ])
  })

  it('edit∧前像空（超界防御）仍映射 modified——created 仅 write∧前像空', () => {
    const rows = turnFileRowsFromJournal([row({ op: 'edit', beforeSha256: null })])
    expect(rows).toEqual([{ path: 'notes/a.md', op: 'modified' }])
  })

  it('旁路过滤：ingest-/media- 前缀 toolCallId（上传/D9 媒体物化）不进卡', () => {
    const rows = turnFileRowsFromJournal([
      row({ toolCallId: 'ingest-att-1', path: 'uploads/att-1/doc.pdf' }),
      row({ toolCallId: 'media-att-2', path: 'uploads/att-2/shot.png' }),
      row({ toolCallId: 'call-agent-1', path: 'notes/b.md' }),
    ])
    expect(rows).toEqual([{ path: 'notes/b.md', op: 'created' }])
  })

  it('op 白名单外（0 信任）丢弃不放大；输入行序保持', () => {
    const rows = turnFileRowsFromJournal([
      row({ path: 'first.md', op: 'write', beforeSha256: null }),
      row({ path: 'weird.md', op: 'rename' }),
      row({ path: 'last.md', op: 'delete', beforeSha256: 'd' }),
    ])
    expect(rows).toEqual([
      { path: 'first.md', op: 'created' },
      { path: 'last.md', op: 'deleted' },
    ])
  })

  it('全旁路行 / 空输入 → 空数组（无行即无卡的调用方判空前提）', () => {
    expect(turnFileRowsFromJournal([])).toEqual([])
    expect(turnFileRowsFromJournal([row({ toolCallId: 'ingest-x' })])).toEqual([])
  })
})
