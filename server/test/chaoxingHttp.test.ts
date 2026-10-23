import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChaoxingHttpRemote } from '../src/chaoxing/httpClient'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'

const options = {
  clientId: 'client', clientSecret: 'private-client-secret',
  credentialSecret: 'encryption-secret-32-characters-long',
  redirectUri: 'https://panel.example/api/v1/integrations/chaoxing/callback',
}
const base = '/api/v1/integrations/chaoxing'

// 既有信封 REST 接缝；替换外部 HTTP，保留绑定、令牌、路由与字段转换的实际链路。
describe('超星 HTTP 只读查询', () => {
  let ctx: TestContext
  let auth: Record<string, string>
  const calls: { url: URL; init?: RequestInit }[] = []
  let upstream: (url: URL) => Response
  const json = (value: unknown) => new Response(JSON.stringify(value))
  beforeAll(async () => {
    const network: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      calls.push({ url, init })
      if (url.pathname.endsWith('/token')) return json({ access_token: 'bound-token', token_type: 'Bearer', expires_in: 3600 })
      return upstream(url)
    }
    ctx = await setupTestApp({ chaoxing: { options, remote: createChaoxingHttpRemote(options, network) } })
    await seedUser(ctx.prisma, 'http-student', 'student-password')
    auth = bearer((await login(ctx.request, 'http-student', 'student-password')).access)
    const start = await ctx.request.post(`${base}/authorize`).set(auth).send({})
    const state = new URL(start.body.data.url).searchParams.get('state')
    await ctx.request.get(`${base}/callback`).set('Cookie', `chaoxing_oauth=${state}`).query({ state, code: 'code' })
    calls.length = 0
  })
  afterAll(async () => ctx?.cleanup())
  const learn = (body: Record<string, unknown>) => ctx.request.post(`${base}/learn`).set(auth).send({ topic: '梯度', ...body })

  it('能力报告不伪称 MCP 已初始化或 HTTP 已验收，也不请求未知课程接口', async () => {
    const result = await ctx.request.get(`${base}/capabilities`).set(auth)
    expect(result.body.code).toBe(0)
    expect(result.body.data).toMatchObject({ tools: [], capabilities: [], http: { transport: 'https-json', callVerified: false } })
    expect(result.body.data.connection).toBeUndefined()
    expect(calls).toHaveLength(0)
    const courses = await ctx.request.get(`${base}/courses`).set(auth)
    expect(courses.body).toMatchObject({ code: 90003, message: expect.stringContaining('尚未提供课程/班级发现接口') })
    expect(calls).toHaveLength(0)
  })

  it('缺课程或学生班级时明确提示，拒绝教师身份参数，且不发送请求', async () => {
    expect((await learn({ target: 'topics' })).body.message).toContain('课程 ID')
    expect((await learn({ target: 'resources', courseId: '123' })).body.message).toContain('班级 ID')
    expect((await learn({ courseId: '123', classId: '0' })).body.code).toBe(90002)
    expect((await learn({ courseId: '123', classId: '456', ut: 't' })).body.code).toBe(90002)
    expect(calls).toHaveLength(0)
  })

  it('按学生身份分页检索资料，过滤文件夹并仅保留实际返回的安全链接', async () => {
    calls.length = 0
    upstream = url => json({ status: true, totalPages: 2, datalist: url.searchParams.get('pageNumber') === '1'
      ? [{ id: 1, dataName: '梯度目录', dataType: 'afolder' }, { id: 2, dataName: '梯度课件', url: 'https://example.com/2' }]
      : [{ id: 3, dataName: '梯度例题', url: 'javascript:alert(1)' }] })
    const result = await learn({ courseId: '123', classId: '456', target: 'resources' })
    expect(result.body.code).toBe(0)
    expect(result.body.data.resources).toEqual([
      { id: '2', name: '梯度课件', courseId: '123', courseName: '课程 123', kind: 'resource', url: 'https://example.com/2' },
      { id: '3', name: '梯度例题', courseId: '123', courseName: '课程 123', kind: 'resource' },
    ])
    expect(calls).toHaveLength(2)
    for (const { url, init } of calls) {
      expect(url.origin + url.pathname).toBe('https://api.chaoxing.com/openapi/coursedata/searchCourseDataJson')
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ courseId: '123', classId: '456', ut: 's', dataName: '梯度', pageSize: '30' })
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer bound-token' } })
    }
    expect(result.body.data.limitations.join(' ')).toContain('未取得正文')
  })

  it('零命中重试后显式发送空 dataName 核对全量，保留相关文件', async () => {
    calls.length = 0
    upstream = url => json({ status: true, totalPages: 1, datalist: url.searchParams.get('dataName') === ''
      ? [{ id: 4, dataName: '梯度讲义' }, { id: 5, dataName: '无关资料' }] : [] })
    const result = await learn({ courseId: '123', classId: '456', target: 'resources' })
    expect(result.body.code).toBe(0)
    expect(result.body.data.resources.map((r: { id: string }) => r.id)).toEqual(['4'])
    expect(calls.map(call => call.url.searchParams.get('dataName'))).toEqual(['梯度', '梯度', ''])
  })

  it('知识点递归遍历并过滤分类，不调用资料接口或自动创建', async () => {
    calls.length = 0
    upstream = () => json({ status: true, data: { list: [{ id: 6, content: '分类', type: 1, subList: [{ id: 7, content: '梯度', type: 0 }] }] } })
    const result = await learn({ courseId: '123', target: 'topics' })
    expect(result.body.code).toBe(0)
    expect(result.body.data.resources).toEqual([{ id: '7', name: '梯度', courseId: '123', courseName: '课程 123', kind: 'topic' }])
    expect(calls).toHaveLength(1)
    expect(calls[0].url.pathname).toBe('/openapi/qbank-educlaw/topic-list')
    expect(calls[0].init?.method).toBe('GET')
  })

  it('页数达到上限时明确不完整，最多展示50条', async () => {
    calls.length = 0
    upstream = url => json({ status: true, totalPages: 51, datalist: [{ id: url.searchParams.get('pageNumber'), dataName: '梯度课件' }] })
    const result = await learn({ courseId: '123', classId: '456', target: 'resources' })
    expect(result.body.code).toBe(0)
    expect(calls).toHaveLength(50)
    expect(result.body.data.resources).toHaveLength(50)
    expect(result.body.data.limitations.join(' ')).toContain('结果可能不完整')
  })

  it('业务拒绝、错误结构和超大正文均脱敏失败，403保留绑定', async () => {
    for (const response of [json({ status: false, msg: 'bound-token private-client-secret' }), json({ status: true, data: {} }), new Response('x'.repeat(2_000_001)), new Response('bound-token private-client-secret', { status: 403 })]) {
      upstream = () => response
      const result = await learn({ courseId: '123', target: 'topics' })
      expect(result.body.code).toBe(90003)
      expect(JSON.stringify(result.body)).not.toContain('bound-token')
      expect(JSON.stringify(result.body)).not.toContain('private-client-secret')
    }
    expect((await ctx.request.get(base).set(auth)).body.data.connected).toBe(true)
  })

  it('HTTP401清除对应绑定并要求重新授权', async () => {
    upstream = () => new Response('private', { status: 401 })
    const result = await learn({ courseId: '123', target: 'topics' })
    expect(result.body).toMatchObject({ code: 90003, data: { httpOperation: ['topics'], httpStatus: ['401'] } })
    expect((await ctx.request.get(base).set(auth)).body.data.connected).toBe(false)
  })
})
