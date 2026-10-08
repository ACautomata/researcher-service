// wiki 常量（#335 · 平移 backend/wiki/service.py；#861 起黑名单零 legacy 成员——
// 旧 `.openclaw-wiki` 目录名随 fleet 退役移除，现役 wiki 容器树零初始化不会产生它）。
// 单一来源：SKIP 集合 / 正则 / 摘要长度。供纯逻辑（logic.ts）、FS 适配器（nodeFs.ts）复用。

// managed 文件黑名单（codex #125 / #315 §4）：插件私有目录与占位文件，读写全拦。
// #789 OKF 适配（#725 §三）：log.md/INSTRUCTIONS.md 是 openwiki 的运行文件（给 agent 的
// 操作说明与运行日志，非知识页），.claims/ 是 claims 证据旁车目录（机器生成物）——三者
// 均不进 tree/graph，写侧一并拒绝（.claims 只读面走 service.readClaims 专用
// 通道，不经本黑名单拦截的页读路径）。
export const SKIP_DIRS = new Set(['_attachments', '_views', '.claims'])
export const SKIP_FILES = new Set(['index.md', 'AGENTS.md', 'WIKI.md', 'inbox.md', 'log.md', 'INSTRUCTIONS.md'])

// obsidian 风格双链 [[target]] 或 [[target|别名]]（WIKILINK_RE）
export const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

// 页面标题 frontmatter 值上限（_page_title 只读前 2000 字符，防大文件整读；保留原行为）
export const TITLE_READ_CHARS = 2000

// _page_title 有界字节前缀上限（TITLE_READ_CHARS × 4，覆盖最坏 4 字节/字符）：原实现 read_text 把
// 整个文件 buffer 进内存再 slice，容器写超大/稀疏 .md 一个页面就能撑爆内存或杀死 Node——只读字节前缀
// 再 decode+slice 字符（codex PR#346 P1）。
export const TITLE_READ_BYTES = TITLE_READ_CHARS * 4
