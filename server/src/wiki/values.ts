// wiki 常量（#335 · 平移 backend/wiki/service.py + integration/openclaw/adapters.py）。
// 单一来源：SKIP 集合 / 正则 / 摘要长度。供纯逻辑（logic.ts）、FS 适配器（nodeFs.ts）复用。

// managed 文件黑名单（codex #125 / #315 §4）：插件私有目录与占位文件，读写全拦。
export const SKIP_DIRS = new Set(['.openclaw-wiki', '_attachments', '_views'])
export const SKIP_FILES = new Set(['index.md', 'AGENTS.md', 'WIKI.md', 'inbox.md'])

// obsidian 风格双链 [[target]] 或 [[target|别名]]（WIKILINK_RE）
export const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

// category 机读标记：整行匹配、大小写不敏感（含 CATEGORY/cAtEgOrY 全形态）、剥离尾反引号
// （issue #84 / spec #75；codex #129 P2 IGNORECASE 全词匹配）
export const CATEGORY_RE = /^`category:\s*([^`\s]+)`\s*$/im
// H1 / H2 标题行（界定 category 提取窗口）
export const H1_RE = /^#\s/m
export const H2_RE = /^##\s/m

// excerpt 摘要长度（正文开头片段，字符数；Python 按码点截断，JS 用 Array.from 对齐）
export const EXCERPT_LEN = 200

// 页面标题 frontmatter 值上限（_page_title 只读前 2000 字符，防大文件整读；保留原行为）
export const TITLE_READ_CHARS = 2000

// _page_title 有界字节前缀上限（TITLE_READ_CHARS × 4，覆盖最坏 4 字节/字符）：原实现 read_text 把
// 整个文件 buffer 进内存再 slice，容器写超大/稀疏 .md 一个页面就能撑爆内存或杀死 Node——只读字节前缀
// 再 decode+slice 字符（codex PR#346 P1）。
export const TITLE_READ_BYTES = TITLE_READ_CHARS * 4
