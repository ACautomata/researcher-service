// DockerArchiveBackend 全方法单测（#747 S2 接缝：Docker 原语注入 fake，零 daemon 零 langchain）。
// 验收覆盖（issue #772）：
//   1. BackendProtocolV2 全方法实现——ls/read/readRaw/write/edit/delete/glob/grep/execute 行为锁定
//   2. /wiki/ 与 /lab/ 路由按容器目标正确分派（每次原语调用的容器名即证据）
//   3. 语义镜像 deepagents@1.14.1（分页/edit 合成/mime/glob）由 runnerBackendSemantics 直锁，此处测组装
// fake 为内存双容器文件系统（getArchive 返回真实 tar 流自举 createTarFile，读侧走真 parseTar）。
// 真 daemon 路径见 dockerArchiveBackendSmoke.test.ts（自动探测门控）。

import { describe, it, expect } from 'vitest'
import { DockerArchiveBackend } from '../src/runner/backend/dockerArchiveBackend'
import type { ExecOutcome, SandboxFilePrimitives } from '../src/runner/backend/primitives'
import type { BackendTargets } from '../src/runner/backend/paths'
import { createTarFile, parseTar } from '../src/files/tar'
import { MAX_OUTPUT_CHARS } from '../src/runner/backend/values'

const WIKI = 'researcher-wiki-u1'
const LAB = 'researcher-sandbox-s1'
const targets: BackendTargets = { wiki: WIKI, lab: LAB }
const MTIME = 1_704_067_200 // 2024-01-01T00:00:00Z（tar mtime 秒精度）

// ---- 内存 fake：双容器扁平路径表（file/dir 条目）+ 原语调用记录 ----

interface FakeEntry {
  type: 'file' | 'dir'
  content?: Buffer
}

type ExecHandler = (container: string, cmd: string[]) => ExecOutcome | undefined

