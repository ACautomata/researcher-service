// Skill 市场域常量（#1054 决策定案 · D2 包边界 / D3 字节落点 / D5 类别枚举）。
// 纯常量单一来源；防护上限经 A 票 zip 管线逐条消费（结构化拒收原因），manifest 常数
//（正文 64KB / 目录快照 4KB）沿 #787 已验证形态，供 C 票运行时接入复用。

// D3 上限：整包 ≤1MB、单文件 ≤256KB、条目 ≤50、SKILL.md 正文 ≤64KB（#787 旧常数）。
export const SKILL_PACKAGE_MAX_BYTES = 1024 * 1024
export const SKILL_FILE_MAX_BYTES = 256 * 1024
export const SKILL_ENTRY_MAX = 50
export const SKILL_BODY_MAX_BYTES = 64 * 1024
// #787 旧常数：prompt 目录快照上限（C 票运行时接入消费）。
export const SKILL_CATALOG_MAX_BYTES = 4 * 1024

// D2 白名单扩展名（zip 内允许；SKILL.md 自身为 .md 天然在内）。
export const SKILL_ALLOWED_EXTENSIONS = ['.md', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.gif'] as const

// SKILL.md 在包内的固定路径（zip 根）。
export const SKILL_MANIFEST_PATH = 'SKILL.md'

// D5 类别固定枚举（SKILL.md frontmatter category 必须命中；V1 五值）。
export const SKILL_CATEGORIES = ['research', 'writing', 'data', 'literature', 'other'] as const
export type SkillCategory = (typeof SKILL_CATEGORIES)[number]

// name 上限（目录展示 + registry 纪律面）与 description 上限。
export const SKILL_NAME_MAX = 64
export const SKILL_DESCRIPTION_MAX = 200

// 按扩展名派生 mime（skill_files.mime；白名单内的确定映射）。
const EXT_MIME: Readonly<Record<string, string>> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export function mimeFromSkillExtension(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot).toLowerCase()
  return EXT_MIME[ext] ?? 'application/octet-stream'
}
