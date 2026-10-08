// DockerWikiFileSystem 适配器单测（#621）：注入 fake snapshot/probeFile/archive 纯逻辑直测，
// 不碰真 docker（对齐 dockerFileArchive.test.ts 的「fake 适配器依赖」分工——docker 接线由
// dockerFileArchive.test.ts 已覆盖的 mock client + 真 tar 模式保障，本文件钉 wiki 语义层）。
// 覆盖：tree 分组/title 兜底链/SKIP 过滤/symlink 跳过/空目录/
// 快照 null 降级/probeFile 三分支映射/managed 黑名单三写一读/异常映射膜/FileExists。

import { describe, it, expect } from 'vitest'
import { FileExists, FileInvalidPath, FileNotFound } from '../src/files/errors'
import type { TarEntry } from '../src/files/tar'
import { DockerWikiFileSystem, type WikiContainerArchive, type WikiProbeResult } from '../src/wiki/dockerFs'
import { WikiInvalidPath, WikiPageExists, WikiPageNotFound } from '../src/wiki/errors'

// 单文件条目（data 默认给空——title/decode 行为由用例按需给）。
function file(name: string, data: Buffer | null = null): TarEntry {
  return { name, type: 'file', size: data?.length ?? 0, mtime: 0, data }
}
function dir(name: string): TarEntry {
  return { name, type: 'directory', size: 0, mtime: 0, data: null }
}
function link(name: string): TarEntry {
  return { name, type: 'symlink', size: 0, mtime: 0, data: null }
}

// 最小 fake 写面（#784 WikiContainerArchive）：只实现 DockerWikiFileSystem 用到的
// writeInContainer/createInContainer/deleteInContainer。可注入：记录调用、按策略抛 files 域异常。
type ArchiveMethod = 'write' | 'create' | 'delete'
class FakeArchive implements WikiContainerArchive {
  calls: Array<{ method: ArchiveMethod; absRoot: string; relPath: string; content?: string }> = []
  constructor(private readonly behave: Partial<Record<ArchiveMethod, (relPath: string) => Error | void>> = {}) {}
  async writeInContainer(_dockerName: string, absRoot: string, relPath: string, content: string): Promise<void> {
    this.calls.push({ method: 'write', absRoot, relPath, content })
    const e = this.behave.write?.(relPath)
    if (e) throw e
  }
  async createInContainer(_dockerName: string, absRoot: string, relPath: string, content: string): Promise<void> {
    this.calls.push({ method: 'create', absRoot, relPath, content })
    const e = this.behave.create?.(relPath)
    if (e) throw e
  }
  async deleteInContainer(_dockerName: string, absRoot: string, relPath: string): Promise<void> {
    this.calls.push({ method: 'delete', absRoot, relPath })
    const e = this.behave.delete?.(relPath)
    if (e) throw e
  }
}

const enc = (s: string) => Buffer.from(s, 'utf8')

function makeDocker(
  opts: {
    snapshot?: () => Promise<TarEntry[] | null>
    probeFile?: (relPath: string) => Promise<WikiProbeResult>
    archive?: FakeArchive
  } = {},
): DockerWikiFileSystem {
  return new DockerWikiFileSystem('demo', {
    snapshot: opts.snapshot,
    probeFile: opts.probeFile,
    archive: opts.archive ?? new FakeArchive(),
  })
}

describe('DockerWikiFileSystem 寻址面（#784 挂新 wiki 容器）', () => {
  it('dockerName 原文保留、rootPath 缺省 /wiki（可写层，wikiContainers/values 单一来源）', () => {
    const fs = new DockerWikiFileSystem('researcher-wiki-u1')
    expect(fs.dockerName).toBe('researcher-wiki-u1')
    expect(fs.rootPath).toBe('/wiki')
  })

  it('rootPath 可覆盖（测试异形根缝）', () => {
    const fs = new DockerWikiFileSystem('any', { rootPath: '/custom' })
    expect(fs.rootPath).toBe('/custom')
  })
})

