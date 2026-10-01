// DockerArchiveBackend（#747·02 · #747 A 节四件自研之一，PoC #724 已验证可行）：
// deepagents BackendProtocolV2 → 控制面 Docker 原语的沙箱文件后端。
//
// 形状：SandboxBackendProtocolV2 全方法（protocol.ts 本地镜像 deepagents@1.14.1）。
// 双根路由：文件工具 path 以 /wiki/（wiki 容器，用户知识树）或 /lab/（会话沙箱）为根
// （#747 E 节双容器模型；根即容器内挂载根），paths.ts 纯函数选容器，容器内路径原样保留。
// execute（shell 通道）固定落 /lab 沙箱——wiki 容器 busybox 级无运行时（sh/mkdir/rm/cat），
// 可执行环境只在沙箱。
//
// 原语通道（S2 接缝）：只依赖 SandboxFilePrimitives Port（exec/getArchive/putArchive，
// files 域 ADR 0012 同通道），dockerode 适配层（dockerPrimitives.ts）构造注入——单测走
// fake（dockerArchiveBackend.test.ts），真 daemon 仅门控 smoke（dockerArchiveBackendSmoke.test.ts）。
//
// 语义（semantics.ts/mime.ts/globmatch.ts 逐条镜像 deepagents@1.14.1 官方行为——基座
// 三包联动升级时按上游核对）：read 行分页、edit 多命中拒绝、MIME 表、glob 全语义、
// grep basename includeGlob、二进制 read 返回 Uint8Array、write 二进制 base64 解码、
// edit 恒 utf8 写回（评审 M1：不过 write 的 base64 分支，对齐官方 edit 无条件 utf8）。

import { createTarFile, mtimeIso, normalizeTarName, parseTar, type TarEntry } from '../../files/tar'
import type {
  BackendProtocolV2,
  DeleteResult,
  EditResult,
  ExecuteResponse,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  SandboxBackendProtocolV2,
  WriteResult,
} from './protocol'
import type { ExecOutcome, SandboxFilePrimitives } from './primitives'
import { routePath, type BackendTargets } from './paths'
import { getMimeType, isTextMimeType } from './mime'
import { matchGlobBaseName, matchGlobPattern } from './globmatch'
import { paginateReadLines, performStringReplacement } from './semantics'
import {
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_OFFSET,
  EMPTY_CONTENT_WARNING,
  EXEC_DEFAULT_TIMEOUT_MS,
  GREP_DEFAULT_MAX_COUNT,
  MAX_COLLECT_BYTES,
  MAX_OUTPUT_CHARS,
} from './values'

// archiveRead 结果：条目（容器内绝对路径）+ 文件内容（collectData 时，key = 绝对路径）
interface ArchiveTree {
  root: TarEntry
  entries: FileInfo[]
  content: Map<string, Buffer>
}

export class DockerArchiveBackend implements SandboxBackendProtocolV2 {
  readonly id: string

  constructor(
    private readonly primitives: SandboxFilePrimitives,
    private readonly targets: BackendTargets,
  ) {
    this.id = `docker-archive:wiki=${targets.wiki},lab=${targets.lab}`
  }

  // ---- 内部：getArchive 全量收集 + tar 解析 ----

  // 单文件根 → entries=[自身]；目录根 → 子条目 strip 根前缀得相对路径，拼回绝对路径。
  // 路径不存在（原语返 null）→ 返回 null；其余故障由原语层抛（caller catch → {error}）。
  private async archiveRead(container: string, absPath: string, collectData: boolean): Promise<ArchiveTree | null> {
    const buf = await this.primitives.getArchive(container, absPath)
    if (buf === null) return null
    // maxDataBytes 语义（files/tar.ts）：超限单文件 data=null（不抛）——超大文件在 read 处给明确 error。
    const parsed = parseTar(buf, { collectData, maxDataBytes: MAX_COLLECT_BYTES })
    const root = parsed[0]
    if (!root) return null
    const base = absPath
    const tree: ArchiveTree = { root, entries: [], content: new Map() }
    if (root.type !== 'directory') {
      tree.entries.push({ path: base, is_dir: false, size: root.size, modified_at: mtimeIso(root.mtime) })
      if (collectData && root.data) tree.content.set(base, root.data)
      return tree
    }
    const rootName = normalizeTarName(root.name)
    for (const t of parsed.slice(1)) {
      const rel = normalizeTarName(t.name)
      if (rel === null) continue
      const stripped = rootName !== null && rel.startsWith(`${rootName}/`) ? rel.slice(rootName.length + 1) : rel
      if (stripped === '') continue
      tree.entries.push({ path: `${base}/${stripped}`, is_dir: t.type === 'directory', size: t.size, modified_at: mtimeIso(t.mtime) })
      if (collectData && t.type === 'file' && t.data) tree.content.set(`${base}/${stripped}`, t.data)
    }
    return tree
  }

  // ---- 内部：read 全量文本（edit 合成用；分页走 paginateReadLines） ----

