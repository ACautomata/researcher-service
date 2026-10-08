// wiki 纯逻辑协作者（#335 · #315 §3 平移 backend/wiki/service.py 纯函数/纯逻辑层）。
// 与文件系统解耦：FrontmatterParser / WikilinkResolver。
// 组合进 WikiService（service.ts）；单测注入 fake FS 直测，不需真实磁盘。
// 按 #315 §3 命名建议用小型不可组合对象，勿套类层级。

import { createHash } from 'node:crypto'

import { WIKILINK_RE } from './values'

// 字典序比较（对齐 Python 的 Unicode code-point 序）。
// JS 的 `a < b` 按 UTF-16 code-unit 序：非 BMP 字符（emoji 等代理对 [D800–DFFF]）会排在高 BMP
// 字符（如 fullwidth U+FF21）之前，与 Python code-point 序相反。树/图排序与
// WikilinkResolver 对重复 stem/title 先见者优先——顺序反转让同一 [[target]] 边解析到不同页面
// （codex PR#346 第三轮 nodeFs / 第五轮 service）。按 code-point 比较。
export function cmp(a: string, b: string): number {
  const ax = [...a] // 按 Unicode code-point 迭代（解开代理对）
  const bx = [...b]
  const n = Math.min(ax.length, bx.length)
  for (let i = 0; i < n; i += 1) {
    const ca = ax[i].codePointAt(0) ?? 0
    const cb = bx[i].codePointAt(0) ?? 0
    if (ca !== cb) return ca < cb ? -1 : 1
  }
  return ax.length - bx.length
}

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

// OKF 页间关系是 markdown 相对链接 `[text](../dir/page.md)`，不是 `[[wikilink]]`（#725 §三：
// 现有 graph 派生只认 wikilink → OKF wiki 是空图）。提取规则（V1）：只收 .md 结尾的相对目标
// ——剥 `#` 片段、`"title"` 后缀与 `./` 前缀；scheme（http:/mailto: 等）、根绝对（/ 开头）、
// 空/纯锚目标不收；图片 `![]()` 因非 .md 自然排除。目标解析与 ghost 复用 WikilinkResolver
// 现有机制（stem/title 已有；不可解析 → ghost，obsidian 死链语义同构，story 43）。
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

export function markdownLinkTargets(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(MD_LINK_RE)) {
    let target = m[1]
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    const hash = target.indexOf('#')
    if (hash >= 0) target = target.slice(0, hash)
    if (target.startsWith('./')) target = target.slice(2)
    if (target === '' || !target.endsWith('.md')) continue
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue
    if (target.startsWith('/')) continue
    out.push(target)
  }
  return out
}

// OKF 徽章字段（story 41 数据面）：front matter 的 status / stale_after / generated.at。
// 简易 FrontmatterParser 不解析行内 flow mapping（`generated: {by, at}` 成字符串且嵌套列表
// 跳过，#725 §三判定「无需动」），OKF 字段专用提取在此单点实现；块界定沿用同款
// `content.find('---', 3)` 歧义语义（logic.ts 头注：逐字保留，勿修正）。
export interface OkfBadge {
  status?: string
  staleAfter?: string
  generatedAt?: string
}

const OKF_GENERATED_AT_RE = /\bat:\s*"?([^",}]+)"?/

function frontmatterBlock(content: string): string | null {
  if (!content.startsWith('---')) return null
  const end = content.indexOf('---', 3)
  if (end < 0) return null
  return content.slice(3, end)
}

export function okfBadge(content: string): OkfBadge | undefined {
  const block = frontmatterBlock(content)
  if (block === null) return undefined
  const badge: OkfBadge = {}
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()
    const status = /^status:\s*(.+)$/.exec(line)
    if (status) {
      badge.status = stripQuotes(status[1].trim())
      continue
    }
    const staleAfter = /^stale_after:\s*(.+)$/.exec(line)
    if (staleAfter) {
      badge.staleAfter = stripQuotes(staleAfter[1].trim())
      continue
    }
    // generated 的 at 在行内 flow mapping 里（`{by: x, at: ...}`），整行取值段再提 at
    const generated = /^generated:\s*(.+)$/.exec(line)
    if (generated) {
      const at = OKF_GENERATED_AT_RE.exec(generated[1])
      if (at) badge.generatedAt = stripQuotes(at[1].trim())
    }
  }
  return Object.keys(badge).length > 0 ? badge : undefined
}

