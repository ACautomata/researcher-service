import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, firstFrameOf, frameOfEvent, findSetCookie, requireSetCookieValue } from './helpers'
import { StreamHub } from '../src/events/hub'

// 接缝 S1（信封级集成，issue #773）：GET /api/v1/events SSE 端点。
// 帧格式准据 = #726：id:=serverSeq / event:=type / data:={type,sessionId?,runId?,payload}；
// 连接级认证失败走 HTTP 401 不入事件（#726 钉死）；首帧 stream.opened{protocolV,serverSeq,serverTime}。

interface RawStream {
  res: Response
  reader: ReadableStreamDefaultReader<Uint8Array>
  abort: () => void
}

async function openStream(port: number, cookie?: string, lastEventId?: string): Promise<RawStream> {
  const headers: Record<string, string> = {}
  if (cookie !== undefined) headers['Cookie'] = cookie
  if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId
  const ctrl = new AbortController()
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
    headers,
    signal: ctrl.signal,
  })
  if (!res.ok || !res.body) return { res, reader: null as never, abort: () => ctrl.abort() }
  return { res, reader: res.body.getReader(), abort: () => ctrl.abort() }
}

// 读到累加文本满足谓词为止；超时/断流抛错（测试不自旋）。
async function readUntil(s: RawStream, pred: (acc: string) => boolean, timeoutMs = 3000): Promise<string> {
  const decoder = new TextDecoder()
  let acc = ''
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remain = deadline - Date.now()
    if (remain <= 0) throw new Error(`readUntil 超时，已收：${JSON.stringify(acc)}`)
    const { done, value } = await Promise.race([
      s.reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('read timeout')), remain)),
    ])
    if (done) throw new Error(`流提前结束，已收：${JSON.stringify(acc)}`)
    acc += decoder.decode(value, { stream: true })
    if (pred(acc)) return acc
  }
}

