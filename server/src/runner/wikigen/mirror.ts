// wiki 治理生成落地副本（#790 · #747 G 节 wiki 三通道②③共享件）。
//
// 落地副本执行模型：run 开始把 wiki 容器 /wiki 整树 pull 到控制面临时镜像（<tmp>/wiki-gen-*/
// openwiki/**——与 #789 wikisearch pullWikiMirror 同布局，但**不过 SKIP 集**：治理生成需要
// log.md/INSTRUCTIONS.md/.claims/.run.json 运行文件面），各工具/执行体同指副本，finish（或
// 独立 run 完成时）复检 base-hash 后把 openwiki/** 子树推回容器。镜像根 git init——openwiki
// 生命周期边界 resolveRepositoryRoot 硬依赖 execFile('git', rev-parse --show-toplevel)，
// repository-root.js；无 HEAD（unborn）被 noop 检测/指纹容忍（getGitHead → undefined）。
//
// 推回范围显式钉死：**只归档镜像 openwiki/** 子树、排除镜像根 .git**——.run.json/
// .page-manifest.json/.last-update.json/.claims 都在 openwiki/ 子树内（config/constants.js
// UPDATE_METADATA_PATH="openwiki/.last-update.json"），随子树推回（durable 元数据供下次
// update 续跑/noop 判定）；镜像根 .git 与 openwiki ensureCodeModeRepoSetup 写的根级
// AGENTS.md/CLAUDE.md 在子树之外被范围天然排除（否则 .git 随每次 getArchive 进容器会逼近
// MAX_COLLECT_BYTES 快照上限）。tar 条目名剥 'openwiki/' 前缀——容器 /wiki 树内容即 openwiki
// 子树内容（#789 检索镜像把容器树映射进 <root>/openwiki/ 的同一布局，反向展开）。
//
// 删除语义：docker putArchive 只覆盖不删除——openwiki 计划删页/改名会留 stale 页。pushBack
// diff 出「容器有镜像无」路径 exec rm（busybox rm applet，wiki 容器有）；**先 put 后 rm**
// （崩溃窗口留 stale 页优于缺页）。
//
// base-hash 口径（AC③ 防静默覆盖的仲裁依据）：treeHash = readContainerWikiTree / pull 共用
// 同一纯核心 hashWikiTreeFiles（容器 /wiki 全文件含 dotfile、无 SKIP 过滤、路径排序 +
// sha256(content)）——pull 侧与 finish 复检侧必须同一函数同一口径，两侧口径漂移 = base-hash
// 永假冲突，直接砸「冲突不静默覆盖」验收（wikigenMirror.test.ts 锁定）。

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { OPEN_WIKI_DIR } from 'openwiki/dist/config/constants.js'
import { createTarTree, normalizeTarName, parseTar, type TarTreeEntry } from '../../files/tar'
import { WIKI_ROOT } from '../../wikiContainers/values'
import { MAX_COLLECT_BYTES } from '../backend/values'
import type { SandboxFilePrimitives } from '../backend/primitives'
import { WIKI_GENERATION_TMP_PREFIX, WIKI_MIRROR_SOURCES_DIR } from './values'

const execFileP = promisify(execFile)

export class WikiMirrorUnavailableError extends Error {}

// 容器 /wiki 树快照：文件清单（/wiki 相对路径，'/' 分隔，排序，含 dotfile，无 SKIP 过滤）
// + 内容 hash。pull 基线与 finish 复检共用此形状。
export interface WikiTreeSnapshot {
  readonly files: string[]
  readonly hash: string
}

// wiki 容器落地镜像：root = 仓库根（git init 处），openwikiDir = <root>/openwiki。
export interface WikiGenerationMirror {
  readonly root: string
  readonly openwikiDir: string
  /** pull 时刻容器树 hash（base-hash 基线；finish/独立 run 收尾复检对比对象） */
  readonly baselineHash: string
  dispose: () => Promise<void>
}

// ---------------------------------------------------------------------------
// 纯核心：treeHash（pull 侧 / 复检侧单一口径）
// ---------------------------------------------------------------------------

export function hashWikiTreeFiles(files: ReadonlyArray<{ rel: string; data: Buffer | null }>): string {
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const h = createHash('sha256')
  for (const f of sorted) {
    h.update(f.rel)
    h.update('\0')
    h.update(createHash('sha256').update(f.data ?? Buffer.alloc(0)).digest('hex'))
    h.update('\0')
  }
  return h.digest('hex')
}

// tar 条目 → 文件清单（路径安全段过滤：拒 '..' 与空段；dotfile 保留——.claims/.last-update.json
// 是 hash 与推回的正当成员）。root 条目（getArchive 的目录头）剥前缀归一。
function wikiTreeFilesFromTar(buf: Buffer): Array<{ rel: string; data: Buffer | null }> {
  const parsed = parseTar(buf, { collectData: true, maxDataBytes: MAX_COLLECT_BYTES })
  const rootName = normalizeTarName(parsed[0]?.name ?? '')
  const files: Array<{ rel: string; data: Buffer | null }> = []
  for (const t of parsed.slice(1)) {
    if (t.type !== 'file') continue
    const raw = normalizeTarName(t.name)
    if (raw === null) continue
    const stripped =
      rootName !== null && raw.startsWith(`${rootName}/`) ? raw.slice(rootName.length + 1) : raw
    if (stripped === '') continue
    if (stripped.split('/').some((p) => p === '..' || p === '')) continue
    files.push({ rel: stripped, data: t.data })
  }
  return files
}

