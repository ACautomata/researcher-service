// DockerFileArchive —— FileArchive 的 dockerode 适配层（#589 · ADR 0012；T0 #801 只读化收缩）。
// 读（readLab/readLabBytes）经 getArchive（以容器为视角打 tar 流，穿过挂载点读卷数据）、写经
// putArchive、删经容器内 exec rm。容器存在即可读（stopped 的 getArchive 由 daemon 处理，
// 不需进程）；写/删先幂等 start（保 exec mkdir / rm 可用，对齐 ADR「stopped 删除需先 start」）。
// client 延迟注入（默认 new Docker() 挂 docker.sock）——构造时不连 daemon（对齐 DockerRuntime）。
// legacy fleet 文件树读写删（root=wiki/workspace）与 openclaw.json config 写读链随 T0 清退删除。
//
// 内存防护（#586 US8「接口不会被大二进制拖垮」）：probe 流式读第一个业务头，文件超
// MAX_FILE_READ_BYTES 时只保留头元数据（size/mtime）、排干剩余流不驻留字节——超大文件读请求
// 不把文件内容拉进控制面内存。

import Docker from 'dockerode'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { containerName } from '../containers/runtime'
import { MOUNT_WORKSPACE } from '../containers/constants'
import { FileExists, FileInvalidPath, FileNotFound } from './errors'
import type { DirListing, FileArchive, FileEntry, FileReading } from './fsPort'
import { LAB_ROOT_ABS, MAX_FILE_READ_BYTES, WALK_LIMIT } from './values'
import { alignTo, createTarFile, createTarTree, mtimeIso, normalizeTarName, parseNumeric, parseTar, type TarEntry, type TarTreeEntry } from './tar'

function toEntry(t: TarEntry): FileEntry {
  return {
    path: t.name,
    // symlink 等非目录条目统一按 file 呈现（spec 的 type 枚举仅 file/directory；读 symlink 已被拒）
    type: t.type === 'directory' ? 'directory' : 'file',
    size: t.size,
    modified: new Date(t.mtime * 1000).toISOString(),
  }
}

// 模板目录树 walk（seedWorkspace 源收集）：先序（目录条目先于其内容），同层按名字典序稳定
// 产出；符号链接跳过（不 dereference、不产链接条目——模板树自包含，悬空链接不炸 create）。
async function walkTree(absDir: string, relDir: string): Promise<TarTreeEntry[]> {
  const names = await readdir(absDir, { withFileTypes: true })
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const out: TarTreeEntry[] = []
  for (const d of names) {
    const abs = path.join(absDir, d.name)
    const rel = relDir === '' ? d.name : `${relDir}/${d.name}`
    if (d.isDirectory()) {
      out.push({ name: rel, type: 'directory' })
      out.push(...(await walkTree(abs, rel)))
    } else if (d.isFile()) {
      out.push({ name: rel, type: 'file', content: await readFile(abs) })
    }
  }
  return out
}

// probe 结果：ok（完整 tar 已收集）/ oversized（只读头，超大文件不收集）/ null（路径不存在）
type ProbeResult =
  | { kind: 'ok'; buf: Buffer; entries: TarEntry[]; root: TarEntry }
  | { kind: 'oversized'; size: number; mtime: number }
  | null

// 排干流的全部剩余字节（超大文件场景：丢弃不驻留）
async function drainStream(it: AsyncIterator<Buffer>): Promise<void> {
  for (;;) {
    const next = await it.next()
    if (next.done) return
  }
}

export class DockerFileArchive implements FileArchive {
  private cached: Docker | null = null

  constructor(private readonly clientFactory: () => Docker = () => new Docker()) {}

  private client(): Docker {
    if (this.cached === null) this.cached = this.clientFactory()
    return this.cached
  }

  // 树根 + 相对路径 → 容器内绝对路径（join 单一来源；absPath 与 InContainer 写面共用）
  private static joinRoot(base: string, relPath: string): string {
    return relPath === '' ? base : `${base}/${relPath}`
  }

  // ---- docker 原语封装（404 语义与 exec 模式对齐 DockerRuntime） ----

  // 幂等 start（已 running → docker 返 304 幂等成功；容器消失 404 幂等成功，后续 exec 再暴露）。
  // dockerName 原文直用——wiki 容器面传 researcher-wiki-<ownerId>（#784），lab 面不经此。
  private async start(dockerName: string): Promise<void> {
    try {
      await this.client().getContainer(dockerName).start()
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode
      if (sc === 404 || sc === 304) return
      throw e
    }
  }

  // 同步等命令完成；退出码非 0 → 抛错（mkdir/rm 失败须让 caller 走错误路径）
  private async execSync(dockerName: string, cmd: string[]): Promise<void> {
    const container = this.client().getContainer(dockerName)
    const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
    const stream = await exec.start({ Detach: false })
    await drainStream(stream[Symbol.asyncIterator]()) // 排干（非 TTY 流含 demux 头，仅作结束信号）
    const info = await exec.inspect()
    if (info.ExitCode !== 0) {
      throw new Error(`exec failed in ${dockerName}: exit_code=${info.ExitCode} cmd=${JSON.stringify(cmd)}`)
    }
  }

