// NodeWikiFileSystem 适配器单测（#335 · 平移 backend/wiki/tests/test_tree_adapter_fs.py）。
// 对真实文件系统直测：照实平铺目录分组 / 递归收页 / SKIP 集合 / symlink 不跟随 / 非 regular
// file / 缺失与 symlink root 降级 / 不可读子树跳过 / 非 UTF-8 fallback / 深嵌套不爆栈。
// 以及 CRUD（read/write/create/delete）与路径双保险（穿越/managed/symlink 逃逸）。

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { NodeWikiFileSystem, type FsLike } from '../src/wiki/nodeFs'
import { WikiInvalidPath, WikiPageExists, WikiPageNotFound } from '../src/wiki/errors'

// 造一份真实 wiki/main（对齐 Django test_tree_adapter_fs wiki_root fixture）。
function makeRoot(): string {
  const base = mkdtempSync(path.join(tmpdir(), 'wiki-fs-'))
  const main = path.join(base, 'wiki', 'main')
  mkdirSync(path.join(main, 'concepts', 'sub'), { recursive: true })
  writeFileSync(path.join(main, 'concepts', 'attention.md'), '---\ntitle: Attention\n---\n# Attention\n')
  writeFileSync(path.join(main, 'concepts', 'sub', 'nested.md'), '---\ntitle: Nested\n---\n# Nested\n')
  const papers = path.join(main, 'domains', 'machine-learning', 'papers')
  mkdirSync(papers, { recursive: true })
  writeFileSync(path.join(papers, 'resnet.md'), '---\npaper:\n  title: ResNet\n---\n# ResNet\n')
  mkdirSync(path.join(main, 'experiments'))
  writeFileSync(path.join(main, 'experiments', 'trial-1.md'), '---\ntitle: Trial 1\n---\n# Trial 1\n')
  mkdirSync(path.join(main, '.openclaw-wiki'))
  writeFileSync(path.join(main, '.openclaw-wiki', 'cache.md'), 'x')
  writeFileSync(path.join(main, 'index.md'), '# INDEX')
  writeFileSync(path.join(main, 'concepts', 'draft.txt'), 'not md')
  mkdirSync(path.join(main, 'emptydir'))
  return main
}

const kinds = (tree: { groups: Array<{ kind: string }> }): Set<string> => new Set(tree.groups.map((g) => g.kind))