describe('GET /api/v1/events（SSE 端点，#773）', () => {
  let ctx: TestContext
  let hub: StreamHub
  let server: Server
  let port: number
  let cookie: string
  let access: string
  beforeAll(async () => {
    hub = new StreamHub()
    ctx = await setupTestApp({ events: { hub, heartbeatMs: 50 } }) // 短心跳：毫秒级验证 20s 语义
    await seedAdmin(ctx.prisma)
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    cookie = requireSetCookieValue(res.setCookie, 'panel_stream')
    access = res.access!
    server = createServer(ctx.app)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    server.close()
    await ctx.cleanup()
  })

  it('认证边界：无 cookie → HTTP 401 + 信封 10001（连接级失败不入事件，#726）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toMatchObject({ code: 10001, data: null })
  })

  it('认证边界：坏 cookie / 仅 Bearer（无 cookie）→ 401（流只认 cookie 通道）', async () => {
    const bad = await openStream(port, 'panel_stream=garbage-token')
    expect(bad.res.status).toBe(401)
    const bearerOnly = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
      headers: { Authorization: `Bearer ${access}` },
    })
    expect(bearerOnly.status).toBe(401)
  })

  it('REST Bearer 不受影响：/me 走 Bearer 正常 200（写面零改动，#726）', async () => {
    const res = await ctx.request.get('/api/v1/auth/me').set('Authorization', `Bearer ${access}`)
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.username).toBe('admin1')
  })

  it('建流：200 + text/event-stream + X-Accel-Buffering: no（#747 C 节防代理攒帧）', async () => {
    const s = await openStream(port, cookie)
    expect(s.res.status).toBe(200)
    expect(s.res.headers.get('content-type')).toContain('text/event-stream')
    expect(s.res.headers.get('x-accel-buffering')).toBe('no')
    s.abort()
  })

  it('首帧 stream.opened：id=event 行 + data 含 protocolV/serverSeq/serverTime（连接域骨架，#747 C 节）', async () => {
    const s = await openStream(port, cookie)
    const acc = await readUntil(s, (a) => a.includes('stream.opened'))
    const frame = firstFrameOf(acc)
    expect(frame.event).toBe('stream.opened')
    expect(Number(frame.id)).toBeGreaterThanOrEqual(0)
    expect(frame.data).toMatchObject({
      type: 'stream.opened',
      payload: { protocolV: 1 },
    })
    const p = frame.data.payload as { serverSeq: number; serverTime: string }
    expect(p.serverSeq).toBe(Number(frame.id)) // serverSeq = 建流时刻高水位（gap 检测游标）
    expect(Number.isNaN(Date.parse(p.serverTime))).toBe(false) // ISO8601
    s.abort()
  })

  it('心跳：:ping 注释帧按注入间隔到达（生产 20s，#747 C 节锁）', async () => {
    const s = await openStream(port, cookie)
    await readUntil(s, (a) => a.includes('stream.opened'))
    const acc = await readUntil(s, (a) => a.split('\n\n').filter((b) => b.startsWith(':ping')).length >= 2, 2000)
    expect(acc).toContain(':ping')
    s.abort()
  })

  it('用户被吊销 → session.terminated{reason:revoked} + 关连接（#726 带内信号）', async () => {
    const s = await openStream(port, cookie)
    await readUntil(s, (a) => a.includes('stream.opened'))
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    try {
      await ctx.prisma.user.update({ where: { id: admin!.id }, data: { isActive: false } })
      const acc = await readUntil(s, (a) => a.includes('session.terminated'), 3000)
      const frame = frameOfEvent(acc, 'session.terminated')
      expect(frame.data).toMatchObject({ type: 'session.terminated', payload: { reason: 'revoked' } })
      // 关连接：终止帧之后流结束
      const { done } = await s.reader.read()
      expect(done).toBe(true)
    } finally {
      await ctx.prisma.user.update({ where: { id: admin!.id }, data: { isActive: true } })
    }
  })

  it('logout → session.terminated{reason:logout} + 关连接（#726：logout 清除流通道）', async () => {
    const s = await openStream(port, cookie)
    await readUntil(s, (a) => a.includes('stream.opened'))
    await ctx.request.post('/api/v1/auth/logout').set('Authorization', `Bearer ${access}`)
    const acc = await readUntil(s, (a) => a.includes('session.terminated'), 3000)
    const frame = frameOfEvent(acc, 'session.terminated')
    expect(frame.data).toMatchObject({ type: 'session.terminated', payload: { reason: 'logout' } })
    const { done } = await s.reader.read()
    expect(done).toBe(true)
  })

  it('改密（强制重登语义）→ session.terminated{reason:logout} + 关连接 + Set-Cookie 清 panel_stream（#773）', async () => {
    const s = await openStream(port, cookie)
    await readUntil(s, (a) => a.includes('stream.opened'))
    const res = await ctx.request
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${access}`)
      .send({ oldPassword: 'pw-admin1-secure', newPassword: 'pw-admin1-rotated' })
    expect(res.body.code).toBe(0)
    const cleared = findSetCookie(res.headers['set-cookie'] as unknown as string[], 'panel_stream')
    expect(cleared, '改密应清 panel_stream').toBeTruthy()
    expect(cleared!.toLowerCase()).toContain('expires=thu, 01 jan 1970')
    const acc = await readUntil(s, (a) => a.includes('session.terminated'), 3000)
    const frame = frameOfEvent(acc, 'session.terminated')
    expect(frame.data).toMatchObject({ type: 'session.terminated', payload: { reason: 'logout' } })
    const { done } = await s.reader.read()
    expect(done).toBe(true)
    // 后续用例还需旧密码登录：改回（不挂流，无副作用面）
    const back = await ctx.request
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${access}`)
      .send({ oldPassword: 'pw-admin1-rotated', newPassword: 'pw-admin1-secure' })
    expect(back.body.code).toBe(0)
  })

  it('admin 重置密码 → 目标 user 的流收 session.terminated{reason:logout} + 关连接（#773 强制重登边界）', async () => {
    await seedUser(ctx.prisma, 'victim1', 'pw-victim1-secure')
    const victimLogin = await login(ctx.request, 'victim1', 'pw-victim1-secure')
    const victimCookie = requireSetCookieValue(victimLogin.setCookie, 'panel_stream')
    const s = await openStream(port, victimCookie)
    await readUntil(s, (a) => a.includes('stream.opened'))
    const victim = await ctx.prisma.user.findUnique({ where: { username: 'victim1' } })
    const res = await ctx.request
      .post(`/api/v1/users/${victim!.id}/reset-password`)
      .set('Authorization', `Bearer ${access}`)
    expect(res.body.code).toBe(0)
    const acc = await readUntil(s, (a) => a.includes('session.terminated'), 3000)
    const frame = frameOfEvent(acc, 'session.terminated')
    expect(frame.data).toMatchObject({ type: 'session.terminated', payload: { reason: 'logout' } })
    const { done } = await s.reader.read()
    expect(done).toBe(true)
  })

  it('事件扇出：publish 经 hub 按 user 送达流内，id 单调递增（多端广播）', async () => {
    const s1 = await openStream(port, cookie)
    const s2 = await openStream(port, cookie)
    await readUntil(s1, (a) => a.includes('stream.opened'))
    await readUntil(s2, (a) => a.includes('stream.opened'))
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    hub.publish(admin!.id, { type: 'text.delta', sessionId: 'sess-1', runId: 'run-1', payload: { delta: 'hi' } })
    const acc1 = await readUntil(s1, (a) => a.includes('text.delta'), 2000)
    const acc2 = await readUntil(s2, (a) => a.includes('text.delta'), 2000)
    const f1 = frameOfEvent(acc1, 'text.delta')
    const f2 = frameOfEvent(acc2, 'text.delta')
    expect(f1.id).toBe(f2.id) // 多端同 seq
    expect(f1.data).toMatchObject({ type: 'text.delta', sessionId: 'sess-1', runId: 'run-1', payload: { delta: 'hi' } })
    s1.abort()
    s2.abort()
  })

  it('gap 检测不重放（#726）：断线期间事件即焚，重连只收 stream.opened 且 serverSeq 揭示 gap', async () => {
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    // 建流 → 收两帧（id 1、2）→ 断开
    const s1 = await openStream(port, cookie)
    const acc1 = await readUntil(s1, (a) => a.includes('stream.opened'))
    const opened1 = firstFrameOf(acc1)
    hub.publish(admin!.id, { type: 'text.delta', payload: { delta: 'a' } })
    hub.publish(admin!.id, { type: 'text.delta', payload: { delta: 'b' } })
    const got2 = await readUntil(s1, (a) => (a.match(/event: text.delta/g) ?? []).length >= 2, 2000)
    const lastId = frameOfEvent(got2, 'text.delta').id // Last-Event-ID = 2
    expect(Number(lastId)).toBeGreaterThan(Number(opened1.id))
    s1.abort()

    // 断线期间再发两帧（即焚不落盘）
    hub.publish(admin!.id, { type: 'text.delta', payload: { delta: 'missed-1' } })
    hub.publish(admin!.id, { type: 'text.delta', payload: { delta: 'missed-2' } })

    // 重连带 Last-Event-ID：首帧 stream.opened，serverSeq=4 > lastSeen=2 → gap 可见
    const s2 = await openStream(port, cookie, lastId)
    const acc2 = await readUntil(s2, (a) => a.includes('stream.opened'))
    const opened2 = firstFrameOf(acc2)
    const p2 = opened2.data.payload as { serverSeq: number }
    expect(p2.serverSeq).toBeGreaterThan(Number(lastId)) // gap 揭示（客户端据此重拉投影）
    // 不重放：等到心跳帧，期间错过的 text.delta 绝不出现（无缓冲可重放，#726）
    const afterPing = await readUntil(s2, (a) => a.includes(':ping'), 2000)
    expect(afterPing).not.toContain('text.delta')
    s2.abort()
  })

  it('gap 检测不重放：断线零事件 → serverSeq 与 lastSeen 齐平（contiguous）', async () => {
    const s1 = await openStream(port, cookie)
    const acc1 = await readUntil(s1, (a) => a.includes('stream.opened'))
    const opened1 = firstFrameOf(acc1)
    s1.abort()
    // 零发布重连
    const s2 = await openStream(port, cookie, opened1.id)
    const acc2 = await readUntil(s2, (a) => a.includes('stream.opened'))
    const opened2 = firstFrameOf(acc2)
    expect((opened2.data.payload as { serverSeq: number }).serverSeq).toBe(Number(opened1.id))
    s2.abort()
  })

  it('连接域 error 事件帧形状（#747 C 节骨架三事件：stream.opened / session.terminated / error）', async () => {
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    const s = await openStream(port, cookie)
    await readUntil(s, (a) => a.includes('stream.opened'))
    hub.publish(admin!.id, { type: 'error', payload: { code: 50002, message: 'session_not_found' } })
    const acc = await readUntil(s, (a) => a.includes('event: error'), 2000)
    const frame = frameOfEvent(acc, 'error')
    expect(frame.data).toEqual({ type: 'error', payload: { code: 50002, message: 'session_not_found' } })
    s.abort()
  })
})
