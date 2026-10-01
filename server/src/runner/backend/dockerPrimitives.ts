// DockerPrimitives —— SandboxFilePrimitives 的 dockerode 适配器（#747·02 · S2 接缝真身）。
// 复用 files 域 ADR 0012 的 Docker 通道形态（getArchive/putArchive/exec rm，tar 工具同 src/files/tar.ts），
// 不新造 Docker 层（issue #772 原文）：exec demux 对齐 PoC dockerBackend.execRaw 与
// dockerRuntime.execSync 的形态；getArchive 全量收集带 MAX_COLLECT_BYTES 护栏（PoC 口径，
// 超护栏 throw——内存防护发生在数据落地前，同 files/dockerArchive.ts probe 哲学）。
//
// 注入：clientFactory 延迟构造（对齐 DockerFileArchive——构造时不连 daemon）；backend 单测注入
// fake（dockerArchiveBackend.test.ts 不走本文件），adapter 级行为由 dockerPrimitives.test.ts
// 直锁；真 daemon 门控 smoke（dockerArchiveBackendSmoke.test.ts，含超时 kill 真 daemon 用例）。

import Docker from 'dockerode'
import { Readable, PassThrough } from 'node:stream'
import type { ExecOptions, ExecOutcome, SandboxFilePrimitives } from './primitives'
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
  // opts.timeoutMs（评审 M2）：Engine API 无 exec-kill 端点（POST /exec/{id}/kill 对真 daemon
  // 404 实证，moby#9098 长期未实现），exec inspect 的 Pid 又是宿主命名空间值、容器内不可
  // 寻址——改经容器内 timeout coreutil 包 argv（busybox/GNU coreutils 皆有；镜像缺该 applet
  // 时 exec start 拒绝（OCI 404）→ throw → execute 落 exitCode:null，loud 失败不伪装成功；
  // 沙箱镜像含 timeout 是 #776/#784 钉镜像的前置）。
  // 信号取 KILL 单阶段（沙箱进程可弃，省略上游 SIGTERM→grace→SIGKILL 双阶段，对齐注释见
  // dockerArchiveBackend.execute）。
  // 退出码归一：-s KILL 真超时恒 137（busybox 与 GNU coreutils 9.x 实测一致 = 128+KILL；
  // GNU 124 仅 TERM 类信号）/124（防御 TERM 类与其他 timeout 实现）→ 124（上游
  // LocalShellBackend 语义）。消歧：仅当 elapsed >= timeoutMs 才归一——限时内自行
  // exit 124/137（受限沙箱 OOM 被杀常见）原样透传，不篡改为超时、不附误报文案。
  // 残留语义：KILL 直达 timeout 的子进程，sh -c 复合命令的孙进程可能残留
  // （随容器生命周期回收）。
  async exec(container: string, cmd: string[], opts: ExecOptions = {}): Promise<ExecOutcome> {
    const timeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : null
    const argv = timeoutMs !== null ? ['timeout', '-s', 'KILL', String(Math.ceil(timeoutMs / 1000)), ...cmd] : cmd
    const t0 = Date.now()
    const c = this.client().getContainer(container)
    const exec = await c.exec({ Cmd: argv, AttachStdout: true, AttachStderr: true })
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
    const exitCode = info.ExitCode ?? null
    const out = Buffer.concat(outBuf).toString('utf8')
    const err = Buffer.concat(errBuf).toString('utf8')
    const hitTimeout =
      timeoutMs !== null && exitCode !== null && (exitCode === 124 || exitCode === 137) && Date.now() - t0 >= timeoutMs
    if (hitTimeout) {
      return { exitCode: 124, stdout: out, stderr: `${err}\nexecute timed out after ${timeoutMs}ms (process killed)` }
    }
    return { exitCode, stdout: out, stderr: err }
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
