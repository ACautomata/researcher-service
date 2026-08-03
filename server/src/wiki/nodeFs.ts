// Node fs WikiFileSystem 适配器（#335 · 平移 backend/integration/openclaw/adapters.py
// 的 BindMountWikiFileSystem，codex #125 全防护）。
//
// 构造注入 wikiRoot（`<home>/wiki/main`）与可选 fs 实现（缺省 node:fs/promises；测试可注入
// 替身造「readdir 抛错/坏 UTF-8」等确定性退化，对齐 Django monkeypatch 用法）。
//
// 必须复刻的防护（#315 §5，全是安全坑）：
//   1. symlink 不跟随：遍历遇 symlink（目录/文件）一律跳过，防经树泄露 wiki/main 之外文件。
//   2. root 与 root 直接父 symlink 检查：`<home>/wiki` 或 `<home>/wiki/main` 被换成 symlink →
//      build_tree/list_category_pages 返回空（不 500）；CRUD 经 resolve 直接拒绝（codex PR#346 P1）。
//      更上层不查（macOS /var→/private/var 不误判）。
//   3. 只收 regular file：FIFO/socket/device 命名 .md 会让读取阻塞 worker——Dirent.isFile() 判定。
//   4. 不可读降级：单目录 readdir 失败 → 跳过该子树；单文件读取/UTF-8 解码失败 → tree 用文件名
//      fallback、categories 跳过该页，不让单个坏文件把整棵树/聚合 500。
//   5. 迭代而非递归：显式栈 DFS，深度仅受文件系统路径上限约束，不触发栈溢出；每层排序。
//   6. path 双保险：①请求层校验（paths.ts）+ ②本层 _resolve 的 managed 黑名单 + realpath 落 root 内。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { Dirent, Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { FrontmatterParser, frontmatterTitle } from './logic'
import { SKIP_DIRS, SKIP_FILES, TITLE_READ_CHARS } from './values'
import { WikiInvalidPath, WikiPageExists, WikiPageNotFound } from './errors'
import type {
  WikiCategoryPage,
  WikiFileSystem,
  WikiPage,
  WikiTree,
  WikiTreePage,
} from './fsPort'

// fs 接触面（可注入替身测退化；缺省 node:fs/promises）。
export interface FsLike {
  readdir(dir: string, opts: { withFileTypes: true }): Promise<Dirent[]>
  readFile(p: string): Promise<Buffer>
  stat(p: string): Promise<Stats>
  lstat(p: string): Promise<Stats>
  realpath(p: string): Promise<string>
  readlink(p: string): Promise<string>
  writeFile(p: string, data: string, opts?: { flag?: string }): Promise<void> // 缺省编码 utf8；flag 供 createPage 独占创建（wx）
  unlink(p: string): Promise<void>
  open(p: string, flag: string): Promise<FileHandle> // 供 pinOpen 钉住 inode 后经 fd 读写（TOCTOU 防护，codex PR#346 P1）
}

