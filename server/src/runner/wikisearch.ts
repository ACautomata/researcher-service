// wiki 常驻检索工具（#789 · #747 G 节 wiki 三通道①：openwiki deep-import 嵌入，minor 锁版 ~0.6.1）。
//
// openwiki_search / openwiki_read 是 always-on 常驻工具（story 37）：进 run 装配（runService
// getOrBuildGraph），模型侧 schema 裁掉 root/wiki/workspace 基础设施参数——root 由本模块注入
//（wiki 容器树的落地镜像），wiki/workspace 寻址在单容器单 wiki 场景无意义；runId/jobId 是
// 生命周期工具（openwiki_begin 等，通道③）的参数，检索工具没有。
//
// 嵌入面（#725 调研 §一/§六）：深导入 openwiki/dist/retrieval/wiki.js 直调 searchWiki/
// readWikiSections——检索是「纯 fs + 排序逻辑」（无模型调用、无 git 依赖；git 硬依赖只在
// openwiki 的 MCP 适配层 resolveRepositoryRoot，绕开）。openwiki 检索布局硬性要求页面位于
// <root>/openwiki/ 之下（ClaimsStore wikiDir 固定 join(rootDir,'openwiki')，normalizeWikiPagePath
// 拒绝非 /openwiki/ 前缀），故每次调用把 wiki 容器 /wiki 树 getArchive 拉取为临时镜像目录
// <tmp>/openwiki/**——每次调用现拉（PoC 实测 getArchive mean 20.6ms）：检索结果与轻写通道的
// agent 直写保持一致（run 内先写后搜也能搜到自己刚写的页），无快照陈旧面。
//
// 返回契约（#737）：结构化 Result `{ok:true,data}|{ok:false,error:{code,message,hint?}}`
// 永不 throw——openwiki 库异常全部在 handler 内归类转译（invalid_input/invalid_state），
// 未知异常兜底 internal；工具面 zod 校验失败（schema 外的畸形输入）由 LangGraph 工具错误
// 面兜住回喂 agent loop，不进本契约。
//
// Node ≥ 22.22（openwiki engines；控制面经 CJS require 加载 ESM dist——Node 22.12+ 支持）。
// deep-import 路径属包内部面（openwiki 无 exports 字段），升级时跑本模块测试作契约测试。

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DynamicStructuredTool, tool } from '@langchain/core/tools'
import { z } from 'zod'
import {
  WIKI_RETRIEVAL_LIMITS,
  WikiRetrievalError,
  readWikiSections,
  searchWiki,
} from 'openwiki/dist/retrieval/wiki.js'
import { ClaimsError, ClaimsPageMissingError } from 'openwiki/dist/claims/core/errors.js'
import { WikiWorkspaceError } from 'openwiki/dist/linking/wiki-workspaces.js'
import { normalizeTarName, parseTar } from '../files/tar'
import { SKIP_DIRS, SKIP_FILES } from '../wiki/values'
import { WIKI_ROOT } from '../wikiContainers/values'
import { MAX_COLLECT_BYTES } from './backend/values'
import type { SandboxFilePrimitives } from './backend/primitives'

// ---- 结构化 Result（#737 工具返回形状） ----
// error.code 增 'conflict'（#790 通道③：openwiki 生命周期 base-hash 冲突经 HostIntegrationError
// 冒泡——冲突中止不静默覆盖的 agent 可读回喂面）。

export interface WikiToolOk {
  ok: true
  data: unknown
}
export interface WikiToolError {
  ok: false
  error: { code: 'invalid_input' | 'invalid_state' | 'conflict' | 'internal'; message: string; hint?: string }
}
export type WikiToolResult = WikiToolOk | WikiToolError

// ---- 落地镜像（wiki 容器 /wiki → 控制面临时目录 <root>/openwiki/**） ----

export interface WikiMirror {
  root: string
  dispose: () => Promise<void>
}

export class WikiMirrorUnavailableError extends Error {}

// tar 条目安全段：拒 '..' 段、空段与隐藏段（'.' 开头——.git 等 SKIP 集外的隐藏目录不进镜像；
// 对齐 backend paths 归一化纪律。tar 来自自家 wiki 容器，防御性保留——镜像写入控制面盘，
// 穿越代价不对等）。
function mirrorSafeRel(rel: string): string | null {
  const parts = rel.split('/')
  if (parts.some((p) => p === '..' || p === '' || p.startsWith('.'))) return null
  return parts.join('/')
}

