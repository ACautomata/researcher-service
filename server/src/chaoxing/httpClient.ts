import { z } from 'zod'
import type { ChaoxingOptions } from './options'
import { createChaoxingOAuth } from './oauth'
import { ChaoxingConfigError, ChaoxingHttpError, type ChaoxingRemote, type LearningResource } from './remote'

const endpoints = {
  resources: 'https://api.chaoxing.com/openapi/coursedata/searchCourseDataJson',
  topics: 'https://api.chaoxing.com/openapi/qbank-educlaw/topic-list',
} as const
const id = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String)
const resourceSchema = z.object({ id, dataName: z.string().min(1), dataType: z.string().optional(), url: z.string().optional() })
const resourcePageSchema = z.object({ status: z.literal(true), datalist: z.array(resourceSchema).max(5000), totalPages: z.coerce.number().int().min(0).max(1_000_000) })
const topicResponseSchema = z.object({ status: z.literal(true), data: z.object({ list: z.array(z.unknown()).max(5000) }) })
const topicSchema = z.object({ id, content: z.string().min(1), type: z.number().int(), subList: z.array(z.unknown()).max(5000).optional() })
const limitations = [
  '超星目前只提供资料检索和已有知识点查询接口；课程/班级发现、正文读取尚未提供',
  '当前使用本人 OAuth access token；新 HTTP 接口的认证兼容性和学生权限仍需真实调用核验',
]
const link = (value?: string): string | undefined => {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}

/** 固定的两个 GET 入口，参数契约来自超星提供的技能包；不执行技能脚本或创建接口。 */
export function createChaoxingHttpRemote(options: ChaoxingOptions, network: typeof fetch = fetch): ChaoxingRemote {
  const oauth = createChaoxingOAuth(options, network)
  async function request(operation: keyof typeof endpoints, token: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    try {
      signal.throwIfAborted()
      const url = new URL(endpoints[operation])
      url.search = new URLSearchParams(params).toString()
      const response = await network(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal })
      if (!response.ok) { await response.body?.cancel(); throw new ChaoxingHttpError(operation, response.status) }
      // 限制实际读取字节；Content-Length 不是可信的大小边界。
      if (!response.body) throw new ChaoxingHttpError(operation)
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 2_000_000) throw new ChaoxingHttpError(operation)
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch (error) {
      if (error instanceof ChaoxingHttpError) throw error
      throw new ChaoxingHttpError(operation)
    }
  }
  return {
    exchange: (code, verifier) => oauth({ grant_type: 'authorization_code', code, redirect_uri: options.redirectUri, ...(options.pkce !== false ? { code_verifier: verifier } : {}) }),
    refresh: refreshToken => oauth({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    courses: async () => { throw new ChaoxingConfigError('超星尚未提供课程/班级发现接口，无法读取或验证课程列表') },
    // 这里只报告本地接入契约，不把 HTTP 请求假装成 MCP 初始化或真实权限验收。
    inspect: async () => ({ tools: [], capabilities: [], http: {
      transport: 'https-json', authentication: 'oauth-bearer', callVerified: false,
      endpoints: (['resources', 'topics'] as const).map(capability => ({ capability, method: 'GET', url: endpoints[capability] })),
      limitations,
    } }),
    learn: async (token, query, courseId, signal, target = 'all', classId) => {
      if (!courseId || !/^[1-9][0-9]{0,29}$/.test(courseId)) throw new ChaoxingConfigError('请提供明确的数字课程 ID；超星尚未提供课程发现接口，无法自动选课')
      if (target !== 'topics' && (!classId || !/^[1-9][0-9]{0,29}$/.test(classId))) throw new ChaoxingConfigError('学生资料检索还需要该课程的班级 ID，请提供 classId；不能使用教师身份代替')
      const deadline = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])])
      const notes = [...limitations]
      const resources: LearningResource[] = []
      const convert = (entry: { id: string; name: string; url?: string }, kind: LearningResource['kind']): LearningResource => ({
        id: entry.id, name: entry.name.slice(0, 500), courseId, courseName: `课程 ${courseId}`, kind,
        ...(link(entry.url) ? { url: link(entry.url) } : {}),
      })
      async function search(operation: keyof typeof endpoints, keyword: string) {
        const rows: LearningResource[] = []
        let truncated = false
        try {
          if (operation === 'resources') {
            for (let page = 1; page <= 50; page++) {
              const data = resourcePageSchema.parse(await request(operation, token, {
                courseId: courseId!, classId: classId!, ut: 's', dataName: keyword, pageNumber: String(page), pageSize: '30',
              }, deadline))
              for (const entry of data.datalist) if (entry.dataType !== 'afolder' && !rows.some(row => row.id === entry.id)) {
                rows.push(convert({ id: entry.id, name: entry.dataName, url: entry.url }, 'resource'))
              }
              if (data.totalPages === 0 && data.datalist.length) throw new ChaoxingHttpError(operation)
              if (page >= data.totalPages) break
              if (page === 50) truncated = true
            }
          } else {
            const data = topicResponseSchema.parse(await request(operation, token, { courseId: courseId!, query: keyword }, deadline))
            const pending = [...data.data.list]
            let count = 0
            while (pending.length && count++ < 5000) {
              const entry = topicSchema.parse(pending.shift())
              if (entry.subList) pending.push(...entry.subList)
              if (entry.type === 0 && !rows.some(row => row.id === entry.id)) rows.push(convert({ id: entry.id, name: entry.content }, 'topic'))
            }
            if (pending.length) truncated = true
          }
        } catch (error) {
          if (error instanceof ChaoxingHttpError) throw error
          throw new ChaoxingHttpError(operation)
        }
        return { rows, truncated }
      }
      for (const operation of target === 'all' ? ['resources', 'topics'] as const : [target]) {
        let result = await search(operation, query)
        if (!result.rows.length) result = await search(operation, query)
        if (!result.rows.length) {
          result = await search(operation, '')
          result.rows = result.rows.filter(row => row.name.toLowerCase().includes(query.toLowerCase()))
        }
        if (result.truncated) notes.push(`${operation === 'resources' ? '资料分页' : '知识点树'}达到处理上限，结果可能不完整`)
        resources.push(...result.rows)
      }
      if (resources.length > 50) notes.push('资料数量较多，展示上限50个资料')
      notes.push('课程名称未取得，当前仅显示课程 ID；所有结果仅作目录推荐，未取得正文，不能推断课程内容')
      if (resources.some(row => !row.url)) notes.push('部分资源未返回可访问链接，不应编造链接')
      return { resources: resources.slice(0, 50), limitations: notes }
    },
  }
}
