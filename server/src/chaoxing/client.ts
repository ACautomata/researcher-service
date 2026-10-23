import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { ChaoxingMcpError, ChaoxingConfigError, type ChaoxingRemote, type LearningResource, type McpInspection, type McpStage, type McpRejectionReason } from './remote'
import type { ChaoxingOptions } from './options'
import { createChaoxingOAuth } from './oauth'

const mcpFailure = (stage: McpStage, error: unknown): ChaoxingMcpError => {
  const status = error instanceof StreamableHTTPError && typeof error.code === 'number' && error.code >= 100 && error.code <= 599 ? error.code
    : error instanceof Error && error.name === 'UnauthorizedError' ? 401 : undefined
  const timedOut = error instanceof McpError && error.code === ErrorCode.RequestTimeout || error instanceof Error && error.name === 'TimeoutError'
  // 仅识别固定类别，不返回或保留任何上游正文。未匹配不能推断为对端权限问题。
  let reason: McpRejectionReason | undefined
  if (status === 403) {
    const text = error instanceof Error ? error.message.slice(0, 4096) : ''
    reason = /URL\s*不在白名单|URL[^\n]{0,40}not (?:in|on) (?:the )?(?:white|allow)list/i.test(text) ? 'url_not_allowlisted'
      : /insufficient_scope|insufficient scope/i.test(text) ? 'insufficient_scope'
        : /invalid cors request/i.test(text) ? 'origin_rejected' : 'unclassified'
  }
  return new ChaoxingMcpError(stage, status, timedOut, reason)
}

