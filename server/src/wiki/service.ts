// WikiService（#335 · 平移 backend/wiki/service.py）：wiki 树读面组合根（每用户 wiki 容器 /wiki）。
// 构造注入 WikiFileSystem Port（生产 DockerWikiFileSystem、测试 fake），组合 FrontmatterParser /
// WikilinkResolver。读方法直接委托 Port（域异常透传）；buildGraph 是本层聚合逻辑（纯逻辑，
// 对 fake FS 可直测）。
// 写面三方法（writePage/createPage/deletePage）已随 #758 Q3 写面整域退役物理删除——零生产
// 调用：agent 写路径 = runner/wikigen mirror pushBack（putArchive + diff rm）+ FilesystemBackend，
// 不经 WikiService；REST 写端点同期下线（routes.ts 头注）。

import {
  claimsDrift,
  FrontmatterParser,
  markdownLinkTargets,
  okfBadge,
  parseClaimsSidecar,
  WikilinkResolver,
  wikilinkTargets,
} from './logic'
import type {
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
