// DockerPrimitives —— SandboxFilePrimitives 的 dockerode 适配器（#747·02 · S2 接缝真身）。
// 复用 files 域 ADR 0012 的 Docker 通道形态（getArchive/putArchive/exec rm，tar 工具同 src/files/tar.ts），
// 不新造 Docker 层（issue #772 原文）：exec demux 对齐 PoC dockerBackend.execRaw 与
// dockerRuntime.execSync 的形态；getArchive 全量收集带 MAX_COLLECT_BYTES 护栏（PoC 口径，
// 超护栏 throw——内存防护发生在数据落地前，同 files/dockerArchive.ts probe 哲学）。
//
// 注入：clientFactory 延迟构造（对齐 DockerFileArchive——构造时不连 daemon）；单测注入
// fake client（dockerArchiveBackend.test.ts 不走本文件），真 daemon 仅门控 smoke
// （dockerArchiveBackendSmoke.test.ts）。

import Docker from 'dockerode'
import { Readable, PassThrough } from 'node:stream'
import type { ExecOutcome, SandboxFilePrimitives } from './primitives'
import { MAX_COLLECT_BYTES } from './values'

export class DockerPrimitives implements SandboxFilePrimitives {
  private cached: Docker | null = null

  constructor(private readonly clientFactory: () => Docker = () => new Docker()) {}

  private client(): Docker {
    if (this.cached === null) this.cached = this.clientFactory()
    return this.cached
  }

  // dockerode exec + demux（TTY=false 流带 8 字节复用头，modem.demuxStream 拆 stdout/stderr）。
  // exitCode 原样透传（null = daemon 未能报告）；执行故障（容器不存在等）原样抛。
  async exec(container: string, cmd: string[]): Promise<ExecOutcome> {
    const c = this.client().getContainer(container)
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
    ;(this.client() as unknown as { modem: { demuxStream(s: unknown, o: PassThrough, e: PassThrough): void } }).modem.demuxStream(
      stream,
      stdout,
      stderr,
    )
    await ended
    const info = await exec.inspect()
    return {
      exitCode: info.ExitCode ?? null,
      stdout: Buffer.concat(outBuf).toString('utf8'),
      stderr: Buffer.concat(errBuf).toString('utf8'),
    }
  }

  // getArchive 全量收集 + 404 → null。超 MAX_COLLECT_BYTES 护栏 throw（不驻留超限内存）。
  async getArchive(container: string, absPath: string): Promise<Buffer | null> {
    let stream: NodeJS.ReadableStream
    try {
      stream = (await this.client().getContainer(container).getArchive({ path: absPath })) as unknown as NodeJS.ReadableStream
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
    const it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    const parts: Buffer[] = []
    let total = 0
    for (;;) {
      const next = await it.next()
      if (next.done) break
      total += (next.value as Buffer).length
      if (total > MAX_COLLECT_BYTES) throw new Error(`getArchive ${absPath} exceeds collect guard (${MAX_COLLECT_BYTES} bytes)`)
      parts.push(next.value as Buffer)
    }
    return Buffer.concat(parts)
  }

  // putArchive：单文件/树 tar Buffer 解包进容器 dir。
  async putArchive(container: string, dir: string, tar: Buffer): Promise<void> {
    await this.client().getContainer(container).putArchive(Readable.from([tar]), { path: dir })
  }
}
