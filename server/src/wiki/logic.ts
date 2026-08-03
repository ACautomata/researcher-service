// wiki 纯逻辑协作者（#335 · #315 §3 平移 backend/wiki/service.py 纯函数/纯逻辑层）。
// 与文件系统解耦：FrontmatterParser / CategoryMarkerExtractor / WikilinkResolver。
// 组合进 WikiService（service.ts）；单测注入 fake FS 直测，不需真实磁盘。
// 按 #315 §3 命名建议用小型不可组合对象，勿套类层级。

import { CATEGORY_RE, EXCERPT_LEN, H1_RE, H2_RE, WIKILINK_RE } from './values'

// frontmatter 值：标量或行内 [a,b] 列表（嵌套键如 paper:/claims: 被跳过，不解析）。
export type FrontmatterValue = string | string[]
export type Frontmatter = Record<string, FrontmatterValue>

// Python str.strip(chars) 语义：先剥首尾所有 `"`、再剥首尾所有 `'`（顺序与实现同 Django）。
function stripQuotes(v: string): string {
  return v.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')
}

// 简易逐行 YAML frontmatter 解析（r29 §3.4：人读浏览页只需 title 与标量标签，不引入 yaml 库）。
// 坑（#315 §3 原样保留）：content.find('---', 3) 会把正文里任意 `---`（含 `----` 分隔线）当
// frontmatter 结束——逐字平移此歧义，勿「修正」为严格 YAML。
export class FrontmatterParser {
  parse(content: string): { frontmatter: Frontmatter; body: string } {
    const frontmatter: Frontmatter = {}
    let body = content
    if (content.startsWith('---')) {
      const end = content.indexOf('---', 3)
      if (end > 0) {
        const yamlText = content.slice(3, end).trim()
        body = content.slice(end + 3).trim()
        for (const rawLine of yamlText.split('\n')) {
          const line = rawLine.trimEnd() // Python line.rstrip()
          if (!line || line.startsWith('#')) continue
          const colon = line.indexOf(':')
          if (colon < 0) continue
          const key = line.slice(0, colon).trim()
          let val: string | string[] = line.slice(colon + 1).trim()
          if (val.startsWith('[') && val.endsWith(']')) {
            val = val
              .slice(1, -1)
              .split(',')
              .filter((v) => v.trim() !== '')
              .map((v) => stripQuotes(v.trim()))
          } else if (val) {
            val = stripQuotes(val)
          } else {
            continue // 嵌套键（paper:/claims:）无行内值，跳过
          }
          if (key && val !== '') frontmatter[key] = val
        }
      }
    }
    return { frontmatter, body }
  }
}

// 从 markdown 正文提取 `` `category:` `` 机读标记 + 摘要（issue #84 / spec #75）。
// 提取只在「第一个 H1 之下、首个 `##` 之前」窗口内：行内混排、H1 之前、首个 `##` 之后的标记不抓。
// 开放词表：扫到什么值返回什么，不预设集合。
export class CategoryMarkerExtractor {
  extractCategory(body: string): string | null {
    const window = this.window(body)
    if (window === null) return null
    const m = CATEGORY_RE.exec(window)
    return m ? m[1].toLowerCase() : null
  }

  // 正文开头片段摘要：剥掉 H1 标题行与 category 标记行，压缩空白后按码点截断。
  excerpt(body: string): string {
    const lines = body.split('\n').filter((ln) => {
      if (!ln.trim()) return false
      if (ln.startsWith('# ')) return false
      if (CATEGORY_RE.test(ln)) return false
      return true
    })
    const text = lines.join(' ').replace(/\s+/g, ' ').trim()
    return Array.from(text).slice(0, EXCERPT_LEN).join('')
  }

  private window(body: string): string | null {
    const lines = body.split('\n')
    const h1 = lines.findIndex((ln) => H1_RE.test(ln))
    if (h1 < 0) return null
    const h2 = lines.findIndex((ln, i) => i > h1 && H2_RE.test(ln))
    const end = h2 < 0 ? lines.length : h2
    return lines.slice(h1 + 1, end).join('\n')
  }
}

// 把 wikilink 目标解析为节点 id（path 末段 stem / title / 整串 id 兜底，r29 §3.3 先见者优先）。
// 构造注入全部页面（{path,title}）；重复 stem/title 用 setdefault 语义（先见者不覆盖）。
export class WikilinkResolver {
  private readonly byStem = new Map<string, string>()
  private readonly byTitle = new Map<string, string>()
  private readonly ids = new Set<string>()

  constructor(pages: readonly { path: string; title: string }[]) {
    for (const p of pages) {
      const path = p.path
      this.ids.add(path)
      const stem = path.endsWith('.md')
        ? path.slice(path.lastIndexOf('/') + 1, -3)
        : path // 非 .md 时整串入 stem（与 Django else 分支一致；现实中 tree 页必 .md）
      if (!this.byStem.has(stem)) this.byStem.set(stem, path)
      if (p.title && !this.byTitle.has(p.title)) this.byTitle.set(p.title, path)
    }
  }

  resolve(target: string): string | null {
    const t = target.trim()
    if (this.ids.has(t)) return t
    let stem = t.includes('/') ? t.slice(t.lastIndexOf('/') + 1) : t
    if (stem.endsWith('.md')) stem = stem.slice(0, -3)
    const byStem = this.byStem.get(stem)
    if (byStem !== undefined) return byStem
    const byTitle = this.byTitle.get(t)
    if (byTitle !== undefined) return byTitle
    return null
  }
}

// 供 service.buildGraph 从正文取 wikilink 目标（[[target|别名]] 取 `|` 前、strip 空白）。
export function wikilinkTargets(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(WIKILINK_RE)) {
    out.push(m[1].split('|')[0].trim())
  }
  return out
}

// 页面标题 frontmatter 取值（Django `fm.get('paper.title') or fm.get('title')` or 链）。
// '' / 空数组视为缺失；title 若为列表（畸形边缘）收敛为字符串，前端 title 类型恒 string。
export function frontmatterTitle(frontmatter: Frontmatter): string | undefined {
  for (const key of ['paper.title', 'title'] as const) {
    const v = frontmatter[key]
    if (v === undefined) continue
    if (typeof v === 'string') return v === '' ? undefined : v
    if (Array.isArray(v) && v.length > 0) return v.join('')
  }
  return undefined
}
