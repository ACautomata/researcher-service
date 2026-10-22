import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { tokenSchema, type ChaoxingRemote, type LearningResource } from './remote'
import type { ChaoxingOptions } from './options'

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
  const checkedFetch: typeof fetch = (url, init) => network(url, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
  async function oauth(parameters: Record<string, string>) {
    const body = new URLSearchParams({ ...parameters, client_id: options.clientId })
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
    if (options.tokenAuth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`).toString('base64')}`
    else body.set('client_secret', options.clientSecret)
    const response = await checkedFetch('https://api.chaoxing.com/auth/oauth2/token', { method: 'POST', headers, body: body.toString() })
    if (!response.ok) throw new Error('超星令牌交换失败')
    return tokenSchema.parse(await response.json())
  }
  async function session<T>(token: string, signal: AbortSignal | undefined, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'researcher-service', version: '0.1.0' })
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' }, fetch: (url, init) => checkedFetch(url, { ...init, signal: signal ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal }) })
    const abort = () => { void client.close().catch(() => {}) }
    signal?.throwIfAborted()
    signal?.addEventListener('abort', abort, { once: true })
    try { await client.connect(transport); return await fn(client) }
    finally { signal?.removeEventListener('abort', abort); await client.close().catch(() => {}) }
  }
  async function list(client: Client) {
    const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const response = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...response.tools)
      if (!response.nextCursor) return tools
      if (response.nextCursor === cursor) throw new Error('MCP 工具分页未前进')
      cursor = response.nextCursor
    }
    throw new Error('MCP 工具目录超出检查上限')
  }
  async function call(client: Client, map: Mapping, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
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
    inspect: (token, signal) => session(token, signal, async client => ({ tools: (await list(client)).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), capabilities: Object.entries(config).filter(([, value]) => !!value).map(([key]) => key) })),
    learn: (token, topic, courseId, signal) => session(token, signal, async client => {
      const deadline = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])])
      const available = await list(client)
      for (const map of Object.values(config)) if (map && !available.some(t => t.name === map.name)) throw new Error('已配置工具不在当前授权目录')
      if (!config.courses) return { resources: [], limitations: ['尚未配置并验证课程发现能力，无法自动定位课程资源'] }
      const all = await courses(client, deadline)
      const eligible = courseId ? all.rows.filter(c => c.id === courseId) : all.rows
      if (courseId && !eligible.length) throw new Error('课程无权限或课程列表不完整')
      const limitations: string[] = []
      if (eligible.length > 10 || all.truncated) limitations.push('课程较多，本次仅检索前 10 个获授权课程，结果可能不完整；可以指定课程缩小范围')
      const resources: LearningResource[] = []
      if (!config.search) limitations.push('资料检索能力尚未配置')
      if (!config.topics) limitations.push('知识点查询能力尚未配置')
      for (const course of eligible.slice(0, 10)) {
        for (const [kind, map] of [['resource', config.search], ['topic', config.topics]] as const) {
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
      if (config.read) for (const resource of shown.filter(r => r.kind === 'resource' && !r.text).slice(0, 5)) {
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