  // 流式 probe：读第一个业务头（容忍前置 GNU 'L' / PAX 'x' 元头）→ 超大文件只留元数据；
  // 否则收集完整 tar 解析。路径不存在（daemon 404）→ null。
  // container = docker 容器名原文：lab 面直传 researcher-sandbox-<sessionId>（readLab，#776），
  // wiki 面传 researcher-wiki-<ownerId>——本方法不再二次加工。
  private async probe(container: string, absPath: string): Promise<ProbeResult> {
    let stream: NodeJS.ReadableStream
    try {
      stream = await this.client().getContainer(container).getArchive({ path: absPath })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
    const it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    let carry = Buffer.alloc(0) // 未消费缓冲：chunk 可能远大于 512，多余字节保留给后续收集

    // 保证 carry 至少够 n 字节（不足则续读；流尽返回 false）
    const ensure = async (n: number): Promise<boolean> => {
      while (carry.length < n) {
        const next = await it.next()
        if (next.done) return false
        carry = Buffer.concat([carry, next.value])
      }
      return true
    }

    for (;;) {
      if (!(await ensure(512))) return null // 流空/无头 → 不存在
      const head = carry.subarray(0, 512)
      if (head.every((b) => b === 0)) return null // 零块 → 不存在
      const typeflag = String.fromCharCode(head[156])
      if (typeflag === 'L' || typeflag === 'K' || typeflag === 'x' || typeflag === 'g') {
        // 元头（GNU longname / PAX）：跳过其头 + 数据段（size + 对齐），继续读业务头
        const metaSize = parseNumeric(head.subarray(124, 136))
        const skip = 512 + alignTo(metaSize)
        if (!(await ensure(skip))) return null
        carry = carry.subarray(skip)
        continue
      }
      const size = parseNumeric(head.subarray(124, 136))
      if (size > MAX_FILE_READ_BYTES) {
        // 超大单文件：只留头元数据，排干剩余流（字节不驻留控制面内存）
        await drainStream(it)
        return { kind: 'oversized', size, mtime: parseNumeric(head.subarray(136, 148)) }
      }
      // 常规：收集 carry（含业务头）剩余 + 流剩余，完整解析
      const parts: Buffer[] = [carry]
      for (;;) {
        const next = await it.next()
        if (next.done) break
        parts.push(next.value)
      }
      const buf = Buffer.concat(parts)
      const entries = parseTar(buf, { collectData: false })
      const root = entries[0]
      if (!root) return null
      return { kind: 'ok', buf, entries, root }
    }
  }

  // 写/建共用后段：幂等 start → mkdir -p 父目录 → putArchive 单文件 tar
  private async ensureParentAndPut(dockerName: string, absPath: string, content: Buffer): Promise<void> {
    await this.start(dockerName)
    await this.execSync(dockerName, ['mkdir', '-p', absPath.slice(0, absPath.lastIndexOf('/'))])
    const container = this.client().getContainer(dockerName)
    const basename = absPath.split('/').pop() ?? 'file'
    const dir = absPath.slice(0, absPath.lastIndexOf('/'))
    await container.putArchive(Readable.from([createTarFile(basename, content)]), { path: dir })
  }

  // ---- FileArchive 实现 ----

  // #776 root=lab 沙箱读面：dockerName 原文直用（不套 openclaw-gw- 前缀），树根固定 /lab。
  async readLab(dockerName: string, relPath: string, recursive: boolean): Promise<DirListing | FileReading> {
    return this.readContainer(
      dockerName,
      DockerFileArchive.joinRoot(LAB_ROOT_ABS, relPath),
      relPath,
      recursive,
    )
  }

  // #780 沙箱字节读（附件下载端点）：与 readLab 的 file 分支同探针/收集路径，但**不做 NUL
  // 嗅探与 UTF-8 转码**——直接返回 entry.data Buffer（/lab/uploads/<attachmentId>/<原文件名> 的
  // 图片/音视频字节透传）。
  async readLabBytes(dockerName: string, relPath: string): Promise<Buffer> {
    const absPath = DockerFileArchive.joinRoot(LAB_ROOT_ABS, relPath)
    const probed = await this.probe(dockerName, absPath)
    if (probed === null) throw new FileNotFound(relPath)
    if (probed.kind === 'oversized') throw new FileInvalidPath(relPath)
    if (probed.root.type !== 'file') throw new FileInvalidPath(relPath)
    const full = parseTar(probed.buf, { collectData: true, maxDataBytes: MAX_FILE_READ_BYTES })
    const entry = full[0]
    if (!entry) throw new FileNotFound(relPath)
    return entry.data ?? Buffer.alloc(0)
  }

  // 读通道本体（readLab 用）：absPath = 容器内绝对路径，relPath = 相对树根的回显路径。
  private async readContainer(
    container: string,
    absPath: string,
    relPath: string,
    recursive: boolean,
  ): Promise<DirListing | FileReading> {
    const probed = await this.probe(container, absPath)
    if (probed === null) throw new FileNotFound(relPath)
    if (probed.kind === 'oversized') {
      // 超上限：明确过滤信号（content null + oversized），不返回内容
      return {
        kind: 'file',
        path: relPath,
        content: null,
        size: probed.size,
        modified: mtimeIso(probed.mtime),
        binary: false,
        oversized: true,
      }
    }
    const { buf, entries, root: rootEntry } = probed

    if (rootEntry.type === 'directory') {
      // Docker 目录 getArchive：根条目 = basename（如 'lab'），子条目带 'lab/' 前缀
      // （对齐 `docker cp` 语义）；逐条 strip 根前缀得到相对 root 的路径。
      const prefix = normalizeTarName(rootEntry.name)
      const files: FileEntry[] = []
      let truncated = false
      for (const t of entries.slice(1)) {
        const raw = normalizeTarName(t.name)
        if (raw === null) continue
        const name_ = prefix !== null && raw.startsWith(`${prefix}/`) ? raw.slice(prefix.length + 1) : raw
        if (name_ === '') continue
        // 非递归只列直接子项（无 '/'）；递归收全量（条目名即完整相对路径）
        if (!recursive && name_.includes('/')) continue
        if (files.length >= WALK_LIMIT) {
          truncated = true
          break
        }
        files.push(toEntry({ ...t, name: name_ }))
      }
      const result: DirListing = { kind: 'dir', path: relPath, files, truncated }
      return result
    }

    if (rootEntry.type === 'file') {
      // 已排除 oversized（probe 短路），此处收集必成功
      const full = parseTar(buf, { collectData: true, maxDataBytes: MAX_FILE_READ_BYTES })
      const entry = full[0]
      if (!entry) throw new FileNotFound(relPath)
      const binary = entry.data === null ? false : entry.data.includes(0) // NUL 嗅探判二进制（US8）
      return {
        kind: 'file',
        path: relPath,
        content: binary ? null : (entry.data?.toString('utf8') ?? ''),
        size: entry.size,
        modified: mtimeIso(entry.mtime),
        binary,
        oversized: false,
      }
    }

    throw new FileInvalidPath(relPath) // symlink / 特殊类型：不支持读
  }

  // ---- 显式容器名写面（#784）：wiki 域 REST 挂 wiki 容器（researcher-wiki-<ownerId>，
  // 树根 /wiki）——写/建/删三方法以 docker 名 + 绝对树根直给。

  async writeInContainer(dockerName: string, absRoot: string, relPath: string, content: string): Promise<void> {
    const absPath = DockerFileArchive.joinRoot(absRoot, relPath)
    const probed = await this.probe(dockerName, absPath)
    if (probed === null) throw new FileNotFound(relPath)
    if (probed.kind === 'ok' && probed.root.type !== 'file') throw new FileInvalidPath(relPath) // 目录/链接不可覆写
    await this.ensureParentAndPut(dockerName, absPath, Buffer.from(content, 'utf8'))
  }

  async createInContainer(dockerName: string, absRoot: string, relPath: string, content: string): Promise<void> {
    const absPath = DockerFileArchive.joinRoot(absRoot, relPath)
    const probed = await this.probe(dockerName, absPath)
    if (probed !== null) throw new FileExists(relPath)
    await this.ensureParentAndPut(dockerName, absPath, Buffer.from(content, 'utf8'))
  }

  async deleteInContainer(dockerName: string, absRoot: string, relPath: string): Promise<void> {
    const absPath = DockerFileArchive.joinRoot(absRoot, relPath)
    const probed = await this.probe(dockerName, absPath)
    if (probed === null) throw new FileNotFound(relPath)
    if (probed.kind === 'ok' && probed.root.type === 'directory') throw new FileInvalidPath(relPath) // 只支持删文件
    await this.start(dockerName)
    await this.execSync(dockerName, ['rm', '-f', '--', absPath])
  }

  // 模板 workspace 灌卷（#6xx · named volume 拓扑下 researcher workspace 预填充）：递归 walk
  // hostDir → 目录树 tar（目录先序条目，父目录先建）→ putArchive 解包进 ~/.openclaw/workspace。
  // chown:true（daemon 语义：应用 tar 头内 uid/gid）+ 头写 node(1000)，灌入文件 node:node——
  // agent 在容器内可写自己的工作区（#660 曾误注「跟随目标目录」，bt 宿主实测不符）。
  // 时序同 writeConfig（create 后 start 前，putArchive 对 created 容器可用）；骨架首挂内容被
  // 同名覆盖（researcher 模板为权威源）。hostDir 不存在/非目录 → 原样抛（fail-fast 不带病出容器）。
  async seedWorkspace(name: string, hostDir: string): Promise<void> {
    const root = path.resolve(hostDir)
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) throw new FileInvalidPath(root)
    const entries = await walkTree(root, '')
    const container = this.client().getContainer(containerName(name))
    await container.putArchive(Readable.from([createTarTree(entries)]), {
      path: MOUNT_WORKSPACE, // 容器内挂载点单一来源（containers/constants）
      chown: true,
    })
  }
}
