// NodeWikiFileSystem 适配器单测（#335 · 平移 backend/wiki/tests/test_tree_adapter_fs.py）。
// 对真实文件系统直测：照实平铺目录分组 / 递归收页 / SKIP 集合 / symlink 不跟随 / 非 regular
// file / 缺失与 symlink root 降级 / 不可读子树跳过 / 非 UTF-8 fallback / 深嵌套不爆栈。
// 以及 CRUD（read/write/create/delete）与路径双保险（穿越/managed/symlink 逃逸）。

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, rmSync } from 'node:fs'
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

  it('scanDir 入口前子目录被换 symlink → 不跟随、不泄露外部文件（codex PR#346 P1）', async () => {
    const main = makeRoot()
    const outside = path.join(path.dirname(path.dirname(main)), 'outside-scandir')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'leaked.md'), '# LEAKED\n')
    // 父 readdir(root) 给出 concepts Dirent 后、scanDir 入口首个原语前，容器把 concepts 换 symlink →
    // outside：stat 跟随会读外部目录（无 containment），lstat 不跟随则拒。
    const fs = swapOnFirstTouch(path.join(main, 'concepts'), outside)
    const tree = await new NodeWikiFileSystem(main, fs).buildTree()
    const all = tree.groups.flatMap((g) => g.pages.map((p) => p.path))
    expect(all.some((p) => p.includes('leaked'))).toBe(false)
  })

  it('scanDir 下钻子目录在 pop/readdir 前被换 symlink → 跳过该子树（codex PR#346 P1）', async () => {
    const main = makeRoot()
    const outside = path.join(path.dirname(path.dirname(main)), 'outside-pop')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'leaked.md'), '# LEAKED\n')
    // concepts/sub 入口 lstat 通过（仍是真目录）；push 后、pop 出 sub 到 readdir(sub) 前，容器把
    // sub 换 symlink → outside：无 pop 复核则 readdir 跟随读外部；pop 后 lstat 复核识别 symlink → 跳过。
    const fs = swapOnFirstTouch(path.join(main, 'concepts', 'sub'), outside)
    const tree = await new NodeWikiFileSystem(main, fs).buildTree()
    const all = tree.groups.flatMap((g) => g.pages.map((p) => p.path))
    expect(all.some((p) => p.includes('leaked'))).toBe(false)
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

  it('文件名含非 BMP 与高 BMP 字符按 Unicode code-point 序（对齐 Python，codex PR#346）', async () => {
    const main = makeRoot()
    // fullwidth Ａ = U+FF21（高 BMP）vs 😀 = U+1F600（非 BMP，UTF-16 代理对 [D83D,DE00]）：
    //   UTF-16 code-unit 序：D83D < FF21 → 😀 在前
    //   Unicode code-point 序：FF21 < 1F600 → Ａ 在前（Python 行为，反转）
    // WikilinkResolver 对重复 stem/title 先见者优先——顺序反转让同一 [[target]] 解析到不同页。
    mkdirSync(path.join(main, 'uni'))
    writeFileSync(path.join(main, 'uni', 'Ａpage.md'), '# A\n')
    writeFileSync(path.join(main, 'uni', '😀page.md'), '# E\n')
    const tree = await new NodeWikiFileSystem(main).buildTree()
    const uni = tree.groups.find((g) => g.kind === 'uni')!
    const paths = uni.pages.map((p) => p.path)
    // 以独立 code-point 比较为 oracle：pages 顺序须与 code-point 序一致（Python）而非 UTF-16 序。
    const byCodePoint = (a: string, b: string): number => {
      const ax = [...a]
      const bx = [...b]
      const n = Math.min(ax.length, bx.length)
      for (let i = 0; i < n; i += 1) {
        const d = (ax[i].codePointAt(0) ?? 0) - (bx[i].codePointAt(0) ?? 0)
        if (d !== 0) return d < 0 ? -1 : 1
      }
      return ax.length - bx.length
    }
    expect(paths).toEqual([...paths].sort(byCodePoint))
    // code-point 序：Ａ(FF21) 在前、😀(1F600) 在后——直接钉死，防 oracle 自身写错。
    expect(paths[0]).toBe('uni/Ａpage.md')
    expect(paths[1]).toBe('uni/😀page.md')
  })

  it('非 UTF-8 字节的 .md 退到文件名 fallback，不让整棵树 500', async () => {
    const main = makeRoot()
    writeFileSync(path.join(main, 'concepts', 'bad.md'), Buffer.from([0xff, 0xfe, 0xfa, 32, 105]))
    const tree = await new NodeWikiFileSystem(main).buildTree()
    const concepts = tree.groups.find((g) => g.kind === 'concepts')!
    const bad = concepts.pages.find((p) => p.path === 'concepts/bad.md')!
    expect(bad.title).toBe('bad')
  })

  it('buildTree 的 pageTitle 只读有界字节前缀，不缓冲整个大文件（codex PR#346 P1）', async () => {
    const main = makeRoot()
    // 远超有界前缀的文件，frontmatter title 在开头（既要读到 title，又不被整文件撑爆内存）。
    writeFileSync(path.join(main, 'concepts', 'big.md'), `---\ntitle: Big\n---\n# Big\n` + 'x'.repeat(200 * 1024))
    const readSizes: number[] = []
    const fs: FsLike = {
      readdir: (dir, opts) => fsp.readdir(dir, opts),
      readFile: async (p) => {
        const b = await fsp.readFile(p)
        readSizes.push(b.length)
        return b
      },
      stat: (p) => fsp.stat(p),
      lstat: (p) => fsp.lstat(p),
      realpath: (p) => fsp.realpath(p),
      readlink: (p) => fsp.readlink(p),
      writeFile: (p, d, o) => fsp.writeFile(p, d, o),
      unlink: (p) => fsp.unlink(p),
      open: (p, flag) => fsp.open(p, flag),
    }
    const tree = await new NodeWikiFileSystem(main, fs).buildTree()
    const big = tree.groups.find((g) => g.kind === 'concepts')!.pages.find((p) => p.path === 'concepts/big.md')!
    expect(big.title).toBe('Big') // 读了 frontmatter
    // pageTitle 不得 readFile 缓冲整文件（200KB）；有界前缀应远小于文件大小。
    expect(Math.max(0, ...readSizes)).toBeLessThan(100 * 1024)
  })

  it('损坏 UTF-8 不被 trim 掉：frontmatter title 后跟 0xff → fallback 文件名而非解析出 title（codex 第六轮 P2）', async () => {
    const main = makeRoot()
    // 旧 decodePrefix 无条件回退：strict 解码失败后逐字节 trim，把末尾 0xff 丢掉、剩余前缀当有效 →
    // title: SECRET 被解析出来。Python read_text 严格解码整文件，损坏 → UnicodeDecodeError → 文件名
    // fallback；未读到截断上限的损坏字节必须返回 null，不得 trim。raw 0xff 字节用 Buffer 拼接（string+Buffer
    // 会把 0xff toString 成合法 UTF-8 的 ÿ，测不到损坏路径）。
    writeFileSync(
      path.join(main, 'concepts', 'corrupt.md'),
      Buffer.concat([Buffer.from('---\ntitle: SECRET\n---\n'), Buffer.from([0xff])]),
    )
    const tree = await new NodeWikiFileSystem(main).buildTree()
    const concepts = tree.groups.find((g) => g.kind === 'concepts')!
    const p = concepts.pages.find((x) => x.path === 'concepts/corrupt.md')!
    expect(p.title).toBe('corrupt')
  })

  it('截断切断多字节序列 → 回退到完整边界仍解析 title；不因损坏而误拒（codex 第六轮 P2）', async () => {
    const main = makeRoot()
    // frontmatter title 在前，正文 emoji padding 超 TITLE_READ_BYTES 且把 4 字节 emoji 切在截断边界。
    // decodePrefix 仅在「读到上限 + 末尾是合法不完整多字节序列」时回退该序列，title 仍解析；若把截断
    // 误判为损坏 → fallback 文件名（测试钉住必须解析出 title）。
    writeFileSync(path.join(main, 'concepts', 'cut.md'), '---\ntitle: Cut\n---\n' + '😀'.repeat(3000))
    const tree = await new NodeWikiFileSystem(main).buildTree()
    const concepts = tree.groups.find((g) => g.kind === 'concepts')!
    const p = concepts.pages.find((x) => x.path === 'concepts/cut.md')!
    expect(p.title).toBe('Cut')
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

describe('NodeWikiFileSystem.listCategoryPages', () => {
  it('顶层文件读取前被换 symlink → 不读外部内容（point of use，codex PR#346 P1）', async () => {
    const main = makeRoot()
    writeFileSync(path.join(main, 'secret.md'), '# LOCAL\n') // 顶层散落 .md（非 SKIP_FILES）
    const outside = path.join(path.dirname(path.dirname(main)), 'outside-cat')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'x.md'), '# LEAKED-CONTENT\n')
    // readdir(root) 给出 secret.md Dirent（真文件）后、pageEntry 读取前，容器把它换 symlink → 外部文件：
    // readFile 跟随会读外部内容进 categories；pageEntry 入口 lstat 复核识别 symlink → 跳过该页。
    const fs = swapOnFirstTouch(path.join(main, 'secret.md'), path.join(outside, 'x.md'))
    const cats = await new NodeWikiFileSystem(main, fs).listCategoryPages()
    expect(cats.map((c) => c.content).some((c) => c.includes('LEAKED-CONTENT'))).toBe(false)
    expect(cats.find((c) => c.path === 'secret.md')).toBeUndefined()
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

  it('read_page/delete_page 命中 FIFO → WikiPageNotFound，open 不阻塞 worker（O_NONBLOCK，codex PR#346 P1）', async () => {
    const main = makeRoot()
    try {
      execFileSync('mkfifo', [path.join(main, 'concepts', 'hang.md')])
    } catch {
      return // 环境无 mkfifo → 跳过
    }
    const fs = new NodeWikiFileSystem(main)
    // 修复前 open('r') 对 FIFO 只读打开会无限等 writer → 卡死 libuv worker pool；超时兜底判红/绿。
    const timeout = <T>(p: Promise<T>, ms = 1500): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('open 阻塞超时')), ms))])
    await expect(timeout(fs.readPage('concepts/hang.md'))).rejects.toBeInstanceOf(WikiPageNotFound)
    await expect(timeout(fs.deletePage('concepts/hang.md'))).rejects.toBeInstanceOf(WikiPageNotFound)
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

  it('create_page 父路径是普通文件（notes.md/child.md）→ WikiInvalidPath 而非 90000（codex PR#346）', async () => {
    const main = makeRoot()
    const fs = new NodeWikiFileSystem(main)
    // concepts/attention.md 是已存在的 regular file：在其路径下建子页，open(wx) 抛 ENOTDIR
    // （父段非目录）。须映射为 WikiInvalidPath → 路由层 90002(data.path)，而非内部错误 90000。
    await expect(fs.createPage('concepts/attention.md/child.md', '# X\n')).rejects.toBeInstanceOf(WikiInvalidPath)
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

  it('open 锁定 fd 后、lstatDeep 前祖先换 symlink → 读/写/删全拦（codex 第四轮 P1）', async () => {
    // 读：open 已锁定真文件 fd，随后 lstatDeep 逐段检测到 concepts 被换 symlink → 拒，不得读 victim
    {
      const main = makeRoot()
      const outside = path.join(path.dirname(path.dirname(main)), 'outside-anchor')
      mkdirSync(outside)
      writeFileSync(path.join(outside, 'attention.md'), '# VICTIM\n')
      const nfs = new NodeWikiFileSystem(main, swapAfterOpenFs(main, outside))
      await expect(nfs.readPage('concepts/attention.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    }
    // 写：open 锁定真 fd 后换链 → 不得覆盖 outside victim
    {
      const main = makeRoot()
      const outside = path.join(path.dirname(path.dirname(main)), 'outside-anchor')
      mkdirSync(outside)
      writeFileSync(path.join(outside, 'attention.md'), '# VICTIM\n')
      const nfs = new NodeWikiFileSystem(main, swapAfterOpenFs(main, outside))
      await expect(nfs.writePage('concepts/attention.md', 'EVIL')).rejects.toBeInstanceOf(WikiInvalidPath)
      expect(await fsp.readFile(path.join(outside, 'attention.md'), 'utf8')).toBe('# VICTIM\n')
    }
    // 删：open 锁定真 fd 后换链 → 不得删 outside victim
    {
      const main = makeRoot()
      const outside = path.join(path.dirname(path.dirname(main)), 'outside-anchor')
      mkdirSync(outside)
      writeFileSync(path.join(outside, 'attention.md'), '# VICTIM\n')
      const nfs = new NodeWikiFileSystem(main, swapAfterOpenFs(main, outside))
      await expect(nfs.deletePage('concepts/attention.md')).rejects.toBeInstanceOf(WikiInvalidPath)
      expect(await fsp.readFile(path.join(outside, 'attention.md'), 'utf8')).toBe('# VICTIM\n')
    }
  })

  it('createPage：parent anchor 下钻后、open(wx) 后祖先换 symlink → 不得在 root 外新建（codex 第四轮 P1）', async () => {
    const main = makeRoot()
    const outside = path.join(path.dirname(path.dirname(main)), 'outside-anchor')
    mkdirSync(outside)
    const nfs = new NodeWikiFileSystem(main, swapAfterOpenFs(main, outside))
    await expect(nfs.createPage('concepts/newpage.md', '# NEW\n')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(fsp.stat(path.join(outside, 'newpage.md'))).rejects.toBeTruthy() // 不在 root 外残留
  })

  it('symlink 自循环 loop→loop：请求其下页面不得解析成无关真实页（codex 第四轮 P2）', async () => {
    const main = makeRoot()
    writeFileSync(path.join(main, 'concepts', 'page.md'), '# VICTIM\n') // 受害真实页
    symlinkSync('loop', path.join(main, 'concepts', 'loop')) // loop → concepts/loop 自循环
    const nfs = new NodeWikiFileSystem(main)
    // 读：不得读回受害页内容
    await expect(nfs.readPage('concepts/loop/page.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    // 删：不得删受害页
    await expect(nfs.deletePage('concepts/loop/page.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    expect(await fsp.readFile(path.join(main, 'concepts', 'page.md'), 'utf8')).toBe('# VICTIM\n')
    // 写：不得覆盖受害页
    await expect(nfs.writePage('concepts/loop/page.md', 'EVIL')).rejects.toBeInstanceOf(WikiInvalidPath)
    expect(await fsp.readFile(path.join(main, 'concepts', 'page.md'), 'utf8')).toBe('# VICTIM\n')
  })

  it('并发 deletePage：inode 复核后 unlink 抛 ENOENT → WikiPageNotFound 而非内部错误（codex 第四轮 P2）', async () => {
    const main = makeRoot()
    const fs: FsLike = {
      readdir: (dir, opts) => fsp.readdir(dir, opts),
      readFile: (p) => fsp.readFile(p),
      stat: (p) => fsp.stat(p),
      lstat: (p) => fsp.lstat(p),
      realpath: (p) => fsp.realpath(p),
      readlink: (p) => fsp.readlink(p),
      writeFile: (p, d, o) => fsp.writeFile(p, d, o),
      // 模拟另一并发 DELETE 在本请求 inode 复核（lstat）通过后、unlink 前已删掉文件
      unlink: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      open: (p, flag) => fsp.open(p, flag),
    }
    const nfs = new NodeWikiFileSystem(main, fs)
    await expect(nfs.deletePage('concepts/attention.md')).rejects.toBeInstanceOf(WikiPageNotFound)
  })

  it('createPage:open(wx) 运行时父目录换出-建外-恢复 → 不得写 root 外文件且返回成功（swap-and-restore，codex 第五轮 P1）', async () => {
    const main = makeRoot()
    const outside = path.join(path.dirname(path.dirname(main)), 'outside-swap')
    mkdirSync(outside)
    const nfs = new NodeWikiFileSystem(main, swapDuringOpenFs(main, outside))
    // open(wx) 期间 concepts 瞬时换 symlink→outside、建到外部后恢复:open 前后父目录 inode 相同,
    // parentAnchor==parentNow 检查通过,旧实现会 fh.writeFile 写外部并返回成功。须以 fd ino 与
    // root 下逐段下钻末段 inode 比对拦截(建外后恢复 → 路径下无该文件 → 复核 ENOENT → 拒)。
    await expect(nfs.createPage('concepts/newpage.md', '# NEW\n')).rejects.toBeInstanceOf(WikiInvalidPath)
    // root 内不残留（建到外部又恢复时本地路径下不该有该文件）
    await expect(fsp.stat(path.join(main, 'concepts', 'newpage.md'))).rejects.toBeTruthy()
    // 外部文件即使被 open 创建成空文件,也不得写入内容（create 被拒,writeFile 未执行）
    const ext = path.join(outside, 'newpage.md')
    if (await fsp.stat(ext).then(() => true).catch(() => false)) {
      expect((await fsp.readFile(ext)).toString('utf8')).not.toContain('# NEW')
    }
  })

  it('deletePage:rename 时祖先换链 → 外部 victim 不被 unlink 删除（被移到隔离名、数据保留），本地页安全，操作拒（codex 第六轮 P1）', async () => {
    const main = makeRoot()
    const outside = path.join(path.dirname(path.dirname(main)), 'outside-rename')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'attention.md'), '# EXTERNAL\n')
    const nfs = new NodeWikiFileSystem(main, swapOnRenameFs(main, outside))
    // quarantine-rename：rename(fpath→隔离名) 期间祖先被换 symlink，rename 跟随把外部 attention.md 移到
    // 外部隔离名（移动非删除、内容保留）；随后锚定 lstatDeep 复核发现原路径仍在（本地文件没动）→ 拒，
    // 不 unlink 隔离名。旧「unlink 后复核」是事后检测，外部 victim 已被不可逆删除——本实现把它改成
    // 可检测、可恢复的移动，删除原语（unlink）的目标锁定为我们刚建的随机隔离名。
    await expect(nfs.deletePage('concepts/attention.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    // 本地页未被删除（rename 被换链引到外部，本地仍留在原路径）
    expect((await fsp.readFile(path.join(main, 'concepts', 'attention.md'))).toString('utf8')).toContain('title: Attention')
    // 外部 victim 未丢失——rename 把它移到外部隔离名，内容仍在 outside 下（数据保留，非删除）
    const names = await fsp.readdir(outside)
    const trash = names.filter((n) => n.startsWith('attention.md'))
    expect(trash.length).toBeGreaterThan(0)
    expect((await fsp.readFile(path.join(outside, trash[0]))).toString('utf8')).toBe('# EXTERNAL\n')
  })

  it('open 时 <home>/wiki（root 可写父目录）被换 symlink → CRUD 全拦，不跨实例读写删建（codex 第六轮 P1）', async () => {
    // root 字面路径的中间段 <home>/wiki 是容器可写的：resolve 的 assertRootNotSymlink 通过后、open 前被换
    // symlink 指向另一实例，open 跟随到外部 main。旧 lstatDeep 从 this.root 字面开始 lstat(root)，lstat 对
    // 中间段会跟随 → fd 外部 inode 与下钻外部 inode 恒匹配 → 跨实例读写删建。锚定到 <home> 后逐段 lstat，
    // wiki 段识别 symlink → 拒。
    const ctx = (): { nfs: NodeWikiFileSystem; outside: string } => {
      const main = makeRoot()
      const outside = path.join(path.dirname(path.dirname(main)), 'outside-wiki')
      mkdirSync(path.join(outside, 'main', 'concepts'), { recursive: true })
      writeFileSync(path.join(outside, 'main', 'concepts', 'attention.md'), '# EXTERNAL\n')
      return { nfs: new NodeWikiFileSystem(main, swapWikiOnOpen(main, outside)), outside }
    }
    // 读/写/删：reject 即证明不跟随外部（若跟随读/写/删外部会成功或污染）
    await expect(ctx().nfs.readPage('concepts/attention.md')).rejects.toBeInstanceOf(WikiInvalidPath)
    await expect(ctx().nfs.writePage('concepts/attention.md', 'EVIL')).rejects.toBeInstanceOf(WikiInvalidPath)
    // 删：外部 victim 未被删除
    {
      const { nfs, outside } = ctx()
      await expect(nfs.deletePage('concepts/attention.md')).rejects.toBeInstanceOf(WikiInvalidPath)
      expect((await fsp.readFile(path.join(outside, 'main', 'concepts', 'attention.md'))).toString('utf8')).toBe('# EXTERNAL\n')
    }
    // 建：不得在外部新建（cleanupCreated 清理误建的外部空文件）
    {
      const { nfs, outside } = ctx()
      await expect(nfs.createPage('concepts/newpage.md', '# NEW\n')).rejects.toBeInstanceOf(WikiInvalidPath)
      await expect(fsp.stat(path.join(outside, 'main', 'concepts', 'newpage.md'))).rejects.toBeTruthy()
    }
  })

  it('并发 write_page 同页被 per-path 锁序列化:truncate+write 原子,内容不被混合（codex 第五轮 P1）', async () => {
    const main = makeRoot()
    writeFileSync(path.join(main, 'concepts', 'attention.md'), '# 原\n')
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let opens = 0
    const fs: FsLike = {
      readdir: (d, o) => fsp.readdir(d, o),
      readFile: (p) => fsp.readFile(p),
      stat: (p) => fsp.stat(p),
      lstat: (p) => fsp.lstat(p),
      realpath: (p) => fsp.realpath(p),
      readlink: (p) => fsp.readlink(p),
      writeFile: (p, d, o) => fsp.writeFile(p, d, o),
      unlink: (p) => fsp.unlink(p),
      open: async (p, flag) => {
        // 包装 FileHandle:拦截 truncate/writeFile 记录顺序;第一个 writer 的写入挂起,验证第二个
        // writer 不会并发进入 truncate+write 段（否则 events 会变成 truncate1,truncate2,write1,write2）
        const fh = await fsp.open(p, flag)
        const label = ++opens
        return new Proxy(fh, {
          get(t, prop) {
            if (prop === 'truncate') {
              return async (n?: number) => {
                events.push(`truncate${label}`)
                return t.truncate(n)
              }
            }
            if (prop === 'writeFile') {
              return async (d: string | Uint8Array) => {
                events.push(`write${label}`)
                if (label === 1) await gate // 第一个 writer 卡在写入中
                return t.writeFile(d)
              }
            }
            const v = Reflect.get(t, prop)
            return typeof v === 'function' ? v.bind(t) : v
          },
        })
      },
    }
    const nfs = new NodeWikiFileSystem(main, fs)
    const p1 = nfs.writePage('concepts/attention.md', 'LONG'.repeat(40))
    const p2 = nfs.writePage('concepts/attention.md', 'S')
    // 等第一个 writer 挂起在 write1;锁生效时第二个 writer 的 pinOpen 也被挡住(opens 仍为 1)
    await waitUntil(() => events.includes('write1'))
    expect(events).toEqual(['truncate1', 'write1'])
    expect(opens).toBe(1)
    release()
    await Promise.all([p1, p2])
    // 锁生效:第二个 writer 的 truncate 在第一个 writer 写入完成后才发生(原子序列,非交错)
    expect(events).toEqual(['truncate1', 'write1', 'truncate2', 'write2'])
    // 最终内容为后写者完整内容(无混合)
    expect((await fsp.readFile(path.join(main, 'concepts', 'attention.md'))).toString('utf8')).toBe('S')
  })

  it('pageTitle 按 code-point 截断:frontmatter title 在大量 emoji 后仍解析,不 fallback 文件名（codex 第五轮 P2）', async () => {
    const main = makeRoot()
    // 1100 emoji = 2200 UTF-16 code units > TITLE_READ_CHARS(2000):raw.slice 按 units 截断在 1000
    // emoji,title 行未进入 → parser 不识别 frontmatter → fallback 文件名。按 code-point 截断后
    // 1100+emoji 与 title 共 ~1133 code points ≤ 2000,完整 frontmatter 进入 → 正确解析。
    writeFileSync(path.join(main, 'concepts', 'cpt.md'), `---\nprefix: ${'😀'.repeat(1100)}\ntitle: Real Title\n---\n# Body\n`)
    const fs = new NodeWikiFileSystem(main)
    const tree = await fs.buildTree()
    const group = tree.groups.find((g) => g.name === 'concepts')!
    const page = group.pages.find((p) => p.path === 'concepts/cpt.md')!
    expect(page.title).toBe('Real Title')
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

// FsLike 替身：任何原语（stat/lstat/readdir/open/...）第一次收到 target 路径时，先把 target 换成
// symlink → outside（rename 原目标 + symlink outside 到 target 位），之后透传。复现 codex PR#346 P1
// 的 scanDir TOCTOU：父 readdir 给出 Dirent 后、子目录/文件被访问前，容器并发把目标换成 root 外链接。
function swapOnFirstTouch(target: string, outside: string): FsLike {
  let swapped = false
  const ensureSwap = (): void => {
    if (swapped) return
    swapped = true
    try {
      renameSync(target, `${target}-orig`)
    } catch {
      /* 目标已不在 */
    }
    try {
      symlinkSync(outside, target)
    } catch {
      /* 链接已存在 */
    }
  }
  const maybeSwap = (p: string): void => {
    if (p === target) ensureSwap()
  }
  return {
    readdir: async (dir, opts) => {
      maybeSwap(dir)
      return fsp.readdir(dir, opts)
    },
    readFile: async (p) => {
      maybeSwap(p)
      return fsp.readFile(p)
    },
    stat: async (p) => {
      maybeSwap(p)
      return fsp.stat(p)
    },
    lstat: async (p) => {
      maybeSwap(p)
      return fsp.lstat(p)
    },
    realpath: async (p) => {
      maybeSwap(p)
      return fsp.realpath(p)
    },
    readlink: async (p) => {
      maybeSwap(p)
      return fsp.readlink(p)
    },
    writeFile: async (p, d, o) => {
      maybeSwap(p)
      return fsp.writeFile(p, d, o)
    },
    unlink: async (p) => {
      maybeSwap(p)
      return fsp.unlink(p)
    },
    open: async (p, flag) => {
      maybeSwap(p)
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

// FsLike 替身：open 成功返回（fd 已锁定真对象）后，立即把 concepts 目录换成指向 outside 的 symlink。
// 复现 codex 第四轮 P1：旧的 `lstat(fpath)` 独立捕获 anchor 会跟随 resolve 后被换的中间段 symlink 命中
// 逃逸 inode；现实现 open 后用 lstatDeep 逐段（禁止 symlink）下钻比对 fd inode——open 后换链使 lstatDeep
// 在 concepts 段遇到 symlink 即拒。注入点选「open 之后」跨平台稳健，不依赖 mkdtemp 路径与 realpath 后
// 路径的字符串相等（macOS /var→/private/var 会让路径字符串不一致）。
function swapAfterOpenFs(main: string, outside: string): FsLike {
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
    readFile: (p) => fsp.readFile(p),
    stat: (p) => fsp.stat(p),
    lstat: (p) => fsp.lstat(p),
    realpath: (p) => fsp.realpath(p),
    readlink: (p) => fsp.readlink(p),
    writeFile: (p, d, o) => fsp.writeFile(p, d, o),
    unlink: (p) => fsp.unlink(p),
    open: async (p, flag) => {
      const fh = await fsp.open(p, flag)
      swap() // fd 已锁定 open 时的真对象；此后 lstatDeep 复核会发现 concepts 已成 symlink → 拒
      return fh
    },
  }
}

// FsLike 替身:open(wx) 运行时把 concepts 瞬时换成外部 symlink(新文件建到 root 外)、随后恢复。
// 复现 codex 第五轮 P1 的「换出-建外-恢复」:open 前后父目录 inode 相同,parentAnchor==parentNow,
// 仅比对父目录 before/after 挡不住——须以 fd ino 与 root 下逐段下钻末段 inode 比对(建外后恢复,
// 路径下无该文件 → 复核 ENOENT → 拒,writeFile 不会执行,外部只剩空文件)。
function swapDuringOpenFs(main: string, outside: string): FsLike {
  const concepts = path.join(main, 'concepts')
  let swapped = false
  return {
    readdir: (d, o) => fsp.readdir(d, o),
    readFile: (p) => fsp.readFile(p),
    stat: (p) => fsp.stat(p),
    lstat: (p) => fsp.lstat(p),
    realpath: (p) => fsp.realpath(p),
    readlink: (p) => fsp.readlink(p),
    writeFile: (p, d, o) => fsp.writeFile(p, d, o),
    unlink: (p) => fsp.unlink(p),
    open: async (p, flag) => {
      if (swapped) return fsp.open(p, flag)
      swapped = true
      renameSync(concepts, `${concepts}-orig`)
      symlinkSync(outside, concepts)
      const fh = await fsp.open(p, flag) // 跟随 symlink,建到 outside
      rmSync(concepts, { force: true }) // 删 symlink 本身
      renameSync(`${concepts}-orig`, concepts)
      return fh
    },
  }
}

// FsLike 替身:deletePage 的 quarantine-rename 的 rename(fpath→隔离名) 期间把 concepts 瞬时换成外部
// symlink(rename 跟随把外部 attention.md 移到外部隔离名——移动非删除)、随后恢复。复现 codex 第六轮 P1:
// Node 无 unlinkat,旧实现路径型 unlink 换链窗口内不可逆删除外部 victim、事后复核只是检测;quarantine-rename
// 把删除原语(unlink)的目标换成刚建的随机隔离名,换链最坏把外部文件 rename 走(数据保留、可检测)。
function swapOnRenameFs(main: string, outside: string): FsLike {
  const concepts = path.join(main, 'concepts')
  let swapped = false
  return {
    readdir: (d, o) => fsp.readdir(d, o),
    readFile: (p) => fsp.readFile(p),
    stat: (p) => fsp.stat(p),
    lstat: (p) => fsp.lstat(p),
    realpath: (p) => fsp.realpath(p),
    readlink: (p) => fsp.readlink(p),
    writeFile: (p, d, o) => fsp.writeFile(p, d, o),
    unlink: (p) => fsp.unlink(p),
    rename: async (from, to) => {
      if (swapped) return fsp.rename(from, to)
      swapped = true
      renameSync(concepts, `${concepts}-orig`)
      symlinkSync(outside, concepts)
      try {
        await fsp.rename(from, to) // 跟随 symlink → 外部 attention.md 移到外部 to
      } finally {
        rmSync(concepts, { force: true })
        renameSync(`${concepts}-orig`, concepts)
      }
    },
    open: (p, flag) => fsp.open(p, flag),
  }
}

// FsLike 替身:open 前把 <home>/wiki(root 的直接父)换成指向 outside 的 symlink,open 跟随到另一实例的
// main。复现 codex 第六轮 P1:resolve 的 assertRootNotSymlink 通过后、open 前根链中间段被换链,open 成功
// 打开外部对象;须以「锚点(<home>)逐段下钻」复核拦截(wiki 段识别 symlink),而非从 root 字面 lstat(对
// 中间段跟随 → fd 外部 inode 与下钻外部 inode 恒匹配 → 跨实例)。
function swapWikiOnOpen(main: string, outside: string): FsLike {
  const wiki = path.dirname(main) // <base>/wiki
  let swapped = false
  return {
    readdir: (d, o) => fsp.readdir(d, o),
    readFile: (p) => fsp.readFile(p),
    stat: (p) => fsp.stat(p),
    lstat: (p) => fsp.lstat(p),
    realpath: (p) => fsp.realpath(p),
    readlink: (p) => fsp.readlink(p),
    writeFile: (p, d, o) => fsp.writeFile(p, d, o),
    unlink: (p) => fsp.unlink(p),
    open: async (p, flag) => {
      if (!swapped) {
        swapped = true
        renameSync(wiki, `${wiki}-orig`)
        symlinkSync(outside, wiki)
      }
      return fsp.open(p, flag) // 跟随 symlink → 打开外部 main 下对象
    },
  }
}

// 轮询等待条件成立(超时抛错);用于并发测试里等第一个 writer 挂起后再做断言。
async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
