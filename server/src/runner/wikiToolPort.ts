// ctx.wiki 核心实现（#908 · 853 §3.2#1 PluginWikiPort）：插件与主 agent 同一套 wiki 检索
// 读写通道 + 窄域建页口。
//
// 读面 search/readPage：复用 runner/wikisearch 同款封装——pullWikiMirror（wiki 容器 /wiki 树
// 逐调用拉控制面临时镜像，SKIP 集过滤）+ openwiki searchWiki/readWikiSections 直调（deep-import
// ~0.6.1 锁定面，wikisearch.ts 头注同），行为与主 agent 常驻检索工具一致。
//
// 写面 createPage：幂等哨兵（页已存在 → {created:false} 不抛错、不覆盖、不再 put——重放窗口
// 防重复建页，幂等跳过是常态路径不进 error 通道）+ **owner 级进程内锁**（key=(ownerId, relPath)，
// createPage 整体 ensure+probe+put+渲染在锁内，关闭并发 probe→put 竞态窗口——Docker 无 O_EXCL；
// 锁表进程级共享、跨 port 实例生效；不动 writelock registry——其互斥域 = 沙箱 parent session，
// 语义不贴，853 §3.2#1）+ ensure(ownerId) 容器前置 + SKIP 集 assertNotManaged（wiki/logic
// isManagedRelPath 单源，与读面同判定）+ claims 渲染与 frontmatter 组装（wiki/pluginPage 纯逻辑，
// §11.3C 字段集）。V1 无 updatePage/deletePage（编辑已存在页 = 越权改用户/治理产物，§3.2 钉）。
//
// 与在飞治理 run（通道②③）共存 = base-hash 乐观并发不变——任何 wiki 写都可能使治理 run 弃回 +
// 冲突信箱（接受，已写进规格）。

import { readWikiSections, searchWiki } from 'openwiki/dist/retrieval/wiki.js'
import { parseTar, createTarTree, type TarTreeEntry } from '../files/tar'
import { isManagedRelPath } from '../wiki/logic'
import { normalizeRelPath } from '../wiki/paths'
import { assemblePageMarkdown, PluginPageDraftSchema, PluginPageProvenanceSchema } from '../wiki/pluginPage'
import { WIKI_ROOT } from '../wikiContainers/values'
import { currentToolCallContext } from './filejournal/context'
import { pullWikiMirror } from './wikisearch'
import type { SandboxFilePrimitives } from './backend/primitives'
import type {
  PluginPageDraft,
  PluginPageProvenance,
  PluginWikiPort,
  PluginWikiReadResponse,
  PluginWikiSearchResponse,
} from '../plugins/api'

export type PluginWikiPortErrorCode =
  | 'invalid_draft' // DTO zod 校验失败
  | 'invalid_path' // 路径形态非法（normalizeRelPath：绝对/穿越/反斜杠/非 .md/超长）
  | 'managed_path' // SKIP 集托管路径（.claims/ _attachments/ log.md…）拒写
  | 'path_occupied' // 目录/特殊文件占位页路径（不静默跳过）
  | 'mirror_unavailable' // 检索返回 workspace 歧义面（单 wiki 镜像不可能——库/镜像行为漂移 loud fail；容器/镜像拉取故障不经本码，原生冒泡）

export class PluginWikiPortError extends Error {
  constructor(
    readonly code: PluginWikiPortErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PluginWikiPortError'
  }
}

export interface PluginWikiToolPortDeps {
  /** 锁 key 与 ensure 的归属主体。 */
  readonly ownerId: string
  /** wiki 容器 docker 名原文（resolveWikiContainer(ownerId) 派生）。 */
  readonly container: string
  /** Docker 原语（S2 接缝；测试 fake）。写面只经 getArchive probe + putArchive 落树。 */
  readonly primitives: Pick<SandboxFilePrimitives, 'getArchive' | 'putArchive'>
  /** wiki 容器 ensure（RunService deps.wikis.ensure；缺省不 ensure——测试/装配缺面）。 */
  readonly ensure?: () => Promise<void>
  /** 溯源 source 盖章 = 调用插件 id（frontmatter source 与 generated.by 同源）。 */
  readonly source: string
  /** wiki 树根覆盖（缺省 WIKI_ROOT = /wiki；测试注入异形根）。 */
  readonly rootPath?: string
  /** ms 时钟（缺省 Date.now；RunService deps.clock 穿线，测试步进钟锁定徽章值）。 */
  readonly now?: () => number
}

// ---- owner 级进程内锁（表进程级共享——port 随 frame/wikiFor 每 run 每插件新建，锁的互斥域
// (ownerId, relPath) 与实例无关；settle 后身份匹配才清表，防无界增长，失败不断链）。 ----

// key → 该 key 最后入队任务的 settle 尾指针（链式互斥：新任务接在尾指针后）
const createLockTails = new Map<string, Promise<unknown>>()

function withCreateLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = createLockTails.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn) // 前任成败都放行本任务——锁只串行化，不传播失败
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  createLockTails.set(key, tail)
  void tail.then(() => {
    if (createLockTails.get(key) === tail) createLockTails.delete(key)
  })
  return run
}

