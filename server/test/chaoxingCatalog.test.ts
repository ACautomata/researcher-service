import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { bearer, login, seedUser } from './helpers'
import { createChaoxingHttpRemote } from '../src/chaoxing/httpClient'

const base = '/api/v1/integrations/chaoxing'
const options = { clientId: 'catalog', clientSecret: 'catalog-secret', credentialSecret: 'catalog-encryption-secret-at-least-32', redirectUri: 'https://panel.example/callback' }
const courses = [{ id: '123', classId: '456', name: '数学' }, { id: '789', classId: '987', name: '物理' }]
describe('本人课程清单与跨课程资料查询', () => {
  let ctx: TestContext
  let auth: Record<string, string>
  let other: Record<string, string>
  let ownerId: string
  let calls: URL[]
  let response: (url: URL) => Response
  const json = (value: unknown) => new Response(JSON.stringify(value))
  async function bind(headers: Record<string, string>) {
    const start = await ctx.request.post(`${base}/authorize`).set(headers).send({})
    const state = new URL(start.body.data.url).searchParams.get('state')
    await ctx.request.get(`${base}/callback`).set('Cookie', `chaoxing_oauth=${state}`).query({ state, code: 'code' })
  }
  beforeEach(async () => {
    calls = []
    response = url => json({ status: true, totalPages: 1, datalist: [{ id: 1, dataName: `课件-${url.searchParams.get('courseId')}` }] })
    const network: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/token')) return json({ access_token: 'catalog-token', token_type: 'Bearer' })
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer catalog-token' })
      calls.push(url)
      return response(url)
    }
    ctx = await setupTestApp({ chaoxing: { options, remote: createChaoxingHttpRemote(options, network) } })
    ownerId = (await seedUser(ctx.prisma, 'catalog-owner', 'student-password')).id
    await seedUser(ctx.prisma, 'catalog-other', 'student-password')
    auth = bearer((await login(ctx.request, 'catalog-owner', 'student-password')).access)
    other = bearer((await login(ctx.request, 'catalog-other', 'student-password')).access)
    await bind(auth)
  })
  afterEach(async () => ctx?.cleanup())
  const sync = () => ctx.request.put(`${base}/courses`).set(auth).send({ courses })
  const search = (extra = {}) => ctx.request.post(`${base}/learn`).set(auth).send({ topic: '课件', target: 'resources', ...extra })

  it('清单需绑定、严格验证、拒绝重复及 owner 覆盖，未授权不写入', async () => {
    expect((await ctx.request.put(`${base}/courses`).send({ courses })).body.code).toBe(10001)
    expect((await ctx.request.put(`${base}/courses`).set(other).send({ courses })).body.code).toBe(90003)
    for (const body of [{ courses, ownerId: 'someone' }, { courses: [courses[0], courses[0]] }, { courses: [{ id: '123', name: 'bad' }] }, { courses: Array.from({ length: 101 }, () => courses[0]) }]) {
      expect((await ctx.request.put(`${base}/courses`).set(auth).send(body)).body.code).toBe(90002)
    }
    expect((await ctx.prisma.chaoxingBinding.findUnique({ where: { ownerId } }))?.coursesJson).toBeNull()
  })
  it('按用户持久化清单，另一用户看不到且查询不能使用它', async () => {
    expect((await sync()).body).toMatchObject({ code: 0, data: { rows: courses, syncedAt: expect.any(String) } })
    expect((await ctx.request.get(`${base}/courses`).set(auth)).body.data.rows).toEqual(courses)
    expect((await ctx.prisma.chaoxingBinding.findUnique({ where: { ownerId } }))?.coursesJson).toContain('数学')
    await bind(other)
    expect((await ctx.request.get(`${base}/courses`).set(other)).body.data.rows).toEqual([])
    expect((await ctx.request.post(`${base}/learn`).set(other).send({ topic: '课件' })).body.code).toBe(90003)
    expect(calls).toHaveLength(0)
  })
  it('仅关键词即可查询全部清单，自动补班级，保留不同课程的同名资料和各自链接', async () => {
    await sync()
    const result = await search()
    expect(result.body.code).toBe(0)
    expect(calls.map(url => [url.searchParams.get('courseId'), url.searchParams.get('classId')])).toEqual([['123', '456'], ['789', '987']])
    expect(result.body.data.resources).toMatchObject([
      { courseId: '123', courseName: '数学', courseDataUrl: expect.stringContaining('clazzid=456') },
      { courseId: '789', courseName: '物理', courseDataUrl: expect.stringContaining('clazzid=987') },
    ])
    expect(result.body.data.resources).toHaveLength(2)
    expect(result.body.data.limitations.join(' ')).toContain('2 个成功')
  })
  it('限定课程从清单补班级；清单移除课程会清理旧会话范围', async () => {
    await sync()
    await ctx.prisma.session.create({ data: { id: 'catalog-scope', ownerId, containerId: '' } })
    expect((await ctx.request.put(`${base}/sessions/catalog-scope/scope`).set(auth).send({ courseId: '123' })).body.code).toBe(0)
    expect((await search({ courseId: '123' })).body.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.searchParams.get('classId')).toBe('456')
    await ctx.request.put(`${base}/courses`).set(auth).send({ courses: [courses[1]] })
    expect((await ctx.prisma.session.findUnique({ where: { id: 'catalog-scope' } }))?.learningCourseId).toBeNull()
  })
  it('部分课程业务拒绝仍返回成功资料并声明不完整，全部失败不冒充零命中', async () => {
    await sync()
    response = url => url.searchParams.get('courseId') === '123' ? json({ status: false, msg: 'private upstream message' }) : json({ status: true, totalPages: 1, datalist: [{ id: 2, dataName: '物理课件' }] })
    const result = await search()
    expect(result.body.code).toBe(0)
    expect(result.body.data.resources).toHaveLength(1)
    expect(result.body.data.limitations.join(' ')).toContain('结果不完整')
    expect(JSON.stringify(result.body)).not.toContain('private upstream message')
    response = () => json({ status: false })
    expect((await search()).body.code).toBe(90003)
  })
  it('授权401清理绑定及清单，不作为局部空结果', async () => {
    await sync()
    response = () => new Response('', { status: 401 })
    expect((await search()).body.code).toBe(90003)
    const row = await ctx.prisma.chaoxingBinding.findUnique({ where: { ownerId } })
    expect(row?.tokenCipher).toBeNull()
    expect(row?.coursesJson).toBeNull()
  })
  it('重新绑定、解绑清除课程清单，避免旧账号清单被复用', async () => {
    await sync()
    await bind(auth)
    expect((await ctx.request.get(`${base}/courses`).set(auth)).body.data.rows).toEqual([])
    await sync()
    await ctx.request.delete(base).set(auth).send({})
    expect((await ctx.prisma.chaoxingBinding.findUnique({ where: { ownerId } }))?.coursesJson).toBeNull()
  })
})