// UTF-8 严格解码：非法字节抛 TypeError（对齐 Python read_text(encoding='utf-8') 的
// UnicodeDecodeError；Node 默认 toString('utf8') 用 U+FFFD 静默替换，会破坏降级语义）。
// ignoreBOM:true 保留 U+FEFF（Python read_text 逐字节保留 BOM；默认 false 会吞掉——GET 不再原文
// 返回、round-trip 丢 BOM、解析层把 BOM 前缀页误识别成 frontmatter。codex PR#346）。
function decodeUtf8Strict(buf: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// 文件名去 .md 后缀（对齐 Python Path.stem：去最后一个后缀）。
function stemOf(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

export class NodeWikiFileSystem implements WikiFileSystem {
  private readonly parser = new FrontmatterParser()

  constructor(
    private readonly root: string,
    private readonly fs: FsLike = fsp,
  ) {}

  // —— Port: build_tree ——

  async buildTree(): Promise<WikiTree> {
    if (!(await this.rootUsable())) return { groups: [] }
    const children = await this.readdir(this.root)
    if (children === null) return { groups: [] }
    const groups: WikiTree['groups'] = []
    for (const d of children) {
      // 只收根下真实子目录成组；顶层散落 .md 不收（categories 才收）
      if (!d.isDirectory() || d.isSymbolicLink() || SKIP_DIRS.has(d.name)) continue
      const pages: WikiTreePage[] = []
      await this.scanDir(path.join(this.root, d.name), `${d.name}/`, pages, false)
      if (pages.length) groups.push({ kind: d.name, name: d.name, pages })
    }
    return { groups }
  }

  // —— Port: read_page ——

  async readPage(relPath: string): Promise<WikiPage> {
    const { fh, fpath } = await this.pinOpen(relPath, 'r')
    let content: string
    try {
      content = decodeUtf8Strict(await fh.readFile()) // 读/解码失败上抛（read_page 不降级，对齐 Django）
    } finally {
      await fh.close().catch(() => {})
    }
    const { frontmatter } = this.parser.parse(content)
    return { path: relPath, title: frontmatterTitle(frontmatter) ?? stemOf(path.basename(fpath)), content }
  }

  // —— Port: list_category_pages ——

  async listCategoryPages(): Promise<WikiCategoryPage[]> {
    if (!(await this.rootUsable())) return []
    const children = await this.readdir(this.root)
    if (children === null) return []
    const pages: WikiCategoryPage[] = []
    for (const d of children) {
      if (d.isSymbolicLink()) continue
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) {
          await this.scanDir(path.join(this.root, d.name), `${d.name}/`, pages, true)
        }
      } else if (d.isFile() && d.name.endsWith('.md') && !SKIP_FILES.has(d.name)) {
        // 顶层散落 .md 也收（与 build_tree 不同，issue #84）
        const entry = await this.pageEntry(path.join(this.root, d.name), d.name, true)
        if (entry) pages.push(entry as WikiCategoryPage)
      }
    }
    return pages
  }

  // —— Port: write_page ——

  async writePage(relPath: string, content: string): Promise<{ path: string }> {
    const { fh } = await this.pinOpen(relPath, 'r+') // 'r+' 打开不截断；验证后才清空写入（byte-exact）
    try {
      await fh.truncate(0)
      await fh.writeFile(content) // 经 fd 写入：open 后路径换链不影响本次 I/O（inode 已钉住）
    } finally {
      await fh.close().catch(() => {})
    }
    return { path: relPath }
  }

  // —— Port: create_page ——

  async createPage(relPath: string, content: string): Promise<{ path: string }> {
    const fpath = await this.resolve(relPath)
    // 父目录 inode anchor：resolve 后捕获；open 后 lstat(parent) 复核——父段在校验后被换 symlink、
    // 新文件落在 root 外（另一实例/宿主）时 inode 不匹配 → 拒（TOCTOU，codex PR#346 P1）。
    let parentAnchor: number
    try {
      parentAnchor = (await this.fs.lstat(path.dirname(fpath))).ino
    } catch {
      throw new WikiInvalidPath(relPath) // 父目录不存在（对齐原 NotADirectoryError → WikiInvalidPath）
    }
    let fh: FileHandle
    try {
      // wx = O_CREAT|O_EXCL 原子独占创建：并发 POST 同路径只一个成功，后写不覆盖先写；
      // EEXIST → WikiPageExists（codex PR#346，替代 exists()+writeFile 的检查-后-写竞态）。
      fh = await this.fs.open(fpath, 'wx')
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') throw new WikiPageExists(relPath)
      if ((err as { code?: string }).code === 'ENOENT') throw new WikiInvalidPath(relPath)
      throw err
    }
    try {
      const parentNow = await this.fs.lstat(path.dirname(fpath))
      if (parentNow.ino !== parentAnchor) {
        // 仅当 lstat(fpath) 命中的恰是我们刚创建的 inode 才清理（防误删并发替换/他人文件），
        // 随后拒：文件不该被建到 root 外。
        const st = await fh.stat()
        try {
          const now = await this.fs.lstat(fpath)
          if (now.ino === st.ino) await this.fs.unlink(fpath).catch(() => {})
        } catch {
          /* 目标不可判 → 不清理 */
        }
        throw new WikiInvalidPath(relPath)
      }
      await fh.writeFile(content)
    } finally {
      await fh.close().catch(() => {})
    }
    return { path: relPath }
  }

  // —— Port: delete_page ——

  async deletePage(relPath: string): Promise<void> {
    // unlink 无 fd 原语（Node 无 unlinkat）：pinOpen 校验打开对象（open 前祖先换 symlink → 拒），
    // 再紧贴 unlink 前 lstat 复核 inode，把 close→unlink 的换链窗口压到最小（TOCTOU，codex PR#346 P1）。
    const { fpath, fh, anchor } = await this.pinOpen(relPath, 'r')
    await fh.close().catch(() => {})
    let now: Stats
    try {
      now = await this.fs.lstat(fpath)
    } catch {
      throw new WikiPageNotFound(relPath) // 已被并发删除
    }
    if (now.ino !== anchor) throw new WikiInvalidPath(relPath) // 复核时目标已被换链
    await this.fs.unlink(fpath)
  }

  // —— internal ——

  private async rootUsable(): Promise<boolean> {
    // root 与其直接父任一为 symlink，或 root 非目录 → 拒绝遍历（codex #125 P1/P2）。
    if (await this.isSymlink(this.root)) return false
    if (await this.isSymlink(path.dirname(this.root))) return false
    try {
      return (await this.fs.stat(this.root)).isDirectory()
    } catch {
      return false
    }
  }

  private async isSymlink(p: string): Promise<boolean> {
    try {
      return (await this.fs.lstat(p)).isSymbolicLink()
    } catch {
      return false
    }
  }

  // resolve + 打开 + inode 验证（TOCTOU 核心，codex PR#346 P1）：
  // resolve 捕获「期望 inode」（anchor，校验时点的末段），fs.open 得到 fd 后 fstat 复核——inode 不匹配
  // 说明 resolve 与 open 之间祖先目录/末段已被换成 symlink（打开的是 root 外/他人文件）→ 拒。一旦
  // open 成功，fd 钉住 inode：后续读/写/截断不再受路径换链影响，是 race-resistant 原语而非复用路径
  // 字符串。缺失/非 regular（dir/FIFO/…）→ WikiPageNotFound（对齐原 isFile 语义）。
  private async pinOpen(relPath: string, flag: 'r' | 'r+'): Promise<{ fh: FileHandle; fpath: string; anchor: number }> {
    const fpath = await this.resolve(relPath)
    let anchor: number
    try {
      anchor = (await this.fs.lstat(fpath)).ino
    } catch {
      throw new WikiPageNotFound(relPath)
    }
    let fh: FileHandle
    try {
      fh = await this.fs.open(fpath, flag)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') throw new WikiPageNotFound(relPath)
      if ((err as { code?: string }).code === 'ELOOP') throw new WikiInvalidPath(relPath) // 打开时末段已成 symlink
      throw err
    }
    try {
      const st = await fh.stat()
      if (!st.isFile()) throw new WikiPageNotFound(relPath)
      if (st.ino !== anchor) throw new WikiInvalidPath(relPath) // 打开对象 ≠ resolve 时捕获的 inode → 换链逃逸
    } catch (err) {
      await fh.close().catch(() => {})
      throw err
    }
    return { fh, fpath, anchor }
  }

  private async readdir(dir: string): Promise<Dirent[] | null> {
    try {
      const entries = await this.fs.readdir(dir, { withFileTypes: true })
      entries.sort((a, b) => cmp(a.name, b.name))
      return entries
    } catch {
      return null // 单目录不可读 → 跳过该子树（codex #125 P2）
    }
  }

  // 显式栈 DFS（codex #125 P2：不递归，深度仅受文件系统路径上限约束）。
  private async scanDir(
    dirpath: string,
    relPrefix: string,
    pagesOut: Array<WikiTreePage | WikiCategoryPage>,
    withContent: boolean,
  ): Promise<void> {
    try {
      if (!(await this.fs.stat(dirpath)).isDirectory()) return
    } catch {
      return
    }
    const stack: Array<[string, string]> = [[dirpath, relPrefix]]
    while (stack.length > 0) {
      const [curDir, curPrefix] = stack.pop()!
      const entries = await this.readdir(curDir)
      if (entries === null) continue
      for (const f of entries) {
        if (f.isSymbolicLink()) continue // 不跟随任何 symlink（目录/文件）
        if (f.isDirectory()) {
          if (!SKIP_DIRS.has(f.name)) stack.push([path.join(curDir, f.name), `${curPrefix}${f.name}/`])
          continue
        }
        if (!f.isFile()) continue // 仅收 regular file（FIFO/socket/device 会阻塞读取）
        if (!f.name.endsWith('.md') || SKIP_FILES.has(f.name)) continue
        const rel = `${curPrefix}${f.name}`
        const entry = await this.pageEntry(path.join(curDir, f.name), rel, withContent)
        if (entry) pagesOut.push(entry)
      }
    }
    // LIFO 弹出顺序与字典序相反；末尾按 path 重排保持稳定（codex #125 P2）。
    pagesOut.sort((a, b) => cmp(a.path, b.path))
  }

  private async pageEntry(
    fpath: string,
    rel: string,
    withContent: boolean,
  ): Promise<WikiTreePage | WikiCategoryPage | null> {
    if (!withContent) {
      return { path: rel, title: await this.pageTitle(fpath, stemOf(path.basename(fpath))) }
    }
    const content = await this.readText(fpath)
    if (content === null) return null // 读不出/解码失败 → 调用方跳过该页（codex #129 P2）
    const { frontmatter, body } = this.parser.parse(content)
    const title = frontmatterTitle(frontmatter) ?? this.h1Title(body) ?? stemOf(path.basename(fpath))
    return { path: rel, title, content }
  }

  // 读全文；读取/UTF-8 解码失败返回 null（调用方决定跳过或降级）。
  private async readText(fpath: string): Promise<string | null> {
    try {
      return decodeUtf8Strict(await this.fs.readFile(fpath))
    } catch {
      return null
    }
  }

  // 从 frontmatter 取标题（只读前 TITLE_READ_CHARS 字符）；读失败/解码失败 → 文件名 fallback。
  private async pageTitle(fpath: string, fallback: string): Promise<string> {
    const raw = await this.readText(fpath)
    if (raw === null) return fallback
    const { frontmatter } = this.parser.parse(raw.slice(0, TITLE_READ_CHARS))
    return frontmatterTitle(frontmatter) ?? fallback
  }

  // 正文首个 `# ` 标题文本（无 frontmatter 时的标题兜底）；无 H1 返回 null。
  private h1Title(body: string): string | null {
    for (const line of body.split('\n')) {
      if (line.startsWith('# ')) {
        const t = line.slice(2).trim()
        return t || null
      }
    }
    return null
  }

  // 解析相对 wiki/main 的路径为绝对路径；越权（managed/穿越/symlink 逃逸）→ WikiInvalidPath。
  // root 与结果都做「realpath 尽可能深」（对齐 Python Path.resolve(strict=False)）。
  private async resolve(relPath: string): Promise<string> {
    this.assertNotManaged(relPath)
    // root 或其直接父被换成 symlink → 直接拒绝（不先 canonicalize）：否则 realpath 会把 symlink
    // 目标当作新信任根，containment 检查恒接受目标下路径，CRUD 可跨实例/宿主读写（codex PR#346 P1）。
    await this.assertRootNotSymlink()
    const root = await this.realpathPrefix(this.root)
    const fpath = await this.realpathPrefix(`${root}/${relPath}`)
    if (root !== fpath && !fpath.startsWith(`${root}/`)) {
      throw new WikiInvalidPath(relPath)
    }
    // canonical 目标重查 managed：alias 的 blacklist 只在解析前对字面路径生效，symlink 可指到
    // SKIP 集合内文件（concepts/a.md → ../index.md / ../.openclaw-wiki/private.md）——解析后
    // 按 canonical 相对路径再拦一次（codex PR#346）。
    if (fpath.startsWith(`${root}/`)) {
      this.assertNotManaged(fpath.slice(root.length + 1))
    }
    return fpath
  }

  // root 与其直接父任一为 symlink → 拒绝解析（对齐 rootUsable 的扫描侧防护；CRUD 走 resolve）。
  private async assertRootNotSymlink(): Promise<void> {
    if (await this.isSymlink(this.root)) throw new WikiInvalidPath(this.root)
    if (await this.isSymlink(path.dirname(this.root))) throw new WikiInvalidPath(this.root)
  }

  // managed 黑名单（#315 §4 第②层）：任一段命中 SKIP_DIRS、或末段命中 SKIP_FILES → 拒。
  private assertNotManaged(relPath: string): void {
    const parts = relPath.split('/')
    if (parts.some((seg) => SKIP_DIRS.has(seg))) throw new WikiInvalidPath(relPath)
    if (SKIP_FILES.has(parts[parts.length - 1])) throw new WikiInvalidPath(relPath)
  }

  // 逐段解析路径（对齐 Python Path.resolve(strict=False) + os.path.realpath 语义）：
  //  - 每段经 lstat 判定是否 symlink；是则 readlink 目标、把目标段压回队列继续解析（含链式/循环，
  //    循环上限 40 防无限跟随）；
  //  - dangling symlink（目标不存在）也跟随到其目标路径（目标逃逸 root → 上层逃逸检查拦截）；
  //  - 某段既非 symlink 又不存在 → 剩余段原样拼回（读不存在页 → 落 root 内 → PageNotFound）。
  // 旧的 fs.realpath 实现遇 dangling symlink 会 ENOENT 回退成「link 自身路径」，令指向 root 外
  // 不存在目标的 symlink 通过逃逸检查，留下并发创建目标后可读外部文件的 TOCTOU（codex #125 威胁
  // 模型正是「容器进程可在 home 内换 symlink 指向宿主路径」）——本实现补上该缝。
  private async realpathPrefix(p: string): Promise<string> {
    const abs = path.posix.isAbsolute(p) ? p : path.resolve(p)
    let resolved = path.posix.parse(abs).root
    const queue: string[] = abs.split(path.posix.sep)
    let links = 0
    while (queue.length > 0) {
      const seg = queue.shift()!
      if (seg === '' || seg === '.') continue
      if (seg === '..') {
        resolved = path.posix.dirname(resolved)
        continue
      }
      const candidate = path.posix.join(resolved, seg)
      let isLink = false
      let target: string | null = null
      try {
        const st = await this.fs.lstat(candidate)
        isLink = st.isSymbolicLink()
        if (isLink) target = await this.fs.readlink(candidate)
      } catch {
        // 段不存在（非 symlink）→ 剩余段原样拼回（strict=False 语义）
        resolved = path.posix.join(candidate, ...queue)
        break
      }
      if (isLink && target !== null) {
        if (links >= 40) {
          // symlink 循环防呆（Python realpath 同有 40 上限）：拼回剩余段，交由上层校验/ops 兜底
          resolved = path.posix.join(resolved, ...queue)
          break
        }
        links += 1
        if (path.posix.isAbsolute(target)) {
          resolved = path.posix.parse(target).root
          queue.unshift(...target.split(path.posix.sep))
        } else {
          // 相对目标：相对 link 所在目录（candidate 的 dirname = 当前 resolved）
          queue.unshift(...target.split(path.posix.sep))
        }
      } else {
        resolved = candidate
      }
    }
    return resolved
  }
}
