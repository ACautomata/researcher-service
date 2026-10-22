import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { createChaoxingRemote } from '../src/chaoxing/client'

// 全模块经 REST 入口验证；仅替换远端 HTTP，包含真实 MCP 初始化与工具调用。
describe('超星 MCP 只读资料链', () => {
  let ctx: TestContext
  let auth: Record<string, string>
  const methods: string[] = []
  const fetchRemote: typeof fetch = async (_url, init) => {
    if (String(_url).includes('/token')) return new Response(JSON.stringify({ access_token: 'test-access', token_type: 'Bearer', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } })
    const body = JSON.parse(String(init?.body ?? '{}'))
    methods.push(body.method)
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    let result: unknown
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
    if (body.method === 'tools/list') result = { tools: [
      { name: 'list_courses', inputSchema: { type: 'object' } },
      { name: 'search_materials', inputSchema: { type: 'object' } },
      { name: 'create_topic', inputSchema: { type: 'object' } },
    ] }
    if (body.method === 'tools/call') {
      const data = body.params.name === 'list_courses' ? { items: [{ id: 'c1', name: '机器学习', classId: 'cl1' }, { id: 'c2', name: '数学' }] } : { items: [{ id: 'folder', name: '梯度下降', type: 'afolder' }, { id: 'r1', name: '梯度下降课件', text: '学习率控制迭代步长', url: 'https://mooc.chaoxing.com/resource/1' }] }
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
  beforeAll(async () => {
    const options = { clientId: 'client', clientSecret: 'secret', credentialSecret: 'encryption-secret-32-characters-long', redirectUri: 'https://panel.example/api/v1/integrations/chaoxing/callback' }
    const remote = createChaoxingRemote(options, {
      courses: { name: 'list_courses', readOnlyConfirmed: true, itemsPath: 'items' },
      search: { name: 'search_materials', readOnlyConfirmed: true, itemsPath: 'items' },
    }, fetchRemote)
    ctx = await setupTestApp({ chaoxing: { options, remote } })
    await seedUser(ctx.prisma, 'mcp-student', 'student-password')
    auth = bearer((await login(ctx.request, 'mcp-student', 'student-password')).access)
    const start = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(auth).send({})
    await ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${new URL(start.body.data.url).searchParams.get('state')}`).query({ state: new URL(start.body.data.url).searchParams.get('state'), code: 'code' })
  })
  afterAll(async () => ctx?.cleanup())
  it('未选课时自动检索获授权课程，保留正文链接、滤除文件夹、禁止创建', async () => {
    const result = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度下降' })
    expect(result.body.code).toBe(0)
    expect(result.body.data.resources).toHaveLength(2)
    expect(result.body.data.resources[0]).toMatchObject({ name: '梯度下降课件', courseName: '机器学习', text: '学习率控制迭代步长' })
    expect(methods).toContain('initialize')
    expect(methods).toContain('tools/list')
    const denied = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度下降', courseId: 'unauthorized' })
    expect(denied.body.code).not.toBe(0)
  })
})
