import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { bearer, login, seedUser } from './helpers'
import type { ChaoxingRemote } from '../src/chaoxing/remote'

const options = {
  clientId: 'test-client', clientSecret: 'test-secret',
  redirectUri: 'https://panel.example/api/v1/integrations/chaoxing/callback',
  credentialSecret: 'test-encryption-secret-at-least-32-chars',
}
let exchanges = 0
const remote: ChaoxingRemote = {
  async exchange() { exchanges++; return { access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'Bearer', expires_in: 3600 } },
  async refresh() { return { access_token: 'new-private-access', token_type: 'Bearer', expires_in: 3600 } },
  async inspect() { return { tools: [], capabilities: [] } },
  async learn() { return { resources: [], limitations: ['资料能力未配置'] } },
}

describe('超星绑定 REST 行为（生产附件路由同时挂载）', () => {
  const attachmentRoot = mkdtempSync(join(tmpdir(), 'chaoxing-callback-'))
  let ctx: TestContext
  let auth: Record<string, string>
  let other: Record<string, string>
  beforeAll(async () => {
    ctx = await setupTestApp({ chaoxing: { options, remote }, attachments: { service: {} as never, tmpRoot: attachmentRoot } })
    await seedUser(ctx.prisma, 'cx-student', 'student-password')
    await seedUser(ctx.prisma, 'cx-other', 'other-password')
    auth = bearer((await login(ctx.request, 'cx-student', 'student-password')).access)
    other = bearer((await login(ctx.request, 'cx-other', 'other-password')).access)
  })
  afterAll(async () => { await ctx?.cleanup(); rmSync(attachmentRoot, { recursive: true, force: true }) })

  it('本人绑定成功，其他用户未绑定，回调不可重放，接口不返回凭证', async () => {
    expect((await ctx.request.get('/api/v1/integrations/chaoxing')).body.code).toBe(10001)
    const start = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(auth).send({})
    expect(start.body.code).toBe(0)
    const url = new URL(start.body.data.url)
    expect(url.origin).toBe('https://api.chaoxing.com')
    expect(url.searchParams.get('redirect_uri')).toBe(options.redirectUri)
    expect(url.searchParams.get('client_secret')).toBeNull()
    const state = url.searchParams.get('state')!
    const noBrowser = await ctx.request.get('/api/v1/integrations/chaoxing/callback').query({ state, code: 'authorization-code' })
    expect(noBrowser.headers.location).toBe('/settings?chaoxing=failed')
    const callback = await ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${state}`).query({ state, code: 'authorization-code' })
    expect(callback.status).toBe(303)
    expect(callback.headers.location).toBe('/settings?chaoxing=connected')
    const status = await ctx.request.get('/api/v1/integrations/chaoxing').set(auth)
    expect(status.body.data.connected).toBe(true)
    expect(JSON.stringify(status.body)).not.toMatch(/private-access|private-refresh|test-secret/)
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(other)).body.data.connected).toBe(false)
    const replay = await ctx.request.get('/api/v1/integrations/chaoxing/callback').query({ state, code: 'authorization-code' })
    expect(replay.headers.location).toBe('/settings?chaoxing=failed')
    expect(exchanges).toBe(1)
  })
})

// API 行为验证：测试超星依赖可以替换，内部凭证、身份和数据库真实运行。
describe('超星数据访问与解绑', () => {
  let ctx: TestContext
  let auth: Record<string, string>
  let other: Record<string, string>
  let release: (() => void) | undefined
  let exchangeStarted: (() => void) | undefined
  let waitExchange = false
  let waitLearning = false
  let learningStarted: (() => void) | undefined
  let releaseLearning: (() => void) | undefined
  const calls: string[] = []
  const gateway: ChaoxingRemote = {
    ...remote,
    async exchange() {
      if (waitExchange) { exchangeStarted?.(); await new Promise<void>(resolve => { release = resolve }) }
      return { access_token: 'owner-token', token_type: 'Bearer', expires_in: 3600 }
    },
    async learn(token, topic, courseId) {
      if (waitLearning) { learningStarted?.(); await new Promise<void>(resolve => { releaseLearning = resolve }) }
      calls.push(`${token}:${topic}:${courseId ?? 'auto'}`)
      return { resources: [{ id: 'r1', name: '梯度下降课件', kind: 'resource', courseId: 'c1', courseName: '机器学习', url: 'https://mooc.chaoxing.com/resource/1', text: '学习率决定每次迭代的步长。' }], limitations: [] }
    },
  }
  async function start() {
    const r = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(auth).send({})
    return new URL(r.body.data.url).searchParams.get('state')!
  }
  beforeAll(async () => {
    ctx = await setupTestApp({ chaoxing: { options, remote: gateway } })
    await seedUser(ctx.prisma, 'cx-learning', 'student-password')
    await seedUser(ctx.prisma, 'cx-isolated', 'other-password')
    auth = bearer((await login(ctx.request, 'cx-learning', 'student-password')).access)
    other = bearer((await login(ctx.request, 'cx-isolated', 'other-password')).access)
  })
  afterAll(async () => ctx?.cleanup())
  it('无需选课可取回正文与来源；不接受覆写身份和创建参数', async () => {
    const initialState = await start()
    await ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${initialState}`).query({ state: initialState, code: 'ok' })
    const r = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度下降' })
    expect(r.body.code).toBe(0)
    expect(r.body.data.resources[0]).toMatchObject({ courseName: '机器学习', text: '学习率决定每次迭代的步长。' })
    expect(calls).toEqual(['owner-token:梯度下降:auto'])
    expect((await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(other).send({ topic: '梯度下降' })).body.code).not.toBe(0)
    expect((await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度下降', ownerId: 'victim', create: true })).body.code).toBe(90002)
    expect(calls).toHaveLength(1)
  })
  it('解绑后不返回在飞请求的课程数据', async () => {
    waitLearning = true
    const started = new Promise<void>(resolve => { learningStarted = resolve })
    const request = ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度' }).then(r => r)
    await started
    await ctx.request.delete('/api/v1/integrations/chaoxing').set(auth).send({})
    releaseLearning!()
    expect((await request).body.code).not.toBe(0)
    waitLearning = false
  })
  it('解绑阻止资料访问，回调在解绑后完成也不能恢复绑定', async () => {
    waitExchange = true
    const state = await start()
    const started = new Promise<void>(resolve => { exchangeStarted = resolve })
    const callback = ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${state}`).query({ state, code: 'late-code' }).then(r => r)
    await started
    expect((await ctx.request.delete('/api/v1/integrations/chaoxing').set(auth).send({})).body.code).toBe(0)
    release!()
    expect((await callback).headers.location).toBe('/settings?chaoxing=failed')
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(auth)).body.data.connected).toBe(false)
    expect((await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度下降' })).body.code).not.toBe(0)
  })
})

describe('超星令牌自动续期', () => {
  let ctx: TestContext
  let auth: Record<string, string>
  let refreshes = 0
  const accesses: string[] = []
  const gateway: ChaoxingRemote = {
    ...remote,
    async exchange() { return { access_token: 'old-access', refresh_token: 'refresh-private', token_type: 'Bearer', expires_in: 1 } },
    async refresh() { refreshes++; await new Promise(resolve => setTimeout(resolve, 20)); return { access_token: 'fresh-access', token_type: 'Bearer', expires_in: 3600 } },
    async learn(token) { accesses.push(token); return { resources: [], limitations: [] } },
  }
  beforeAll(async () => {
    ctx = await setupTestApp({ chaoxing: { options, remote: gateway } })
    await seedUser(ctx.prisma, 'refresh-student', 'student-password')
    auth = bearer((await login(ctx.request, 'refresh-student', 'student-password')).access)
    const start = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(auth).send({})
    const state = new URL(start.body.data.url).searchParams.get('state')
    await ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${state}`).query({ state, code: 'code' })
  })
  afterAll(async () => ctx?.cleanup())
  it('并发查询共用一次刷新，使用新令牌且不向前端暴露', async () => {
    const result = await Promise.all([1, 2].map(() => ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度' })))
    expect(result.map(r => r.body.code)).toEqual([0, 0])
    expect(refreshes).toBe(1)
    expect(accesses).toEqual(['fresh-access', 'fresh-access'])
    expect(JSON.stringify(result.map(r => r.body))).not.toContain('fresh-access')
  })
})

describe('重新授权与旧刷新隔离', () => {
  let ctx: TestContext
  let auth: Record<string, string>
  let exchanges = 0
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  const gateway: ChaoxingRemote = {
    ...remote,
    async exchange() { exchanges++; return exchanges === 1 ? { access_token: 'expiring', refresh_token: 'refresh-old', token_type: 'Bearer', expires_in: 1 } : { access_token: 'reauthorized', token_type: 'Bearer', expires_in: 3600 } },
    async refresh() { started?.(); await new Promise<void>(resolve => { release = resolve }); return { access_token: 'stale-refresh', token_type: 'Bearer', expires_in: 3600 } },
  }
  async function start() {
    const result = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(auth).send({})
    return new URL(result.body.data.url).searchParams.get('state')!
  }
  async function finish(state: string) {
    return ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${state}`).query({ state, code: 'code' })
  }
  beforeAll(async () => {
    ctx = await setupTestApp({ chaoxing: { options, remote: gateway } })
    await seedUser(ctx.prisma, 'reauth-student', 'student-password')
    auth = bearer((await login(ctx.request, 'reauth-student', 'student-password')).access)
    await finish(await start())
  })
  afterAll(async () => ctx?.cleanup())
  it('旧令牌刷新晚于新授权完成，不清除新绑定', async () => {
    const state = await start()
    const refreshing = new Promise<void>(resolve => { started = resolve })
    const query = ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度' }).then(r => r)
    await refreshing
    expect((await finish(state)).headers.location).toBe('/settings?chaoxing=connected')
    release!()
    await query
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(auth)).body.data.connected).toBe(true)
  })
})