describe('DockerWikiFileSystem.buildTree', () => {
  it('snapshot 为 null（容器/wiki 目录不存在/超限）→ 空树降级', async () => {
    const fs = makeDocker({ snapshot: async () => null })
    expect(await fs.buildTree()).toEqual({ groups: [] })
  })

  it('按首段目录成组；组序与组内按 cmp 排序；顶层散落页不收', async () => {
    const fs = makeDocker({
      snapshot: async () => [
        file('concepts/attention.md', enc('---\ntitle: Attention\n---\n# ignored\n')),
        file('thoughts/idea.md', enc('# First Idea\n')), // 无 frontmatter → stem（无 H1 兜底）
        file('domains/cv/papers/resnet.md', enc('---\npaper:\n  title: ResNet\n---\n# R\n')),
        file('top.md', enc('# Top\n')), // 顶层散落页不收
      ],
    })
    const tree = await fs.buildTree()
    expect(tree.groups.map((g) => g.kind)).toEqual(['concepts', 'domains', 'thoughts'])
    const concepts = tree.groups[0]
    expect(concepts.pages).toEqual([{ path: 'concepts/attention.md', title: 'Attention' }])
    const thoughts = tree.groups.find((g) => g.kind === 'thoughts')!
    expect(thoughts.pages[0].title).toBe('idea') // frontmatter 无 → stem（H1 不兜底，对齐 NodeFs buildTree）
  })

  it('symlink / 非 .md / SKIP_DIRS 段 / SKIP_FILES 末段 一律跳过', async () => {
    const fs = makeDocker({
      snapshot: async () => [
        link('concepts/evil.md'), // symlink 跳过
        file('concepts/notes.txt', enc('x')), // 非 .md 跳过
        file('_attachments/cache.md', enc('x')), // SKIP_DIRS 段
        file('concepts/index.md', enc('x')), // SKIP_FILES 末段
        file('concepts/keep.md', enc('---\ntitle: Keep\n---\n')),
      ],
    })
    const tree = await fs.buildTree()
    expect(tree.groups[0].pages.map((p) => p.path)).toEqual(['concepts/keep.md'])
  })

  it('data=null（超大未收集）→ title 退 stem；坏 UTF-8 → title 退 stem', async () => {
    const fs = makeDocker({
      snapshot: async () => [
        file('concepts/oversized.md', null),
        file('concepts/bad-utf8.md', Buffer.from([0xff, 0xfe])),
      ],
    })
    const tree = await fs.buildTree()
    const titles = tree.groups[0].pages.map((p) => p.title)
    expect(titles).toEqual(['bad-utf8', 'oversized'])
  })

  it('空目录（仅有目录条目、无文件页）→ 不成组', async () => {
    const fs = makeDocker({
      snapshot: async () => [dir('empty'), dir('concepts'), file('concepts/a.md', enc('---\ntitle: A\n---\n'))],
    })
    const tree = await fs.buildTree()
    expect(tree.groups.map((g) => g.kind)).toEqual(['concepts'])
  })
})

