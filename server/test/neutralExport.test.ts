// story 64（#747 · R6 双栈不可逆缓解）：会话数据导出中性格式 JSON 的映射纯函数单测。
//
// 验收依据（#747 B 节）：「中性导出离线脚本——从 session_messages 导出中性格式 JSON」；
// story 64：「会话数据可导出为中性格式，so that 双栈分叉不是单行道」。
//
// 「中性」口径（本测试锁定）：
//   - 只含产品读源字段（turn/role/content/clientKey/attachments v1 聚合）——
//     LangGraph checkpoint blob / DB 机制列（archivedAt / anchorCheckpointId /
//     attachmentsJson 命名）一律不落导出面；
//   - fork 溯源（parentSessionKey / forkSource）保留——跨栈对账要认得出来源；
//   - 输入零信任：attachmentsJson 解析失败 → 该消息 attachments 省略（不 throw）；
//   - 输出序 = (turn, createdAt) 升序，与输入顺序无关（回放确定性）。
//
// seam = 纯函数 buildNeutralSessionExport（给定 session 行 + message 行 → 导出文档）。

import { describe, it, expect } from 'vitest'
import { buildNeutralSessionExport } from '../src/sessions/neutralExport'
import type { NeutralExportSessionRow, NeutralExportMessageRow } from '../src/sessions/neutralExport'

const SESSION: NeutralExportSessionRow = {
  id: 'sess-1',
  title: '抗体筛选实验',
  createdAt: new Date('2026-10-01T08:00:00.000Z'),
  parentSessionKey: null,
  forkSourceJson: null,
}

const AT = (s: string): Date => new Date(s)

function row(partial: Partial<NeutralExportMessageRow> & { turn: number }): NeutralExportMessageRow {
  return {
    role: 'user',
    content: '',
    clientKey: null,
    attachmentsJson: '{"v":1}',
    createdAt: AT('2026-10-01T09:00:00.000Z'),
    ...partial,
  }
}

describe('buildNeutralSessionExport（story 64 · 中性格式导出）', () => {
  it('导出文档形状：format/version/session 元信息恒定，exportedAt 为 ISO 串', () => {
    const doc = buildNeutralSessionExport(SESSION, [row({ turn: 1 })], AT('2026-10-09T00:00:00.000Z'))
    expect(doc.format).toBe('researcher-session-export')
    expect(doc.version).toBe(1)
    expect(doc.exportedAt).toBe('2026-10-09T00:00:00.000Z')
    expect(doc.session).toEqual({
      id: 'sess-1',
      title: '抗体筛选实验',
      createdAt: '2026-10-01T08:00:00.000Z',
    })
    // JSON 可序列化（离线脚本落盘面）
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc)
  })

  it('消息映射：turn/role/content/createdAt 直出，clientKey 非空才带', () => {
    const doc = buildNeutralSessionExport(SESSION, [
      row({ turn: 1, role: 'user', content: '帮我查文献', clientKey: 'a'.repeat(32) }),
      row({ turn: 2, role: 'assistant', content: '已找到 3 篇' }),
    ])
    expect(doc.messages).toEqual([
      {
        turn: 1,
        role: 'user',
        content: '帮我查文献',
        createdAt: '2026-10-01T09:00:00.000Z',
        clientKey: 'a'.repeat(32),
      },
      {
        turn: 2,
        role: 'assistant',
        content: '已找到 3 篇',
        createdAt: '2026-10-01T09:00:00.000Z',
      },
    ])
  })

  it('中性化：DB 机制面（attachmentsJson 命名 / anchorCheckpointId / archivedAt）不落导出字段', () => {
    const doc = buildNeutralSessionExport(SESSION, [
      row({ turn: 1, content: 'x', attachmentsJson: '{"v":1,"thinking":"…","tools":[]}' }),
    ])
    const serialized = JSON.stringify(doc)
    expect(serialized).not.toContain('attachmentsJson')
    expect(serialized).not.toContain('anchorCheckpointId')
    expect(serialized).not.toContain('archivedAt')
    // v1 聚合以中性名 attachments 透传（产品 schema 版本化，跨栈可读）
    expect(doc.messages[0]!.attachments).toEqual({ v: 1, thinking: '…', tools: [] })
  })

  it('输入零信任：attachmentsJson 非法 JSON → attachments 省略不 throw；空聚合对象也省略', () => {
    const doc = buildNeutralSessionExport(SESSION, [
      row({ turn: 1, attachmentsJson: '{not-json' }),
      row({ turn: 2, attachmentsJson: '{"v":1}' }),
    ])
    expect(doc.messages[0]!.attachments).toBeUndefined()
    expect(doc.messages[1]!.attachments).toBeUndefined()
  })

  it('排序：输出恒为 (turn, createdAt) 升序，与输入顺序无关', () => {
    const doc = buildNeutralSessionExport(SESSION, [
      row({ turn: 3, createdAt: AT('2026-10-01T11:00:00.000Z') }),
      row({ turn: 1, createdAt: AT('2026-10-01T09:00:00.000Z') }),
      row({ turn: 2, createdAt: AT('2026-10-01T10:00:00.000Z') }),
      // 同 turn：createdAt 决胜
      row({ turn: 2, createdAt: AT('2026-10-01T09:30:00.000Z'), content: 'earlier' }),
    ])
    expect(doc.messages.map((m) => [m.turn, m.createdAt])).toEqual([
      [1, '2026-10-01T09:00:00.000Z'],
      [2, '2026-10-01T09:30:00.000Z'],
      [2, '2026-10-01T10:00:00.000Z'],
      [3, '2026-10-01T11:00:00.000Z'],
    ])
    expect(doc.messages[1]!.content).toBe('earlier')
  })

  it('fork 溯源：parentSessionKey / forkSourceJson 可解析时带出（中性面保留来源链）', () => {
    const doc = buildNeutralSessionExport(
      {
        ...SESSION,
        id: 'sess-fork',
        parentSessionKey: 'sess-1',
        forkSourceJson: '{"checkpointId":"ckpt-9","note":"切点"}',
      },
      [row({ turn: 1 })],
    )
    expect(doc.session).toEqual({
      id: 'sess-fork',
      title: '抗体筛选实验',
      createdAt: '2026-10-01T08:00:00.000Z',
      parentSessionKey: 'sess-1',
      forkSource: { checkpointId: 'ckpt-9', note: '切点' },
    })
  })

  it('forkSourceJson 非法 JSON → forkSource 省略（零信任，导出不炸）', () => {
    const doc = buildNeutralSessionExport(
      { ...SESSION, parentSessionKey: 'sess-1', forkSourceJson: 'not-json' },
      [row({ turn: 1 })],
    )
    expect(doc.session.parentSessionKey).toBe('sess-1')
    expect('forkSource' in doc.session).toBe(false)
  })
})
