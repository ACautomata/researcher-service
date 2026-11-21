// #1077 · S3：模型输入白名单（schema 即协议真源）。
import { describe, expect, it } from 'vitest'
import { HistoryReadSchema, HistorySearchSchema, SessionHistorySchema } from '../src/sessions/history/params'

describe('session_history 参数合同', () => {
  it('C14/P1/M2/G10：字段白名单不含身份、SQL、shell 或数据库路径', () => {
    expect(Object.keys(HistorySearchSchema.shape).sort()).toEqual(['case_sensitive', 'context', 'cursor', 'fields', 'operation', 'query', 'session_ids', 'time', 'title'])
    expect(Object.keys(HistoryReadSchema.shape).sort()).toEqual(['cursor', 'operation', 'targets'])
    for (const field of ['ownerId', 'role', 'sql', 'shell', 'command', 'dbPath', 'budget']) {
      expect(SessionHistorySchema.safeParse({ operation: 'search', [field]: 'x' }).success).toBe(false)
    }
  })
  it.each([
    { operation: 'list' }, { operation: 'search', session_ids: [] },
    { operation: 'search', range: { from_turn: 1 } },
    { operation: 'search', fields: ['thinking'] }, { operation: 'search', context: {} },
    { operation: 'search', query: { text: '' } }, { operation: 'search', query: { text: '  ' } },
    { operation: 'search', query: { text: 'x', mode: 'sql' } },
    { operation: 'search', time: { from: '2026-01-01T00:00:00' } },
    { operation: 'search', time: { from: '2026-02-30T00:00:00Z' } },
    { operation: 'search', time: { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' } },
    { operation: 'read', targets: [] },
    ...['query', 'title', 'time', 'fields', 'context', 'range'].map(field => ({ operation: 'read', targets: [{ session_id: 's' }], [field]: {} })),
    { operation: 'read', targets: [{ session_id: 's', range: {} }] },
    { operation: 'read', targets: [{ session_id: 's', range: { from_turn: 9, to_turn: 1 } }] },
  ])('C1/C5/C9/C11/C13：拒绝非法组合 %j', request => {
    expect(SessionHistorySchema.safeParse(request).success).toBe(false)
  })
  it('C5/C11：带时区且合法的日历时间', () => {
    expect(SessionHistorySchema.safeParse({ operation: 'search', time: { from: '2024-02-29T00:00:00+08:00' } }).success).toBe(true)
  })
  it.each(['[', '(a+)+', '(a|aa)+', '(?=x)', '(x)\\1', 'a{1,1001}'])('C6：非法或危险正则明确报参数错误 %s', text => {
    expect(SessionHistorySchema.safeParse({ operation: 'search', query: { text, mode: 'regex' } }).success).toBe(false)
  })
})
