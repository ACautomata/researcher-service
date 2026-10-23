import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { bearer, login, seedUser } from './helpers'
import { ChaoxingMcpError, type ChaoxingRemote } from '../src/chaoxing/remote'

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

// #1008：真实学生授权前的平台侧可复核边界。外部 OAuth/MCP 由受控替身替代，
// 授权事务、回调归属、令牌持久化与用户隔离走真实临时 SQLite。
describe('授权参数、拒绝与异常 state（#1008）', () => {
  let ctx: TestContext
  let auth: Record<string, string>
  let exchanges = 0
  const gateway: ChaoxingRemote = {
    ...remote,
    async exchange() { exchanges++; return { access_token: 'should-not-be-issued', token_type: 'Bearer', expires_in: 3600 } },
  }
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  async function begin(user = auth) {
    const response = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(user).send({})
    expect(response.body.code).toBe(0)
    const url = new URL(response.body.data.url)
    return { url, state: url.searchParams.get('state')!, response }
  }
  const call = (cookieState: string, state: string, extra: Record<string, string> = {}) =>
    ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${cookieState}`).query({ state, ...extra })
  const finish = (state: string, extra: Record<string, string> = {}) => call(state, state, extra)
  beforeAll(async () => {
    ctx = await setupTestApp({ chaoxing: { options, remote: gateway } })
    await seedUser(ctx.prisma, 'cx-state', 'student-password')
    auth = bearer((await login(ctx.request, 'cx-state', 'student-password')).access)
  })
  afterAll(async () => ctx?.cleanup())

  it('授权地址只携带已确认参数和 scope，state cookie 同浏览器限时', async () => {
    const { url, state, response } = await begin()
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(options.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe(options.redirectUri)
    expect(url.searchParams.get('scope')).toBe('mooc:resource mooc:qbank')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('client_secret')).toBeNull()
    expect(url.searchParams.get('access_token')).toBeNull()
    const setCookie = response.headers['set-cookie'] as unknown as string[] | undefined
    const cookie = setCookie?.find(value => value.startsWith('chaoxing_oauth=')) ?? ''
    expect(cookie).toContain(`chaoxing_oauth=${state}`)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toContain('Path=/api/v1/integrations/chaoxing')
    expect(cookie).toMatch(/Max-Age=600/i)
    expect(cookie).toMatch(/Secure/i)
  })

  it('拒绝授权、伪造 state 与过期 state 都不建立绑定', async () => {
    const denied = await begin()
    const deny = await finish(denied.state, { error: 'access_denied' })
    expect(deny.status).toBe(303)
    expect(deny.headers.location).toBe('/settings?chaoxing=failed')
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(auth)).body.data.connected).toBe(false)
    expect((await finish(denied.state, { code: 'denied-code' })).headers.location).toBe('/settings?chaoxing=failed')

    const bogus = 'x'.repeat(43)
    expect((await finish(bogus, { code: 'code' })).headers.location).toBe('/settings?chaoxing=failed')

    const expired = await begin()
    await ctx.prisma.chaoxingAuthorization.update({ where: { stateHash: hash(expired.state) }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await finish(expired.state, { code: 'expired-code' })).headers.location).toBe('/settings?chaoxing=failed')
    expect(await ctx.prisma.chaoxingAuthorization.count({ where: { stateHash: hash(expired.state) } })).toBe(0)
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(auth)).body.data.connected).toBe(false)
    expect(exchanges).toBe(0)
  })

  it('回调只绑定发起 state 的用户，其他平台用户的 cookie 不能完成授权', async () => {
    await seedUser(ctx.prisma, 'cx-state-other', 'other-password')
    const otherAuth = bearer((await login(ctx.request, 'cx-state-other', 'other-password')).access)
    const owner = await begin()
    const other = await begin(otherAuth)

    expect((await call(other.state, owner.state, { code: 'code' })).headers.location).toBe('/settings?chaoxing=failed')
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(auth)).body.data.connected).toBe(false)
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(otherAuth)).body.data.connected).toBe(false)

    expect((await finish(owner.state, { code: 'code' })).headers.location).toBe('/settings?chaoxing=connected')
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(auth)).body.data.connected).toBe(true)
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(otherAuth)).body.data.connected).toBe(false)
  })

  it('用户在授权进行中被禁用后，回调不能建立绑定', async () => {
    const user = await seedUser(ctx.prisma, 'cx-state-disabled', 'student-password')
    const userAuth = bearer((await login(ctx.request, 'cx-state-disabled', 'student-password')).access)
    const pending = await begin(userAuth)
    await ctx.prisma.user.update({ where: { id: user.id }, data: { isActive: false } })
    expect((await finish(pending.state, { code: 'code' })).headers.location).toBe('/settings?chaoxing=failed')
    expect((await ctx.prisma.chaoxingBinding.findUnique({ where: { ownerId: user.id } }))?.tokenCipher ?? null).toBeNull()
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(userAuth)).body.code).toBe(10001)
  })
})

describe('双用户绑定、禁用与解绑隔离（#1008）', () => {
  let ctx: TestContext
  let aAuth: Record<string, string>
  let bAuth: Record<string, string>
  let aId = ''
  let bId = ''
  let exchanges = 0
  const calls: string[] = []
  const gateway: ChaoxingRemote = {
    ...remote,
    async exchange(code) {
      exchanges++
      return { access_token: `access-${code}`, refresh_token: `refresh-${code}`, token_type: 'Bearer', expires_in: 3600 }
    },
    async learn(token, topic) {
      calls.push(`${token}:${topic}`)
      return { resources: [], limitations: [] }
    },
  }
  async function bind(user: Record<string, string>, code: string) {
    const start = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(user).send({})
    const state = new URL(start.body.data.url).searchParams.get('state')!
    const callback = await ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${state}`).query({ state, code })
    expect(callback.headers.location).toBe('/settings?chaoxing=connected')
  }
  beforeAll(async () => {
    ctx = await setupTestApp({ chaoxing: { options, remote: gateway } })
    aId = (await seedUser(ctx.prisma, 'cx-iso-a', 'a-password')).id
    bId = (await seedUser(ctx.prisma, 'cx-iso-b', 'b-password')).id
    aAuth = bearer((await login(ctx.request, 'cx-iso-a', 'a-password')).access)
    bAuth = bearer((await login(ctx.request, 'cx-iso-b', 'b-password')).access)
    await bind(aAuth, 'a')
    await bind(bAuth, 'b')
  })
  afterAll(async () => ctx?.cleanup())

  it('两个用户各自使用自己的令牌，解绑一个不影响另一个', async () => {
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(aAuth)).body.data.connected).toBe(true)
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(bAuth)).body.data.connected).toBe(true)
    const aRun = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(aAuth).send({ topic: 'a-topic' })
    const bRun = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(bAuth).send({ topic: 'b-topic' })
    expect([aRun.body.code, bRun.body.code]).toEqual([0, 0])
    expect(calls).toEqual(['access-a:a-topic', 'access-b:b-topic'])
    expect(JSON.stringify([aRun.body, bRun.body])).not.toMatch(/access-[ab]|refresh-[ab]/)

    const session = await ctx.prisma.session.create({ data: { ownerId: aId, containerId: 'test-container', learningCourseId: 'course-a' } })
    expect((await ctx.request.delete('/api/v1/integrations/chaoxing').set(aAuth).send({})).body.code).toBe(0)
    expect(exchanges).toBe(2)
    expect((await ctx.prisma.session.findUniqueOrThrow({ where: { id: session.id } })).learningCourseId).toBeNull()
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(aAuth)).body.data.connected).toBe(false)
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(bAuth)).body.data.connected).toBe(true)
    expect((await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(aAuth).send({ topic: 'a-after-unlink' })).body.code).toBe(90003)
    expect((await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(bAuth).send({ topic: 'b-after-unlink' })).body.code).toBe(0)
    expect(calls).toEqual(['access-a:a-topic', 'access-b:b-topic', 'access-b:b-after-unlink'])
  })

  it('绑定后禁用用户立即停止访问，其他用户不受影响', async () => {
    await ctx.prisma.user.update({ where: { id: bId }, data: { isActive: false } })
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(bAuth)).body.code).toBe(10001)
    expect((await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(bAuth).send({ topic: 'b-disabled' })).body.code).toBe(10001)
    expect(calls).toEqual(['access-a:a-topic', 'access-b:b-topic', 'access-b:b-after-unlink'])
    expect((await ctx.prisma.chaoxingBinding.findUniqueOrThrow({ where: { ownerId: bId } })).tokenCipher).not.toBeNull()
  })
})