export async function pullWikiMirror(
  primitives: SandboxFilePrimitives,
  container: string,
): Promise<WikiMirror> {
  const buf = await primitives.getArchive(container, WIKI_ROOT)
  if (buf === null) {
    throw new WikiMirrorUnavailableError(`wiki container tree unavailable: ${container}:${WIKI_ROOT}`)
  }
  const root = await mkdtemp(join(tmpdir(), 'wiki-mirror-'))
  const wikiDir = join(root, 'openwiki')
  await mkdir(wikiDir, { recursive: true })
  try {
    const entries = parseTar(buf, { collectData: true, maxDataBytes: MAX_COLLECT_BYTES })
    const rootName = normalizeTarName(entries[0]?.name ?? '')
    for (const t of entries.slice(1)) {
      if (t.type !== 'file' || t.data === null) continue
      const raw = normalizeTarName(t.name)
      if (raw === null) continue
      const stripped =
        rootName !== null && raw.startsWith(`${rootName}/`) ? raw.slice(rootName.length + 1) : raw
      if (stripped === '') continue
      const rel = mirrorSafeRel(stripped)
      if (rel === null) continue
      // SKIP 集过滤（wiki/values 单一来源）：镜像 = 面板 tree 同语义的知识页视图，
      // openwiki 检索不应看到 log.md/INSTRUCTIONS.md/.claims 等运行文件。
      if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue
      if (SKIP_FILES.has(rel.split('/').pop() ?? '')) continue
      const dest = join(wikiDir, ...rel.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, t.data)
    }
  } catch (e) {
    await rm(root, { recursive: true, force: true })
    throw e
  }
  return { root, dispose: () => rm(root, { recursive: true, force: true }) }
}

// ---- 常驻工具（模型面 schema = 裁剪后参数集） ----

// 绑定 schema 只声明类型面；边界校验归 searchWiki/readWikiSections 本体（openwiki 校验
// 抛 WikiRetrievalError → handler 转译 Result，错误文案可引导模型自纠——双层 schema 漂移
// 无收益）。schema 键集即「裁掉 root/wiki/workspace」的模型面承诺（测试锁定键集）。
const SearchSchema = z.object({
  query: z.string().describe('Natural-language question or concept to find in the knowledge wiki.'),
  paths: z.array(z.string()).optional().describe('Optional path hints that boost related wiki sections.'),
  limit: z.number().int().optional().describe(`Optional ranked result count (1-${WIKI_RETRIEVAL_LIMITS.searchResults}, default ${WIKI_RETRIEVAL_LIMITS.defaultSearchResults}).`),
})

const ReadSchema = z.object({
  page: z.string().describe('Wiki page from a search ref, e.g. "openwiki/concepts/attention.md".'),
  sections: z
    .array(z.string())
    .min(1)
    .describe('Heading anchors from the search ref (split each ref at "#").'),
})

export interface WikiRetrievalDeps {
  readonly primitives: SandboxFilePrimitives
  readonly wikiContainer: string
}

function classifyError(e: unknown): WikiToolError['error'] {
  if (e instanceof WikiRetrievalError) {
    return { code: 'invalid_input', message: e.message }
  }
  if (e instanceof ClaimsPageMissingError) {
    return {
      code: 'invalid_input',
      message: 'The requested wiki page does not exist.',
      hint: 'Use a page returned by openwiki_search refs.',
    }
  }
  if (e instanceof ClaimsError) {
    return { code: 'invalid_state', message: 'Unable to read the wiki safely. Retry later.' }
  }
  if (e instanceof WikiWorkspaceError) {
    return { code: 'invalid_state', message: e.message }
  }
  if (e instanceof WikiMirrorUnavailableError) {
    return { code: 'invalid_state', message: 'The wiki tree is currently unavailable.', hint: 'Retry later.' }
  }
  return {
    code: 'internal',
    message: e instanceof Error ? e.message : String(e),
  }
}

// 返回类型显式宽化（DynamicStructuredTool 缺省泛型）：两个 tool() 实例的 zod 泛型不同，
// 数组推断成联合会让调用方 .invoke 签名互斥不可调用——类型面统一，schema 面不变。
export function createWikiRetrievalTools(deps: WikiRetrievalDeps): DynamicStructuredTool[] {
  // 每次调用现拉镜像（见文件头：与轻写一致性 + PoC 延迟量级）；dispose 恒在 finally。
  async function withMirror<T>(fn: (mirror: WikiMirror) => Promise<T>): Promise<string> {
    let mirror: WikiMirror | undefined
    try {
      mirror = await pullWikiMirror(deps.primitives, deps.wikiContainer)
      const data = await fn(mirror)
      return JSON.stringify({ ok: true, data } satisfies WikiToolOk)
    } catch (e) {
      return JSON.stringify({ ok: false, error: classifyError(e) } satisfies WikiToolError)
    } finally {
      await mirror?.dispose()
    }
  }

  const search = tool(
    ({ query, paths, limit }) =>
      withMirror((mirror) =>
        searchWiki(mirror.root, {
          query,
          ...(paths !== undefined ? { paths } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
    {
      name: 'openwiki_search',
      description:
        "Search the user's knowledge wiki (OKF pages) without writing anything. " +
        'Returns compact ranked results; split each ref at "#" into the page and exact heading anchor for openwiki_read. ' +
        'Empty results are valid.',
      schema: SearchSchema,
    },
  )

  const read = tool(
    ({ page, sections }) => withMirror((mirror) => readWikiSections(mirror.root, { page, sections })),
    {
      name: 'openwiki_read',
      description:
        'Read one or more complete markdown sections of a knowledge wiki page selected from openwiki_search refs. ' +
        'Pass the page and heading anchors exactly as returned by the search ref.',
      schema: ReadSchema,
    },
  )

  return [search, read]
}