const MCP_URL = 'https://api.chaoxing.com/openai/studyai/data'
const mapping = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/),
  readOnlyConfirmed: z.literal(true),
  itemsPath: z.string().max(200).default('items'),
  idField: z.string().default('id'), nameField: z.string().default('name'),
  classIdField: z.string().default('classId'), urlField: z.string().default('url'),
  textField: z.string().default('text'), typeField: z.string().default('type'),
  subListField: z.string().default('subList'),
  courseArg: z.string().default('courseId'), classArg: z.string().default('classId'),
  queryArg: z.string().default('query'), pageArg: z.string().default('pageNumber'),
  sizeArg: z.string().default('pageSize'), resourceArg: z.string().default('resourceId'),
  totalPagesPath: z.string().default('totalPages'),
}).strict()
export const mcpMappingSchema = z.object({ courses: mapping.optional(), search: mapping.optional(), topics: mapping.optional(), read: mapping.optional() }).strict()
export type McpMapping = z.input<typeof mcpMappingSchema>
type Mapping = z.output<typeof mapping>
const courseSchema = z.object({ id: z.string(), name: z.string(), classId: z.string().optional() })
type Course = z.infer<typeof courseSchema>
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const at = (v: unknown, path: string): unknown => path === '' ? v : path.split('.').reduce<unknown>((value, key) => Object.prototype.hasOwnProperty.call(record(value), key) ? record(value)[key] : undefined, v)
const scalar = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : ''
const items = (v: unknown, path: string): unknown[] => { const list = at(v, path); if (!Array.isArray(list)) throw new Error('超星返回数据结构与映射不符'); return list }
const safeLink = (v: unknown): string | undefined => {
  try { const u = new URL(scalar(v)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined } catch { return undefined }
}

/** Tool names/field mappings are deployment-reviewed contracts, never inferred from names or supplied by a model. */
export function createChaoxingRemote(options: ChaoxingOptions, input: McpMapping = {}, network: typeof fetch = fetch): ChaoxingRemote {
  const config = mcpMappingSchema.parse(input)
  const oauth = createChaoxingOAuth(options, network)
  // 完整目录只在本次 MCP 连接内复用，绝不跨账号或授权会话缓存。
  const catalogs = new WeakMap<Client, Awaited<ReturnType<Client['listTools']>>['tools']>()
  const checkedFetch: typeof fetch = (url, init) => network(url, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
  async function session<T>(token: string, signal: AbortSignal | undefined, fn: (client: Client, transport: StreamableHTTPClientTransport) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'researcher-service', version: '0.1.0' })
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' }, fetch: (url, init) => checkedFetch(url, { ...init, signal: signal ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal }) })
    const abort = () => { void client.close().catch(() => {}) }
    signal?.throwIfAborted()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      try { await client.connect(transport, { timeout: 20_000, signal }) }
      catch (error) { throw mcpFailure('initialize', error) }
      return await fn(client, transport)
    }
    finally { signal?.removeEventListener('abort', abort); await client.close().catch(() => {}) }
  }
  async function list(client: Client, signal?: AbortSignal) {
    try {
      const cached = catalogs.get(client)
      if (cached) return cached
      const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        const response = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20_000, signal })
        tools.push(...response.tools)
        if (!response.nextCursor) { catalogs.set(client, tools); return tools }
        if (response.nextCursor === cursor) throw new Error('MCP 工具分页未前进')
        cursor = response.nextCursor
      }
      throw new Error('MCP 工具目录超出检查上限')
    } catch (error) { throw mcpFailure('tools/list', error) }
  }
  async function call(client: Client, map: Mapping, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const tool = (await list(client, signal)).find(t => t.name === map.name)
    if (!tool) throw new ChaoxingConfigError('已配置工具不在当前授权目录')
    if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true) throw new ChaoxingConfigError('已配置工具与只读声明冲突，已阻止调用')
    try {
      const result = await client.callTool({ name: map.name, arguments: args }, undefined, { signal, timeout: 20_000 })
      if (result.isError) throw new Error('超星工具调用失败')
      let output: unknown = result.structuredContent
      if (output === undefined) {
        const blocks = result.content
        if (!Array.isArray(blocks)) throw new Error('超星工具结果格式错误')
        const text = blocks.filter(b => record(b).type === 'text').map(b => scalar(record(b).text)).join('\n')
        if (text.length > 2_000_000) throw new Error('超星工具结果过大')
        output = JSON.parse(text)
      }
      const business = record(output)
      if (business.status === false || business.status === 'false' || business.result === false) throw new Error('超星拒绝访问')
      return output
    } catch (error) { throw mcpFailure('tools/call', error) }
  }
  async function courses(client: Client, signal?: AbortSignal): Promise<{ rows: Course[]; truncated: boolean }> {
    if (!config.courses) throw new Error('课程发现能力未配置')
    const rows: Course[] = []
    for (let page = 1; page <= 10; page++) {
      const data = await call(client, config.courses, { [config.courses.pageArg]: page, [config.courses.sizeArg]: 30 }, signal)
      for (const item of items(data, config.courses.itemsPath)) {
        const id = scalar(at(item, config.courses.idField)), name = scalar(at(item, config.courses.nameField)), classId = scalar(at(item, config.courses.classIdField))
        if (!id || !name) throw new Error('课程身份或名称缺失')
        if (!rows.some(c => c.id === id && c.classId === (classId || undefined))) rows.push({ id, name, ...(classId ? { classId } : {}) })
      }
      const pages = Number(at(data, config.courses.totalPagesPath) ?? 1)
      if (!Number.isInteger(pages) || pages < 1) throw new Error('课程分页格式错误')
      if (page >= pages) return { rows, truncated: false }
    }
    return { rows, truncated: true }
  }
  async function search(client: Client, map: Mapping, course: Course, query: string, kind: LearningResource['kind'], signal?: AbortSignal) {
    const found: LearningResource[] = []
    let truncated = false
    for (let page = 1; page <= 50; page++) {
      const data = await call(client, map, { [map.courseArg]: course.id, ...(course.classId ? { [map.classArg]: course.classId } : {}), [map.queryArg]: query, [map.pageArg]: page, [map.sizeArg]: 30 }, signal)
      const pending = [...items(data, map.itemsPath)]
      let count = 0
      while (pending.length && count++ < 5000) {
        const item = pending.shift()
        const children = at(item, map.subListField)
        if (kind === 'topic' && Array.isArray(children)) pending.push(...children)
        if (at(item, map.typeField) === 'afolder') continue
        const id = scalar(at(item, map.idField)), name = scalar(at(item, map.nameField))
        if (!id || !name) continue
        const text = scalar(at(item, map.textField)).slice(0, 12_000)
        const url = safeLink(at(item, map.urlField))
        if (!found.some(r => r.id === id)) found.push({ id, name: name.slice(0, 500), courseId: course.id, courseName: course.name, kind, ...(text ? { text } : {}), ...(url ? { url } : {}) })
      }
      if (pending.length) truncated = true
      const pages = Number(at(data, map.totalPagesPath) ?? 1)
      if (!Number.isInteger(pages) || pages < 1) throw new Error('资料分页格式错误')
      if (page >= pages) break
      if (page === 50) truncated = true
    }
    return { found, truncated }
  }
  return {
    exchange: (code, verifier) => oauth({ grant_type: 'authorization_code', code, redirect_uri: options.redirectUri, ...(options.pkce !== false ? { code_verifier: verifier } : {}) }),
    refresh: refreshToken => oauth({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    courses: (token, signal) => session(token, signal, client => courses(client, signal)),
    inspect: (token, signal) => session(token, signal, async (client, transport): Promise<McpInspection> => {
      const tools = await list(client, signal)
      const mappingChecks: NonNullable<McpInspection['mappingChecks']> = (['courses', 'search', 'topics', 'read'] as const).map(capability => {
        const configured = config[capability]
        const tool = tools.find(t => t.name === configured?.name)
        const status = !configured ? 'not-configured' : !tool ? 'tool-missing'
          : tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true ? 'not-read-only' : 'listed'
        return { capability, ...(configured ? { toolName: configured.name } : {}), status, callVerified: false }
      })
      return {
        connection: { initialized: true, transport: 'streamable-http', protocolVersion: transport.protocolVersion!, authentication: 'oauth-bearer', sessionMode: transport.sessionId ? 'stateful' : 'stateless' },
        tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}), ...(t.annotations ? { annotations: t.annotations } : {}) })),
        capabilities: mappingChecks.filter(c => c.status === 'listed').map(c => c.capability),
        mappingChecks,
      }
    }),
    learn: (token, topic, courseId, signal, target = 'all') => session(token, signal, async client => {
      const deadline = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])])
      if (target === 'resources' && !config.search) throw new ChaoxingConfigError('资料检索能力尚未配置')
      if (target === 'topics' && !config.topics) throw new ChaoxingConfigError('知识点查询能力尚未配置')
      const needed = target === 'resources'
        ? [config.courses, config.search, config.read]
        : target === 'topics' ? [config.courses, config.topics] : Object.values(config)
      const available = await list(client, deadline)
      for (const map of needed) if (map && !available.some(t => t.name === map.name)) throw new ChaoxingConfigError('已配置工具不在当前授权目录')
      if (!config.courses) {
        if (target !== 'all') throw new ChaoxingConfigError('课程发现能力未配置')
        return { resources: [], limitations: ['尚未配置并验证课程发现能力，无法自动定位课程资源'] }
      }
      const all = await courses(client, deadline)
      const eligible = courseId ? all.rows.filter(c => c.id === courseId) : all.rows
      if (courseId && !eligible.length) throw new ChaoxingConfigError('课程无权限或课程列表不完整')
      const limitations: string[] = []
      if (eligible.length > 10 || all.truncated) limitations.push('课程较多，本次仅检索前 10 个获授权课程，结果可能不完整；可以指定课程缩小范围')
      const resources: LearningResource[] = []
      if (target === 'all' && !config.search) limitations.push('资料检索能力尚未配置')
      if (target === 'all' && !config.topics) limitations.push('知识点查询能力尚未配置')
      const kinds = target === 'all'
        ? [['resource', config.search], ['topic', config.topics]] as const
        : target === 'resources' ? [['resource', config.search]] as const : [['topic', config.topics]] as const
      for (const course of eligible.slice(0, 10)) {
        for (const [kind, map] of kinds) {
          if (!map) continue
          let result = await search(client, map, course, topic, kind, deadline)
          // Reuse the supplied skill's zero-hit retry then full-list verification; only related matches survive fallback.
          if (!result.found.length) result = await search(client, map, course, topic, kind, deadline)
          if (!result.found.length) {
            result = await search(client, map, course, '', kind, deadline)
            result.found = result.found.filter(r => `${r.name} ${r.text ?? ''}`.toLowerCase().includes(topic.toLowerCase()))
          }
          if (result.truncated) limitations.push(`${course.name} 的${kind === 'resource' ? '资料' : '知识点'}检索达到上限，结果可能不完整`)
          resources.push(...result.found)
        }
      }
      const shown = resources.slice(0, 50)
      if (resources.length > 50) limitations.push('资料数量较多，展示上限50个资料')
      if (config.read && target !== 'topics') for (const resource of shown.filter(r => r.kind === 'resource' && !r.text).slice(0, 5)) {
        const output = await call(client, config.read, { [config.read.courseArg]: resource.courseId, [config.read.resourceArg]: resource.id }, deadline)
        const text = scalar(at(output, config.read.textField))
        if (text) resource.text = text.slice(0, 12_000)
        resource.url ??= safeLink(at(output, config.read.urlField))
      }
      if (shown.some(r => !r.text)) limitations.push('部分资源未取得正文，只能作为目录推荐，不能据此推断课程内容')
      if (shown.some(r => !r.url)) limitations.push('部分资源未返回可访问链接，不应编造链接')
      return { resources: shown, limitations: [...new Set(limitations)] }
    }),
  }
}