  private async readFullText(container: string, absPath: string): Promise<{ text: string } | { error: string }> {
    const tree = await this.archiveRead(container, absPath, true)
    if (tree === null) return { error: `File '${absPath}' not found` }
    if (tree.root.type === 'directory') return { error: `is a directory: ${absPath}` }
    const buf = tree.content.get(absPath)
    if (buf === undefined) return { error: `File '${absPath}' not found` }
    return { text: buf.toString('utf8') }
  }

  // ---- 内部：mkdir -p 父目录 + putArchive 单文件落盘（write/edit 共用通道） ----

  // edit 必须走本通道而非 write()：write 对二进制 mime 做 base64 解码，而 edit 读侧按
  // utf8 全文本（readFullText）——错名二进制扩展名（.png 实为文本）经 write() 写回会把
  // 替换后文本 base64 解码成乱码（评审 M1）。上游 FilesystemBackend.edit 无条件 utf8 写回。
  private async putBuffer(routed: { container: string; absPath: string }, buf: Buffer): Promise<void> {
    const abs = routed.absPath
    const dir = abs.slice(0, abs.lastIndexOf('/')) || '/'
    const basename = abs.split('/').pop() ?? 'file'
    if (dir !== '/') await this.primitives.exec(routed.container, ['mkdir', '-p', dir])
    await this.primitives.putArchive(routed.container, dir, createTarFile(basename, buf))
  }

  // ---- SandboxBackendProtocolV2 ----

  // shell 固定落 /lab 沙箱（wiki 容器无运行时）；stdout+stderr 合并，超 MAX_OUTPUT_CHARS 截断。
  // 默认超时 EXEC_DEFAULT_TIMEOUT_MS（上游 LocalShellBackend 120s 对齐，评审 M2）：adapter
  // 超时 SIGKILL + exitCode 124 + stderr 附说明——挂起命令不再永久楔死 runner 回合。
  async execute(command: string): Promise<ExecuteResponse> {
    try {
      const r: ExecOutcome = await this.primitives.exec(this.targets.lab, ['/bin/sh', '-c', command], {
        timeoutMs: EXEC_DEFAULT_TIMEOUT_MS,
      })
      const combined = r.stdout + r.stderr
      const truncated = combined.length > MAX_OUTPUT_CHARS
      return {
        output: truncated ? combined.slice(0, MAX_OUTPUT_CHARS) : combined,
        exitCode: r.exitCode,
        truncated,
      }
    } catch (e) {
      // 协议无 error 位：backend 故障作为输出回 agent（exitCode null = 未能执行），不炸 agent loop。
      return { output: `execute failed: ${String(e)}`, exitCode: null, truncated: false }
    }
  }

  async ls(path: string): Promise<LsResult> {
    try {
      const routed = routePath(path, this.targets)
      if ('error' in routed) return { error: routed.error }
      const tree = await this.archiveRead(routed.container, routed.absPath, false)
      if (tree === null || tree.root.type !== 'directory') return { files: [] } // 非目录/不存在：对齐官方
      const prefix = `${routed.absPath}/`
      // 目录条目 path 带尾 '/'（官方 ls 语义）；按 path 排序（确定性输出）
      const files: FileInfo[] = tree.entries
        .filter((e) => !e.path.slice(prefix.length).includes('/'))
        .map((e) => (e.is_dir ? { ...e, path: `${e.path}/` } : e))
      files.sort((a, b) => a.path.localeCompare(b.path))
      return { files }
    } catch (e) {
      return { error: `ls failed: ${String(e)}` }
    }
  }