function fakeDocker(opts: { execHandler?: ExecHandler } = {}) {
  // trees[container] = 绝对路径 → 条目（目录与文件同表，路径已归一）
  const trees = new Map<string, Map<string, FakeEntry>>()
  const calls: { kind: 'exec' | 'getArchive' | 'putArchive'; container: string; cmd?: string[]; path?: string; tar?: Buffer }[] = []
  const execCalls: { container: string; cmd: string[] }[] = []

  const treeOf = (container: string): Map<string, FakeEntry> => {
    let t = trees.get(container)
    if (!t) {
      t = new Map()
      trees.set(container, t)
    }
    return t
  }

  // 造目录 tar（对齐 Docker getArchive 产出）：根条目 = basename 目录项（typeflag '5'），
  // 子条目带 '<basename>/' 前缀（docker cp 语义，dockerFileArchive.test.ts dirTar 同源）。
  const dirTarOf = (tree: Map<string, FakeEntry>, base: string): Buffer => {
    const parts: Buffer[] = []
    const baseName = base.slice(base.lastIndexOf('/') + 1)
    const pushDir = (name: string) => {
      const h = createTarFile(`${name}/`, Buffer.alloc(0), MTIME)
      h.write('5', 156, 'utf8') // typeflag 目录
      h.write('00000000000', 124, 'utf8') // size 0
      parts.push(h.subarray(0, 512))
    }
    const pushFile = (name: string, content: Buffer) => {
      parts.push(createTarFile(name, content, MTIME).subarray(0, 512 + Math.ceil(content.length / 512) * 512))
    }
    pushDir(baseName) // 根目录条目
    const prefix = `${base}/`
    // 直接子项
    const subs: { name: string; e: FakeEntry }[] = []
    for (const [p, e] of tree) {
      if (p === base || !p.startsWith(prefix)) continue
      const rel = p.slice(prefix.length)
      if (rel.includes('/')) continue
      subs.push({ name: rel, e })
    }
    // 全树平铺（含深层），条目名相对 base
    const all: { name: string; e: FakeEntry }[] = []
    for (const [p, e] of tree) {
      if (p === base || !p.startsWith(prefix)) continue
      all.push({ name: p.slice(prefix.length), e })
    }
    for (const { name, e } of subs) {
      if (e.type === 'dir') {
        pushDir(name)
        for (const a of all) {
          if (!a.name.startsWith(`${name}/`) || a.name === name) continue
          if (a.e.type === 'dir') pushDir(a.name)
          else pushFile(a.name, a.e.content ?? Buffer.alloc(0))
        }
      } else {
        pushFile(name, e.content ?? Buffer.alloc(0))
      }
    }
    parts.push(Buffer.alloc(1024))
    return Buffer.concat(parts)
  }

  const primitives: SandboxFilePrimitives = {
    async exec(container, cmd) {
      calls.push({ kind: 'exec', container, cmd })
      execCalls.push({ container, cmd })
      const handled = opts.execHandler?.(container, cmd)
      if (handled) return handled
      // 默认行为：mkdir -p 建目录；rm -rf 删除；其余 exit 0 无输出
      if (cmd[0] === 'mkdir') {
        const target = cmd[cmd.length - 1]
        treeOf(container).set(target, { type: 'dir' })
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (cmd[0] === 'rm') {
        const target = cmd[cmd.length - 1]
        const t = treeOf(container)
        for (const p of [...t.keys()]) if (p === target || p.startsWith(`${target}/`)) t.delete(p)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    async getArchive(container, absPath) {
      calls.push({ kind: 'getArchive', container, path: absPath })
      const t = treeOf(container)
      const e = t.get(absPath)
      if (!e) return null
      if (e.type === 'dir') return dirTarOf(t, absPath)
      const buf = createTarFile(absPath.split('/').pop()!, e.content ?? Buffer.alloc(0), MTIME)
      return buf
    },
    async putArchive(container, dir, tar) {
      calls.push({ kind: 'putArchive', container, path: dir, tar })
      const t = treeOf(container)
      for (const entry of parseTar(tar, { collectData: true })) {
        const name = entry.name.replace(/^\.\//, '').replace(/\/$/, '')
        if (entry.type === 'directory') t.set(`${dir}/${name}`, { type: 'dir' })
        else t.set(`${dir}/${name}`, { type: 'file', content: entry.data ?? Buffer.alloc(0) })
      }
    },
  }

  const seed = (container: string, files: Record<string, string>, dirs: string[] = []) => {
    const t = treeOf(container)
    // 父目录链自动补全（对齐真实文件系统：/wiki 根本身存在，挂载点恒在）
    const ensureParents = (p: string) => {
      let idx = p.lastIndexOf('/')
      while (idx > 0) {
        const parent = p.slice(0, idx)
        if (!t.has(parent)) t.set(parent, { type: 'dir' })
        idx = parent.lastIndexOf('/')
      }
    }
    for (const d of dirs) {
      ensureParents(d)
      t.set(d, { type: 'dir' })
    }
    for (const [p, content] of Object.entries(files)) {
      ensureParents(p)
      t.set(p, { type: 'file', content: Buffer.from(content, 'utf8') })
    }
  }

  return { primitives, calls, execCalls, trees, seed }
}

// ---- 路由分派（验收 2）----

describe('双根路由分派（/wiki/ → wiki 容器，/lab/ → 沙箱容器）', () => {
  it('read/write/edit/delete/glob/grep 的文件操作全部按前缀分派容器', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.md': '# A\n' })
    f.seed(LAB, { '/lab/b.py': 'print(1)\n' })
    const b = new DockerArchiveBackend(f.primitives, targets)

    await b.read('/wiki/a.md')
    await b.read('/lab/b.py')
    await b.write('/wiki/a.md', '# A2\n')
    await b.write('/lab/c.py', 'x')
    await b.edit('/wiki/a.md', '# A2', '# A3')
    await b.delete('/lab/c.py')
    await b.glob('**/*.md', '/wiki')
    await b.grep('print', '/lab')

    const nonExec = f.calls.filter((c) => c.kind !== 'exec')
    expect(nonExec.map((c) => c.container)).toEqual([WIKI, LAB, WIKI, LAB, WIKI, WIKI, WIKI, LAB])
    // exec（mkdir/rm）同样落在正确容器
    const execContainers = f.execCalls.map((c) => `${c.container}:${c.cmd[0]}`)
    expect(execContainers).toEqual([WIKI + ':mkdir', LAB + ':mkdir', WIKI + ':mkdir', LAB + ':rm'])
  })

  it('execute 固定落 /lab 沙箱容器（shell 只在沙箱执行；wiki 容器 busybox 级无运行时）', async () => {
    const f = fakeDocker()
    const b = new DockerArchiveBackend(f.primitives, targets)
    await b.execute('ls /')
    expect(f.execCalls).toEqual([{ container: LAB, cmd: ['/bin/sh', '-c', 'ls /'] }])
  })

  it('非法路径（相对/未知根/穿越）→ error 且不触发任何原语', async () => {
    const f = fakeDocker()
    const b = new DockerArchiveBackend(f.primitives, targets)
    for (const p of ['wiki/a.md', '/etc/passwd', '/wiki/../x', '/wiki/a\u0000b']) {
      const r = await b.read(p)
      expect(r.error).toBeTruthy()
      expect(r.content).toBeUndefined()
    }
    expect(f.calls).toEqual([])
  })

  it('backend id 标识双容器目标', () => {
    const f = fakeDocker()
    const b = new DockerArchiveBackend(f.primitives, targets)
    expect(b.id).toBe(`docker-archive:wiki=${WIKI},lab=${LAB}`)
  })
})

// ---- execute ----

describe('execute（shell 通道，PoC exec 语义）', () => {
  it('exitCode/输出原样透传（stdout+stderr 合并），零截断', async () => {
    const f = fakeDocker({
      execHandler: (_c, cmd) =>
        cmd[2] === 'boom' ? { exitCode: 7, stdout: 'ok\n', stderr: 'err\n' } : undefined,
    })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.execute('boom')
    expect(r).toEqual({ output: 'ok\nerr\n', exitCode: 7, truncated: false })
  })

  it('输出超 MAX_OUTPUT_CHARS → 截断 + truncated:true', async () => {
    const big = 'x'.repeat(MAX_OUTPUT_CHARS + 100)
    const f = fakeDocker({ execHandler: () => ({ exitCode: 0, stdout: big, stderr: '' }) })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.execute('big')
    expect(r.output).toHaveLength(MAX_OUTPUT_CHARS)
    expect(r.truncated).toBe(true)
  })
})

// ---- ls ----

describe('ls', () => {
  it('目录：直接子项（目录 path 带尾 /、is_dir、size、modified_at）', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.md': 'x', '/wiki/notes/b.md': 'y' }, ['/wiki/notes'])
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.ls('/wiki')
    expect(r.error).toBeUndefined()
    expect(r.files).toEqual([
      { path: '/wiki/a.md', is_dir: false, size: 1, modified_at: '2024-01-01T00:00:00.000Z' },
      { path: '/wiki/notes/', is_dir: true, size: 0, modified_at: '2024-01-01T00:00:00.000Z' },
    ])
  })

  it('文件路径/不存在路径 → { files: [] }（对齐官方 ls 非目录行为），非 error', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.md': 'x' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    expect(await b.ls('/wiki/a.md')).toEqual({ files: [] })
    expect(await b.ls('/wiki/nope')).toEqual({ files: [] })
  })
})

// ---- read ----

describe('read（行分页组装）', () => {
  it('文本：mimeType + 分页字段（语义层已直锁，此处测 ReadResult 组装）', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/big.md': 'l1\nl2\nl3\nl4\nl5' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.read('/wiki/big.md', 1, 2)
    expect(r).toEqual({
      content: 'l2\nl3',
      mimeType: 'text/markdown',
      totalLines: 5,
      startLine: 2,
      endLine: 3,
      nextOffset: 3,
    })
  })

  it('二进制（mime 判定）：全文 Uint8Array + mimeType，无分页字段', async () => {
    const f = fakeDocker()
    f.trees.set(WIKI, new Map([['/wiki/pic.png', { type: 'file', content: Buffer.from([0x89, 0x50]) }]]))
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.read('/wiki/pic.png')
    expect(r.error).toBeUndefined()
    expect(r.content).toBeInstanceOf(Uint8Array)
    expect([...new Uint8Array(r.content as Uint8Array)]).toEqual([0x89, 0x50])
    expect(r.mimeType).toBe('image/png')
    expect(r.totalLines).toBeUndefined()
  })

  it('空文件 → EMPTY_CONTENT_WARNING（非 error）', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/empty.md': '' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.read('/wiki/empty.md')
    expect(r.error).toBeUndefined()
    expect(r.content).toBe('System reminder: File exists but has empty contents')
  })

  it('目录 → error；不存在 → error', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/dir/a.md': 'x' }, ['/wiki/dir'])
    const b = new DockerArchiveBackend(f.primitives, targets)
    expect((await b.read('/wiki/dir')).error).toContain('is a directory')
    expect((await b.read('/wiki/nope.md')).error).toBeTruthy()
  })

  it('默认 offset=0/limit=500（deepagents 签名默认）', async () => {
    const f = fakeDocker()
    f.seed(LAB, { '/lab/t.txt': 'a\nb' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.read('/lab/t.txt')
    expect(r).toMatchObject({ content: 'a\nb', totalLines: 2, startLine: 1, endLine: 2 })
  })
})

