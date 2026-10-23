import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { createChaoxingRemote, type McpMapping } from '../src/chaoxing/client'
import { encryptCredential } from '../src/models/cipher'

const options = {
  clientId: 'client', clientSecret: 'secret',
  credentialSecret: 'encryption-secret-32-characters-long',
  redirectUri: 'https://panel.example/api/v1/integrations/chaoxing/callback',
}

// 全模块经 REST 入口验证；仅替换远端 HTTP，包含真实 MCP 初始化与工具调用。
function fixtureFetch(methods: string[], called: string[]): typeof fetch {
  return async (_url, init) => {
    if (String(_url).includes('/token')) return new Response(JSON.stringify({ access_token: 'test-access', token_type: 'Bearer', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } })
    const body = JSON.parse(String(init?.body ?? '{}'))
    methods.push(body.method)
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    let result: unknown
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
    if (body.method === 'tools/list') result = { tools: [
      { name: 'list_courses', inputSchema: { type: 'object' } },
      { name: 'search_materials', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { items: { type: 'array' } } }, annotations: { readOnlyHint: true } },
      { name: 'list_topics', inputSchema: { type: 'object' } },
      { name: 'read_material', inputSchema: { type: 'object' } },
      { name: 'create_topic', inputSchema: { type: 'object' } },
    ] }
    if (body.method === 'tools/call') {
      const name = body.params.name as string
      called.push(name)
      let data: unknown
      if (name === 'list_courses') data = { items: [{ id: 'c1', name: '机器学习', classId: 'cl1' }, { id: 'c2', name: '数学' }] }
      else if (name === 'list_topics') data = { items: [{ id: 't1', name: '梯度知识点', text: '梯度的定义' }] }
      else if (name === 'read_material') data = { text: '完整正文', url: 'https://mooc.chaoxing.com/resource/1' }
      else data = { items: [{ id: 'folder', name: '梯度下降', type: 'afolder' }, { id: 'r1', name: '梯度下降课件', text: '学习率控制迭代步长', url: 'https://mooc.chaoxing.com/resource/1' }] }
      result = { content: [{ type: 'text', text: JSON.stringify(data) }], ...(name === 'search_materials' ? { structuredContent: data } : {}) }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
}

const fullMapping = {
  courses: { name: 'list_courses', readOnlyConfirmed: true, itemsPath: 'items' },
  search: { name: 'search_materials', readOnlyConfirmed: true, itemsPath: 'items' },
  topics: { name: 'list_topics', readOnlyConfirmed: true, itemsPath: 'items' },
  read: { name: 'read_material', readOnlyConfirmed: true },
} satisfies McpMapping

describe('超星 MCP 只读资料链', () => {
  let ctx: TestContext
  let auth: Record<string, string>
  const methods: string[] = []
  const called: string[] = []
  beforeAll(async () => {
    const remote = createChaoxingRemote(options, fullMapping, fixtureFetch(methods, called))
    ctx = await setupTestApp({ chaoxing: { options, remote } })
    await seedUser(ctx.prisma, 'mcp-student', 'student-password')
    auth = bearer((await login(ctx.request, 'mcp-student', 'student-password')).access)
    const start = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(auth).send({})
    const state = new URL(start.body.data.url).searchParams.get('state')
    await ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${state}`).query({ state, code: 'code' })
  })
  afterAll(async () => ctx?.cleanup())
  it('未选课时自动检索获授权课程，保留正文链接、滤除文件夹、禁止创建', async () => {
    const result = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度下降' })
    expect(result.body.code).toBe(0)
    expect(result.body.data.resources).toHaveLength(4)
    expect(result.body.data.resources[0]).toMatchObject({ name: '梯度下降课件', courseName: '机器学习', text: '学习率控制迭代步长' })
    expect(result.body.data.resources).toContainEqual(expect.objectContaining({ name: '梯度知识点', kind: 'topic' }))
    expect(result.body.data.resources.some((r: { name: string }) => r.name === '梯度下降')).toBe(false)
    expect(methods).toContain('initialize')
    expect(methods).toContain('tools/list')
    expect(called).not.toContain('create_topic')
    const denied = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度下降', courseId: 'unauthorized' })
    expect(denied.body.code).not.toBe(0)
  })
  it('目录检查提供协商版本、输出 schema 和只读声明，但不执行任何工具', async () => {
    const before = called.length
    const result = await ctx.request.get('/api/v1/integrations/chaoxing/capabilities').set(auth)
    expect(result.body.code).toBe(0)
    expect(result.body.data.connection).toMatchObject({ initialized: true, transport: 'streamable-http', protocolVersion: '2025-03-26', authentication: 'oauth-bearer', sessionMode: 'stateless' })
    expect(result.body.data.tools).toContainEqual(expect.objectContaining({ name: 'search_materials', outputSchema: { type: 'object', properties: { items: { type: 'array' } } }, annotations: { readOnlyHint: true } }))
    expect(result.body.data.mappingChecks).toContainEqual({ capability: 'search', toolName: 'search_materials', status: 'listed', callVerified: false })
    expect(called).toHaveLength(before)
  })
  it('target=resources 只调用资料检索链，不调用知识点工具', async () => {
    called.splice(0)
    const result = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度下降', target: 'resources' })
    expect(result.body.code).toBe(0)
    expect(result.body.data.resources.every((r: { kind: string }) => r.kind === 'resource')).toBe(true)
    expect(called).toContain('search_materials')
    expect(called).not.toContain('list_topics')
    expect(called).not.toContain('read_material')
  })
  it('target=topics 只调用知识点查询链，不调用资料检索/正文读取工具', async () => {
    called.splice(0)
    const result = await ctx.request.post('/api/v1/integrations/chaoxing/learn').set(auth).send({ topic: '梯度', target: 'topics' })
    expect(result.body.code).toBe(0)
    expect(result.body.data.resources).toHaveLength(2)
    expect(result.body.data.resources.every((r: { id: string; kind: string }) => r.id === 't1' && r.kind === 'topic')).toBe(true)
    expect(called).toContain('list_topics')
    expect(called).not.toContain('search_materials')
    expect(called).not.toContain('read_material')
  })
})

describe('超星查询目标映射缺失隔离', () => {
  let ctx: TestContext | undefined
  afterAll(async () => { await ctx?.cleanup() })

  async function context(mapping: McpMapping, wrap?: (network: typeof fetch) => typeof fetch) {
    await ctx?.cleanup()
    ctx = undefined
    const methods: string[] = []
    const called: string[] = []
    const network = fixtureFetch(methods, called)
    ctx = await setupTestApp({ chaoxing: { options, remote: createChaoxingRemote(options, mapping, wrap ? wrap(network) : network) } })
    const owner = await seedUser(ctx.prisma, `mapping-${randomUUID()}`, 'student-password')
    const auth = bearer((await login(ctx.request, owner.username, 'student-password')).access)
    await ctx.prisma.chaoxingBinding.create({ data: {
      ownerId: owner.id,
      generation: randomUUID(),
      tokenCipher: encryptCredential(JSON.stringify({ access_token: 'bound-token', token_type: 'Bearer' }), options.credentialSecret),
      expiresAt: new Date(Date.now() + 3_600_000),
    } })
    return { ctx, auth, called }
  }

  it('初始化 HTTP 拒绝只返回阶段和状态，不暴露上游正文或凭证', async () => {
    const h = await context({}, network => async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      return body.method === 'initialize'
        ? new Response('denied bound-token secret', { status: 403 })
        : network(url, init)
    })
    const result = await h.ctx.request.get('/api/v1/integrations/chaoxing/capabilities').set(h.auth)
    expect(result.body).toMatchObject({ code: 90003, message: '超星 MCP 初始化失败（HTTP 403）', data: { mcpStage: ['initialize'], httpStatus: ['403'] } })
    expect(JSON.stringify(result.body)).not.toContain('bound-token')
    expect(JSON.stringify(result.body)).not.toContain('denied')
    expect(h.called).toEqual([])
  })
  it('网关明确拒绝 URL 白名单时返回固定原因类别，不回显原始错误', async () => {
    const h = await context({}, network => async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      return body.method === 'initialize'
        ? new Response(JSON.stringify({ msg: '无效请求：URL不在白名单中', private: 'bound-token secret' }), { status: 403 })
        : network(url, init)
    })
    const result = await h.ctx.request.get('/api/v1/integrations/chaoxing/capabilities').set(h.auth)
    expect(result.body.data).toMatchObject({ mcpStage: ['initialize'], httpStatus: ['403'], mcpRejectionReason: ['url_not_allowlisted'] })
    expect(JSON.stringify(result.body)).not.toContain('bound-token')
    expect(JSON.stringify(result.body)).not.toContain('private')
  })
  it.each([
    ['insufficient_scope bound-token secret', 'insufficient_scope'],
    ['Invalid CORS request bound-token secret', 'origin_rejected'],
    ['unknown private error bound-token secret', 'unclassified'],
  ])('403 响应只提取固定类别 %s', async (text, reason) => {
    const h = await context({}, network => async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      return body.method === 'initialize' ? new Response(text, { status: 403 }) : network(url, init)
    })
    const result = await h.ctx.request.get('/api/v1/integrations/chaoxing/capabilities').set(h.auth)
    expect(result.body.data.mcpRejectionReason).toEqual([reason])
    expect(JSON.stringify(result.body)).not.toContain('bound-token')
    expect(JSON.stringify(result.body)).not.toContain('secret')
    expect(JSON.stringify(result.body)).not.toContain('private')
  })
  it('工具目录错误与初始化错误可区分，JSON-RPC 原文不回显', async () => {
    const h = await context({}, network => async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      return body.method === 'tools/list'
        ? new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'private bound-token secret' } }), { headers: { 'content-type': 'application/json' } })
        : network(url, init)
    })
    const result = await h.ctx.request.get('/api/v1/integrations/chaoxing/capabilities').set(h.auth)
    expect(result.body).toMatchObject({ code: 90003, message: '超星 MCP 工具目录读取失败', data: { mcpStage: ['tools/list'] } })
    expect(JSON.stringify(result.body)).not.toContain('private')
    expect(JSON.stringify(result.body)).not.toContain('bound-token')
  })

  it('已配置工具被对端声明为写操作时，报告冲突且任何入口均不调用', async () => {
    const h = await context({ courses: fullMapping.courses }, network => async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.method !== 'tools/list') return network(url, init)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'list_courses', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } }] } }), { headers: { 'content-type': 'application/json' } })
    })
    const report = await h.ctx.request.get('/api/v1/integrations/chaoxing/capabilities').set(h.auth)
    expect(report.body.data.capabilities).toEqual([])
    expect(report.body.data.mappingChecks).toContainEqual({ capability: 'courses', toolName: 'list_courses', status: 'not-read-only', callVerified: false })
    const courses = await h.ctx.request.get('/api/v1/integrations/chaoxing/courses').set(h.auth)
    expect(courses.body.code).toBe(90003)
    expect(h.called).toEqual([])
  })
  it('有状态连接带协商头读取完整分页目录，但不返回会话标识或令牌', async () => {
    let requestsWithSession = 0
    const h = await context({}, network => async (url, init) => {
      if (init?.method === 'GET') return new Response(null, { status: 405 })
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.method === 'initialize') {
        const response = await network(url, init)
        response.headers.set('mcp-session-id', 'private-session-identity')
        return response
      }
      if (body.method === 'tools/list') {
        const headers = new Headers(init?.headers)
        if (headers.get('mcp-session-id') === 'private-session-identity' && headers.get('mcp-protocol-version') === '2025-03-26') requestsWithSession++
        const result = body.params?.cursor
          ? { tools: [{ name: 'page_two', inputSchema: { type: 'object' } }] }
          : { tools: [{ name: 'page_one', inputSchema: { type: 'object' } }], nextCursor: 'opaque-page-two' }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
      }
      return network(url, init)
    })
    const result = await h.ctx.request.get('/api/v1/integrations/chaoxing/capabilities').set(h.auth)
    expect(result.body.code).toBe(0)
    expect(result.body.data.connection.sessionMode).toBe('stateful')
    expect(result.body.data.tools.map((t: { name: string }) => t.name)).toEqual(['page_one', 'page_two'])
    expect(requestsWithSession).toBe(2)
    expect(JSON.stringify(result.body)).not.toContain('private-session-identity')
    expect(JSON.stringify(result.body)).not.toContain('bound-token')
  })

  it('目录游标不前进时不返回半份目录或已验证能力', async () => {
    const h = await context(fullMapping, network => async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.method !== 'tools/list') return network(url, init)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [], nextCursor: 'same-cursor' } }), { headers: { 'content-type': 'application/json' } })
    })
    const result = await h.ctx.request.get('/api/v1/integrations/chaoxing/capabilities').set(h.auth)
    expect(result.body).toMatchObject({ code: 90003, message: '超星 MCP 工具目录读取失败', data: { mcpStage: ['tools/list'] } })
    expect(result.body.data).not.toHaveProperty('capabilities')
    expect(h.called).toEqual([])
  })

  it('只读调用被拒绝时保留 tools/call 阶段，目录存在不等于调用成功', async () => {
    const h = await context(fullMapping, network => async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      return body.method === 'tools/call' ? new Response('private bound-token', { status: 403 }) : network(url, init)
    })
    const result = await h.ctx.request.get('/api/v1/integrations/chaoxing/courses').set(h.auth)
    expect(result.body).toMatchObject({ code: 90003, message: '超星 MCP 只读工具调用失败（HTTP 403）', data: { mcpStage: ['tools/call'], httpStatus: ['403'] } })
    expect(JSON.stringify(result.body)).not.toContain('bound-token')
  })
  it('仅配置资料能力时，资料目标可运行，知识点目标明确拒绝', async () => {
    const h = await context({ courses: fullMapping.courses, search: fullMapping.search })
    const resources = await h.ctx.request.post('/api/v1/integrations/chaoxing/learn').set(h.auth).send({ topic: '梯度', target: 'resources' })
    expect(resources.body.code).toBe(0)
    expect(h.called).toContain('search_materials')
    const topics = await h.ctx.request.post('/api/v1/integrations/chaoxing/learn').set(h.auth).send({ topic: '梯度', target: 'topics' })
    expect(topics.body.code).toBe(90003)
    expect(topics.body.message).toBe('知识点查询能力尚未配置')
    expect(h.called).not.toContain('list_topics')
  })

  it('仅配置知识点能力时，知识点目标可运行，资料目标明确拒绝', async () => {
    const h = await context({ courses: fullMapping.courses, topics: fullMapping.topics })
    const topics = await h.ctx.request.post('/api/v1/integrations/chaoxing/learn').set(h.auth).send({ topic: '梯度', target: 'topics' })
    expect(topics.body.code).toBe(0)
    expect(h.called).toContain('list_topics')
    const resources = await h.ctx.request.post('/api/v1/integrations/chaoxing/learn').set(h.auth).send({ topic: '梯度', target: 'resources' })
    expect(resources.body.code).toBe(90003)
    expect(resources.body.message).toBe('资料检索能力尚未配置')
    expect(h.called).not.toContain('search_materials')
  })
})