describe('NodeWikiFileSystem.buildTree', () => {
  it('分组 = 真实子目录；未知目录也成组；物理无页目录不成组', async () => {
    const tree = await new NodeWikiFileSystem(makeRoot()).buildTree()
    const ks = kinds(tree)
    expect(ks).toEqual(expect.objectContaining(new Set(['concepts', 'domains', 'experiments'])))
    expect(ks).not.toContain('entities')
    expect(ks).not.toContain('sources')
    expect(ks).not.toContain('emptydir')
    const experiments = tree.groups.find((g) => g.kind === 'experiments')!
    expect(experiments.name).toBe('experiments')
    expect(experiments.pages.map((p) => p.path)).toEqual(['experiments/trial-1.md'])
  })

  it('五分类单数键已废；物理不存在的目录不成组', async () => {
    const ks = kinds(await new NodeWikiFileSystem(makeRoot()).buildTree())
    expect(ks).not.toContain('concept')
    expect(ks).not.toContain('entity')
    expect(ks).not.toContain('syntheses')
    expect(ks).not.toContain('reports')
  })

  it('跳过插件私有目录/占位文件/非 .md；顶层散落页不收', async () => {
    const tree = await new NodeWikiFileSystem(makeRoot()).buildTree()
    const all = tree.groups.flatMap((g) => g.pages.map((p) => p.path))
    expect(all.some((p) => p.includes('.openclaw-wiki'))).toBe(false)
    expect(all).not.toContain('index.md')
    expect(all.some((p) => p.endsWith('.txt'))).toBe(false)
    expect(kinds(tree)).not.toContain('.openclaw-wiki')
    expect(tree.groups.some((g) => g.pages.some((p) => !p.path.includes('/')))).toBe(false) // 无顶层散落
  })

  it('递归收任意深度 .md 进其顶层目录组', async () => {
    const tree = await new NodeWikiFileSystem(makeRoot()).buildTree()
    const concepts = tree.groups.find((g) => g.kind === 'concepts')!
    expect(concepts.pages.map((p) => p.path)).toContain('concepts/attention.md')
    expect(concepts.pages.map((p) => p.path)).toContain('concepts/sub/nested.md')
  })

  it('domain 页标题走 frontmatter paper.title（嵌套键跳过、title 子键提升）', async () => {
    const tree = await new NodeWikiFileSystem(makeRoot()).buildTree()
    const domains = tree.groups.find((g) => g.kind === 'domains')!
    const resnet = domains.pages.find((p) => p.path.endsWith('resnet.md'))!
    expect(resnet.title).toBe('ResNet')
  })

  it('symlink 目录（顶层或组内）不跟随，防经树泄露外部文件', async () => {
    const main = makeRoot()
    const outside = path.join(path.dirname(path.dirname(main)), 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.md'), '# SECRET\n')
    symlinkSync(outside, path.join(main, 'evil-link'))
    symlinkSync(outside, path.join(main, 'concepts', 'evil-sub'))
    const tree = await new NodeWikiFileSystem(main).buildTree()
    const all = tree.groups.flatMap((g) => g.pages.map((p) => p.path))
    expect(kinds(tree)).not.toContain('evil-link')
    expect(all.some((p) => p.includes('evil-sub') || p.includes('secret'))).toBe(false)
  })

  it('symlink .md 文件不列出', async () => {
    const main = makeRoot()
    const outside = path.join(path.dirname(path.dirname(main)), 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.md'), '# SECRET\n')
    symlinkSync(path.join(outside, 'secret.md'), path.join(main, 'concepts', 'evil.md'))
    const tree = await new NodeWikiFileSystem(main).buildTree()
    const all = tree.groups.flatMap((g) => g.pages.map((p) => p.path))
    expect(all).not.toContain('concepts/evil.md')
  })

  it('FIFO/非 regular file 命名 .md 不列出（读取会阻塞 worker）', async () => {
    const main = makeRoot()
    try {
      execFileSync('mkfifo', [path.join(main, 'concepts', 'evil.md')])
    } catch {
      return // 环境无 mkfifo → 跳过
    }
    const tree = await new NodeWikiFileSystem(main).buildTree()
    const all = tree.groups.flatMap((g) => g.pages.map((p) => p.path))
    expect(all).not.toContain('concepts/evil.md')
  })

  it('wiki/main 不存在 → 空树不上抛', async () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'wiki-missing-')), 'wiki', 'main')
    expect(await new NodeWikiFileSystem(missing).buildTree()).toEqual({ groups: [] })
  })

  it('wiki/main 自身被换成 symlink → 空树，不扫外部', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'wiki-rootsym-'))
    const outside = path.join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.md'), '# SECRET\n')
    const rootLink = path.join(base, 'wiki', 'main')
    mkdirSync(path.dirname(rootLink))
    symlinkSync(outside, rootLink)
    expect(await new NodeWikiFileSystem(rootLink).buildTree()).toEqual({ groups: [] })
  })

  it('<home>/wiki 直接父被换成 symlink → 空树，不跨实例泄露', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'wiki-anc-'))
    const other = path.join(base, 'other-instance', 'wiki')
    mkdirSync(path.join(other, 'main', 'concepts'), { recursive: true })
    writeFileSync(path.join(other, 'main', 'concepts', 'secret.md'), '# SECRET\n')
    const home = path.join(base, 'my-home')
    mkdirSync(home)
    symlinkSync(other, path.join(home, 'wiki'))
    expect(await new NodeWikiFileSystem(path.join(home, 'wiki', 'main')).buildTree()).toEqual({ groups: [] })
  })

  it('同组内多子目录页面按 path 字典序输出', async () => {
    const main = makeRoot()
    mkdirSync(path.join(main, 'concepts', 'aa'))
    mkdirSync(path.join(main, 'concepts', 'bb'))
    writeFileSync(path.join(main, 'concepts', 'aa', 'page1.md'), '# A1\n')
    writeFileSync(path.join(main, 'concepts', 'bb', 'page2.md'), '# B1\n')
    const tree = await new NodeWikiFileSystem(main).buildTree()
    const concepts = tree.groups.find((g) => g.kind === 'concepts')!
    const paths = concepts.pages.map((p) => p.path)
    expect(paths).toEqual([...paths].sort())
  })

  it('非 UTF-8 字节的 .md 退到文件名 fallback，不让整棵树 500', async () => {
    const main = makeRoot()
    writeFileSync(path.join(main, 'concepts', 'bad.md'), Buffer.from([0xff, 0xfe, 0xfa, 32, 105]))
    const tree = await new NodeWikiFileSystem(main).buildTree()
    const concepts = tree.groups.find((g) => g.kind === 'concepts')!
    const bad = concepts.pages.find((p) => p.path === 'concepts/bad.md')!
    expect(bad.title).toBe('bad')
  })

  it('任意深度嵌套不触发栈溢出（迭代 DFS）', async () => {
    const main = makeRoot()
    let cur = path.join(main, 'concepts')
    for (let i = 0; i < 150; i += 1) {
      cur = path.join(cur, 'a')
      try {
        mkdirSync(cur)
      } catch {
        return // 文件系统路径上限过浅 → 跳过
      }
    }
    writeFileSync(path.join(cur, 'leaf.md'), '# LEAF\n')
    const tree = await new NodeWikiFileSystem(main).buildTree()
    const all = tree.groups.flatMap((g) => g.pages.map((p) => p.path))
    expect(all.some((p) => p.endsWith('leaf.md'))).toBe(true)
  })

  it('子目录 readdir 抛错 → 跳过该子树，其它分支不受影响', async () => {
    const main = makeRoot()
    mkdirSync(path.join(main, 'locked'))
    writeFileSync(path.join(main, 'locked', 'x.md'), '# X\n')
    const fs = throwingReaddirOn(path.join(main, 'locked'))
    const tree = await new NodeWikiFileSystem(main, fs).buildTree()
    const all = tree.groups.flatMap((g) => g.pages.map((p) => p.path))
    expect(all).toContain('concepts/attention.md')
    expect(all.some((p) => p.includes('locked'))).toBe(false)
  })

  it('wiki/main 自身 readdir 抛错 → 空树不上抛', async () => {
    const main = makeRoot()
    const fs = throwingReaddirOn(main)
    expect(await new NodeWikiFileSystem(main, fs).buildTree()).toEqual({ groups: [] })
  })
})

