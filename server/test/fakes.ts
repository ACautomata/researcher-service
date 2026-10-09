// 测试共享 fake（#621）：内存 WikiFileSystem（wiki 域 Port，src/wiki/fsPort.ts）。
// 供 wiki.test.ts（REST 契约，经 serviceFor 注入）与 wikiService.test.ts（service 聚合逻辑）共用。
// 行为语义对齐生产适配器（DockerWikiFileSystem / 退役的 NodeWikiFileSystem）：
//   - validatePath：拒 `..` / SKIP_DIRS 段 / SKIP_FILES 末段 → WikiInvalidPath（managed 黑名单）；
//   - buildTree：按顶层目录分组，顶层散落页不收；title = frontmatter → stem（**无 H1**，对齐真实现）；
//   - readPage：title = frontmatter → stem（**无 H1**）。
// 只余读面：写面三方法（writePage/createPage/deletePage）随 #758 Q3 写面整域退役删除——
// 测试播种/改页直接写 pages/claims Map。

import { claimsSidecarPath, FrontmatterParser, frontmatterTitle } from '../src/wiki/logic'
import { SKIP_DIRS, SKIP_FILES } from '../src/wiki/values'
import { WikiInvalidPath, WikiPageNotFound } from '../src/wiki/errors'
import type {
  WikiFileSystem,
  WikiTree,
  WikiTreeGroup,
  WikiTreePage,
} from '../src/wiki/fsPort'

export class FakeWikiFileSystem implements WikiFileSystem {
  pages = new Map<string, string>()
  // .claims 旁车（#789）：键 = 旁车完整路径（'.claims/concepts/a.json'），构造条目按前缀分桶。
  claims = new Map<string, string>()

  constructor(entries: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(entries)) {
      if (k.startsWith('.claims/')) this.claims.set(k, v)
      else this.pages.set(k, v)
    }
  }

  private validatePath(relPath: string): void {
    const parts = relPath.split('/').filter(Boolean)
    if (parts.some((p) => p === '..')) throw new WikiInvalidPath(relPath)
    if (parts.some((p) => SKIP_DIRS.has(p))) throw new WikiInvalidPath(relPath)
    if (parts.length && SKIP_FILES.has(parts[parts.length - 1])) throw new WikiInvalidPath(relPath)
  }

  // 扫描侧 SKIP 过滤（buildTree 用）：任一段命中 SKIP_DIRS 或末段命中
  // SKIP_FILES → 跳过（对齐生产适配器 isPageEntry；读侧 readPage 才是 validatePath 拒绝）。
  private isSkipped(relPath: string): boolean {
    const parts = relPath.split('/')
    if (parts.some((p) => SKIP_DIRS.has(p))) return true
    return SKIP_FILES.has(parts[parts.length - 1])
  }

  private stemOf(relPath: string): string {
    const base = relPath.slice(relPath.lastIndexOf('/') + 1)
    return base.endsWith('.md') ? base.slice(0, -3) : base
  }

  // buildTree / readPage 的 title 链：frontmatter → stem（无 H1 fallback，对齐真实现）。
  private treeTitleOf(content: string, stem: string): string {
    const { frontmatter } = new FrontmatterParser().parse(content)
    return frontmatterTitle(frontmatter) ?? stem
  }

  async buildTree(): Promise<WikiTree> {
    const groups = new Map<string, WikiTreeGroup>()
    for (const rel of [...this.pages.keys()].sort()) {
      if (!rel.endsWith('.md')) continue // 只收 .md（对齐生产适配器）
      if (this.isSkipped(rel)) continue // 扫描侧 SKIP 过滤（读侧才是 validatePath 拒绝）
      const slash = rel.indexOf('/')
      if (slash < 0) continue // 顶层散落页不收
      const top = rel.slice(0, slash)
      const item: WikiTreePage = { path: rel, title: this.treeTitleOf(this.pages.get(rel)!, this.stemOf(rel)) }
      if (!groups.has(top)) groups.set(top, { kind: top, name: top, pages: [] })
      groups.get(top)!.pages.push(item)
    }
    return { groups: [...groups.values()].map((g) => ({ kind: g.kind, name: g.name, pages: g.pages })) }
  }

  async readPage(relPath: string): Promise<{ path: string; title: string; content: string }> {
    this.validatePath(relPath)
    const content = this.pages.get(relPath)
    if (content === undefined) throw new WikiPageNotFound(relPath)
    return { path: relPath, title: this.treeTitleOf(content, this.stemOf(relPath)), content }
  }

  async readClaimsFile(relPath: string): Promise<string | null> {
    return this.claims.get(claimsSidecarPath(relPath)) ?? null
  }
}