// ---- readRaw ----

describe('readRaw（FileData V2）', () => {
  it('文本：content string + mimeType + created_at/modified_at = tar mtime', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.md': '# Hi' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.readRaw('/wiki/a.md')
    expect(r.error).toBeUndefined()
    expect(r.data).toEqual({
      content: '# Hi',
      mimeType: 'text/markdown',
      created_at: '2024-01-01T00:00:00.000Z',
      modified_at: '2024-01-01T00:00:00.000Z',
    })
  })

  it('二进制：Uint8Array 内容（mime 二进制扩展名 .png；.bin 在官方表外属 text/plain，对齐上游）', async () => {
    const f = fakeDocker()
    f.trees.set(LAB, new Map([['/lab/f.png', { type: 'file', content: Buffer.from([1, 2, 3]) }]]))
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.readRaw('/lab/f.png')
    expect(r.data?.content).toBeInstanceOf(Uint8Array)
    expect([...new Uint8Array(r.data!.content as Uint8Array)]).toEqual([1, 2, 3])
    expect(r.data && 'mimeType' in r.data && r.data.mimeType).toBe('image/png')
  })
})

// ---- write ----

describe('write', () => {
  it('新建：mkdir -p 父目录（exec）+ putArchive 单文件 tar（内容/mtime），path 返回归一化绝对路径', async () => {
    const f = fakeDocker()
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.write('/lab/src/main.py', 'print(1)')
    expect(r.error).toBeUndefined()
    expect(r.path).toBe('/lab/src/main.py')
    expect(r.filesUpdate).toBeNull()
    expect(f.calls.map((c) => `${c.kind}:${c.container}`)).toEqual([`exec:${LAB}`, `putArchive:${LAB}`])
    const mkdir = f.execCalls[0]
    expect(mkdir.cmd).toEqual(['mkdir', '-p', '/lab/src'])
    const put = f.calls.find((c) => c.kind === 'putArchive')!
    expect(put.path).toBe('/lab/src')
    const parsed = parseTar(put.tar!, { collectData: true })
    expect(parsed[0]).toMatchObject({ name: 'main.py', type: 'file' })
    expect(parsed[0].data?.toString('utf8')).toBe('print(1)')
    // 状态真落：read 回读
    const back = await b.read('/lab/src/main.py')
    expect(back.content).toBe('print(1)')
  })

  it('根下文件：mkdir -p 根挂载点（幂等 no-op）+ putArchive 到根', async () => {
    const f = fakeDocker()
    const b = new DockerArchiveBackend(f.primitives, targets)
    await b.write('/lab/top.txt', 't')
    expect(f.calls.map((c) => c.kind)).toEqual(['exec', 'putArchive'])
    expect(f.execCalls[0].cmd).toEqual(['mkdir', '-p', '/lab'])
    expect(f.calls[1].path).toBe('/lab')
  })

  it('二进制 mime：content 按 base64 解码写盘（对齐官方 FilesystemBackend）', async () => {
    const f = fakeDocker()
    const b = new DockerArchiveBackend(f.primitives, targets)
    await b.write('/lab/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
    expect([...f.trees.get(LAB)!.get('/lab/pic.png')!.content!]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('原语故障 → { error } 不 throw（put 失败）', async () => {
    const f = fakeDocker()
    const failing: SandboxFilePrimitives = {
      ...f.primitives,
      putArchive: async () => {
        throw new Error('daemon exploded')
      },
    }
    const b = new DockerArchiveBackend(failing, targets)
    const r = await b.write('/lab/x.txt', 'x')
    expect(r.error).toContain('daemon exploded')
    expect(r.path).toBeUndefined()
  })
})

// ---- edit ----

describe('edit（read+write 合成）', () => {
  it('唯一命中：全链 read → write（getArchive + mkdir + putArchive），occurrences=1', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.md': 'hello world' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.edit('/wiki/a.md', 'world', 'there')
    expect(r).toEqual({ path: '/wiki/a.md', filesUpdate: null, occurrences: 1 })
    expect(f.calls.map((c) => c.kind)).toEqual(['getArchive', 'exec', 'putArchive'])
    expect((await b.read('/wiki/a.md')).content).toBe('hello there')
  })

  it('多命中未 replaceAll → error 且不写（无 putArchive）', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.md': 'x y x' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.edit('/wiki/a.md', 'x', 'z')
    expect(r.error).toContain('multiple occurrences')
    expect(f.calls.some((c) => c.kind === 'putArchive')).toBe(false)
  })

  it('replaceAll：全替换 + occurrences 计数', async () => {
    const f = fakeDocker()
    f.seed(LAB, { '/lab/a.txt': 'x y x y' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.edit('/lab/a.txt', 'x', 'z', true)
    expect(r.occurrences).toBe(2)
    expect((await b.read('/lab/a.txt')).content).toBe('z y z y')
  })

  it('未命中 → error 且不写', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.md': 'abc' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.edit('/wiki/a.md', 'zzz', 'y')
    expect(r.error).toContain('String not found')
    expect(f.calls.some((c) => c.kind === 'putArchive')).toBe(false)
  })
})

// ---- delete ----

describe('delete', () => {
  it('rm -rf -- 绝对路径（目录递归删，BackendProtocolV2 语义），path 返回', async () => {
    const f = fakeDocker()
    f.seed(LAB, { '/lab/dir/a.txt': 'x', '/lab/dir/b.txt': 'y' }, ['/lab/dir'])
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.delete('/lab/dir')
    expect(r).toEqual({ path: '/lab/dir' })
    expect(f.execCalls[0]).toEqual({ container: LAB, cmd: ['rm', '-rf', '--', '/lab/dir'] })
    expect(await b.ls('/lab')).toEqual({ files: [] })
  })
})

// ---- glob ----

describe('glob（相对搜索基目录的全语义匹配）', () => {
  it('**/*.md 跨目录；只收文件；绝对路径 FileInfo；路径排序', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/z.md': 'z', '/wiki/notes/a.md': 'a', '/wiki/notes/deep/b.md': 'b', '/wiki/x.py': 'x' }, ['/wiki/notes', '/wiki/notes/deep'])
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.glob('**/*.md', '/wiki')
    expect(r.error).toBeUndefined()
    expect(r.files!.map((x) => x.path)).toEqual(['/wiki/notes/a.md', '/wiki/notes/deep/b.md', '/wiki/z.md'])
    expect(r.files![0]).toMatchObject({ is_dir: false, size: 1 })
    expect(r.truncated ?? false).toBe(false)
  })

  it('glob 调用落正确容器；path 参数本身经路由（/lab）', async () => {
    const f = fakeDocker()
    f.seed(LAB, { '/lab/main.py': 'x' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.glob('*.py', '/lab')
    expect(r.files!.map((x) => x.path)).toEqual(['/lab/main.py'])
    expect(f.calls[0]).toMatchObject({ kind: 'getArchive', container: LAB, path: '/lab' })
  })

  it('搜索基目录是文件 → { files: [] }（对齐官方 glob 非目录行为）', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.md': 'x' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    expect(await b.glob('*.md', '/wiki/a.md')).toEqual({ files: [] })
  })
})

// ---- grep ----

describe('grep（literal，二进制跳过，basename includeGlob）', () => {
  it('命中：绝对路径 + 1-indexed 行号 + 行文本（去尾换行）', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.md': 'foo\nbar foo\n', '/wiki/notes/b.md': 'foo here' }, ['/wiki/notes'])
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.grep('foo', '/wiki')
    expect(r.error).toBeUndefined()
    expect(r.matches).toEqual([
      { path: '/wiki/a.md', line: 1, text: 'foo' },
      { path: '/wiki/a.md', line: 2, text: 'bar foo' },
      { path: '/wiki/notes/b.md', line: 1, text: 'foo here' },
    ])
  })

  it('二进制文件按 mime 跳过（png 内容含 pattern 字节也不命中）', async () => {
    const f = fakeDocker()
    f.trees.set(LAB, new Map([['/lab/blob.png', { type: 'file', content: Buffer.from('foo-in-binary', 'utf8') }]]))
    f.seed(LAB, { '/lab/a.txt': 'foo text' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.grep('foo', '/lab')
    expect(r.matches!.map((m) => m.path)).toEqual(['/lab/a.txt'])
  })

  it('includeGlob 按 basename 匹配（**/*.md 过滤跨目录文件名）；matches 按 path+line 排序', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/x.md': 'hit', '/wiki/sub/y.py': 'hit', '/wiki/sub/z.md': 'hit' }, ['/wiki/sub'])
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.grep('hit', '/wiki', '**/*.md')
    expect(r.matches!.map((m) => m.path)).toEqual(['/wiki/sub/z.md', '/wiki/x.md'])
  })

  it('maxCount 截断：超 cap → truncated:true + 恰好 cap 条', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.txt': Array.from({ length: 5 }, () => 'hit').join('\n') })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.grep('hit', '/wiki', null, 3)
    expect(r.matches).toHaveLength(3)
    expect(r.truncated).toBe(true)
  })

  it('默认 cap = 1000：1001 命中 → truncated', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.txt': Array.from({ length: 1001 }, () => 'hit').join('\n') })
    const b = new DockerArchiveBackend(f.primitives, targets)
    const r = await b.grep('hit', '/wiki')
    expect(r.matches).toHaveLength(1000)
    expect(r.truncated).toBe(true)
  })

  it('无命中 → { matches: [] }（非 error）', async () => {
    const f = fakeDocker()
    f.seed(WIKI, { '/wiki/a.md': 'x' })
    const b = new DockerArchiveBackend(f.primitives, targets)
    expect(await b.grep('zzz', '/wiki')).toEqual({ matches: [], truncated: false })
  })
})
