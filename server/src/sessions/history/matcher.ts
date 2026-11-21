import type { HistoryEvidence, HistoryMatch } from './model'
import type { HistoryRequest } from './params'

type Search = Extract<HistoryRequest, { operation: 'search' }>
const DEFAULT_FIELDS = ['user_content', 'assistant_content', 'tool_name', 'tool_input', 'tool_result']

export function withinTime(value: string, time: Search['time']): boolean {
  const at = Date.parse(value)
  return (!time?.from || at >= Date.parse(time.from)) && (!time?.to || at < Date.parse(time.to))
}

export function literalContains(text: string, query: string, caseSensitive: boolean): boolean {
  return fold(text, caseSensitive).includes(fold(query, caseSensitive))
}

// 合同默认忽略英文大小写；ASCII 折叠保持原字段偏移，不受 Unicode 大小写展开影响。
const fold = (text: string, sensitive: boolean): string => sensitive ? text : text.replace(/[A-Z]/g, c => c.toLowerCase())

export function matchMessage(message: HistoryEvidence, request: Search): HistoryMatch[] {
  if (!request.query) return []
  const fields = request.fields ?? DEFAULT_FIELDS
  const regions: { field: string; text: string; toolCallId?: string; name?: string }[] = []
  const bodyField = message.role === 'user' ? 'user_content' : message.role === 'assistant' ? 'assistant_content' : undefined
  if (bodyField && fields.includes(bodyField)) regions.push({ field: bodyField, text: message.content })
  if (fields.includes('thinking') && message.thinking !== undefined) regions.push({ field: 'thinking', text: message.thinking })
  for (const tool of message.tools ?? []) {
    for (const [field, key] of [['tool_name', 'name'], ['tool_input', 'input'], ['tool_result', 'details']] as const) {
      if (fields.includes(field) && typeof tool[key] === 'string') regions.push({ field, text: tool[key],
        ...(typeof tool.toolCallId === 'string' ? { toolCallId: tool.toolCallId } : {}),
        ...(typeof tool.name === 'string' ? { name: tool.name } : {}),
      })
    }
  }
  return regions.flatMap(region => {
    const query = request.query!
    const found = query.mode === 'regex' ? new RegExp(query.text, request.case_sensitive ? 'u' : 'iu').exec(region.text) : undefined
    const position = query.mode === 'regex' ? found?.index ?? -1
      : fold(region.text, request.case_sensitive).indexOf(fold(query.text, request.case_sensitive))
    if (position < 0) return []
    // 偏移使用 UTF-16 单位，切点修正代理对，节选不是源截断。
    let start = Math.max(0, position - 80)
    let end = Math.min(region.text.length, Math.max(position + (found?.[0].length ?? query.text.length), start + 320))
    if (start > 0 && /[\uDC00-\uDFFF]/.test(region.text[start]!)) start--
    if (end < region.text.length && /[\uDC00-\uDFFF]/.test(region.text[end]!)) end++
    return [{ ...region, text: region.text.slice(start, end), start, end, omitted_before: start > 0, omitted_after: end < region.text.length }]
  })
}

export function searchExcerpt(message: HistoryEvidence, matches: HistoryMatch[]): HistoryEvidence {
  const { thinking: _thinking, tools: _tools, ...rest } = message
  const body = matches.find(m => m.field === 'user_content' || m.field === 'assistant_content')
  const content = body?.text ?? (matches.length ? '' : [...message.content].slice(0, 320).join(''))
  return { ...rest, content, matches, context_only: matches.length === 0,
    excerpt: { offset_unit: 'utf16', start: body?.start ?? 0, end: body?.end ?? content.length, omitted_before: body?.omitted_before ?? false, omitted_after: body?.omitted_after ?? content.length < message.content.length },
  }
}
