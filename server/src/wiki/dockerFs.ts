// Docker WikiFileSystem 适配器（#621 ADR 0012 引入；#784 改挂新 wiki 容器）：
// wiki 域 REST 的存储目标 = 每用户 wiki 容器（researcher-wiki-<ownerId>，树根 /wiki）——
// 构造参数即 docker 容器名原文 + 树根绝对路径，路由层经 wikiContainerName(inst.ownerId)
// 派生（legacy openclaw-gw-<name> + ~/.openclaw/wiki/main 寻址随本票退役，wiki 数据源
// 整体换轨；named volume / bind 拓扑语义随之作废）。
//
// 形态（与 NodeFs 对照）：
//   - 读侧自实现：FileArchive.read 的 DirListing 无内容、FileReading 的 16MB/binary-null 语义
//     不合 wiki 契约（readPage content 恒 string、tree title 需 frontmatter）。snapshot() 经
//     getArchive 拉全库 tar + parseTar 收集内容，buildTree 在快照上跑与
//     NodeFs 等价的过滤/分组/title 语义；readPage 单文件 probe（无字节上限，对齐 NodeFs 全读）。
//   - 写面已随 #758 Q3 写面整域退役物理删除（writePage/createPage/deletePage 及其委托的
//     FileArchive 显式容器名三方法窄接口 WikiContainerArchive、异常映射膜、createPage 父链
//     守卫）——零生产调用：agent 写路径 = runner/wikigen mirror pushBack（putArchive + diff rm）
//     + FilesystemBackend，不经 WikiService。本适配器只剩读侧。
//   - managed 黑名单（SKIP_DIRS 段 / SKIP_FILES 末段 → WikiInvalidPath）在本层前置——读面
//     页请求逐路径拒 managed（对齐 NodeFs assertNotManaged，请求层 paths.ts 不做）。
//
// 与 NodeFs 的安全模型差异（有意，注释即契约）：
//   - symlink/TOCTOU 锚定防护无 Docker 等价物也无必要：getArchive 以容器为视角，
//     tar 内容由控制面解析、不落控制面盘，容器内 symlink 逃逸不到控制面文件系统；路径合法性
//     由请求层 paths.ts（穿越/绝对/反斜杠/NUL）+ 本层 managed 黑名单承载。
//   - buildGraph（service 层）逐页 readPage → N 次 getArchive 往返：功能正确，性能后续可
//     加快照缓存优化，本票不动 service 层。

import Docker from 'dockerode'
import { parseTar, type TarEntry } from '../files/tar'
import { MAX_FILE_READ_BYTES, WALK_LIMIT } from '../files/values'
import { WIKI_ROOT } from '../wikiContainers/values'
import { claimsSidecarPath, cmp, decodeUtf8Strict, FrontmatterParser, frontmatterTitle } from './logic'
import { SKIP_DIRS, SKIP_FILES } from './values'
import { WikiInvalidPath, WikiPageNotFound } from './errors'
import type {
  WikiFileSystem,
  WikiPage,
  WikiTree,
  WikiTreePage,
} from './fsPort'

// 快照 tar 全量字节上限：正常 wiki 库为几 MB 量级，但 _attachments 等 SKIP 目录的附件字节
// 也会被 getArchive 一并拉出，故取宽裕值。超限降级「空树/空聚合」（对齐 NodeFs「单目录
// 不可读→跳过」的降级精神），readPage 走单文件 probe 不受影响。
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024

// readPage 单文件 probe 结果：file 携带全文（无字节上限，对齐 NodeFs read_page 全读契约）；
// dir/link 区分目录（→WikiPageNotFound）与 symlink/特殊（→WikiInvalidPath，对齐 NodeFs
// ELOOP/锚定语义）；null = 不存在。
export type WikiProbeResult =
  | { kind: 'file'; data: Buffer }
  | { kind: 'dir' }
  | { kind: 'link' }
  | null

// 注入接缝：生产全缺省（真 docker）；单测注入 fake snapshot/probeFile 纯逻辑直测，
// 缺省实现的 docker 接线由 mock client 测（对齐 dockerFileArchive.test.ts 模式）。
export interface DockerWikiDeps {
  docker?: () => Docker
  /** wiki 树根覆盖（缺省 WIKI_ROOT = /wiki；测试可注入异形根） */
  rootPath?: string
  snapshot?: () => Promise<TarEntry[] | null>
  probeFile?: (relPath: string) => Promise<WikiProbeResult>
}

