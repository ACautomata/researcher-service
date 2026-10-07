// DockerFileArchive 适配层单测（接缝：clientFactory 注入 mock dockerode client）。
// T0 #801 只读化收缩后本文件覆盖：readLab 沙箱只读读面（目录/文件/404/truncated 语义）
// 与 seedWorkspace 灌卷（多条目 tar 原语序列 + chown）；legacy 读写删与 config 链用例随
// root=wiki/workspace 与 openclaw.json 写盘链退役删除。真容器端到端由 containers-smoke 覆盖。
// tar 流用本模块 createTarFile 自举构造（读侧真实走 parseTar 解析）。

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type Docker from 'dockerode'
import { DockerFileArchive } from '../src/files/dockerArchive'
import { FileNotFound } from '../src/files/errors'
import { createTarFile, parseTar } from '../src/files/tar'

// 造一个目录 tar（对齐 Docker getArchive 产出）：根 '.' + 直接子项 + 深层文件。
// mtime 秒精度（2024-01-01）。createTarFile 自带尾部结束零块，拼接时去除、末位统一补。
function dirTar(entries: { name: string; content?: string }[]): Buffer {
  const parts: Buffer[] = []
  const mtime = 1_704_067_200
  for (const e of entries) {
    if (e.content === undefined) {
      // 目录条目（tar 内名字带尾 '/'，Docker 的目录条目为 typeflag '5'）
      const dir = createTarFile(`${e.name}/`, Buffer.alloc(0), mtime)
      // createTarFile 产的是 type '0' 文件——改造成目录条目：把 typeflag 改 '5'，size 置 0
      const h = Buffer.from(dir)
      h.write('5', 156, 'utf8') // typeflag '5' 目录；chksum 未重算（parseTar 宽容不校验）
      h.write('00000000000', 124, 'utf8') // size 0
      parts.push(h.subarray(0, 512))
      continue
    }
    const tar = createTarFile(e.name, Buffer.from(e.content, 'utf8'), mtime)
    parts.push(tar.subarray(0, tar.length - 1024)) // 去尾部结束零块
  }
  parts.push(Buffer.alloc(1024)) // 结束零块
  return Buffer.concat(parts)
}

// mock dockerode：记录 getArchive/putArchive/exec/start 调用，可注入 tar 结果与 404。
function mockClient(opts: {
  archives?: Map<string, Buffer>
  archive404?: Set<string>
  startErr?: { statusCode: number }
}): { docker: Docker; calls: { kind: string; path?: string; cmd?: string[]; stream?: Buffer; chown?: boolean }[] } {
  const calls: { kind: string; path?: string; cmd?: string[]; stream?: Buffer; chown?: boolean }[] = []
  const docker = {
    getContainer: (_name: string) => ({
      getArchive: async (o: { path: string }) => {
        calls.push({ kind: 'getArchive', path: o.path })
        if (opts.archive404?.has(o.path)) {
          const e = new Error('no such path') as Error & { statusCode: number }
          e.statusCode = 404
          throw e
        }
        return Readable.from([opts.archives?.get(o.path) ?? Buffer.alloc(0)])
      },
      putArchive: async (stream: NodeJS.ReadableStream, o: { path: string; chown?: boolean }) => {
        const chunks: Buffer[] = []
        for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c)
        calls.push({ kind: 'putArchive', path: o.path, stream: Buffer.concat(chunks), chown: o.chown })
      },
      start: async () => {
        calls.push({ kind: 'start' })
        if (opts.startErr) {
          const e = new Error('start failed') as Error & { statusCode: number }
          e.statusCode = opts.startErr.statusCode
          throw e
        }
      },
      exec: async (e: { Cmd: string[] }) => {
        calls.push({ kind: 'exec', cmd: e.Cmd })
        return {
          start: async () => Readable.from([Buffer.alloc(0)]),
          inspect: async () => ({ ExitCode: 0 }),
        }
      },
    }),
  } as unknown as Docker
  return { docker, calls }
}