// .claims 旁车与页面目录结构镜像、同名 .json（#725 §二）：`concepts/a.md` → `.claims/concepts/a.json`。
export function claimsSidecarPath(page: string): string {
  const slash = page.lastIndexOf('/')
  const dir = slash < 0 ? '' : page.slice(0, slash)
  const base = slash < 0 ? page : page.slice(slash + 1)
  const stem = base.endsWith('.md') ? base.slice(0, -3) : base
  return dir === '' ? `.claims/${stem}.json` : `.claims/${dir}/${stem}.json`
}

// claims 旁车结构化提取（#725 §二确切结构；lenient——畸形条目跳过不炸，消费面是只读展示）。
export interface WikiClaimEvidence {
  resource: string
  version?: string
}
export interface WikiClaim {
  id: string
  statement: string
  evidence: WikiClaimEvidence[]
}
export interface ParsedClaimsSidecar {
  schemaVersion: number | null
  pageVersion: string | null
  claims: WikiClaim[]
}

export function parseClaimsSidecar(raw: string): ParsedClaimsSidecar | null {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof doc !== 'object' || doc === null) return null
  const o = doc as Record<string, unknown>
  const claims: WikiClaim[] = []
  if (Array.isArray(o.claims)) {
    for (const c of o.claims) {
      if (typeof c !== 'object' || c === null) continue
      const co = c as Record<string, unknown>
      if (typeof co.statement !== 'string') continue
      const evidence: WikiClaimEvidence[] = []
      if (Array.isArray(co.evidence)) {
        for (const ev of co.evidence) {
          if (typeof ev !== 'object' || ev === null) continue
          const evo = ev as Record<string, unknown>
          if (typeof evo.resource !== 'string') continue
          evidence.push(
            typeof evo.version === 'string'
              ? { resource: evo.resource, version: evo.version }
              : { resource: evo.resource },
          )
        }
      }
      claims.push({ id: typeof co.id === 'string' ? co.id : '', statement: co.statement, evidence })
    }
  }
  return {
    schemaVersion: typeof o.schemaVersion === 'number' ? o.schemaVersion : null,
    pageVersion: typeof o.pageVersion === 'string' ? o.pageVersion : null,
    claims,
  }
}

// 页级漂移（story 42 数据面）：openwiki 的 pageVersion = 页文件字节的 sha256
//（`sha256:<hex>`，openwiki claims store hashPage 同源），与当前页内容 utf8 重编码后比对。
// 旁车缺失 / 无 pageVersion / 非 sha256: 形态 → null（前端「无证据面板」语义）。
// repo:// 源文件的 evidence 漂移语义（725 §五-4）归后续票定稿，V1 数据面不解析。
export function claimsDrift(pageVersion: string | null, content: string): 'fresh' | 'drifted' | null {
  if (pageVersion === null || !pageVersion.startsWith('sha256:')) return null
  const current = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
  return pageVersion.slice('sha256:'.length) === current ? 'fresh' : 'drifted'
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

// UTF-8 严格解码：非法字节抛 TypeError（对齐 Python read_text(encoding='utf-8') 的
// UnicodeDecodeError；Node 默认 toString('utf8') 用 U+FFFD 静默替换，会破坏降级语义）。
// ignoreBOM:true 保留 U+FEFF（Python read_text 逐字节保留 BOM；默认 false 会吞掉——GET 不再原文
// 返回、round-trip 丢 BOM、解析层把 BOM 前缀页误识别成 frontmatter。codex PR#346）。
// （自 nodeFs.ts 搬入：Node 适配器退役后由 Docker 适配器复用。）
export function decodeUtf8Strict(buf: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
}
