import { parse } from 'yaml'

/** Official visualize reader shape; provenance stays out of the preview. */
export function parseWikiDocument(content: string, fallbackTitle: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  let fields: Record<string, unknown> = {}
  if (match) {
    try {
      const parsed: unknown = parse(match[1], { maxAliasCount: 0 })
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>
    } catch { /* Invalid metadata must not hide readable markdown. */ }
  }
  const text = (key: string) => typeof fields[key] === 'string' ? fields[key] as string : ''
  return {
    type: text('type'), title: text('title') || fallbackTitle,
    description: text('description'),
    tags: Array.isArray(fields.tags) ? fields.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    body: match ? content.slice(match[0].length) : content,
  }
}

export function resolveWikiLink(from: string, href: string): { path: string; anchor: string } | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(href)) return null
  let decoded: string
  try { decoded = decodeURIComponent(href) } catch { return null }
  const [path = '', anchor = ''] = decoded.split('#')
  if (!path.endsWith('.md') || /[\\?\u0000]/.test(path)) return null
  const parts = from.split('/').slice(0, -1)
  for (const part of path.split('/')) {
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else if (part && part !== '.') parts.push(part)
  }
  return { path: parts.join('/'), anchor }
}
