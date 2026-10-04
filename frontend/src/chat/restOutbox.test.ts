// seam: chat/restOutbox —— REST 断线排队（story 12 · #779「outbox 收敛为断线排队」）。
// 覆盖:sessionStorage 落盘（单键 blob {v:1, sessions}）、32-hex clientKey、cap 50 丢最旧、
// 0 信任 normalize、flush 按序幂等注入（成功移除/失败保序停止）、storage 降级。
// #793 消费本模块接线（useEventStream 断线重连时 flush）；UI 编排不在本模块。

import { beforeEach, describe, expect, it } from 'vitest'
import { createRestOutbox, REST_OUTBOX_STORAGE_KEY, type OutboxEntry, type RestOutboxSend } from './restOutbox'

function makeEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return { clientKey: 'a'.repeat(32), content: '你好', queuedAt: 1000, ...overrides }
}

function fakeSend(results: Map<string, 'ok' | 'fail'>, calls: OutboxEntry[]): RestOutboxSend {
  return async (_sessionId, entry) => {
    calls.push(entry)
    if (results.get(entry.clientKey) === 'fail') throw new Error('network down')
  }
}

describe('restOutbox（story 12 · REST 断线排队）', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('enqueue → 单 JSON blob 落盘（REST_OUTBOX_STORAGE_KEY，值 {v:1, sessions}）+ 32-hex clientKey', () => {
    const outbox = createRestOutbox()
    const entry = outbox.enqueue('sess-1', '第一条')
    expect(entry.content).toBe('第一条')
    expect(entry.clientKey).toMatch(/^[0-9a-f]{32}$/)
    const raw = JSON.parse(sessionStorage.getItem(REST_OUTBOX_STORAGE_KEY)!)
    expect(raw.version).toBe(1)
    expect(raw.sessions['sess-1']).toEqual([entry])
  })

  it('session 隔离 + pending 按入队序', () => {
    const outbox = createRestOutbox()
    const a1 = outbox.enqueue('sess-a', 'a1')
    const a2 = outbox.enqueue('sess-a', 'a2')
    outbox.enqueue('sess-b', 'b1')
    expect(outbox.pending('sess-a').map((e) => e.content)).toEqual(['a1', 'a2'])
    expect(outbox.pending('sess-b').map((e) => e.content)).toEqual(['b1'])
    expect(outbox.pending('sess-c')).toEqual([])
    expect(outbox.pending('sess-a')[0].clientKey).toBe(a1.clientKey)
    expect(outbox.pending('sess-a')[1].clientKey).toBe(a2.clientKey)
  })

  it('上限 50 丢最旧（第 51 条入队 → 最旧被挤出）', () => {
    const outbox = createRestOutbox()
    const first = outbox.enqueue('sess-1', '第 1 条')
    for (let i = 2; i <= 51; i++) outbox.enqueue('sess-1', `第 ${i} 条`)
    const pending = outbox.pending('sess-1')
    expect(pending).toHaveLength(50)
    expect(pending.some((e) => e.clientKey === first.clientKey)).toBe(false)
    expect(pending[0].content).toBe('第 2 条')
    expect(pending[49].content).toBe('第 51 条')
  })

  it('remove：按 clientKey 移除；清空后 blob 键删除', () => {
    const outbox = createRestOutbox()
    const a = outbox.enqueue('sess-1', 'a')
    const b = outbox.enqueue('sess-1', 'b')
    outbox.remove('sess-1', a.clientKey)
    expect(outbox.pending('sess-1').map((e) => e.clientKey)).toEqual([b.clientKey])
    outbox.remove('sess-1', b.clientKey)
    expect(outbox.pending('sess-1')).toEqual([])
    expect(sessionStorage.getItem(REST_OUTBOX_STORAGE_KEY)).toBeNull()
  })

  it('0 信任读回：坏 blob → 空（不抛）；坏行丢弃好行保留', () => {
    const outbox = createRestOutbox()
    sessionStorage.setItem(REST_OUTBOX_STORAGE_KEY, 'garbage{{{')
    expect(outbox.pending('sess-1')).toEqual([])
    sessionStorage.setItem(REST_OUTBOX_STORAGE_KEY, JSON.stringify({ version: 2, sessions: {} }))
    expect(outbox.pending('sess-1')).toEqual([])
    sessionStorage.setItem(
      REST_OUTBOX_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        sessions: {
          'sess-1': [
            { clientKey: 'b'.repeat(32), content: '好的', queuedAt: 1 },
            { content: '缺 key', queuedAt: 2 },
            { clientKey: 'short', content: 'key 非法', queuedAt: 3 },
            { clientKey: 'c'.repeat(32), content: '', queuedAt: 4 },
            { clientKey: 'd'.repeat(32), content: '时间非法' },
            'not-an-object',
            null,
          ],
        },
      }),
    )
    expect(outbox.pending('sess-1')).toEqual([{ clientKey: 'b'.repeat(32), content: '好的', queuedAt: 1 }])
  })

  it('flush 按序注入：逐条 send（原 clientKey 复用 = 服务端幂等 replay 面）、成功移除', async () => {
    const outbox = createRestOutbox()
    const e1 = outbox.enqueue('sess-1', '一')
    const e2 = outbox.enqueue('sess-1', '二')
    const calls: OutboxEntry[] = []
    const order: number[] = []
    let seq = 0
    const result = await outbox.flush('sess-1', async (_sid, entry) => {
      order.push(seq++)
      calls.push(entry)
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(result.sent).toBe(2)
    expect(order).toEqual([0, 1]) // 严格按序（await 完成后才发下一条）
    expect(calls.map((e) => e.clientKey)).toEqual([e1.clientKey, e2.clientKey])
    expect(calls.map((e) => e.content)).toEqual(['一', '二'])
    expect(outbox.pending('sess-1')).toEqual([])
  })

  it('flush 失败保序停止：失败条保留、后续条不再发（重连再 flush 续传）', async () => {
    const outbox = createRestOutbox()
    const e1 = outbox.enqueue('sess-1', '一')
    outbox.enqueue('sess-1', '二')
    outbox.enqueue('sess-1', '三')
    const calls: OutboxEntry[] = []
    const results = new Map<string, 'ok' | 'fail'>([[outbox.pending('sess-1')[1].clientKey, 'fail']])
    await expect(outbox.flush('sess-1', fakeSend(results, calls))).rejects.toThrow('network down')
    expect(calls.map((e) => e.content)).toEqual(['一', '二']) // 第三条未发（保序）
    const remaining = outbox.pending('sess-1')
    expect(remaining.map((e) => e.content)).toEqual(['二', '三'])
    expect(remaining[0].clientKey).not.toBe(e1.clientKey)

    // 重连再 flush：跳过已发的「一」（已移除），从「二」按序续传（同 clientKey → 服务端 replay）
    const calls2: OutboxEntry[] = []
    const r2 = await outbox.flush('sess-1', async (_sid, entry) => {
      calls2.push(entry)
    })
    expect(r2.sent).toBe(2)
    expect(calls2.map((e) => e.content)).toEqual(['二', '三'])
    expect(outbox.pending('sess-1')).toEqual([])
  })

  it('flush 空队列 → sent 0；多 session flush 只动本 session', async () => {
    const outbox = createRestOutbox()
    const r0 = await outbox.flush('sess-x', async () => {})
    expect(r0).toEqual({ sent: 0 })
    outbox.enqueue('sess-a', 'a')
    outbox.enqueue('sess-b', 'b')
    const calls: OutboxEntry[] = []
    await outbox.flush('sess-a', async (_sid, entry) => {
      calls.push(entry)
    })
    expect(calls.map((e) => e.content)).toEqual(['a'])
    expect(outbox.pending('sess-b').map((e) => e.content)).toEqual(['b'])
  })

  it('storage 降级（null storage）：enqueue/pending/remove/flush 不抛（尽力而为语义）', async () => {
    const outbox = createRestOutbox(null)
    const entry = outbox.enqueue('sess-1', '内存面')
    expect(entry.content).toBe('内存面')
    expect(outbox.pending('sess-1')).toEqual([])
    await expect(outbox.flush('sess-1', async () => {})).resolves.toEqual({ sent: 0 })
    expect(() => outbox.remove('sess-1', entry.clientKey)).not.toThrow()
  })

  it('enqueue 注入 idgen/now（测试确定性）', () => {
    const outbox = createRestOutbox()
    const entry = outbox.enqueue('sess-1', 'x', {
      idgen: () => 'f'.repeat(32),
      now: () => 42,
    })
    expect(entry).toEqual({ clientKey: 'f'.repeat(32), content: 'x', queuedAt: 42 })
    expect(makeEntry()).toEqual({ clientKey: 'a'.repeat(32), content: '你好', queuedAt: 1000 })
  })
})