describe('刷新失败与远端 401 的重新绑定引导（#1008）', () => {
  let ctx: TestContext
  let auth: Record<string, string>
  let refreshes = 0
  const gateway: ChaoxingRemote = {
    ...remote,
    async exchange() { return { access_token: 'expiring-access', refresh_token: 'refresh-private', token_type: 'Bearer', expires_in: 1 } },
    async refresh() { refreshes++; throw new Error('refresh unavailable') },
    async learn() { throw new Error('learn must not run after failed refresh') },
  }
  beforeAll(async () => {
    ctx = await setupTestApp({ chaoxing: { options, remote: gateway } })
    await seedUser(ctx.prisma, 'cx-refresh-fail', 'student-password')
    auth = bearer((await login(ctx.request, 'cx-refresh-fail', 'student-password')).access)
    const start = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(auth).send({})
    const state = new URL(start.body.data.url).searchParams.get('state')
    await ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${state}`).query({ state, code: 'code' })
  })
  afterAll(async () => ctx?.cleanup())

  it('刷新失败清除本地绑定并要求重新绑定，不泄露上游错误', async () => {
    const first = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度' })
    expect(first.body.code).toBe(90003)
    expect(first.body.message).toContain('重新绑定')
    expect(JSON.stringify(first.body)).not.toMatch(/refresh unavailable|expiring-access|refresh-private/)
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(auth)).body.data.connected).toBe(false)
    expect((await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度' })).body.code).toBe(90003)
    expect(refreshes).toBe(1)
  })
})

describe('远端 401 清理绑定并可重新授权恢复（#1008）', () => {
  let ctx: TestContext
  let auth: Record<string, string>
  let exchanges = 0
  let attempts = 0
  const gateway: ChaoxingRemote = {
    ...remote,
    async exchange() {
      exchanges++
      return exchanges === 1
        ? { access_token: 'revoked-access', token_type: 'Bearer', expires_in: 3600 }
        : { access_token: 'renewed-access', token_type: 'Bearer', expires_in: 3600 }
    },
    async learn(token) {
      attempts++
      if (token === 'revoked-access') throw new ChaoxingMcpError('tools/call', 401)
      return { resources: [], limitations: [] }
    },
  }
  async function authorize(user: Record<string, string>) {
    const start = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(user).send({})
    const state = new URL(start.body.data.url).searchParams.get('state')!
    return ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${state}`).query({ state, code: 'code' })
  }
  beforeAll(async () => {
    ctx = await setupTestApp({ chaoxing: { options, remote: gateway } })
    await seedUser(ctx.prisma, 'cx-revoked', 'student-password')
    auth = bearer((await login(ctx.request, 'cx-revoked', 'student-password')).access)
    expect((await authorize(auth)).headers.location).toBe('/settings?chaoxing=connected')
  })
  afterAll(async () => ctx?.cleanup())

  it('远端 401 停止访问并清除绑定，重新绑定后恢复', async () => {
    const rejected = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度' })
    expect(rejected.body.code).toBe(90003)
    expect(rejected.body.data?.httpStatus).toEqual(['401'])
    expect((await ctx.request.get('/api/v1/integrations/chaoxing').set(auth)).body.data.connected).toBe(false)

    expect((await authorize(auth)).headers.location).toBe('/settings?chaoxing=connected')
    const recovered = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度' })
    expect(recovered.body.code).toBe(0)
    expect(attempts).toBe(2)
  })
})
