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

import { promises as fsp, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import type { Dirent, Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { cmp, FrontmatterParser, frontmatterTitle } from './logic'
import { SKIP_DIRS, SKIP_FILES, TITLE_READ_CHARS, TITLE_READ_BYTES } from './values'
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
  open(p: string, flag: string | number): Promise<FileHandle> // 供 pinOpen 钉住 inode 后经 fd 读写（TOCTOU 防护，codex PR#346 P1）；number flag 传 O_NONBLOCK 防 FIFO 阻塞
}

// UTF-8 严格解码：非法字节抛 TypeError（对齐 Python read_text(encoding='utf-8') 的
// UnicodeDecodeError；Node 默认 toString('utf8') 用 U+FFFD 静默替换，会破坏降级语义）。
// ignoreBOM:true 保留 U+FEFF（Python read_text 逐字节保留 BOM；默认 false 会吞掉——GET 不再原文
// 返回、round-trip 丢 BOM、解析层把 BOM 前缀页误识别成 frontmatter。codex PR#346）。
function decodeUtf8Strict(buf: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
}

// 解码字节前缀：截断处可能切断多字节 UTF-8 序列（fatal decoder 抛 TypeError）——末尾最多 3 字节
// 不完整（UTF-8 最长 4 字节），逐步回退重试到完整序列边界。对齐 Python read_text 按字符截断不切断
// 多字节字符的行为；解码整体失败（非截断导致的非法字节）返回 null（调用方降级，codex PR#346 P1）。
function decodePrefix(buf: Buffer): string | null {
  for (let trim = 0; trim <= 3 && trim < buf.length; trim += 1) {
    try {
      return decodeUtf8Strict(buf.subarray(0, buf.length - trim))
    } catch {
      // 末尾仍含不完整序列 → 继续回退（最多 3 字节）
    }
  }
  return null
}

// 字典序比较（对齐 Python 的 Unicode code-point 序）见 logic.ts 的 cmp（nodeFs/service 共用）。

// 文件名去 .md 后缀（对齐 Python Path.stem：去最后一个后缀）。
function stemOf(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

// 并发同页写序列化（codex 第五轮 P1）：per-path 互斥把「truncate+write」变原子——否则两个 PUT 同页，
// 两 handle 都截断后较短写入者把较长者尾部残留，内容既非 A 也非 B。模块级（非实例级）：路由层每次请求
// 新建 NodeWikiFileSystem 实例，实例级锁跨请求不共享、形同虚设。键含 root，隔离不同容器同名页。
const pageLocks = new Map<string, Promise<void>>()

function withPageLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pageLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn) // 前一任务失败也继续执行本次
  // 存入的 tail 恒 resolve（吞错），保证链不断；错误由调用方 await run 处理
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  pageLocks.set(key, tail)
  // 本任务完成后清理：仅当仍是最新链尾（无后续入队）才删除，否则保留给后续任务
  tail.finally(() => {
    if (pageLocks.get(key) === tail) pageLocks.delete(key)
  })
  return run
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
    // 并发 PUT 同页：两个 handle 都 'r+' 打开、都 truncate(0) 后，较短写入者把较长者尾部残留，内容
    // 既非 A 也非 B（codex 第五轮 P1）。per-path 锁把「pinOpen+truncate+write+close」串行化；
    // 键含 root 隔离不同容器（见 withPageLock 模块级注释）。
    return withPageLock(`${this.root}::${relPath}`, async () => {
      const { fh } = await this.pinOpen(relPath, 'r+') // 'r+' 打开不截断；验证后才清空写入（byte-exact）
      try {
        await fh.truncate(0)
        await fh.writeFile(content) // 经 fd 写入：open 后路径换链不影响本次 I/O（inode 已钉住）
      } finally {
        await fh.close().catch(() => {})
      }
      return { path: relPath }
    })
  }

  // —— Port: create_page ——

  async createPage(relPath: string, content: string): Promise<{ path: string }> {
    const fpath = await this.resolve(relPath)
    const parentParts = relPath.split('/').slice(0, -1)
    // 父目录锚定（open 前逐段禁 symlink 下钻到父目录，验证其存在且为目录）。旧 `lstat(dirname(fpath))`
    // 单独捕获会跟随 resolve 后被换的中间段 symlink、命中逃逸目录 inode，使随后复核恒匹配，
    // 新文件被建到 root 外/他人容器（codex 第四轮 P1）。
    try {
      await this.lstatDeep(parentParts, 'dir', relPath)
    } catch {
      throw new WikiInvalidPath(relPath) // 父不存在/非目录/含 symlink（对齐原 NotADirectoryError → WikiInvalidPath）
    }
    let fh: FileHandle
    try {
      // wx = O_CREAT|O_EXCL 原子独占创建：并发 POST 同路径只一个成功，后写不覆盖先写；
      // EEXIST → WikiPageExists（codex PR#346，替代 exists()+writeFile 的检查-后-写竞态）。
      fh = await this.fs.open(fpath, 'wx')
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') throw new WikiPageExists(relPath)
      if ((err as { code?: string }).code === 'ENOENT') throw new WikiInvalidPath(relPath)
      // 父段是普通文件（如 notes.md/child.md）：open(wx) 抛 ENOTDIR（父段非目录）——映射为
      // WikiInvalidPath → 路由层 90002(data.path)，而非内部错误 90000（codex PR#346）。
      if ((err as { code?: string }).code === 'ENOTDIR') throw new WikiInvalidPath(relPath)
      throw err
    }
    try {
      // open('wx') 成功后，验证 fd 锁定的新文件确实在 root 内：以 fh.stat().ino 与「root 下逐段禁
      // symlink 下钻到末段」的 inode 比对（与 pinOpen 同款）。仅比对父目录 before/after inode 挡不住
      // 「换出-建外-恢复」时序——open 运行期间父目录被瞬时换外部 symlink、新文件建到 root 外、随即
      // 恢复，parentAnchor==parentNow 恒匹配，fd 却指向 root 外文件，writeFile 会写外部并返回成功
      // （codex 第五轮 P1）。建外后恢复：fpath 下并无该文件（lstatDeep 末段 ENOENT）或中间段残留
      // symlink（lstatDeep 拒）→ fd 不在 root 内 → 清理后拒。
      const ino = (await fh.stat()).ino
      let underRoot: number
      try {
        underRoot = await this.lstatDeep(relPath.split('/'), 'file', relPath)
      } catch {
        await this.cleanupCreated(fpath, ino)
        throw new WikiInvalidPath(relPath)
      }
      if (underRoot !== ino) {
        await this.cleanupCreated(fpath, ino)
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
    // 紧贴 unlink 前 lstat 复核 inode，把 close→unlink 的换链窗口压到最小（codex PR#346 P1）。
    // 窗口内祖先仍可能被换链、路径型 unlink 跟随删到外部同名——「unlink 后复核删除生效」兜底：
    // root 内该文件必须已消失；若仍在（同 inode），说明 unlink 删的是别处（外部 victim）→ 攻击，
    // 抛 InvalidPath 而非静默成功（codex 第五轮 P1）。
    const { fpath, fh, anchor } = await this.pinOpen(relPath, 'r')
    await fh.close().catch(() => {})
    let now: Stats
    try {
      now = await this.fs.lstat(fpath)
    } catch {
      throw new WikiPageNotFound(relPath) // 已被并发删除
    }
    if (now.ino !== anchor) throw new WikiInvalidPath(relPath) // 复核时目标已被换链
    try {
      await this.fs.unlink(fpath)
    } catch (err) {
      // 并发 DELETE：另一请求在本请求 inode 复核通过后、unlink 前已删掉文件 → ENOENT。映射为
      // WikiPageNotFound（30040），而非绕过域映射成内部错误 90000（codex 第四轮 P2）。
      if ((err as { code?: string }).code === 'ENOENT') throw new WikiPageNotFound(relPath)
      throw err
    }
    // unlink 后复核：逐段禁 symlink 下钻（lstat 对中间段会跟随，遇换链会读到外部、复核失效）。
    // lstatDeep 找到文件（root 内该页仍在）→ unlink 没删到它（删了外部 victim）→ 拒。
    try {
      await this.lstatDeep(relPath.split('/'), 'file', relPath)
      throw new WikiInvalidPath(relPath)
    } catch (err) {
      if (err instanceof WikiInvalidPath) throw err
      // WikiPageNotFound → 文件已消失，unlink 生效（正常删除）
    }
  }

  // —— internal ——

  // 清理刚误建的文件：仅当 fpath 仍指向我们刚创建的 inode 才 unlink（防误删并发替换/他人文件）。
  // 建到 root 外时 fpath（基于当前路径）解析不到该 inode → no-op：writeFile 未执行，外部只留 open 创建
  // 的空文件，不构成内容泄露。
  private async cleanupCreated(fpath: string, ino: number): Promise<void> {
    try {
      const now = await this.fs.lstat(fpath)
      if (now.ino === ino) await this.fs.unlink(fpath).catch(() => {})
    } catch {
      /* 目标不可判/不存在 → 不清理 */
    }
  }

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
    let fh: FileHandle
    try {
      // O_NONBLOCK：FIFO/socket/设备文件命名 .md 时，open 只读会无限等 writer、卡死 libuv worker
      // pool，fh.stat().isFile() 复核永不到达（codex PR#346 P1）。加 O_NONBLOCK 让 open 立即返回，
      // 由随后的 isFile() 复核拒绝非 regular；普通文件 O_NONBLOCK 被忽略（总是就绪）。
      const openFlag = (flag === 'r' ? fsConstants.O_RDONLY : fsConstants.O_RDWR) | fsConstants.O_NONBLOCK
      fh = await this.fs.open(fpath, openFlag)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') throw new WikiPageNotFound(relPath)
      if ((err as { code?: string }).code === 'ELOOP') throw new WikiInvalidPath(relPath) // 末段已成 symlink
      throw err
    }
    try {
      const st = await fh.stat()
      if (!st.isFile()) throw new WikiPageNotFound(relPath)
      // fd 已钉住「open 时」实际对象的 inode（不可变）；与「root 下逐段禁止 symlink 下钻到的 inode」
      // 比对——不一致说明 open 跟随了 resolve 之后被换的中间段 symlink 到 root 外/他人文件。旧的
      // `lstat(fpath)` 独立捕获 anchor 会跟随已换链的中间段、命中逃逸 inode，使 open/fstat 复核恒匹配
      // （codex 第四轮 P1）。lstatDeep 遇任一段 symlink 即拒，故 open 前/后/段间换链均被此比对拦截。
      if (st.ino !== (await this.lstatDeep(relPath.split('/'), 'file', relPath))) {
        throw new WikiInvalidPath(relPath)
      }
      return { fh, fpath, anchor: st.ino }
    } catch (err) {
      await fh.close().catch(() => {})
      throw err
    }
  }

  // 逐段从 root 下钻 lstat（不跟随任何 symlink）：任一段是 symlink → WikiInvalidPath；中间段非目录
  // → WikiInvalidPath；末段须匹配 expectKind（file=regular / dir=目录），否则 WikiPageNotFound/
  // InvalidPath；返回末段 inode。parts=[] 时末段即 root（用作 createPage 顶层页的父目录）。
  // 用于把「open/open(wx) fd 锁定的 inode」与「root 下逐段非 symlink 下钻到的 inode」比对：fd 锁定
  // open 时刻的对象（不可变），独立下钻反映当前路径真实指向，两者不等即 open 跟随了 resolve 之后被
  // 换的中间段 symlink 到 root 外/他人文件（TOCTOU，codex 第四轮 P1）。
  private async lstatDeep(parts: string[], expectKind: 'file' | 'dir', label: string): Promise<number> {
    let cur = this.root
    let st: Stats
    try {
      st = await this.fs.lstat(cur)
    } catch {
      throw new WikiPageNotFound(label)
    }
    if (st.isSymbolicLink()) throw new WikiInvalidPath(label) // root 被换 symlink → 下钻会跟随到 root 外
    if (parts.length === 0) {
      if (expectKind === 'dir' && !st.isDirectory()) throw new WikiInvalidPath(label)
      if (expectKind === 'file' && !st.isFile()) throw new WikiPageNotFound(label)
      return st.ino
    }
    for (let i = 0; i < parts.length; i += 1) {
      cur = path.join(cur, parts[i])
      try {
        st = await this.fs.lstat(cur)
      } catch {
        throw new WikiPageNotFound(label)
      }
      if (st.isSymbolicLink()) throw new WikiInvalidPath(label)
      const isLast = i === parts.length - 1
      if (isLast) {
        if (expectKind === 'file' && !st.isFile()) throw new WikiPageNotFound(label)
        if (expectKind === 'dir' && !st.isDirectory()) throw new WikiInvalidPath(label)
      } else if (!st.isDirectory()) {
        throw new WikiInvalidPath(label)
      }
    }
    return st.ino
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
      // lstat（不跟随）：dirpath 在调用方 readdir 给出 Dirent 后可能被容器换成 symlink 指向 root 外——
      // stat 会跟随读外部目录、后续遍历再无 containment 校验（codex PR#346 P1）。lstat 对 symlink 返回
      // isDirectory()=false → 拒。
      if (!(await this.fs.lstat(dirpath)).isDirectory()) return
    } catch {
      return
    }
    const stack: Array<[string, string]> = [[dirpath, relPrefix]]
    while (stack.length > 0) {
      const [curDir, curPrefix] = stack.pop()!
      // point of use 不跟随：push→pop 之间 curDir 可能被换 symlink，readdir(curDir) 会跟随——pop 后
      // lstat 复核，识别 symlink/非目录则跳过该子树（codex PR#346 P1）。
      try {
        if (!(await this.fs.lstat(curDir)).isDirectory()) continue
      } catch {
        continue
      }
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
    // Dirent 已判 isFile，但读取前文件可能被换 symlink（point of use 防护，codex PR#346 P1）：
    // readText/readTitlePrefix 的 readFile/open 会跟随 symlink 读外部——lstat 复核非 symlink 且仍
    // regular，否则跳过该页（降级，不 500）。
    try {
      const st = await this.fs.lstat(fpath)
      if (!st.isFile() || st.isSymbolicLink()) return null
    } catch {
      return null
    }
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

  // 从 frontmatter 取标题（只读有界字节前缀，防大文件整读撑爆内存）；读失败/解码失败 → 文件名 fallback。
  private async pageTitle(fpath: string, fallback: string): Promise<string> {
    const raw = await this.readTitlePrefix(fpath)
    if (raw === null) return fallback
    // 按 Unicode code-point 截断（[...str] 解代理对）：`raw.slice(0, N)` 按 UTF-16 code unit 计，含
    // emoji 的 frontmatter 会在 title 键前被截断 → 解析失败 fallback 文件名（codex 第五轮 P2）。
    const { frontmatter } = this.parser.parse([...raw].slice(0, TITLE_READ_CHARS).join(''))
    return frontmatterTitle(frontmatter) ?? fallback
  }

  // 只读文件前 TITLE_READ_BYTES 字节并解码为标题文本（codex PR#346 P1）：原 pageTitle 经 readText 把
  // 整个文件 buffer 进内存再 slice，TITLE_READ_CHARS 的边界形同虚设——容器写超大/稀疏 .md 一个页面就
  // 能撑爆内存或杀死 Node。O_NONBLOCK 打开（FIFO/设备不阻塞 worker，纵然 scanDir 已过滤仍 defense in
  // depth）；fh.read 限定字节数，截断多字节序列由 decodePrefix 回退处理。
  private async readTitlePrefix(fpath: string): Promise<string | null> {
    let fh: FileHandle
    try {
      fh = await this.fs.open(fpath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    } catch {
      return null
    }
    try {
      const buf = Buffer.alloc(TITLE_READ_BYTES)
      const { bytesRead } = await fh.read(buf, 0, TITLE_READ_BYTES, 0)
      return decodePrefix(buf.subarray(0, bytesRead))
    } catch {
      return null
    } finally {
      await fh.close().catch(() => {})
    }
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
          // symlink 循环/链过深（Python realpath 同有 40 上限）：旧实现拼回剩余段会把循环段丢弃，
          // 令 concepts/loop/page.md（loop→loop 自循环）解析成 concepts/page.md（无关真实页），CRUD
          // 经循环别名读写删到错误目标（codex 第四轮 P2）。直接拒绝。
          throw new WikiInvalidPath(p)
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
