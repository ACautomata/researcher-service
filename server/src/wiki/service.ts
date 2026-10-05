// WikiService（#335 · 平移 backend/wiki/service.py）：单容器 wiki/main 直读/直写组合根。
// 构造注入 WikiFileSystem Port（生产 NodeWikiFileSystem、测试 fake），组合 FrontmatterParser /
// CategoryMarkerExtractor / WikilinkResolver。CRUD 直接委托 Port（域异常透传）；
// buildGraph / listCategories 是本层聚合逻辑（纯逻辑，对 fake FS 可直测）。

import {
  CategoryMarkerExtractor,
  cmp,
  claimsDrift,
  FrontmatterParser,
  markdownLinkTargets,
  okfBadge,
  parseClaimsSidecar,
  WikilinkResolver,
  wikilinkTargets,
} from './logic'
import type {
  WikiCategoryItem,
  WikiClaims,
  WikiFileSystem,
  WikiGraph,
  WikiPage,
  WikiTree,
} from './fsPort'

export class WikiService {
  constructor(
    private readonly fs: WikiFileSystem,
    private readonly parser: FrontmatterParser = new FrontmatterParser(),
    private readonly extractor: CategoryMarkerExtractor = new CategoryMarkerExtractor(),
  ) {}

  buildTree(): Promise<WikiTree> {
    return this.fs.buildTree()
  }

  readPage(relPath: string): Promise<WikiPage> {
    return this.readPageWithOkf(relPath)
  }

  // readPage + OKF 徽章数据面（#789 story 41）：徽章从页 front matter 单点提取，非 OKF 页
  // 无 okf 字段（不进 JSON）。适配器返回的 WikiPage 不带徽章——徽章是聚合层语义。
  private async readPageWithOkf(relPath: string): Promise<WikiPage> {
    const page = await this.fs.readPage(relPath)
    const badge = okfBadge(page.content)
    return badge === undefined ? page : { ...page, okf: badge }
  }

  writePage(relPath: string, content: string): Promise<{ path: string }> {
    return this.fs.writePage(relPath, content)
  }

  createPage(relPath: string, content: string): Promise<{ path: string }> {
    return this.fs.createPage(relPath, content)
  }

  deletePage(relPath: string): Promise<void> {
    return this.fs.deletePage(relPath)
  }

  // claims 只读面（#789 story 42 数据面）：页存在性先于旁车读取（页缺失 → WikiPageNotFound
  // 透传，路由 30040 语义不变）；旁车缺失/畸形 → drift null + 空 claims（sidecar 是 openwiki
  // 生成物，两种情况对消费方同义——无证据面板）。漂移 = pageVersion（页字节 sha256）与当前
  // 页内容比对；repo:// 源文件 evidence 漂移归后续票（725 §五-4），V1 不解析。
  async readClaims(relPath: string): Promise<WikiClaims> {
    const page = await this.readPage(relPath)
    const raw = await this.fs.readClaimsFile(relPath)
    const parsed = raw === null ? null : parseClaimsSidecar(raw)
    if (parsed === null) return { schemaVersion: null, pageVersion: null, drift: null, claims: [] }
    return { ...parsed, drift: claimsDrift(parsed.pageVersion, page.content) }
  }

  // 按 category 标记分组带标记页（issue #84 / spec #75）。返回 `{<cat>:[item,…]}`。
  // 只收带标记页；无标记页与插件私有目录/占位文件（fs 层已过滤）不进响应。组名按字典序、
  // 组内按 path 字典序，保证响应稳定。
  // 用 Map 累积：category 是开放词表、用户可控，`constructor`/`toString` 等值若用普通对象
  // `??=` 会命中继承属性崩溃（codex 评审#1）——Map 无原型链污染。结果对象用 null-prototype：
  // `__proto__` 键在普通对象上会触发原型 setter 而非建自有属性，category 静默丢失（codex PR#346）。
  async listCategories(): Promise<Record<string, WikiCategoryItem[]>> {
    const groups = new Map<string, WikiCategoryItem[]>()
    for (const page of await this.fs.listCategoryPages()) {
      const { body } = this.parser.parse(page.content)
      const category = this.extractor.extractCategory(body)
      if (category === null) continue
      const list = groups.get(category)
      const item: WikiCategoryItem = {
        path: page.path,
        title: page.title,
        category,
        excerpt: this.extractor.excerpt(body),
      }
      if (list) list.push(item)
      else groups.set(category, [item])
    }
    const result: Record<string, WikiCategoryItem[]> = Object.create(null) as Record<string, WikiCategoryItem[]>
    // 组名与组内 path 均按 Unicode code-point 序（cmp）：默认 sort()/`<` 按 UTF-16 code-unit 序，含
    // emoji 等非 BMP 字符时顺序与 Python 相反（codex 第五轮 P2）。
    for (const cat of [...groups.keys()].sort(cmp)) {
      result[cat] = groups.get(cat)!.sort((a, b) => cmp(a.path, b.path))
    }
    return result
  }

  // 全库图谱：节点 = 遍历 tree 全部页；边 = 正文 [[wikilink]] + markdown 相对链接 + frontmatter
  // related_pages。wikilink 目标解析顺序（r29 §3.3）：整串 id → stem（末段去 .md）→ title → ghost。
  // markdown 相对链接目标（#789 story 43，OKF 页间关系）走同一 resolver / ghost 机制。
  // 边逐条 push 不去重（同 from→to 可并存真/ghost）；ghost 节点按首次出现顺序 append。
  async buildGraph(): Promise<WikiGraph> {
    const tree = await this.fs.buildTree()
    const allPages = tree.groups.flatMap((g) => g.pages)
    const resolver = new WikilinkResolver(allPages)
    const nodes: WikiGraph['nodes'] = allPages.map((p) => ({ id: p.path, title: p.title }))
    const nodeIds = new Set(allPages.map((p) => p.path))
    const edges: WikiGraph['edges'] = []
    // 用 Set 记 ghost 已见（不用 `raw in ghosts`：open 词表 wikilink 目标 `constructor`/`toString`
    // 等会命中普通对象继承属性，导致 ghost 节点被漏建——codex 评审#2）。ghost 存储用 Map：
    // `__proto__` 目标在普通对象上会触发原型 setter 而非建键，节点静默丢失、edge 悬空（codex PR#346）。
    const ghostSeen = new Set<string>()
    const ghosts = new Map<string, { id: string; title: string; ghost: true }>()

    for (const page of allPages) {
      let content: string
      try {
        content = (await this.fs.readPage(page.path)).content
      } catch {
        continue // 单页读不出 → 跳过该页（不 500）
      }
      const { frontmatter, body } = this.parser.parse(content)
      const targets = [...wikilinkTargets(body), ...markdownLinkTargets(body)]
      let related = frontmatter['related_pages']
      if (related === undefined) related = []
      else if (typeof related === 'string') related = [related]
      for (const raw of related) targets.push(raw)

      for (const raw of targets) {
        if (!raw) continue
        let toId = resolver.resolve(raw)
        if (toId === null) {
          if (!nodeIds.has(raw) && !ghostSeen.has(raw)) {
            ghosts.set(raw, { id: raw, title: raw, ghost: true })
            ghostSeen.add(raw)
          }
          toId = raw
        }
        edges.push({ from: page.path, to: toId })
      }
    }
    return { nodes: [...nodes, ...ghosts.values()], edges }
  }
}