describe('NodeWikiFileSystem 页面 CRUD', () => {
  it('read_page 返回原文全文 + frontmatter title', async () => {
    const page = await new NodeWikiFileSystem(makeRoot()).readPage('concepts/attention.md')
    expect(page.path).toBe('concepts/attention.md')
    expect(page.title).toBe('Attention')
    expect(page.content).toContain('# Attention')
  })

  it('read_page 缺失 → WikiPageNotFound；路径穿越/managed → WikiInvalidPath', async () => {
    const fs = new NodeWikiFileSystem(makeRoot())
    await expect(fs.readPage('concepts/nope.md')).rejects.toBeInstanceOf(WikiPageNotFound)
    await expect(fs.readPage('../../evil.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.readPage('.openclaw-wiki/evil.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.readPage('concepts/index.md')).rejects.toBeInstanceOf(WikiInvalidPath)
  })

  it('symlink 逃逸读写全拦：目标解析到 root 外 → WikiInvalidPath', async () => {
    const main = makeRoot()
    const outside = path.join(path.dirname(path.dirname(main)), 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.md'), '# SECRET\n')
    symlinkSync(path.join(outside, 'secret.md'), path.join(main, 'concepts', 'evil.md'))
    const fs = new NodeWikiFileSystem(main)
    await expect(fs.readPage('concepts/evil.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.writePage('concepts/evil.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.deletePage('concepts/evil.md')).rejects.toBeInstanceOf(WikiInvalidPath)
  })

  it('symlink alias 指向 root 内 managed 文件 → 读改删全拦（canonical 重查，codex PR#346）', async () => {
    const main = makeRoot()
    // concepts/alias.md → ../index.md（SKIP_FILES）；concepts/alias2.md → .openclaw-wiki/cache.md（SKIP_DIRS）
    symlinkSync(path.join(main, 'index.md'), path.join(main, 'concepts', 'alias.md'))
    symlinkSync(path.join(main, '.openclaw-wiki', 'cache.md'), path.join(main, 'concepts', 'alias2.md'))
    const fs = new NodeWikiFileSystem(main)
    await expect(fs.readPage('concepts/alias.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.writePage('concepts/alias.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.deletePage('concepts/alias.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.readPage('concepts/alias2.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.writePage('concepts/alias2.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.deletePage('concepts/alias2.md')).rejects.toBeInstanceOf(WikiInvalidPath)
  })

  it('dangling symlink 指向 root 外不存在目标 → 读写全拦（TOCTOU 回归）', async () => {
    const main = makeRoot()
    const outside = path.join(path.dirname(path.dirname(main)), 'outside-missing')
    symlinkSync(outside, path.join(main, 'concepts', 'dangling.md')) // 目标不存在
    const fs = new NodeWikiFileSystem(main)
    // 目标不存在时 read_page 本会按「页不存在」走 404；但 dangling 目标在 root 外，
    // 必须按越权（WikiInvalidPath）拦截——防并发创建目标后读外部文件（codex 评审#3）。
    await expect(fs.readPage('concepts/dangling.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.writePage('concepts/dangling.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.createPage('concepts/dangling.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.deletePage('concepts/dangling.md')).rejects.toBeInstanceOf(WikiInvalidPath)
  })

  it('symlink 目录逃逸：中间段指向 root 外 → 写/读该子树全拦', async () => {
    const main = makeRoot()
    const outside = path.join(path.dirname(path.dirname(main)), 'outside-sub')
    mkdirSync(outside)
    symlinkSync(outside, path.join(main, 'concepts', 'evil-dir'))
    const fs = new NodeWikiFileSystem(main)
    await expect(fs.readPage('concepts/evil-dir/x.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.createPage('concepts/evil-dir/y.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
  })

  it('root 或 root 直接父被换 symlink → CRUD 全拦，不跨实例读改（codex PR#346 P1）', async () => {
    // root（<home>/wiki/main）本身是 symlink → 指向外部目录
    const base = mkdtempSync(path.join(tmpdir(), 'wiki-rootsym-crud-'))
    const outside = path.join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.md'), '# SECRET\n')
    const rootLink = path.join(base, 'wiki', 'main')
    mkdirSync(path.dirname(rootLink))
    symlinkSync(outside, rootLink)
    const fs = new NodeWikiFileSystem(rootLink)
    await expect(fs.readPage('secret.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.writePage('secret.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.createPage('new.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs.deletePage('secret.md')).rejects.toBeInstanceOf(WikiInvalidPath)

    // root 直接父（<home>/wiki）是 symlink → 指向另一实例 wiki
    const base2 = mkdtempSync(path.join(tmpdir(), 'wiki-ancsym-crud-'))
    const otherHome = path.join(base2, 'other-home')
    mkdirSync(path.join(otherHome, 'wiki', 'main', 'concepts'), { recursive: true })
    writeFileSync(path.join(otherHome, 'wiki', 'main', 'concepts', 'secret.md'), '# SECRET\n')
    const home = path.join(base2, 'home')
    mkdirSync(home)
    symlinkSync(path.join(otherHome, 'wiki'), path.join(home, 'wiki'))
    const fs2 = new NodeWikiFileSystem(path.join(home, 'wiki', 'main'))
    await expect(fs2.readPage('concepts/secret.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fs2.writePage('concepts/secret.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
  })

  it('write_page 覆写 byte-exact（保留尾换行/首尾空白）；缺失 → WikiPageNotFound', async () => {
    const main = makeRoot()
    const fs = new NodeWikiFileSystem(main)
    await fs.writePage('concepts/attention.md', '  # 已编辑  \n\n')
    const raw = (await fsp.readFile(path.join(main, 'concepts', 'attention.md'))).toString('utf8')
    expect(raw).toBe('  # 已编辑  \n\n')
    await expect(fs.writePage('concepts/nope.md', 'x')).rejects.toBeInstanceOf(WikiPageNotFound)
  })

  it('create_page 新建；已存在 → WikiPageExists；父目录缺失 → WikiInvalidPath', async () => {
    const main = makeRoot()
    const fs = new NodeWikiFileSystem(main)
    await fs.createPage('concepts/new.md', '# New\n')
    expect((await fsp.readFile(path.join(main, 'concepts', 'new.md'))).toString('utf8')).toBe('# New\n')
    await expect(fs.createPage('concepts/attention.md', 'x')).rejects.toBeInstanceOf(WikiPageExists)
    await expect(fs.createPage('nope-dir/x.md', 'x')).rejects.toBeInstanceOf(WikiInvalidPath)
  })

  it('并发 create_page 同一路径：一个成功、另一个 WikiPageExists（wx 原子，codex PR#346）', async () => {
    const main = makeRoot()
    const fs = new NodeWikiFileSystem(main)
    const results = await Promise.allSettled([
      fs.createPage('concepts/dup.md', '# A\n'),
      fs.createPage('concepts/dup.md', '# B\n'),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WikiPageExists)
    // 最终落盘内容为成功一方写入（后写不覆盖）
    const raw = (await fsp.readFile(path.join(main, 'concepts', 'dup.md'))).toString('utf8')
    expect(['# A\n', '# B\n']).toContain(raw)
  })

  it('delete_page 删除；缺失 → WikiPageNotFound', async () => {
    const main = makeRoot()
    const fs = new NodeWikiFileSystem(main)
    await fs.deletePage('concepts/attention.md')
    await expect(fsp.stat(path.join(main, 'concepts', 'attention.md'))).rejects.toBeTruthy()
    await expect(fs.deletePage('concepts/attention.md')).rejects.toBeInstanceOf(WikiPageNotFound)
  })

  it('UTF-8 BOM 保留（ignoreBOM:true，逐字节对齐 Python read_text；codex PR#346）', async () => {
    const main = makeRoot()
    writeFileSync(path.join(main, 'concepts', 'bom.md'), '﻿---\ntitle: BOM 页\n---\n# BOM\n')
    const fs = new NodeWikiFileSystem(main)
    const page = await fs.readPage('concepts/bom.md')
    expect(page.content.startsWith('﻿')).toBe(true) // BOM 不被吞
    // BOM 前缀 → frontmatter 不识别（对齐 Python：BOM 视为正文前缀）→ title 回落 stem
    expect(page.title).toBe('bom')
    // 读改写 round-trip 不丢 BOM
    await fs.writePage('concepts/bom.md', page.content)
    expect((await fsp.readFile(path.join(main, 'concepts', 'bom.md'))).subarray(0, 3).toString('utf8')).toBe('﻿')
  })

  it('祖先目录在校验后被换 symlink → 读/写/建/删全拦（TOCTOU，codex PR#346 P1）', async () => {
    // 读：不得把 root 外 victim 内容读回来
    {
      const { nfs, outside } = makeRacyContext()
      await expect(nfs.readPage('concepts/attention.md')).rejects.toBeInstanceOf(WikiInvalidPath)
      expect(await fsp.readFile(path.join(outside, 'attention.md'), 'utf8')).toBe('# VICTIM\n')
    }
    // 写：不得覆盖 root 外 victim
    {
      const { nfs, outside } = makeRacyContext()
      await expect(nfs.writePage('concepts/attention.md', 'EVIL')).rejects.toBeInstanceOf(WikiInvalidPath)
      expect(await fsp.readFile(path.join(outside, 'attention.md'), 'utf8')).toBe('# VICTIM\n')
    }
    // 建：不得在 root 外新建（误建须清理）
    {
      const { nfs, outside } = makeRacyContext()
      await expect(nfs.createPage('concepts/newpage.md', '# NEW\n')).rejects.toBeInstanceOf(WikiInvalidPath)
      await expect(fsp.stat(path.join(outside, 'newpage.md'))).rejects.toBeTruthy()
    }
    // 删：不得删除 root 外 victim
    {
      const { nfs, outside } = makeRacyContext()
      await expect(nfs.deletePage('concepts/attention.md')).rejects.toBeInstanceOf(WikiInvalidPath)
      expect(await fsp.readFile(path.join(outside, 'attention.md'), 'utf8')).toBe('# VICTIM\n')
    }
  })
})

// FsLike 替身：仅让指定目录 readdir 抛 EACCES（对齐 Django monkeypatch Path.iterdir）。
function throwingReaddirOn(badDir: string): FsLike {
  return {
    readdir: async (dir, opts) => {
      if (dir === badDir) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return fsp.readdir(dir, opts)
    },
    readFile: (p) => fsp.readFile(p),
    stat: (p) => fsp.stat(p),
    lstat: (p) => fsp.lstat(p),
    realpath: (p) => fsp.realpath(p),
    readlink: (p) => fsp.readlink(p),
    writeFile: (p, d) => fsp.writeFile(p, d),
    unlink: (p) => fsp.unlink(p),
    open: (p, flag) => fsp.open(p, flag),
  }
}

// FsLike 替身：首个「变更类」原语（open/writeFile/unlink/readFile）被调时，先把 concepts 目录换成
// symlink → root 外 outside（模拟容器在「resolve 校验后、真正打开/写入前」的并发目录替换）；之后透传。
// 复现 codex PR#346 P1 的 TOCTOU：校验通过 ≠ 操作目标仍安全，操作须经 race-resistant 原语（fd）钉住 inode。
function racySwapFs(main: string, outside: string): FsLike {
  const concepts = path.join(main, 'concepts')
  let swapped = false
  const swap = (): void => {
    if (swapped) return
    swapped = true
    renameSync(concepts, `${concepts}-orig`)
    symlinkSync(outside, concepts)
  }
  return {
    readdir: (dir, opts) => fsp.readdir(dir, opts),
    readFile: async (p) => {
      swap()
      return fsp.readFile(p)
    },
    stat: (p) => fsp.stat(p),
    lstat: (p) => fsp.lstat(p),
    realpath: (p) => fsp.realpath(p),
    readlink: (p) => fsp.readlink(p),
    writeFile: async (p, d, o) => {
      swap()
      return fsp.writeFile(p, d, o)
    },
    unlink: async (p) => {
      swap()
      return fsp.unlink(p)
    },
    open: async (p, flag) => {
      swap()
      return fsp.open(p, flag)
    },
  }
}

// 一份可复现「校验后祖先目录换 symlink」的上下文：outside 含同名 victim（写/删目标仍在、但 inode 不同）。
function makeRacyContext(): { nfs: NodeWikiFileSystem; outside: string } {
  const main = makeRoot()
  const outside = path.join(path.dirname(path.dirname(main)), 'outside-race')
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'attention.md'), '# VICTIM\n')
  return { nfs: new NodeWikiFileSystem(main, racySwapFs(main, outside)), outside }
}
