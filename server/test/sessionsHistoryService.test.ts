// #1077 · S1/S4：真实 SQLite + 公共业务口；不以 repository 替身测试权限。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { SessionHistoryService } from '../src/sessions/history/service'
import { SqliteHistoryReader, withHistoryReadConnection } from '../src/sessions/history/sqliteReader'
import type { HistoryAccessEvent } from '../src/sessions/history/model'
import { readFileSync } from 'node:fs'

describe('session_history（RF-T01）', () => {
  let app: TestContext
  let history: SessionHistoryService
  const context = { ownerId: 'history-owner', currentSessionId: 'current', role: 'leader' as const }

  beforeAll(async () => {
    app = await setupTestApp()
    await app.prisma.user.create({ data: { id: context.ownerId, username: 'history-owner', role: 'admin' } })
    await app.prisma.user.create({ data: { id: 'other', username: 'history-other' } })
    for (const [id, ownerId, extra] of [
      ['current', context.ownerId, {}], ['old', context.ownerId, {}],
      ['foreign', 'other', {}], ['hidden', context.ownerId, { archivedAt: new Date() }],
      ['teammate', context.ownerId, { isTeammate: true }],
    ] as const) {
      await app.prisma.session.create({ data: { id, ownerId, containerId: id, title: `方案 ${id}`, ...extra } })
      await app.prisma.sessionMessage.create({ data: { id: `${id}-msg`, sessionId: id, turn: 1, role: 'assistant', content: 'Alpha 研究 a.b',
        attachmentsJson: JSON.stringify({ v: 1, thinking: '独立推理', tools: [{ toolCallId: 'call-1', name: 'lookup', input: '工具输入', details: '工具结果', state: 'success', truncated: true }], media: [{ attachmentId: 'ref-1', fileName: 'paper.pdf', mime: 'application/pdf', size: 7 }] }),
      } })
    }
    await app.prisma.sessionMessage.create({ data: { id: 'archived-msg', sessionId: 'old', turn: 2, role: 'user', content: '被放弃路线', archivedAt: new Date() } })
    history = new SessionHistoryService(new SqliteHistoryReader(app.dbUrl.slice(5)))
  })
  afterAll(async () => { await app.cleanup() })

  it('C1/C10/P3/P4/M1：无 query 仅发现本人非当前、可见主会话目录', async () => {
    const result = await history.execute(context, { operation: 'search' })
    expect(result).toMatchObject({ outcome: 'success', progress: 'complete', groups: [{ session_id: 'old', title: '方案 old' }] })
    expect(JSON.stringify(result)).not.toContain('Alpha')
    expect(result.groups).toHaveLength(1)
  })

  it.each(['foreign', 'hidden', 'teammate', 'absent'])('P2/P3/P5：显式 %s 与不存在目标同形，admin 无越权', async id => {
    const result = await history.execute(context, { operation: 'read', targets: [{ session_id: id }] })
    expect(result).toMatchObject({ outcome: 'failure', progress: 'stopped', groups: [{ session_id: id, status: 'incomplete', error: { code: 'unreadable', message: '目标会话不可读取' } }] })
    expect(JSON.stringify(result)).not.toContain('Alpha')
  })
  it('P7：当前会话有专门提示，不能当历史读取', async () => {
    expect(await history.execute(context, { operation: 'read', targets: [{ session_id: 'current' }] }))
      .toMatchObject({ groups: [{ error: { code: 'current_session' } }] })
  })
  it('P1/M2/G4：手工误路由非 leader 被执行入口拒绝', async () => {
    expect(await history.execute({ ...context, role: 'subagent' }, { operation: 'search' }))
      .toMatchObject({ outcome: 'failure', error: { category: 'permission' } })
  })
  it('C2/C3/P6/P14/M4：读取保存的正文/thinking/工具及附件引用，排除归档消息', async () => {
    const result = await history.execute(context, { operation: 'read', targets: [{ session_id: 'old' }, { session_id: 'foreign' }] })
    expect(result.outcome).toBe('partial_success')
    expect(result.groups[0]?.messages).toEqual([expect.objectContaining({ session_id: 'old', message_id: 'old-msg', turn: 1, content: 'Alpha 研究 a.b', thinking: '独立推理', tools: [expect.objectContaining({ toolCallId: 'call-1', truncated: true })], media: [expect.objectContaining({ attachmentId: 'ref-1' })], source_truncated: true, missing: [] })])
    expect(JSON.stringify(result)).not.toContain('被放弃路线')
  })
  it('P17/M5：坏聚合保留正文，标明缺失且不当作空历史', async () => {
    await app.prisma.sessionMessage.create({ data: { id: 'bad-msg', sessionId: 'old', turn: 3, role: 'assistant', content: '可靠正文', attachmentsJson: '{bad' } })
    const result = await history.execute(context, { operation: 'read', targets: [{ session_id: 'old', range: { from_turn: 3 } }] })
    expect(result).toMatchObject({ progress: 'stopped', groups: [{ status: 'incomplete', messages: [{ message_id: 'bad-msg', content: '可靠正文', missing: ['aggregate'] }] }] })
    expect(JSON.stringify(result)).not.toContain('{bad')
    await app.prisma.sessionMessage.delete({ where: { id: 'bad-msg' } })
  })
  it.each([
    ['alpha', undefined, 'old-msg'], ['研究', undefined, 'old-msg'],
    ['a.b', undefined, 'old-msg'], ['lookup', undefined, 'old-msg'],
    ['工具输入', undefined, 'old-msg'], ['工具结果', undefined, 'old-msg'],
    ['独立推理', undefined, undefined], ['独立推理', ['thinking'], 'old-msg'],
    ['Alpha 研究 a.b工具输入', undefined, undefined], ['toolCallId', undefined, undefined],
  ])('C3/C6/C12：逐产品区域匹配 %s', async (text, fields, expected) => {
    const result = await history.execute(context, { operation: 'search', query: { text }, ...(fields ? { fields } : {}), context: { before: 0, after: 0 } })
    expect(result.groups.flatMap(g => g.messages ?? []).map(m => m.message_id)).toEqual(expected ? [expected] : [])
  })
  it('C4/C5：ID/标题/时间/关键词交集，消息时间与关键词须落在同一行', async () => {
    const result = await history.execute(context, { operation: 'search', session_ids: ['old'], title: '方案', time: { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' }, query: { text: 'Alpha' } })
    expect(result.groups[0]?.messages?.[0]?.message_id).toBe('old-msg')
    expect((await history.execute(context, { operation: 'search', title: '不匹配', query: { text: 'Alpha' } })).groups).toEqual([])
    expect((await history.execute(context, { operation: 'search', time: { field: 'session_created_at', to: '2000-01-01T00:00:00+08:00' } })).groups).toEqual([])
  })

  it('C6：regex 显式切换；大小写可选；普通标点没有正则含义', async () => {
    const query = async (text: string, mode = 'literal', case_sensitive = false) => (await history.execute(context, { operation: 'search', query: { text, mode }, case_sensitive })).count.value
    expect(await query('^Alpha.*a\\.b$', 'regex')).toBe(1)
    expect(await query('alpha', 'literal', true)).toBe(0)
    expect(await query('a.b')).toBe(1)
    expect(await query('a\\.b')).toBe(0)
    expect(await query('不存在')).toBe(0)
    expect(await history.execute(context, { operation: 'search', query: { text: '不存在' } })).toMatchObject({ outcome: 'success', progress: 'complete', groups: [] })
  })

  it('C2/C5：消息时间前闭后开，read 同会话不同范围各自保持，不串目标', async () => {
    await app.prisma.sessionMessage.update({ where: { id: 'old-msg' }, data: { createdAt: new Date('2026-01-02T00:00:00Z') } })
    const search = (from: string, to: string) => history.execute(context, { operation: 'search', query: { text: 'Alpha' }, time: { from, to } })
    expect((await search('2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z')).count.value).toBe(1)
    expect((await search('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).count.value).toBe(0)
    const read = await history.execute(context, { operation: 'read', targets: [{ session_id: 'old', range: { to_turn: 1 } }, { session_id: 'old', range: { from_turn: 3 } }] })
    expect(read.groups.map(g => g.messages?.map(m => m.message_id))).toEqual([['old-msg'], []])
  })

  it('C3/C12：长字段节选与源截断独立，匹配后 read 能按稳定引用读全保存文本', async () => {
    const content = '前'.repeat(500) + '关键定位' + '后'.repeat(500)
    await app.prisma.sessionMessage.create({ data: { id: 'long-msg', sessionId: 'old', turn: 7, role: 'assistant', content } })
    const found = await history.execute(context, { operation: 'search', query: { text: '关键定位' }, context: { before: 0, after: 0 } })
    expect(found.groups[0]?.messages?.[0]).toMatchObject({ message_id: 'long-msg', source_truncated: false, matches: [{ field: 'assistant_content', omitted_before: true, omitted_after: true }], excerpt: { omitted_before: true, omitted_after: true } })
    const read = await history.execute(context, { operation: 'read', targets: [{ session_id: 'old', range: { from_turn: 7 } }] })
    expect(read.groups[0]?.messages?.[0]?.content).toBe(content)
    await app.prisma.sessionMessage.delete({ where: { id: 'long-msg' } })
  })

  it('P17/M5：混合坏字段保留可靠工具片段，缺失调用标识不补造', async () => {
    await app.prisma.sessionMessage.create({ data: { id: 'partial-msg', sessionId: 'old', turn: 5, role: 'assistant', content: '保留', attachmentsJson: JSON.stringify({ v: 1, thinking: 42, tools: [{ name: 'lookup', input: '可靠输入', details: 17, internal: '不能外露' }, null], media: 'bad' }) } })
    const result = await history.execute(context, { operation: 'read', targets: [{ session_id: 'old', range: { from_turn: 5 } }] })
    expect(result.groups[0]?.messages?.[0]).toMatchObject({ content: '保留', tools: [{ name: 'lookup', input: '可靠输入' }], missing: expect.arrayContaining(['thinking', 'tools[0].details', 'tools[0].toolCallId', 'tools[1]', 'media']) })
    expect(JSON.stringify(result)).not.toContain('不能外露')
    await app.prisma.sessionMessage.delete({ where: { id: 'partial-msg' } })
  })

  it('P8/P9/P19：每次调用重新核实用户与可见性，权限无法核实拒绝交付', async () => {
    await app.prisma.session.update({ where: { id: 'old' }, data: { archivedAt: new Date() } })
    expect(await history.execute(context, { operation: 'read', targets: [{ session_id: 'old' }] })).toMatchObject({ outcome: 'failure', groups: [{ error: { code: 'unreadable' } }] })
    await app.prisma.session.update({ where: { id: 'old' }, data: { archivedAt: null } })
    await app.prisma.user.update({ where: { id: context.ownerId }, data: { isActive: false } })
    expect(await history.execute(context, { operation: 'search' })).toMatchObject({ outcome: 'failure', error: { category: 'system' }, groups: [] })
    await app.prisma.user.update({ where: { id: context.ownerId }, data: { isActive: true } })
  })

  it('P10：未知/篡改书签返回同形拒绝，不泄露目标', async () => {
    for (const cursor of ['tampered', 'other-user-cursor']) expect(await history.execute(context, { operation: 'search', cursor })).toMatchObject({ outcome: 'failure', error: { code: 'invalid_cursor', message: '书签无效或不适用于本次请求' }, groups: [] })
  })

  it('P15/P16：真实适配器故障及读取上限不冒充空历史，错误脱敏', async () => {
    const broken = new SessionHistoryService(new SqliteHistoryReader('/private/tmp/should-not-exist-history-secret.db'))
    const result = await broken.execute(context, { operation: 'search' })
    expect(result).toMatchObject({ outcome: 'failure', progress: 'stopped', error: { category: 'system' } })
    expect(JSON.stringify(result)).not.toMatch(/should-not-exist|SELECT|stack|SQLITE/)
    const bounded = new SessionHistoryService(new SqliteHistoryReader(app.dbUrl.slice(5)), { scanMessages: 0 })
    expect(await bounded.execute(context, { operation: 'read', targets: [{ session_id: 'old' }] })).toMatchObject({
      progress: 'stopped', groups: [{ status: 'reading' }], cursor: expect.any(String),
    })
    const small = new SessionHistoryService(new SqliteHistoryReader(app.dbUrl.slice(5)), { maxResponseBytes: 600 })
    expect(await small.execute(context, { operation: 'read', targets: [{ session_id: 'old' }] })).toMatchObject({ progress: 'stopped', error: { code: 'response_limit' } })
  })

  it('P18/P19：日志白名单无 query/正文/书签；日志失败告警且已授权读取继续', async () => {
    const events: HistoryAccessEvent[] = []
    const warnings: string[] = []
    const logged = new SessionHistoryService(new SqliteHistoryReader(app.dbUrl.slice(5)), { events: {
      record: event => { events.push(event); throw new Error('secret logger failure') },
      warn: text => { warnings.push(text) },
    } })
    expect(await logged.execute(context, { operation: 'search', query: { text: 'Alpha' } })).toMatchObject({ outcome: 'success' })
    expect(Object.keys(events[0]!).sort()).toEqual(['category', 'count', 'currentSessionId', 'durationMs', 'explicitTargets', 'operation', 'ownerId'])
    expect(JSON.stringify(events)).not.toContain('Alpha')
    expect(warnings).toEqual(['历史访问日志写入失败'])
  })

  it('M6：真实连接层拒绝写入；成功和异常路径均关闭连接', () => {
    const connection = withHistoryReadConnection(app.dbUrl.slice(5), db => {
      expect(() => db.prepare('DELETE FROM session_messages').run()).toThrow(/readonly/i)
      return db
    })
    expect(connection.open).toBe(false)
    let failedConnection = connection
    expect(() => withHistoryReadConnection(app.dbUrl.slice(5), db => { failedConnection = db; throw new Error('stop') })).toThrow('stop')
    expect(failedConnection.open).toBe(false)
  })

  it('M3：业务核心不导入数据库/REST/图/执行器，不调用投影或 checkpoint', () => {
    for (const file of ['model', 'service', 'evidence', 'matcher', 'params', 'regex', 'cursor']) {
      const source = readFileSync(`src/sessions/history/${file}.ts`, 'utf8')
      expect(source).not.toMatch(/from ['"].*(?:prisma|express|langgraph|better-sqlite3|worker_threads|sqliteReader)/i)
      expect(source).not.toMatch(/getProjection\(|checkpoint.*blob/i)
    }
  })

  it('C5：SQLite UTC 文本时间与 Prisma 毫秒时间同义，时间筛选不受宿主时区影响', async () => {
    const previousTZ = process.env.TZ
    process.env.TZ = 'Asia/Singapore'
    try {
      await app.prisma.$executeRaw`INSERT INTO sessions (id,ownerId,containerId,title,createdAt,updatedAt) VALUES ('utc-text',${context.ownerId},'utc-text','UTC文本','2026-01-01 00:00:00','2026-01-01 00:00:00')`
      await app.prisma.$executeRaw`INSERT INTO session_messages (id,sessionId,turn,role,content,createdAt) VALUES ('utc-msg','utc-text',1,'user','UTC证据','2026-01-02 00:00:00')`
      const found = await history.execute(context, { operation: 'search', query: { text: 'UTC证据' }, time: { from: '2026-01-02T00:00:00Z', to: '2026-01-03T00:00:00Z' } })
      expect(found.groups[0]?.messages?.[0]).toMatchObject({ message_id: 'utc-msg', created_at: '2026-01-02T00:00:00.000Z' })
      expect(found.groups[0]?.created_at).toBe('2026-01-01T00:00:00.000Z')
      await app.prisma.sessionMessage.update({ where: { id: 'old-msg' }, data: { createdAt: new Date('2026-01-03T00:00:00Z') } })
      const directory = await history.execute(context, { operation: 'search', session_ids: ['utc-text', 'old'] })
      expect(directory.groups.map(g => g.session_id)).toEqual(['old', 'utc-text'])
    } finally {
      if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ
      await app.prisma.session.deleteMany({ where: { id: 'utc-text' } })
    }
  })
})