function snapshotOf(files: Array<{ rel: string; data: Buffer | null }>): WikiTreeSnapshot {
  return {
    files: files.map((f) => f.rel).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    hash: hashWikiTreeFiles(files),
  }
}

// 容器 /wiki 全量快照（复检侧入口；树缺失 → null——调用方按冲突/失败面处置）。
export async function readContainerWikiTree(
  primitives: SandboxFilePrimitives,
  container: string,
): Promise<WikiTreeSnapshot | null> {
  const buf = await primitives.getArchive(container, WIKI_ROOT)
  if (buf === null) return null
  return snapshotOf(wikiTreeFilesFromTar(buf))
}

// ---------------------------------------------------------------------------
// pull：容器 /wiki 整树 → <tmp>/wiki-gen-*/openwiki/**（git init 根）
// ---------------------------------------------------------------------------

export async function pullWikiGenerationMirror(
  primitives: SandboxFilePrimitives,
  container: string,
): Promise<WikiGenerationMirror> {
  const buf = await primitives.getArchive(container, WIKI_ROOT)
  if (buf === null) {
    throw new WikiMirrorUnavailableError(`wiki container tree unavailable: ${container}:${WIKI_ROOT}`)
  }
  const treeFiles = wikiTreeFilesFromTar(buf)
  const baseline = snapshotOf(treeFiles)
  const root = await mkdtemp(join(tmpdir(), WIKI_GENERATION_TMP_PREFIX))
  const openwikiDir = join(root, OPEN_WIKI_DIR)
  const sourcesDir = join(root, WIKI_MIRROR_SOURCES_DIR)
  await mkdir(openwikiDir, { recursive: true })
  await mkdir(sourcesDir, { recursive: true })
  try {
    for (const f of treeFiles) {
      if (f.data === null) continue // 超限单文件（>MAX_COLLECT_BYTES）：无字节可落，跳过
      const dest = join(openwikiDir, ...f.rel.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, f.data)
      // sources/ 语料副本（只读快照；隐藏路径（.claims 等）不入——claims 旁车非证据语料）：
      // openwiki claims 证据校验（repo://<path>）要求解析到仓库内 **openwiki/ 之外** 的真实
      // 文件——镜像根除 openwiki/ 外无源语料时，每个新页的 submit_page 都会被
      // 「must retain or establish at least one material Claim → evidence 不解析」拒绝，
      // 更新退化为全 skip。sources/ = 页面 pre-update 快照，双职责：证据锚 + planner/worker
      // 的只读源视图。不入推回范围（pushBack 只取 openwiki/**）。
      if (!f.rel.split('/').some((p) => p.startsWith('.'))) {
        const src = join(sourcesDir, ...f.rel.split('/'))
        await mkdir(dirname(src), { recursive: true })
        await writeFile(src, f.data)
      }
    }
    // git init（openwiki 生命周期硬依赖）：unborn HEAD 被 noop 检测/源指纹容忍，
    // 无需 commit。git 二进制缺失（生产镜像未装）→ 此处 ENOENT 上抛 = 更新不可用。
    await execFileP('git', ['init'], { cwd: root })
  } catch (e) {
    await rm(root, { recursive: true, force: true })
    throw e
  }
  return { root, openwikiDir, baselineHash: baseline.hash, dispose: () => rm(root, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
// pushBack：镜像 openwiki/** 子树 → 容器 /wiki（putArchive 覆盖 + diff exec rm）
// ---------------------------------------------------------------------------

export interface PushBackResult {
  readonly pushedFiles: number
  readonly removedFiles: string[]
}

// 收集镜像 openwiki 子树全部文件（rel 相对 openwikiDir；含 dotfile；排序）。
async function collectMirrorFiles(openwikiDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(rel === '' ? openwikiDir : join(openwikiDir, rel), { withFileTypes: true })
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) await walk(child)
      else if (e.isFile()) out.push(child)
    }
  }
  await walk('')
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export async function pushBackWikiGenerationMirror(
  primitives: SandboxFilePrimitives,
  container: string,
  mirrorRoot: string,
): Promise<PushBackResult> {
  const openwikiDir = join(mirrorRoot, OPEN_WIKI_DIR)
  const mirrorFiles = await collectMirrorFiles(openwikiDir)
  const mirrorSet = new Set(mirrorFiles)
  const current = await readContainerWikiTree(primitives, container)
  const removedFiles = (current?.files ?? []).filter((f) => !mirrorSet.has(f))

  // tar：目录条目先序（父目录先建，daemon 解包前提）+ 文件条目；名相对 openwiki 子树。
  const entries: TarTreeEntry[] = []
  const dirs = new Set<string>()
  for (const rel of mirrorFiles) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  for (const d of [...dirs].sort()) entries.push({ name: d, type: 'directory', modeOctal: '0000755' })
  for (const rel of mirrorFiles) {
    entries.push({ name: rel, type: 'file', content: await readFile(join(openwikiDir, ...rel.split('/'))) })
  }
  // 先 put（覆盖写全部镜像内容）
  await primitives.putArchive(container, WIKI_ROOT, createTarTree(entries))
  // 后 rm（容器有镜像无 → 删除；漏删 = 静默留 stale 页）。哨兵形态与 backend delete 同款
  //（44 = 已不存在，幂等无害）。
  for (const rel of removedFiles) {
    await primitives.exec(container, [
      'sh',
      '-c',
      'if [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 44; fi; rm -rf -- "$1"',
      'sh',
      `${WIKI_ROOT}/${rel}`,
    ])
  }
  return { pushedFiles: mirrorFiles.length, removedFiles }
}
