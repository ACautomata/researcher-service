import { publicResourceSearchSchema } from '../../server/src/validation/schemas'
import { searchPublicResources } from '../../server/src/publicResourceSearch'
import { fail } from '../../server/src/envelope'
import { CODE } from '../../server/src/codes'
import type { PluginToolExec, PluginCommandOutcome } from '../../server/src/plugins/api'

export const RESOURCE_SEARCH_TOOL = 'public_resource_search'
export const resourceSearchParameters = publicResourceSearchSchema
export const RESOURCE_SEARCH_USAGE = '/resource-search <学习问题或关键词>'

export async function resourceSearchCommand(args: string): Promise<PluginCommandOutcome> {
  const parsed = resourceSearchParameters.safeParse({ query: args })
  if (!parsed.success) throw fail(CODE.VALIDATION_FAILED, `用法：${RESOURCE_SEARCH_USAGE}（1–200 个字符）`)
  return { execute: { tool: RESOURCE_SEARCH_TOOL, args: parsed.data } }
}

export async function executeResourceSearch(_toolCallId: string, params: { query: string }, exec: PluginToolExec) {
  const { query } = resourceSearchParameters.parse(params)
  const result = await searchPublicResources(query, {
    enabled: exec.ctx.config.PUBLIC_RESOURCE_SEARCH_ENABLED === 'true', signal: exec.signal,
  })
  // details shares the tool.end 4KB budget. Reserve room for the envelope and retain
  // both documents and videos; never cut JSON in the middle of a resource link.
  const documents = result.results.filter(item => item.kind === 'document').slice(0, 3)
  const videos = result.results.filter(item => item.kind === 'video').slice(0, 3)
  const selected = [0, 1, 2].flatMap(index => [documents[index], videos[index]].filter(item => item !== undefined))
  const resources: typeof result.results = []
  for (const item of selected) {
    const compact = { ...item, title: item.title.slice(0, 100), snippet: '' }
    if (Buffer.byteLength(JSON.stringify([...resources, compact]), 'utf8') <= 3000) resources.push(compact)
  }
  const details = { query, results: resources, partial: result.partial, total: result.results.length }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ...details, contentVerified: false, popularityVerified: false }) }],
    details,
  }
}