// ---- 单文件 probe（dockerFs.defaultProbeFile 同语义、原语面重写：getArchive 单文件路径，
// 404 → null；目录/特殊类型区分——目录占位页路径 → path_occupied 明确报错。只判 kind 不收
// 内容——collectData:false 零死重） ----

type WikiProbeResult = { kind: 'file' } | { kind: 'dir' } | { kind: 'link' } | null

async function probeWikiPath(
  primitives: Pick<SandboxFilePrimitives, 'getArchive'>,
  container: string,
  rootPath: string,
  relPath: string,
): Promise<WikiProbeResult> {
  const buf = await primitives.getArchive(container, `${rootPath}/${relPath}`)
  if (buf === null) return null
  const entries = parseTar(buf)
  const root = entries[0]
  if (!root) return null
  if (root.type === 'directory') return { kind: 'dir' }
  if (root.type !== 'file') return { kind: 'link' }
  return { kind: 'file' }
}

// 页 tar：父链目录条目（0755 可遍历）+ 文件条目——putArchive 落树不依赖容器内 mkdir
// （wiki 镜像 busybox 级，daemon 侧解 tar，目录所有权随 tar 头）。
function pageTar(relPath: string, content: Buffer): Buffer {
  const segs = relPath.split('/')
  const entries: TarTreeEntry[] = []
  for (let i = 1; i < segs.length; i += 1) {
    entries.push({ name: segs.slice(0, i).join('/'), type: 'directory', modeOctal: '0000755' })
  }
  entries.push({ name: relPath, type: 'file', content })
  return createTarTree(entries)
}

export function createPluginWikiPort(deps: PluginWikiToolPortDeps): PluginWikiPort {
  const rootPath = deps.rootPath ?? WIKI_ROOT

  return {
    async search(query, opts): Promise<PluginWikiSearchResponse> {
      const mirror = await pullWikiMirror(deps.primitives, deps.container)
      try {
        const res = await searchWiki(mirror.root, {
          query,
          ...(opts?.paths !== undefined ? { paths: opts.paths } : {}),
          ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        })
        // 单 wiki 镜像不可能 workspace 歧义面——出现即镜像/库行为漂移，loud fail
        if (!('results' in res)) {
          throw new PluginWikiPortError('mirror_unavailable', 'wiki 检索返回 workspace 歧义面（单镜像不可达）')
        }
        return res // 结构兼容（WikiSearchResult ⊆ PluginWikiSearchHit）
      } finally {
        await mirror.dispose()
      }
    },

    async readPage(page, sections): Promise<PluginWikiReadResponse> {
      const mirror = await pullWikiMirror(deps.primitives, deps.container)
      try {
        // openwiki 的检索域错误（WikiRetrievalError/ClaimsPageMissingError…）原样冒泡——
        // 与主 agent 工具面同源同型（wikisearch classifyError 的分类是模型面转译，插件
        // 节点消费原生错误类型做重试/回喂判定）。
        return await readWikiSections(mirror.root, { page, sections })
      } finally {
        await mirror.dispose()
      }
    },

    async createPage(draft: PluginPageDraft, provenance?: PluginPageProvenance): Promise<{ created: boolean }> {
      const parsed = PluginPageDraftSchema.safeParse(draft)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new PluginWikiPortError(
          'invalid_draft',
          `PageDraft 校验失败: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown'}`,
        )
      }
      // provenance zod 边界（workflow 形态/relatedPages 元素单点）——非法同归 invalid_draft
      let prov = provenance
      if (prov !== undefined) {
        const parsedProv = PluginPageProvenanceSchema.safeParse(prov)
        if (!parsedProv.success) {
          const issue = parsedProv.error.issues[0]
          throw new PluginWikiPortError(
            'invalid_draft',
            `Provenance 校验失败: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown'}`,
          )
        }
        prov = parsedProv.data
      }
      const rel = normalizeRelPath(draft.path)
      if (!rel.ok) throw new PluginWikiPortError('invalid_path', rel.errors.join('；'))
      if (isManagedRelPath(rel.path)) {
        throw new PluginWikiPortError('managed_path', `SKIP 集托管路径不可写: ${rel.path}`)
      }
      return withCreateLock(`${deps.ownerId}:${rel.path}`, async () => {
        await deps.ensure?.()
        const probed = await probeWikiPath(deps.primitives, deps.container, rootPath, rel.path)
        if (probed?.kind === 'file') return { created: false } // 幂等哨兵：常态路径不进 error 通道
        if (probed !== null) {
          throw new PluginWikiPortError('path_occupied', `页路径被非页条目占用: ${rel.path}`)
        }
        const toolCallId = currentToolCallContext()?.toolCallId
        const md = assemblePageMarkdown({
          draft: parsed.data,
          source: deps.source,
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          ...(prov?.workflow !== undefined ? { workflow: prov.workflow } : {}),
          ...(prov?.relatedPages !== undefined ? { relatedPages: prov.relatedPages } : {}),
          now: (deps.now ?? Date.now)(),
        })
        await deps.primitives.putArchive(deps.container, rootPath, pageTar(rel.path, Buffer.from(md, 'utf8')))
        return { created: true }
      })
    },
  }
}