describe('DockerFileArchive readLab（#776 root=lab 沙箱只读读面）', () => {
  it('docker 名原文直用（不套 openclaw-gw- 前缀）；树根固定 /lab；目录/文件分支同读通道', async () => {
    const LAB_ROOT = '/lab'
    const archives = new Map<string, Buffer>([
      [LAB_ROOT, dirTar([{ name: '.' }, { name: 'notes.md', content: '# lab\n' }, { name: 'out' }, { name: 'out/r.txt', content: '42' }])],
      [`${LAB_ROOT}/notes.md`, createTarFile('notes.md', Buffer.from('# lab\n'), 1_704_067_200)],
    ])
    const { docker, calls } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    // docker 名 = researcher-sandbox-<sessionId> 原文（适配层不得再拼 fleet 前缀）
    const dir = await fa.readLab('researcher-sandbox-c0001', '', false)
    expect(dir).toMatchObject({ kind: 'dir', path: '' })
    if (dir.kind !== 'dir') return
    expect(dir.files.map((f) => f.path)).toEqual(['notes.md', 'out'])
    const file = await fa.readLab('researcher-sandbox-c0001', 'notes.md', false)
    expect(file).toMatchObject({ kind: 'file', path: 'notes.md', content: '# lab\n', binary: false })
    // 探针落点：/lab 树根与 /lab/notes.md（不落 wiki/workspace 路径）
    expect(calls.map((c) => c.path)).toEqual([LAB_ROOT, `${LAB_ROOT}/notes.md`])
  })

  it('沙箱/路径不存在（daemon 404）→ FileNotFound（60040 语义；不触发惰性创建）', async () => {
    const { docker } = mockClient({ archive404: new Set(['/lab']) })
    const fa = new DockerFileArchive(() => docker)
    await expect(fa.readLab('researcher-sandbox-missing', '', false)).rejects.toBeInstanceOf(FileNotFound)
  })
})



describe('DockerFileArchive seedWorkspace（#6xx named volume 模板 workspace 灌卷）', () => {
  it('递归 walk 模板目录 → 多条目 tar putArchive 到 ~/.openclaw/workspace（目录先序 + chown）', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'seedws-'))
    mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true })
    writeFileSync(path.join(root, 'AGENTS.md'), '# ws\n')
    writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), '# skill\n')

    const { docker, calls } = mockClient({})
    const fa = new DockerFileArchive(() => docker)
    await fa.seedWorkspace('box', root)

    expect(calls.map((c) => c.kind)).toEqual(['putArchive']) // 无 start/exec/probe（created 容器可用）
    const put = calls.find((c) => c.kind === 'putArchive')!
    expect(put.path).toBe('/home/node/.openclaw/workspace')
    expect(put.chown).toBe(true) // daemon 语义：应用 tar 头内 uid/gid（bt 宿主实测非「跟随目标目录」）
    const tarBuf = put.stream!
    // tar 头 uid/gid 必须 = 容器内 node(1000:1000)——硬编码 0 会落 root:root，agent 不可写
    // （#660 回归：部署机实测灌入文件 root:root。八进制 1000 = '0001750'）
    expect(tarBuf.subarray(108, 116).toString('latin1').replace(/\0.*$/, '')).toBe('0001750')
    expect(tarBuf.subarray(116, 124).toString('latin1').replace(/\0.*$/, '')).toBe('0001750')
    expect(tarBuf.subarray(265, 297).toString('latin1').replace(/\0.*$/, '')).toBe('node')
    expect(tarBuf.subarray(297, 329).toString('latin1').replace(/\0.*$/, '')).toBe('node')
    const parsed = parseTar(tarBuf, { collectData: true })
    expect(parsed.map((e) => `${e.type}:${e.name}`)).toEqual([
      'file:AGENTS.md',
      'directory:skills',
      'directory:skills/demo',
      'file:skills/demo/SKILL.md',
    ])
    expect(parsed[0].data?.toString('utf8')).toBe('# ws\n')
    expect(parsed[3].data?.toString('utf8')).toBe('# skill\n')
  })

  it('hostDir 不存在 → 原样抛（fail-fast 不带病出容器），不发 putArchive', async () => {
    const { docker, calls } = mockClient({})
    const fa = new DockerFileArchive(() => docker)
    await expect(fa.seedWorkspace('box', '/nonexistent/seed-src')).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