  async read(filePath: string, offset = DEFAULT_READ_OFFSET, limit = DEFAULT_READ_LIMIT): Promise<ReadResult> {
    try {
      const routed = routePath(filePath, this.targets)
      if ('error' in routed) return { error: routed.error }
      const tree = await this.archiveRead(routed.container, routed.absPath, true)
      if (tree === null) return { error: `File '${filePath}' not found` }
      if (tree.root.type === 'directory') return { error: `is a directory: ${filePath}` }
      const buf = tree.content.get(routed.absPath)
      if (buf === undefined) {
        return { error: `File '${filePath}' exceeds read limit (${MAX_COLLECT_BYTES} bytes)` }
      }

      const mimeType = getMimeType(filePath)
      if (!isTextMimeType(mimeType)) {
        return { content: new Uint8Array(buf), mimeType }
      }
      const text = buf.toString('utf8')
      if (text.trim() === '') return { content: EMPTY_CONTENT_WARNING, mimeType }
      const page = paginateReadLines(text, offset, limit)
      if ('error' in page) return { error: page.error, mimeType }
      return { ...page, mimeType }
    } catch (e) {
      return { error: `read failed: ${String(e)}` }
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    try {
      const routed = routePath(filePath, this.targets)
      if ('error' in routed) return { error: routed.error }
      const tree = await this.archiveRead(routed.container, routed.absPath, true)
      if (tree === null) return { error: `File '${filePath}' not found` }
      if (tree.root.type === 'directory') return { error: `is a directory: ${filePath}` }
      const buf = tree.content.get(routed.absPath)
      if (buf === undefined) return { error: `File '${filePath}' exceeds read limit (${MAX_COLLECT_BYTES} bytes)` }
      const mimeType = getMimeType(filePath)
      const created = mtimeIso(tree.root.mtime)
      return {
        data: isTextMimeType(mimeType)
          ? { content: buf.toString('utf8'), mimeType, created_at: created, modified_at: created }
          : { content: new Uint8Array(buf), mimeType, created_at: created, modified_at: created },
      }
    } catch (e) {
      return { error: `readRaw failed: ${String(e)}` }
    }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const routed = routePath(filePath, this.targets)
      if ('error' in routed) return { error: routed.error }
      // 二进制 mime：content 为 base64（对齐官方 FilesystemBackend 的 write 分支）
      const buf = isTextMimeType(getMimeType(filePath)) ? Buffer.from(content, 'utf8') : Buffer.from(content, 'base64')
      await this.putBuffer(routed, buf)
      return { path: routed.absPath, filesUpdate: null }
    } catch (e) {
      return { error: `write failed: ${String(e)}` }
    }
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<EditResult> {
    try {
      const routed = routePath(filePath, this.targets)
      if ('error' in routed) return { error: routed.error }
      const full = await this.readFullText(routed.container, routed.absPath)
      if ('error' in full) return { error: full.error }
      const replaced = performStringReplacement(full.text, oldString, newString, replaceAll)
      if (typeof replaced === 'string') return { error: replaced }
      await this.putBuffer(routed, Buffer.from(replaced[0], 'utf8'))
      return { path: routed.absPath, filesUpdate: null, occurrences: replaced[1] }
    } catch (e) {
      return { error: `edit failed: ${String(e)}` }
    }
  }

  async delete(filePath: string): Promise<DeleteResult> {
    try {
      const routed = routePath(filePath, this.targets)
      if ('error' in routed) return { error: routed.error }
      await this.primitives.exec(routed.container, ['rm', '-rf', '--', routed.absPath])
      return { path: routed.absPath }
    } catch (e) {
      return { error: `delete failed: ${String(e)}` }
    }
  }

  async glob(pattern: string, path = '/'): Promise<GlobResult> {
    try {
      const routed = routePath(path, this.targets)
      if ('error' in routed) return { error: routed.error }
      const tree = await this.archiveRead(routed.container, routed.absPath, false)
      if (tree === null || tree.root.type !== 'directory') return { files: [] } // 对齐官方 glob 非目录行为
      const base = routed.absPath
      const prefix = `${base}/`
      const files: FileInfo[] = tree.entries
        .filter((e) => !e.is_dir && matchGlobPattern(e.path.slice(prefix.length), pattern))
        .map((e) => ({ path: e.path, is_dir: false, size: e.size, modified_at: e.modified_at }))
      files.sort((a, b) => a.path.localeCompare(b.path))
      return { files }
    } catch (e) {
      return { error: `glob failed: ${String(e)}` }
    }
  }

  async grep(pattern: string, path: string | null = null, glob: string | null = null, maxCount: number | null = null): Promise<GrepResult> {
    try {
      const routed = routePath(path ?? '/', this.targets)
      if ('error' in routed) return { error: routed.error }
      const tree = await this.archiveRead(routed.container, routed.absPath, true)
      if (tree === null) return { matches: [], truncated: false } // 不存在：对齐官方 grep 宽容行为
      const cap = maxCount ?? GREP_DEFAULT_MAX_COUNT
      const matches: GrepMatch[] = []
      for (const e of tree.entries) {
        if (e.is_dir) continue
        const mimeType = getMimeType(e.path)
        if (!isTextMimeType(mimeType)) continue // 二进制按 mime 跳过（官方语义）
        if (glob !== null && !matchGlobBaseName(e.path, glob)) continue
        const buf = tree.content.get(e.path)
        if (buf === undefined) continue
        const lines = buf.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            matches.push({ path: e.path, line: i + 1, text: lines[i].replace(/\n$/, '') })
            if (matches.length >= cap) {
              return { matches, truncated: true } // push 后恰达 cap：无需再截
            }
          }
        }
      }
      // 按 path+line 排序：官方 rg/字面搜索序未定义，V1 定确定性输出（agent 可预期、快照可锁）
      matches.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)))
      return { matches, truncated: false }
    } catch (e) {
      return { error: `grep failed: ${String(e)}` }
    }
  }
}

// BackendProtocolV2 类型级断言：DockerArchiveBackend 满足协议全形状（编译期锁定）。
// runner 票接入 deepagents 时以同样方式对齐 import('deepagents').BackendProtocolV2。
const _protocolCheck: BackendProtocolV2 = null as unknown as DockerArchiveBackend
void _protocolCheck
