// DockerFileArchive —— FileArchive 的 dockerode 适配层（#589 · ADR 0012；T0 #801 只读化收缩）。
// 只读：readLab/readLabBytes 经 getArchive（以容器为视角打 tar 流，穿过挂载点读卷数据）——
// 容器存在即可读（stopped 的 getArchive 由 daemon 处理，不需进程）。
// client 延迟注入（默认 new Docker() 挂 docker.sock）——构造时不连 daemon（对齐 DockerRuntime）。
// legacy fleet 文件树读写删（root=wiki/workspace）与 openclaw.json config 写读链随 T0 清退删除；
// seedWorkspace 模板灌卷随 fleet create 流程退役（#858）；wiki 域显式容器名写/建/删三方法
//（#784 InContainer 系）随 #758 Q3 wiki 写面整域退役删除——最后生产调用方 wiki/dockerFs 写面
// 已物理移除（agent 写路径 = runner wikigen pushBack / DockerArchiveBackend，不经本类）。
//
// 内存防护（#586 US8「接口不会被大二进制拖垮」）：probe 流式读第一个业务头，文件超
// MAX_FILE_READ_BYTES 时只保留头元数据（size/mtime）、排干剩余流不驻留字节——超大文件读请求
// 不把文件内容拉进控制面内存。

import Docker from 'dockerode'
import { FileInvalidPath, FileNotFound } from './errors'
import type { DirListing, FileArchive, FileEntry, FileReading } from './fsPort'
import { LAB_ROOT_ABS, MAX_FILE_READ_BYTES, WALK_LIMIT } from './values'
import { alignTo, mtimeIso, normalizeTarName, parseNumeric, parseTar, type TarEntry } from './tar'

function toEntry(t: TarEntry): FileEntry {
  return {
    path: t.name,
    // symlink 等非目录条目统一按 file 呈现（spec 的 type 枚举仅 file/directory；读 symlink 已被拒）
    type: t.type === 'directory' ? 'directory' : 'file',
    size: t.size,
    modified: new Date(t.mtime * 1000).toISOString(),
  }
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

  // 树根 + 相对路径 → 容器内绝对路径（join 单一来源）
  private static joinRoot(base: string, relPath: string): string {
    return relPath === '' ? base : `${base}/${relPath}`
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
}