// tar 条目名归一化（对齐 dockerArchive：去 './' 前缀、去尾 '/'；根 '.' → null 跳过）。
function normalizeTarName(raw: string): string | null {
  let n = raw.startsWith('./') ? raw.slice(2) : raw
  while (n.endsWith('/')) n = n.slice(0, -1)
  if (n === '' || n === '.') return null
  return n
}

function stemOf(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

export class DockerWikiFileSystem implements WikiFileSystem {
  private readonly parser = new FrontmatterParser()
  private readonly snap: () => Promise<TarEntry[] | null>
  private readonly probeFile: (relPath: string) => Promise<WikiProbeResult>
  // 寻址面只读暴露（测试断言 docker 名/树根派生；运行期只读）
  readonly dockerName: string
  readonly rootPath: string

  constructor(
    dockerName: string, // wiki 容器 docker 名原文（researcher-wiki-<ownerId>，路由层派生）
    deps: DockerWikiDeps = {},
  ) {
    this.dockerName = dockerName
    this.rootPath = deps.rootPath ?? WIKI_ROOT
    const docker = deps.docker ?? (() => new Docker())
    this.snap = deps.snapshot ?? (() => this.defaultSnapshot(docker()))
    this.probeFile = deps.probeFile ?? ((relPath) => this.defaultProbeFile(docker(), relPath))
  }

  // —— Port: build_tree ——

  async buildTree(): Promise<WikiTree> {
    const entries = await this.snap()
    if (entries === null) return { groups: [] } // 根不可用（容器/wiki 目录缺失/快照超限）→ 空树降级
    const groups = new Map<string, WikiTreePage[]>()
    for (const t of entries) {
      const page = this.treePage(t)
      if (page === null) continue
      const top = t.name.split('/')[0]
      const pages = groups.get(top)
      if (pages) pages.push(page)
      else groups.set(top, [page])
    }
    return {
      groups: [...groups.entries()]
        .sort(([a], [b]) => cmp(a, b))
        .map(([kind, pages]) => ({ kind, name: kind, pages: pages.sort((x, y) => cmp(x.path, y.path)) })),
    }
  }

  // —— Port: read_page ——

  async readPage(relPath: string): Promise<WikiPage> {
    this.assertNotManaged(relPath)
    const probed = await this.probeFile(relPath)
    if (probed === null || probed.kind === 'dir') throw new WikiPageNotFound(relPath)
    if (probed.kind === 'link') throw new WikiInvalidPath(relPath)
    // 读/解码失败上抛 TypeError（read_page 不降级，对齐 NodeFs decodeUtf8Strict 语义）。
    const content = decodeUtf8Strict(probed.data)
    const { frontmatter } = this.parser.parse(content)
    const stem = stemOf(relPath.slice(relPath.lastIndexOf('/') + 1))
    return { path: relPath, title: frontmatterTitle(frontmatter) ?? stem, content }
  }

  // —— Port: read_claims_file（#789 claims 只读面）——

  // 页路径 → .claims 镜像旁车（claimsSidecarPath 单点映射）。调用方（service.readClaims）
  // 已先经 readPage 的 assertNotManaged/probe 校验页本体——旁车是 openwiki 生成物，读侧
  // 不再过 managed 黑名单（.claims 在 SKIP_DIRS：树/图不收；这里是旁车的唯一合法读出口）。
  // 旁车缺失/非 UTF-8 → null（「无旁车」语义，不放大为读失败）。
  async readClaimsFile(relPath: string): Promise<string | null> {
    const probed = await this.probeFile(claimsSidecarPath(relPath))
    if (probed === null || probed.kind !== 'file') return null
    try {
      return decodeUtf8Strict(probed.data)
    } catch {
      return null
    }
  }

  // —— internal ——

  // tree 页条目：过滤后返回 {path,title}；非页（目录/symlink/非 .md/SKIP/顶层散落）→ null。
  private treePage(t: TarEntry): WikiTreePage | null {
    if (!this.isPageEntry(t)) return null
    if (!t.name.includes('/')) return null // 顶层散落页不收（对齐 NodeFs buildTree）
    const stem = stemOf(t.name.slice(t.name.lastIndexOf('/') + 1))
    // title = frontmatter（全文 parse；frontmatter 在文件头，与 NodeFs 读前缀等价）→ stem。
    // 无 H1 fallback（对齐 NodeFs buildTree 的 pageTitle 语义）；超大/解码失败 → stem。
    return { path: t.name, title: this.titleFromEntry(t) ?? stem }
  }

  // 页条目判定：regular file + .md + 无 SKIP_DIRS 段 + 非 SKIP_FILES 末段。
  // symlink/other 跳过（对齐 NodeFs 不跟随）；目录条目自然排除。
  private isPageEntry(t: TarEntry): boolean {
    if (t.type !== 'file') return false
    if (!t.name.endsWith('.md')) return false
    const parts = t.name.split('/')
    if (parts.some((p) => SKIP_DIRS.has(p))) return false
    if (SKIP_FILES.has(parts[parts.length - 1])) return false
    return true
  }

  // 从快照条目解析 title：frontmatter ?? undefined（调用方补 stem/H1 兜底）；data 未收集
  // （超大）或解码失败 → undefined（对齐 NodeFs pageTitle 读失败 → 文件名 fallback）。
  private titleFromEntry(t: TarEntry): string | undefined {
    if (t.data === null) return undefined
    try {
      const { frontmatter } = this.parser.parse(decodeUtf8Strict(t.data))
      return frontmatterTitle(frontmatter)
    } catch {
      return undefined
    }
  }

  // managed 黑名单（#315 §4 第②层，对齐 NodeFs assertNotManaged）：任一段命中 SKIP_DIRS、
  // 或末段命中 SKIP_FILES → 拒。读面页请求前置。
  private assertNotManaged(relPath: string): void {
    const parts = relPath.split('/')
    if (parts.some((seg) => SKIP_DIRS.has(seg))) throw new WikiInvalidPath(relPath)
    if (SKIP_FILES.has(parts[parts.length - 1])) throw new WikiInvalidPath(relPath)
  }

  // —— 缺省 docker 实现（生产路径；单测注入 fake 绕过） ——

  // 全库快照：getArchive(树根) 拉目录 tar（容器内 /wiki 可写层），收集全量（总量防护）→
  // parseTar 收内容（单文件 16MB 上限）→ strip 根前缀成相对 /wiki。daemon 404（容器不存在 /
  // wiki 目录不存在）→ null；快照超 SNAPSHOT_MAX_BYTES → null（降级）。
  private async defaultSnapshot(docker: Docker): Promise<TarEntry[] | null> {
    let stream: NodeJS.ReadableStream
    try {
      stream = await docker.getContainer(this.dockerName).getArchive({ path: this.rootPath })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
    const buf = await this.collect(stream, SNAPSHOT_MAX_BYTES)
    if (buf === null) {
      // eslint-disable-next-line no-console
      console.warn(`[wiki] snapshot 超 ${SNAPSHOT_MAX_BYTES}B 降级空树: container=${this.dockerName}`)
      return null
    }
    const entries = parseTar(buf, { collectData: true, maxDataBytes: MAX_FILE_READ_BYTES })
    const root = entries[0]
    if (!root) return []
    // Docker 目录 getArchive：根条目 = basename（'wiki'），子条目带 'wiki/' 前缀（对齐
    // DockerFileArchive.read 目录分支 strip 语义）。
    const prefix = normalizeTarName(root.name)
    const out: TarEntry[] = []
    for (const t of entries.slice(1)) {
      const raw = normalizeTarName(t.name)
      if (raw === null) continue
      const name = prefix !== null && raw.startsWith(`${prefix}/`) ? raw.slice(prefix.length + 1) : raw
      if (name === '') continue
      out.push({ ...t, name })
      if (out.length >= WALK_LIMIT) break // 条目数上限（对齐 files 域 WALK_LIMIT 防护）
    }
    return out
  }

  // 单文件 probe：getArchive 单文件路径，受 SNAPSHOT_MAX_BYTES（64MB）内存防护——超限返
  // WikiInvalidPath（合法 wiki 页受路由 body limit 约束远小于此，不可达；防护防失控 daemon 流）。
  private async defaultProbeFile(docker: Docker, relPath: string): Promise<WikiProbeResult> {
    let stream: NodeJS.ReadableStream
    try {
      stream = await docker
        .getContainer(this.dockerName)
        .getArchive({ path: `${this.rootPath}/${relPath}` })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
    const buf = await this.collect(stream, SNAPSHOT_MAX_BYTES)
    if (buf === null) throw new WikiInvalidPath(relPath) // 单文件超总量上限：拒（不进内存）
    const entries = parseTar(buf, { collectData: true })
    const root = entries[0]
    if (!root) return null
    if (root.type === 'directory') return { kind: 'dir' }
    if (root.type !== 'file') return { kind: 'link' } // symlink / 特殊类型
    return { kind: 'file', data: root.data ?? Buffer.alloc(0) }
  }

  // 流收集全量字节；超 maxBytes 中止（for-await break 销毁流）→ null。
  private async collect(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer | null> {
    const parts: Buffer[] = []
    let total = 0
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length
      if (total > maxBytes) return null
      parts.push(chunk)
    }
    return Buffer.concat(parts)
  }
}
