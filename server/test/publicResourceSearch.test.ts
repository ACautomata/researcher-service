import { describe, expect, it } from 'vitest'
import { formatResourceResults, searchPublicResources } from '../src/publicResourceSearch'
import { publicResourceSearchSchema } from '../src/validation/schemas'
describe('public resource search', () => {
  it('labels known publishers, keeps video candidates and rejects unsafe or duplicate links', () => {
    const result = formatResourceResults({ results: [
      { title: '视频', url: 'https://www.bilibili.com/video/BV123' },
      { title: '官方文档', url: 'https://cn.vuejs.org/guide/' },
      { title: '伪造站点', url: 'https://cn.vuejs.org.evil.example/guide/' },
      { title: '重复', url: 'https://cn.vuejs.org/guide/' },
      { title: '脚本', url: 'javascript:alert(1)' },
    ], unresponsive_engines: [['brave', 'timeout']] })
    expect(result.partial).toBe(true)
    expect(result.results).toHaveLength(3)
    expect(result.results[0]).toMatchObject({ publisher: 'Vue 中文官方文档', kind: 'document' })
    expect(result.results.find(x => x.title === '视频')).toMatchObject({ kind: 'video', publisher: null })
    expect(result.results.find(x => x.title === '伪造站点')?.publisher).toBeNull()
  })
  it('requires a short non-empty query', () => {
    expect(publicResourceSearchSchema.safeParse({ query: '  ' }).success).toBe(false)
    expect(publicResourceSearchSchema.safeParse({ query: 'a'.repeat(201) }).success).toBe(false)
    expect(publicResourceSearchSchema.parse({ query: '  特征向量  ' }).query).toBe('特征向量')
  })
})

import { afterEach, vi } from 'vitest'
import publicResourcesManifest from '../../plugins/public-resources/manifest'
import { resourceSearchCommand, executeResourceSearch, RESOURCE_SEARCH_TOOL } from '../../plugins/public-resources/server'
import { toLangChainTool } from '../src/plugins/tools'
import { buildPluginPrompt, createPluginRuntime } from '../src/plugins/surface'
import { PLUGIN_MANIFESTS } from '../../plugins/index'

const logger = { info: () => {}, warn: () => {} }
const ctx = { config: { PUBLIC_RESOURCE_SEARCH_ENABLED: 'true' }, logger }
afterEach(() => vi.unstubAllGlobals())

it('explicit command and agent tool share real search and expose actual links', async () => {
  const transport = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    results: [{ title: 'Vue 官方文档', url: 'https://cn.vuejs.org/guide/' }, { title: '视频', url: 'https://www.bilibili.com/video/BV123' }],
    unresponsive_engines: [['brave', 'too many requests']],
  }), { status: 200 }))
  vi.stubGlobal('fetch', transport)
  const command = await resourceSearchCommand('  响应式原理  ')
  if (!('execute' in command)) throw new Error('Expected execute outcome')
  expect(command.execute.tool).toBe(RESOURCE_SEARCH_TOOL)
  const manual = await executeResourceSearch('manual', command.execute.args as { query: string }, { ctx, signal: new AbortController().signal })
  const def = publicResourcesManifest.tools![0]!
  const agent = toLangChainTool(def, ctx, publicResourcesManifest.id)
  const answer = await agent.invoke({ query: '响应式原理' })
  expect(JSON.parse(String(answer))).toMatchObject({ results: manual.details.results, partial: true, contentVerified: false, popularityVerified: false })
  expect(transport).toHaveBeenCalledTimes(4)
  expect(String(transport.mock.calls[0]![0])).toContain('http://searxng:8080/search?')
  expect(manual.details.results.map(item => item.url)).toEqual(['https://cn.vuejs.org/guide/', 'https://www.bilibili.com/video/BV123'])
})

it('rejects invalid commands and disabled search without contacting upstream', async () => {
  await expect(resourceSearchCommand('')).rejects.toThrow('用法')
  const transport = vi.fn()
  vi.stubGlobal('fetch', transport)
  await expect(executeResourceSearch('disabled', { query: '数学' }, { ctx: { ...ctx, config: {} }, signal: new AbortController().signal })).rejects.toThrow('尚未配置')
  expect(transport).not.toHaveBeenCalled()
})

it('only enabled skills expose tools, commands and learning guidelines', () => {
  const runtime = createPluginRuntime({ manifests: PLUGIN_MANIFESTS, config: {} })
  expect(runtime.surface([]).tools.some(tool => tool.name === RESOURCE_SEARCH_TOOL)).toBe(false)
  const enabled = runtime.surface(['public-resources'])
  expect(enabled.tools.map(tool => tool.name)).toEqual([RESOURCE_SEARCH_TOOL])
  expect(enabled.commands.map(command => command.command.name)).toEqual(['resource-search'])
  expect(enabled.prompt).toContain('For concrete learning questions')
  expect(Buffer.byteLength(buildPluginPrompt(PLUGIN_MANIFESTS), 'utf8')).toBeLessThanOrEqual(4096)
})

it('queries documents and videos, and does not disguise unavailable empty search as no matches', async () => {
  const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [], unresponsive_engines: [['sogou', 'timeout']] })))
  await expect(searchPublicResources('Vue', { enabled: true, fetch: transport })).rejects.toThrow('搜索服务暂时不可用')
  expect(String(transport.mock.calls[0]![0])).toContain('engines=360search%2Csogou')
  expect(String(transport.mock.calls[1]![0])).toContain('engines=bilibili')
})

it('retains videos when a web source fills the result budget', () => {
  const result = formatResourceResults({ results: [
    ...Array.from({ length: 35 }, (_, i) => ({ title: `资料${i}`, url: `https://example.org/${i}` })),
    { title: '中文数学视频', url: 'https://www.bilibili.com/video/BV123' },
  ] })
  expect(result.results).toHaveLength(30)
  expect(result.results.some(item => item.kind === 'video')).toBe(true)
})

it('keeps actual video results if web transport fails and marks partial', async () => {
  const transport = vi.fn().mockImplementation(async (url: URL) => {
    if (url.searchParams.get('engines') !== 'bilibili') throw new Error('timeout')
    return new Response(JSON.stringify({ results: [{ title: '特征值', url: 'https://www.bilibili.com/video/BV123' }] }))
  })
  const result = await searchPublicResources('特征值', { enabled: true, fetch: transport })
  expect(result).toMatchObject({ partial: true, results: [{ kind: 'video' }] })
})
