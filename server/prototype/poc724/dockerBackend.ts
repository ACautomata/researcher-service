// PoC #724 · THROWAWAY —— DockerArchiveBackend：deepagents BackendProtocolV2/SandboxBackendProtocolV2
// 的 Docker 容器适配层。文件原语走 ADR 0012 同款路径（getArchive/putArchive/exec rm，复用
// src/files/tar.ts），shell 走 dockerode exec（busybox /bin/sh，对齐 dockerRuntime.execSync 形态）。
// 每个原语调用进 latency registry —— 验收问题 1（exec/archive 延迟实测）的数据源。

import Docker from 'dockerode'
import { Readable, PassThrough } from 'node:stream'
import { createTarFile, parseTar, type TarEntry } from '../../src/files/tar'
import { timed, type LatencyRegistry } from './latency'
import type {
  BackendProtocolV2,
  ExecuteResponse,
  ReadResult,
  ReadRawResult,
  LsResult,
  GlobResult,
  GrepResult,
  GrepMatch,
  WriteResult,
  EditResult,
  DeleteResult,
  FileInfo,
  FileData,
} from 'deepagents'

const MAX_COLLECT_BYTES = 32 * 1024 * 1024 // PoC 护栏：单次 getArchive 收集上限
const MAX_OUTPUT_CHARS = 50_000

// ---- 极简 glob（PoC 够用）：支持 exact / *.ext / **/*.ext / dir/** / ** ----
function matchGlob(rel: string, pattern: string): boolean {
  const p = pattern.replace(/^\.\//, '').replace(/^\//, '').replace(/\/$/, '')
  if (p === '' || p === '**') return true
  if (p.startsWith('**/')) {
    const suf = p.slice(3)
    return rel === suf || rel.endsWith(`/${suf}`)
  }
  if (p.endsWith('/**')) {
    const pre = p.slice(0, -3)
    return rel.startsWith(`${pre}/`) || rel === pre
  }
  if (!p.includes('/')) {
    const seg = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel
    const star = p.indexOf('*')
    if (star === 0) return seg.endsWith(p.slice(1))
    if (star > 0) return seg.startsWith(p.slice(0, star)) && seg.endsWith(p.slice(star + 1))
    return seg === p
  }
  return rel === p
}

const MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
}

function mimeOf(p: string): string {
  const dot = p.lastIndexOf('.')
  return dot >= 0 ? (MIME[p.slice(dot).toLowerCase()] ?? 'application/octet-stream') : 'text/plain'
}

function iso(mtimeSec: number): string {
  return new Date(mtimeSec * 1000).toISOString()
}

