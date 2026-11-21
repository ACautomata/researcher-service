// #1078 · RF-T02 S1/S4：真实 SQLite + 公共业务口；分页、冻结版本、长消息分段与局部失效。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { SessionHistoryService, type SessionHistoryOptions } from '../src/sessions/history/service'
import { SqliteHistoryReader } from '../src/sessions/history/sqliteReader'
import type { HistoryContext, HistoryResult } from '../src/sessions/history/model'

type ReadRequest = { operation: 'read'; targets: { session_id: string; range?: { from_turn?: number; to_turn?: number } }[] }
type SearchRequest = { operation: 'search'; query?: { text: string; mode?: 'literal' | 'regex' }; fields?: ('user_content' | 'assistant_content' | 'tool_name' | 'tool_input' | 'tool_result' | 'thinking')[]; context?: { before?: number; after?: number }; title?: string; time?: { field?: 'message_created_at' | 'session_created_at'; from?: string; to?: string } }
type Request = ReadRequest | SearchRequest

describe('session_history（RF-T02）', () => {
  let app: TestContext
  const context: HistoryContext = { ownerId: 't02-owner', currentSessionId: 't02-current', role: 'leader' }

  const readerPath = () => app.dbUrl.slice(5)
  const service = (options: SessionHistoryOptions = {}) => new SessionHistoryService(new SqliteHistoryReader(readerPath()), options)

  async function pages(history: SessionHistoryService, request: Request, ctx: HistoryContext = context, limit = 30): Promise<HistoryResult[]> {
    const results: HistoryResult[] = []
    let next: Request & { cursor?: string } = request
    for (let i = 0; i < limit; i++) {
      const result = await history.execute(ctx, next)
      results.push(result)
      if (!result.cursor) break
      next = { ...request, cursor: result.cursor }
    }
    return results
  }

  beforeAll(async () => {
    app = await setupTestApp()
    await app.prisma.user.create({ data: { id: context.ownerId, username: 't02-owner', role: 'admin' } })
    await app.prisma.user.create({ data: { id: 't02-other', username: 't02-other' } })
    const session = (id: string, ownerId = context.ownerId, extra: Record<string, unknown> = {}) =>
      app.prisma.session.create({ data: { id, ownerId, containerId: id, title: id, ...extra } })
    const message = (sessionId: string, turn: number, role: string, content: string, attachmentsJson = '{"v":1}') =>
      app.prisma.sessionMessage.create({ data: { id: `${sessionId}-m${turn}`, sessionId, turn, role, content, attachmentsJson } })

    await session('t02-current')
    await session('t02-other-current', 't02-other')
    await session('t02-foreign', 't02-other')
    await app.prisma.sessionMessage.create({ data: { id: 't02-foreign-m1', sessionId: 't02-foreign', turn: 1, role: 'assistant', content: '他人秘密' } })

    await session('multi')
    for (let turn = 1; turn <= 12; turn++) {
      const role = turn % 2 ? 'user' : 'assistant'
      const content = turn === 2 ? '开场一' : turn === 3 ? '紧邻甲 关键重叠' : turn === 4 ? '关键重叠 紧邻乙'
        : turn === 5 ? '紧邻丙' : turn === 12 ? '条目十二' : `条目${turn}`
      const attachments = turn === 2
        ? JSON.stringify({ v: 1, thinking: '思考甲', tools: [{ toolCallId: 'tc-1', name: 'lookup', input: '输入甲', details: '结果甲', state: 'success', truncated: true }], media: [{ attachmentId: 'att-x', fileName: 'x.pdf', mime: 'application/pdf', size: 1 }] })
        : '{"v":1}'
      await message('multi', turn, role, content, attachments)
    }

    await session('gappy')
    for (const turn of [1, 2, 5, 9]) await message('gappy', turn, turn % 2 ? 'user' : 'assistant', `空洞${turn}`)

    await session('ctx-a')
    await message('ctx-a', 1, 'assistant', '开头命中')
    await session('ctx-b')
    await message('ctx-b', 1, 'assistant', '开头命中')

    await session('aggregate')
    await message('aggregate', 1, 'assistant', '普通正文', JSON.stringify({ v: 1, internal: '仅聚合关键词' }))

    await session('chinese')
    await message('chinese', 1, 'assistant', '实验方案讨论')
    await session('trad')
    await message('trad', 1, 'assistant', '實驗方案討論')

    await session('long')
    const longContent = '前'.repeat(7) + '跨段关键词' + '后'.repeat(200)
    await message('long', 1, 'assistant', longContent)

    await session('regexbig')
    await message('regexbig', 1, 'assistant', `${'甲'.repeat(100)}目标`)

    for (const id of ['freeze', 'change', 'archiveT', 'restart', 'budget']) {
      await session(id)
      for (let turn = 1; turn <= (id === 'budget' ? 12 : id === 'archiveT' ? 3 : id === 'restart' ? 3 : 6); turn++) {
        await message(id, turn, turn % 2 ? 'user' : 'assistant', `${id}-消息${turn}`)
      }
    }
  })
  afterAll(async () => { await app.cleanup() })

  it('C7/O12/O21/B8/B18：多目标 read 按目标顺序分页，覆盖完整且引用稳定', async () => {
    const history = service({ pageItems: 2 })
    const request: ReadRequest = { operation: 'read', targets: [{ session_id: 'multi' }, { session_id: 'gappy', range: { from_turn: 2, to_turn: 8 } }] }
    const results = await pages(history, request)
    expect(results.length).toBeGreaterThan(3)
    for (const result of results.slice(0, -1)) {
      expect(result.progress).toBe('more')
      expect(result.cursor).toEqual(expect.any(String))
    }
    expect(results.at(-1)).toMatchObject({ progress: 'complete', count: { unit: 'messages' } })
    expect(results.at(-1)?.cursor).toBeUndefined()
    for (const result of results) {
      expect(result.groups.map(g => g.session_id)).toEqual(['multi', 'gappy'])
      expect(result.count.unit).toBe('messages')
    }
    const delivered = results.flatMap(r => r.groups[0]?.messages?.map(m => m.message_id) ?? [])
    expect(delivered).toEqual(Array.from({ length: 12 }, (_, i) => `multi-m${i + 1}`))
    const ranged = results.flatMap(r => r.groups[1]?.messages?.map(m => m.message_id) ?? [])
    expect(ranged).toEqual(['gappy-m2', 'gappy-m5'])
    // O18：连续页有实际前进，不重复同一批消息。
    expect(results[1]?.groups[0]?.messages?.length).toBeGreaterThan(0)
    expect(results[0]?.groups[0]?.messages?.map(m => m.message_id)).not.toContain(results[1]?.groups[0]?.messages?.[0]?.message_id)
  })

  it('C7：turn 闭区间、单端、空范围与编号空洞', async () => {
    const history = service()
    const ids = async (range: NonNullable<ReadRequest['targets'][number]['range']>) =>
      (await history.execute(context, { operation: 'read', targets: [{ session_id: 'gappy', range }] })).groups[0]?.messages?.map(m => m.message_id)
    expect(await ids({ from_turn: 3 })).toEqual(['gappy-m5', 'gappy-m9'])
    expect(await ids({ to_turn: 2 })).toEqual(['gappy-m1', 'gappy-m2'])
    expect(await ids({ from_turn: 1, to_turn: 9 })).toEqual(['gappy-m1', 'gappy-m2', 'gappy-m5', 'gappy-m9'])
    const empty = await history.execute(context, { operation: 'read', targets: [{ session_id: 'gappy', range: { from_turn: 4, to_turn: 4 } }] })
    expect(empty).toMatchObject({ progress: 'complete', groups: [{ status: 'complete', messages: [] }] })
  })

  it('O13/B2：长消息分段连续重组，字面命中可跨段边界', async () => {
    const history = service({ pageItems: 4, segmentChars: 16, literalSegmentChars: 8 })
    const results = await pages(history, { operation: 'read', targets: [{ session_id: 'long' }] })
    const parts = results.flatMap(r => r.groups[0]?.messages ?? []).filter(m => m.message_id === 'long-m1' && m.segment?.region === 'content')
    expect(parts.length).toBeGreaterThan(5)
    const reassembled = parts.map(m => m.content).join('')
    expect(reassembled).toBe(`${'前'.repeat(7)}跨段关键词${'后'.repeat(200)}`)
    let offset = 0
    for (const part of parts) {
      expect(part.segment).toMatchObject({ start: offset })
      expect(part.segment!.end).toBeGreaterThan(part.segment!.start)
      offset = part.segment!.end
    }
    expect(offset).toBe(reassembled.length)
    expect(results.at(-1)?.progress).toBe('complete')

    const found = await service({ literalSegmentChars: 8 }).execute(context, { operation: 'search', query: { text: '跨段关键词' }, context: { before: 0, after: 0 } })
    expect(found.groups[0]?.messages?.[0]).toMatchObject({ message_id: 'long-m1', matches: [expect.objectContaining({ field: 'assistant_content' })] })
  })

  it('C8/O10：上下文重叠合并且不跨会话', async () => {
    const history = service()
    const result = await history.execute(context, { operation: 'search', query: { text: '关键重叠' }, context: { before: 1, after: 1 } })
    const group = result.groups.find(g => g.session_id === 'multi')!
    expect(group.messages?.map(m => m.message_id)).toEqual(['multi-m2', 'multi-m3', 'multi-m4', 'multi-m5'])
    expect(group.messages?.find(m => m.message_id === 'multi-m2')?.context_only).toBe(true)
    expect(group.messages?.find(m => m.message_id === 'multi-m3')?.context_only).toBe(false)
    expect(group.messages?.find(m => m.message_id === 'multi-m4')?.context_only).toBe(false)
    expect(group.messages?.find(m => m.message_id === 'multi-m5')?.context_only).toBe(true)

    const both = await history.execute(context, { operation: 'search', query: { text: '开头命中' }, context: { before: 1, after: 1 } })
    for (const g of both.groups) for (const m of g.messages ?? []) expect(m.session_id).toBe(g.session_id)
    expect(both.groups.flatMap(g => g.messages ?? [])).toHaveLength(2)
  })

  it('O1/O3/B10：空页仍有待扫描不报完成，进度与书签可续读', async () => {
    const history = service({ pageItems: 20, scanMessages: 4 })
    const first = await history.execute(context, { operation: 'search', query: { text: '条目十二' }, fields: ['assistant_content', 'user_content'], context: { before: 0, after: 0 } })
    expect(first.count.value).toBe(0)
    expect(first.progress).toBe('stopped')
    expect(first.cursor).toEqual(expect.any(String))
    expect(first.outcome).not.toBe('failure')
    const results = await pages(history, { operation: 'search', query: { text: '条目十二' }, fields: ['assistant_content', 'user_content'], context: { before: 0, after: 0 } })
    expect(results.at(-1)?.progress).toBe('complete')
    expect(results.at(-1)?.groups.flatMap(g => g.messages ?? []).map(m => m.message_id)).toContain('multi-m12')
  })

  it('O2/O12/O19/P11/P12：部分成功、失败目标贯穿续页且不泄露元数据', async () => {
    const history = service({ pageItems: 2 })
    const request: ReadRequest = { operation: 'read', targets: [{ session_id: 'multi' }, { session_id: 't02-foreign' }, { session_id: 'gappy' }] }
    const results = await pages(history, request)
    for (const result of results) {
      expect(result.groups.map(g => g.session_id)).toEqual(['multi', 't02-foreign', 'gappy'])
      const foreign = result.groups[1]!
      expect(foreign).toMatchObject({ status: 'incomplete', error: { code: 'unreadable', message: '目标会话不可读取' } })
      expect(foreign.title).toBeUndefined()
    }
    expect(results[0]?.outcome).toBe('partial_success')
    expect(results[0]?.groups[0]?.status).toBe('reading')
    expect(results[0]?.groups[2]?.status).toBe('pending')
    expect(results.at(-1)?.progress).toBe('stopped')
    expect(results.at(-1)?.cursor).toBeUndefined()
  })

  it('O15/M7：普通追加、标题与模型设置不推进版本，消息上界冻结', async () => {
    const history = service({ pageItems: 2 })
    const first = await history.execute(context, { operation: 'read', targets: [{ session_id: 'freeze' }] })
    expect(first.cursor).toEqual(expect.any(String))
    await app.prisma.sessionMessage.create({ data: { id: 'freeze-m7', sessionId: 'freeze', turn: 7, role: 'user', content: '追加消息' } })
    await app.prisma.session.update({ where: { id: 'freeze' }, data: { title: '改标题', preferredModelJson: JSON.stringify({ id: 'other' }) } })
    let next = { operation: 'read' as const, targets: [{ session_id: 'freeze' }], cursor: first.cursor! }
    const collected = (first.groups[0]?.messages?.map(m => m.message_id) ?? [])
    for (let i = 0; i < 10; i++) {
      const result = await history.execute(context, next)
      collected.push(...(result.groups[0]?.messages?.map(m => m.message_id) ?? []))
      if (!result.cursor) break
      next = { operation: 'read', targets: [{ session_id: 'freeze' }], cursor: result.cursor }
    }
    expect(collected).toEqual(['freeze-m1', 'freeze-m2', 'freeze-m3', 'freeze-m4', 'freeze-m5', 'freeze-m6'])
  })

  it('O16/M7/P12：旧内容变化使目标局部失效，其他目标继续', async () => {
    const history = service({ pageItems: 2 })
    const request: ReadRequest = { operation: 'read', targets: [{ session_id: 'change' }, { session_id: 'gappy' }] }
    const first = await history.execute(context, request)
    expect(first.cursor).toEqual(expect.any(String))
    await app.prisma.sessionMessage.update({ where: { id: 'change-m5' }, data: { content: '改过的旧内容' } })
    const second = await history.execute(context, { ...request, cursor: first.cursor! })
    expect(second.groups[0]).toMatchObject({ session_id: 'change', status: 'incomplete', title: 'change', error: { code: 'changed' } })
    expect(second.groups[0]?.messages ?? []).toEqual([])
    const remaining: string[] = []
    remaining.push(...(second.groups[1]?.messages?.map(m => m.message_id) ?? []))
    const base = { ...request, ...(second.cursor ? { cursor: second.cursor } : {}) }
    const rest = await pages(history, base)
    for (const r of rest) remaining.push(...(r.groups[1]?.messages?.map(m => m.message_id) ?? []), ...(r.groups[0]?.messages?.map(m => m.message_id) ?? []))
    expect(remaining).toContain('gappy-m1')
    expect(remaining).toContain('gappy-m2')
    expect(remaining).toContain('gappy-m5')
    expect(remaining).toContain('gappy-m9')
  })

  it('M7/P11/P12：归档目标局部失效且不泄露元数据，其他目标继续', async () => {
    const history = service({ pageItems: 2 })
    const request: ReadRequest = { operation: 'read', targets: [{ session_id: 'archiveT' }, { session_id: 'gappy' }] }
    const first = await history.execute(context, request)
    expect(first.cursor).toEqual(expect.any(String))
    await app.prisma.session.update({ where: { id: 'archiveT' }, data: { archivedAt: new Date() } })
    const second = await history.execute(context, { ...request, cursor: first.cursor! })
    expect(second.groups[0]).toMatchObject({ session_id: 'archiveT', status: 'incomplete', error: { code: 'unreadable' } })
    expect(second.groups[0]?.title).toBeUndefined()
    const ids = [...(second.groups[1]?.messages?.map(m => m.message_id) ?? [])]
    let cursor = second.cursor
    for (let i = 0; i < 10 && cursor; i++) {
      const next = await history.execute(context, { ...request, cursor })
      ids.push(...(next.groups[1]?.messages?.map(m => m.message_id) ?? []))
      cursor = next.cursor
    }
    expect(ids).toEqual(['gappy-m1', 'gappy-m2', 'gappy-m5', 'gappy-m9'])
  })

  it('O17/P9：续读中途失权拒绝交付', async () => {
    const history = service({ pageItems: 2 })
    const first = await history.execute(context, { operation: 'read', targets: [{ session_id: 'restart' }] })
    expect(first.cursor).toEqual(expect.any(String))
    await app.prisma.user.update({ where: { id: context.ownerId }, data: { isActive: false } })
    try {
      const denied = await history.execute(context, { operation: 'read', targets: [{ session_id: 'restart' }], cursor: first.cursor! })
      expect(denied).toMatchObject({ outcome: 'failure', progress: 'stopped', groups: [], error: { category: 'system' } })
    } finally {
      await app.prisma.user.update({ where: { id: context.ownerId }, data: { isActive: true } })
    }
  })

  it('O14/P10/B13：书签绑定身份、条件与绝对到期；重启失效', async () => {
    const history = service({ pageItems: 2, cursorTtlMs: 60_000 })
    const request: ReadRequest = { operation: 'read', targets: [{ session_id: 'restart' }] }
    const first = await history.execute(context, request)
    const cursor = first.cursor!
    const invalid = '书签无效或不适用于本次请求'
    expect(await history.execute(context, { operation: 'read', targets: [{ session_id: 'restart', range: { from_turn: 2 } }], cursor }))
      .toMatchObject({ outcome: 'failure', error: { code: 'invalid_cursor', message: invalid } })
    expect(await history.execute({ ...context, ownerId: 't02-other', currentSessionId: 't02-other-current' }, { ...request, cursor }))
      .toMatchObject({ error: { code: 'invalid_cursor', message: invalid } })
    expect(await history.execute(context, { ...request, cursor: `${cursor}x` })).toMatchObject({ error: { code: 'invalid_cursor', message: invalid } })
    const restarted = service({ pageItems: 2 })
    expect(await restarted.execute(context, { ...request, cursor })).toMatchObject({ error: { code: 'invalid_cursor', message: invalid } })
    let now = 100
    const clocked = service({ pageItems: 2, cursorTtlMs: 60_000, clock: () => now })
    const timed = await clocked.execute(context, request)
    now += 60_001
    expect(await clocked.execute(context, { ...request, cursor: timed.cursor! })).toMatchObject({ error: { code: 'invalid_cursor', message: invalid } })
  })

  it('B7/B9/B14：可注入目标上限、响应字节上限与书签容量', async () => {
    const tooMany = service({ maxTargets: 2 })
    expect(await tooMany.execute(context, { operation: 'read', targets: [{ session_id: 'multi' }, { session_id: 'gappy' }, { session_id: 'freeze' }] }))
      .toMatchObject({ outcome: 'failure', error: { code: 'too_many_targets' } })

    const limited = service({ maxResponseBytes: 2048 })
    const results = await pages(limited, { operation: 'read', targets: [{ session_id: 'budget' }] })
    for (const result of results) {
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(2048)
      expect(result).toMatchObject({ outcome: expect.any(String), progress: expect.any(String), count: { unit: 'messages' }, guidance: expect.any(String) })
    }
    const ids = results.flatMap(r => r.groups[0]?.messages?.map(m => m.message_id) ?? [])
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `budget-m${i + 1}`))
    expect(results.at(-1)?.progress).toBe('complete')

    const single = service({ pageItems: 1, maxCursorsPerUser: 1 })
    const held = await single.execute(context, { operation: 'read', targets: [{ session_id: 'multi' }] })
    expect(held.cursor).toEqual(expect.any(String))
    const second = await single.execute(context, { operation: 'read', targets: [{ session_id: 'freeze' }] })
    expect(second).toMatchObject({ progress: 'stopped', error: { category: 'limit', code: 'busy' } })
    expect(second.cursor).toBeUndefined()
    const continued = await single.execute(context, { operation: 'read', targets: [{ session_id: 'multi' }], cursor: held.cursor! })
    expect(continued.groups[0]?.messages?.length).toBeGreaterThan(0)
  })

  it('B16：正则单字段超限标未完成，不静默回退为无命中', async () => {
    const history = service({ regexFieldChars: 16 })
    const result = await history.execute(context, { operation: 'search', query: { text: '目标', mode: 'regex' }, context: { before: 0, after: 0 } })
    expect(result.groups.find(g => g.session_id === 'regexbig')).toMatchObject({ status: 'incomplete', error: { code: 'field_limit' } })
    expect(result.groups.flatMap(g => g.messages ?? [])).toEqual([])
    expect(result.outcome).toBe('failure')
  })

  it('B1/B3：只匹配产品字段，中文短词可查且不做近义/繁体扩展', async () => {
    expect(await service().execute(context, { operation: 'search', query: { text: '仅聚合关键词' } }))
      .toMatchObject({ outcome: 'success', progress: 'complete', groups: [] })
    expect((await service().execute(context, { operation: 'search', query: { text: '实验' } })).count.value).toBe(1)
    expect((await service().execute(context, { operation: 'search', query: { text: '實驗' } })).count.value).toBe(1)
    expect((await service().execute(context, { operation: 'search', query: { text: '方案研究' } })).count.value).toBe(0)
  })

  it('O6/O7/O8/O9/O11/O20：证据结构与节选/源截断/分段标识互不掩盖', async () => {
    const read = await service().execute(context, { operation: 'read', targets: [{ session_id: 'multi', range: { from_turn: 2, to_turn: 3 } }] })
    expect(read.groups[0]?.messages).toEqual([
      expect.objectContaining({ message_id: 'multi-m2', content: '开场一', thinking: '思考甲', source_truncated: true, missing: [],
        tools: [expect.objectContaining({ toolCallId: 'tc-1', name: 'lookup', truncated: true })], media: [expect.objectContaining({ attachmentId: 'att-x' })] }),
      expect.objectContaining({ message_id: 'multi-m3', content: '紧邻甲 关键重叠' }),
    ])
    const hit = await service().execute(context, { operation: 'search', query: { text: '结果甲' }, context: { before: 0, after: 0 } })
    const evidence = hit.groups[0]?.messages?.[0]
    expect(evidence?.matches?.[0]).toMatchObject({ field: 'tool_result', toolCallId: 'tc-1', name: 'lookup' })
    expect(evidence?.matches?.[0]?.start).toBeGreaterThanOrEqual(0)
    expect(read.groups[0]?.messages?.map(m => m.turn)).toEqual([2, 3])
  })
})
