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
  '查询本人有权限的课程资料；使用已同步课程清单，暂不支持全校课程发现',
  '资料按名称检索，使用本人超星授权和课程成员权限；课程/班级发现、正文读取尚未提供',
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
      if (!response.ok) { await response.body?.cancel(); throw new ChaoxingHttpError(operation, response.status, 'http_rejected') }
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
          if (size > 2_000_000) throw new ChaoxingHttpError(operation, undefined, 'too_large')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (data && typeof data === 'object' && ('status' in data && (data.status === false || data.status === 'false') || 'result' in data && data.result === false)) {
        throw new ChaoxingHttpError(operation, undefined, 'business_rejected')
      }
      return data
    } catch (error) {
      if (error instanceof ChaoxingHttpError) throw error
      throw new ChaoxingHttpError(operation, undefined, error instanceof SyntaxError ? 'invalid_json' : 'transport')
    }
  }
  return {
    exchange: (code, verifier) => oauth({ grant_type: 'authorization_code', code, redirect_uri: options.redirectUri, ...(options.pkce !== false ? { code_verifier: verifier } : {}) }),
    refresh: refreshToken => oauth({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    courses: async () => ({ rows: [], truncated: false }),
    // 这里只报告本地接入契约，不把 HTTP 请求假装成 MCP 初始化或真实权限验收。
    inspect: async () => ({ tools: [], capabilities: [], http: {
      transport: 'https-json', authentication: 'oauth-bearer', callVerified: false,
      endpoints: (['resources', 'topics'] as const).map(capability => ({ capability, method: 'GET', url: endpoints[capability] })),
      limitations,
    } }),
    learn: async (token, query, courseId, signal, target = 'all', classId) => {
      if (!courseId || !/^[1-9][0-9]{0,29}$/.test(courseId)) throw new ChaoxingConfigError('请先在账号设置同步课程清单，或提供明确的数字课程 ID')
      if (target !== 'topics' && (!classId || !/^[1-9][0-9]{0,29}$/.test(classId))) throw new ChaoxingConfigError('学生资料检索还需要该课程的班级 ID，请提供 classId；不能使用教师身份代替')
      const deadline = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])])
      const notes = [...limitations]
      if (target === 'all') notes.push('第一版自动推荐仅查询课程资料，知识点查询暂缓，不影响资料结果')
      const resources: LearningResource[] = []
      // 本人浏览器实测的官方资料页，仅需课程/班级；不复制 cpi、stuenc 或云盘临时签名。
      const courseDataUrl = new URL('https://mooc2-ans.chaoxing.com/mooc2-ans/coursedata/stu-datalist')
      courseDataUrl.search = new URLSearchParams({ courseid: courseId, clazzid: classId ?? '', ut: 's' }).toString()
      const convert = (entry: { id: string; name: string; url?: string }, kind: LearningResource['kind']): LearningResource => ({
        id: entry.id, name: entry.name.slice(0, 500), courseId, courseName: `课程 ${courseId}`, kind,
        ...(link(entry.url) ? { url: link(entry.url) } : {}),
        ...(kind === 'resource' ? { courseDataUrl: courseDataUrl.href } : {}),
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
          throw new ChaoxingHttpError(operation, undefined, error instanceof z.ZodError ? 'response_schema' : 'transport')
        }
        return { rows, truncated }
      }
      // 默认推荐只使用已核验的资料入口；知识点拒绝不能阻断资料推荐。
      for (const operation of target === 'all' ? ['resources'] as const : [target]) {
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
      notes.push('所有结果仅作目录推荐，未取得正文，不能推断课程内容；课程名称来自已同步清单，未同步时仅显示课程 ID')
      if (resources.some(row => row.kind === 'resource')) notes.push('前往课程资料：需在当前浏览器登录本人超星账号并具备课程权限；进入后按文件名搜索或文件夹定位，再点击资料预览。该入口不是单份文件直达链接')
      if (resources.some(row => !row.url)) notes.push('部分资源未返回文件直达链接；课程资料页入口与文件直达链接需区分，不应编造下载或预览地址')
      return { resources: resources.slice(0, 50), limitations: notes }
    },
  }
}