// 容器内绝对路径归一（防双斜杠/尾斜杠）
function norm(p: string): string {
  if (!p.startsWith('/')) p = `/${p}`
  let n = p.replace(/\/{2,}/g, '/')
  while (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  return n
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  const parts: Buffer[] = []
  let total = 0
  for (;;) {
    const next = await it.next()
    if (next.done) break
    total += (next.value as Buffer).length
    if (total > MAX_COLLECT_BYTES) throw new Error(`poc724: archive 响应超 ${MAX_COLLECT_BYTES} 字节护栏`)
    parts.push(next.value as Buffer)
  }
  return Buffer.concat(parts)
}

// getArchive 条目名归一化（与 dockerArchive.ts 同语义）：去 './' 前缀、尾 '/'；根 '.' → null。
function normalizeTarName(raw: string): string | null {
  let n = raw.startsWith('./') ? raw.slice(2) : raw
  while (n.endsWith('/')) n = n.slice(0, -1)
  if (n === '' || n === '.') return null
  return n
}

// 目录 getArchive 结果的子条目 → 相对 base 的路径（strip 根前缀）
function stripRoot(rootName: string, childName: string): string | null {
  const root = normalizeTarName(rootName)
  const raw = normalizeTarName(childName)
  if (raw === null) return null
  if (root !== null && raw.startsWith(`${root}/`)) return raw.slice(root.length + 1)
  return raw
}

interface ArchiveTree {
  // 相对请求 base 的文件/目录条目（目录 is_dir=true）
  entries: FileInfo[]
  // 文件内容（collectData 时）；key = 相对 base 路径
  content: Map<string, Buffer>
}

export class DockerArchiveBackend implements BackendProtocolV2 {
  readonly id: string

  constructor(
    private docker: Docker,
    private containerName: string,
    private reg: LatencyRegistry,
  ) {
    this.id = `docker-archive:${containerName}`
  }

  private container(): Docker.Container {
    return this.docker.getContainer(this.containerName)
  }

  // ---- docker 原语 ----

  // exec 同步执行：/bin/sh -c，demux 收输出（TTY=false 流带 8 字节复用头）
  private async execRaw(cmd: string[]): Promise<{ exitCode: number; output: string }> {
    const c = this.container()
    const exec = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
    const stream = (await exec.start({ Detach: false })) as unknown as NodeJS.ReadableStream & {
      on(ev: 'end', cb: () => void): void
    }
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const outBuf: Buffer[] = []
    const errBuf: Buffer[] = []
    stdout.on('data', (d: Buffer) => outBuf.push(d))
    stderr.on('data', (d: Buffer) => errBuf.push(d))
    const ended = new Promise<void>((res) => stream.on('end', () => res()))
    ;(this.docker as unknown as { modem: { demuxStream(s: unknown, o: PassThrough, e: PassThrough): void } }).modem.demuxStream(
      stream,
      stdout,
      stderr,
    )
    await ended
    const info = await exec.inspect()
    return {
      exitCode: info.ExitCode ?? -1,
      output: Buffer.concat(outBuf).toString('utf8') + Buffer.concat(errBuf).toString('utf8'),
    }
  }

  private async execSync(cmd: string[], op: string): Promise<void> {
    const r = await timed(this.reg, 'exec', op, () => this.execRaw(cmd))
    if (r.exitCode !== 0) throw new Error(`poc724: exec ${JSON.stringify(cmd)} exit=${r.exitCode} out=${r.output.slice(0, 200)}`)
  }

  // getArchive 全量收集 + 解析（目录：返回整棵子树 tar；文件：单条目）
  private async archiveRead(absPath: string, collectData: boolean): Promise<{ root: TarEntry; tree: ArchiveTree }> {
    const buf = await timed(
      this.reg,
      'archive',
      'getArchive',
      async () => {
        const stream = (await this.container().getArchive({ path: absPath })) as unknown as NodeJS.ReadableStream
        return collectStream(stream)
      },
      (b) => b.length,
    )
    const entries = parseTar(buf, { collectData, maxDataBytes: MAX_COLLECT_BYTES })
    const root = entries[0]
    if (!root) throw new Error(`poc724: getArchive ${absPath} 返回空 tar`)
    const base = norm(absPath)
    const tree: ArchiveTree = { entries: [], content: new Map() }
    if (root.type !== 'directory') {
      tree.entries.push({ path: base, is_dir: false, size: root.size, modified_at: iso(root.mtime) })
      if (collectData && root.data) tree.content.set(base, root.data)
    } else {
      for (const t of entries.slice(1)) {
        const rel = stripRoot(root.name, t.name)
        if (rel === null || rel === '') continue
        const full = `${base}/${rel}`
        tree.entries.push({ path: full, is_dir: t.type === 'directory', size: t.size, modified_at: iso(t.mtime) })
        if (collectData && t.type === 'file' && t.data) tree.content.set(full, t.data)
      }
    }
    return { root, tree }
  }

  // ---- BackendProtocolV2 ----

  async execute(command: string): Promise<ExecuteResponse> {
    const r = await timed(
      this.reg,
      'exec',
      'execute',
      () => this.execRaw(['/bin/sh', '-c', command]),
      (v) => v.output.length,
    )
    const truncated = r.output.length > MAX_OUTPUT_CHARS
    return { output: truncated ? r.output.slice(0, MAX_OUTPUT_CHARS) : r.output, exitCode: r.exitCode, truncated }
  }

  async ls(path: string): Promise<LsResult> {
    try {
      const { root, tree } = await this.archiveRead(norm(path), false)
      if (root.type !== 'directory') return { files: tree.entries }
      return { files: tree.entries.filter((e) => !e.path.slice(norm(path).length + 1).includes('/')) }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    try {
      const { root, tree } = await this.archiveRead(norm(filePath), true)
      if (root.type === 'directory') return { error: `is a directory: ${filePath}` }
      const buf = tree.content.get(norm(filePath))
      if (buf === undefined) return { error: `empty or unreadable: ${filePath}` }
      const text = buf.toString('utf8')
      const lines = text.split('\n')
      const page = lines.slice(offset, offset + limit)
      const endLine = offset + page.length
      return {
        content: page.join('\n'),
        mimeType: mimeOf(filePath),
        totalLines: lines.length,
        startLine: offset + 1,
        endLine,
        nextOffset: endLine < lines.length ? endLine : undefined,
      }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    try {
      const { root, tree } = await this.archiveRead(norm(filePath), true)
      if (root.type === 'directory') return { error: `is a directory: ${filePath}` }
      const buf = tree.content.get(norm(filePath))
      if (buf === undefined) return { error: `empty or unreadable: ${filePath}` }
      const now = new Date().toISOString()
      const data: FileData = {
        content: new Uint8Array(buf),
        mimeType: mimeOf(filePath),
        created_at: now,
        modified_at: now,
      }
      return { data }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const abs = norm(filePath)
      const dir = abs.slice(0, abs.lastIndexOf('/')) || '/'
      const basename = abs.split('/').pop() ?? 'file'
      // mkdir -p 父目录（busybox mkdir，与 dockerArchive.ensureParentAndPut 同形态）
      if (dir !== '/') await this.execSync(['mkdir', '-p', dir], 'mkdir')
      const tar = createTarFile(basename, Buffer.from(content, 'utf8'))
      await timed(this.reg, 'archive', 'putArchive', () =>
        this.container().putArchive(Readable.from([tar]), { path: dir === '/' ? '/' : dir }),
      )
      return { path: abs, filesUpdate: null }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<EditResult> {
    const abs = norm(filePath)
    const r = await this.read(abs)
    if (r.error !== undefined || typeof r.content !== 'string') return { error: r.error ?? 'unreadable' }
    const full = r.content
    if (!full.includes(oldString)) return { error: `oldString not found in ${abs}` }
    const count = full.split(oldString).length - 1
    const occurrences = replaceAll ? count : 1
    const next = replaceAll ? full.split(oldString).join(newString) : full.replace(oldString, newString)
    const w = await this.write(abs, next)
    if (w.error !== undefined) return { error: w.error }
    return { path: abs, occurrences }
  }

  async delete(filePath: string): Promise<DeleteResult> {
    try {
      await this.execSync(['rm', '-rf', '--', norm(filePath)], 'rm')
      return { path: norm(filePath) }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async glob(pattern: string, path = '/'): Promise<GlobResult> {
    try {
      const base = norm(path)
      const { root, tree } = await this.archiveRead(base, false)
      const files = tree.entries.filter((e) => {
        if (e.is_dir) return false
        if (root.type !== 'directory') return matchGlob(e.path, pattern)
        const rel = e.path.slice(base.length + 1)
        return matchGlob(rel, pattern)
      })
      return { files, truncated: false }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async grep(pattern: string, path: string | null = null, glob: string | null = null, maxCount: number | null = null): Promise<GrepResult> {
    try {
      const cap = maxCount ?? 1000
      const base = norm(path ?? '/')
      const { tree } = await this.archiveRead(base, true)
      const matches: GrepMatch[] = []
      let truncated = false
      for (const e of tree.entries) {
        if (e.is_dir) continue
        if (glob !== null && !matchGlob(e.path.slice(base.length + 1), glob)) continue
        const buf = tree.content.get(e.path)
        if (buf === undefined) continue
        const lines = buf.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            matches.push({ path: e.path, line: i + 1, text: lines[i].slice(0, 300) })
            if (matches.length >= cap) {
              truncated = true
              return { matches, truncated }
            }
          }
        }
      }
      return { matches, truncated }
    } catch (e) {
      return { error: String(e) }
    }
  }
}