describe('DockerWikiFileSystem.readPage', () => {
  it('managed 路径 → WikiInvalidPath（CRUD 前置黑名单）', async () => {
    const fs = makeDocker({ probeFile: async () => null })
    await expect(fs.readPage('_attachments/x.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.readPage('concepts/index.md')).rejects.toBeInstanceOf(WikiInvalidPath)
  })

  it('probeFile null → WikiPageNotFound；dir → WikiPageNotFound；link → WikiInvalidPath', async () => {
    const fs = makeDocker({
      probeFile: async (rel) => {
        if (rel === 'concepts/nope.md') return null
        if (rel === 'concepts/adir.md') return { kind: 'dir' }
        if (rel === 'concepts/evil.md') return { kind: 'link' }
        if (rel === 'concepts/a.md') return { kind: 'file', data: enc('---\ntitle: A\n---\n# A\n') }
        return null
      },
    })
    await expect(fs.readPage('concepts/nope.md')).rejects.toBeInstanceOf(WikiPageNotFound)
    await expect(fs.readPage('concepts/adir.md')).rejects.toBeInstanceOf(WikiPageNotFound)
    await expect(fs.readPage('concepts/evil.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    const page = await fs.readPage('concepts/a.md')
    expect(page).toEqual({ path: 'concepts/a.md', title: 'A', content: '---\ntitle: A\n---\n# A\n' })
  })

  it('坏 UTF-8 → TypeError 上抛（read_page 不降级，对齐 NodeFs decodeUtf8Strict）', async () => {
    const fs = makeDocker({ probeFile: async () => ({ kind: 'file', data: Buffer.from([0xff, 0xfe]) }) })
    await expect(fs.readPage('concepts/bad.md')).rejects.toBeInstanceOf(TypeError)
  })
})

describe('DockerWikiFileSystem 写侧（委托 FileArchive 显式容器名方法 + managed + 异常映射）', () => {
  it('write/create/delete 委托 InContainer 三方法（透传 dockerName/树根 /wiki/rel/content，#784）', async () => {
    const archive = new FakeArchive()
    const fs = makeDocker({ archive, probeFile: async () => ({ kind: 'dir' }) }) // createPage 父链放行
    await fs.writePage('concepts/a.md', '# A\n')
    await fs.createPage('concepts/new.md', '# N\n')
    await fs.deletePage('concepts/a.md')
    expect(archive.calls).toEqual([
      { method: 'write', absRoot: '/wiki', relPath: 'concepts/a.md', content: '# A\n' },
      { method: 'create', absRoot: '/wiki', relPath: 'concepts/new.md', content: '# N\n' },
      { method: 'delete', absRoot: '/wiki', relPath: 'concepts/a.md' },
    ])
  })

  it('managed 黑名单在三写方法前置 → WikiInvalidPath（不触达 archive）', async () => {
    const archive = new FakeArchive()
    const fs = makeDocker({ archive })
    await expect(fs.writePage('index.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.createPage('_attachments/x.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.deletePage('index.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    expect(archive.calls).toEqual([])
  })

  it('异常映射膜：FileNotFound→WikiPageNotFound / FileExists→WikiPageExists / FileInvalidPath→WikiInvalidPath', async () => {
    const fs = makeDocker({
      archive: new FakeArchive({
        write: () => new FileNotFound(''),
        create: () => new FileExists(''),
        delete: () => new FileInvalidPath(''),
      }),
      probeFile: async () => ({ kind: 'dir' }), // createPage 父链放行，让 archive.create 抛 FileExists
    })
    await expect(fs.writePage('concepts/miss.md', 'x')).rejects.toBeInstanceOf(WikiPageNotFound)
    await expect(fs.createPage('concepts/a.md', 'x')).rejects.toBeInstanceOf(WikiPageExists)
    await expect(fs.deletePage('concepts/a.md')).rejects.toBeInstanceOf(WikiInvalidPath)
  })

  it('create 父目录不存在自动 mkdir（#621 行为变化：不再 90002）', async () => {
    const archive = new FakeArchive()
    const fs = makeDocker({ archive, probeFile: async () => null }) // 父链全不存在 → mkdir -p 创建
    await expect(fs.createPage('newdir/sub/page.md', '# P\n')).resolves.toEqual({ path: 'newdir/sub/page.md' })
    // FileArchive.create 语义：自动 mkdir -p 父目录（旧 NodeFs 会抛 WikiInvalidPath → 90002）。
    expect(archive.calls[0]).toMatchObject({ method: 'create', relPath: 'newdir/sub/page.md' })
  })

  it('createPage 父段是普通文件 → WikiInvalidPath（保 nodeFs ENOTDIR→90002，不退 90000）', async () => {
    const archive = new FakeArchive()
    const fs = makeDocker({
      archive,
      probeFile: async (rel) => (rel === 'notes.md' ? { kind: 'file', data: Buffer.alloc(0) } : null),
    })
    // notes.md 已是文件：DockerFileArchive.create 的 mkdir -p notes.md 会 exec 失败抛裸 Error→90000；
    // 前置父链守卫（assertParentsAreDirs）保 nodeFs ENOTDIR → WikiInvalidPath → 90002 契约。
    await expect(fs.createPage('notes.md/child.md', '# C\n')).rejects.toBeInstanceOf(WikiInvalidPath)
    expect(archive.calls).toEqual([]) // 前置拦截，不触达 archive
  })
})

describe('DockerWikiFileSystem.readClaimsFile（#789 claims 只读面）', () => {
  const sidecar = JSON.stringify({ schemaVersion: 1, pageVersion: 'sha256:x', claims: [] })

  it('页路径映射 .claims 镜像同名 .json 读取；缺失（null/dir/link）→ null', async () => {
    const seen: string[] = []
    const fs = makeDocker({
      probeFile: async (rel) => {
        seen.push(rel)
        if (rel === '.claims/concepts/a.json') return { kind: 'file', data: enc(sidecar) }
        return null
      },
    })
    expect(await fs.readClaimsFile('concepts/a.md')).toBe(sidecar)
    expect(seen).toEqual(['.claims/concepts/a.json'])
    expect(await fs.readClaimsFile('concepts/none.md')).toBeNull()
  })

  it('旁车非 UTF-8 → null（「无旁车」语义，不放大为读失败）', async () => {
    const fs = makeDocker({
      probeFile: async () => ({ kind: 'file', data: Buffer.from([0xff, 0xfe, 0x00]) }),
    })
    expect(await fs.readClaimsFile('concepts/a.md')).toBeNull()
  })
})
