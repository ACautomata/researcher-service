import { z } from 'zod'
import { fail } from './envelope'
import { CODE } from './codes'
import { publicResourceSearchSchema } from './validation/schemas'

const searchResult = z.object({ title: z.string(), url: z.string(), content: z.string().optional() }).passthrough()
const responseSchema = z.object({ results: z.array(searchResult).max(200), unresponsive_engines: z.array(z.unknown()).optional() })
const knownPublishers: Record<string, string> = { 'cn.vuejs.org': 'Vue 中文官方文档', 'vuejs.org': 'Vue 官方文档', 'www.pep.com.cn': '人民教育出版社' }
export function formatResourceResults(data: z.infer<typeof responseSchema>) {
  const seen = new Set<string>()
  const results = data.results.flatMap((item) => {
    let url: URL
    try { url = new URL(item.url) } catch { return [] }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return []
    if (seen.has(url.href)) return []
    seen.add(url.href)
    const host = url.hostname.toLowerCase()
    if (host === 'ai.so.com' || (host.endsWith('bilibili.com') && url.pathname.startsWith('/cheese/'))) return []
    const video = host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'youtube.com' || host.endsWith('.youtube.com')
    return [{ title: item.title.slice(0, 300), url: url.href, snippet: (item.content ?? '').slice(0, 350), kind: video ? 'video' : 'document', publisher: knownPublishers[host] ?? null }]
  })
  results.sort((a, b) => Number(Boolean(b.publisher)) - Number(Boolean(a.publisher)))
  // Preserve video candidates even when a web source fills the first page.
  const videos = results.filter(item => item.kind === 'video').slice(0, 3)
  const documents = results.filter(item => item.kind !== 'video').slice(0, 30 - videos.length)
  return { results: [...documents, ...videos], partial: Boolean(data.unresponsive_engines?.length) }
}
export async function searchPublicResources(query: string, options: { enabled: boolean; signal?: AbortSignal; fetch?: typeof fetch }) {
  if (!options.enabled) throw fail(CODE.INTERNAL, '公开资源搜索尚未配置，请联系管理员')
  const parsedQuery = publicResourceSearchSchema.parse({ query }).query
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000)
  try {
    // Two bounded requests: web sources cannot displace the video query, and
    // the developer feed that returned unrelated articles is deliberately excluded.
    const requests = await Promise.allSettled([
      { engines: '360search,sogou', categories: 'general' },
      { engines: 'bilibili', categories: 'videos' },
    ].map(async source => {
      const url = new URL('http://searxng:8080/search')
      url.search = new URLSearchParams({ q: parsedQuery, format: 'json', language: 'zh-CN', ...source }).toString()
      const response = await (options.fetch ?? fetch)(url, { signal, redirect: 'error' })
      if (!response.ok) throw new Error('search unavailable')
      return responseSchema.parse(await response.json())
    }))
    if (signal.aborted) throw new Error('search aborted')
    const results: z.infer<typeof searchResult>[] = []
    const failures: unknown[] = []
    for (const request of requests) {
      if (request.status === 'rejected') failures.push('source unavailable')
      else {
        results.push(...request.value.results)
        failures.push(...(request.value.unresponsive_engines ?? []))
      }
    }
    if (!results.length && failures.length) throw new Error('search sources unavailable')
    return formatResourceResults({ results, unresponsive_engines: failures })
  } catch {
    if (options.signal?.aborted) throw fail(CODE.INTERNAL, '公开资源搜索已取消')
    throw fail(CODE.INTERNAL, '搜索服务暂时不可用，请稍后重试')
  }
}
