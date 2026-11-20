// Skill 包 zip 管线（#1055 A 票 · #1054 D2 包边界）：打包 / 解包 / 解析校验三面，纯逻辑。
//
// 解析（parseSkillPackage）＝ D2 防护清单逐条落地，任一违反 → `{ok:false, reasons[]}` 结构化
// 拒收（每条原因自解释、可直接透传给上传者——spec「结构化拒收原因（非模糊错误）」）：
//   整包 ≤1MB · 单文件 ≤256KB · 条目 ≤50 · 路径拒绝穿越（.. / 绝对路径 / 反斜杠 / 空段）·
//   扩展名白名单（.md/.txt/.png/.jpg/.jpeg/.webp/.gif）· SKILL.md 必备（zip 根）·
//   frontmatter name/description/category 可解析 · category 命中固定枚举 ·
//   name 长度/保留字（registry + 内置命令同源纪律）· description 非空 · 重复路径拒收。
// 打包（packSkillZip）＝ 下载端点按 skill_files 行还原 zip（B 票消费）；与解包往返字节级一致
//（S3 用例锁）。

import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { RESERVED_PLUGIN_IDS, RESERVED_RUN_KINDS } from '../plugins/registry'
import { BUILTIN_COMMANDS } from '../plugins/slash'
import {
  SKILL_ALLOWED_EXTENSIONS,
  SKILL_BODY_MAX_BYTES,
  SKILL_CATEGORIES,
  SKILL_DESCRIPTION_MAX,
  SKILL_ENTRY_MAX,
  SKILL_FILE_MAX_BYTES,
  SKILL_MANIFEST_PATH,
  SKILL_NAME_MAX,
  SKILL_PACKAGE_MAX_BYTES,
  mimeFromSkillExtension,
  type SkillCategory,
} from './values'

// skill name 保留面（同源纪律）：与插件 id / run.kind / 内置命令名合流——skill name 不得占用
// 这些身份（registry 纯常量模块，无依赖环）。
const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set<string>([
  ...RESERVED_PLUGIN_IDS,
  ...RESERVED_RUN_KINDS,
  ...BUILTIN_COMMANDS,
])

export interface SkillManifest {
  name: string
  description: string
  category: SkillCategory
}

export interface SkillFileContent {
  /** zip 内相对路径（'/' 分隔；SKILL.md 在根，资源可带子目录） */
  path: string
  mime: string
  size: number
  sha256: string
  content: Buffer
}

export type SkillPackageParseResult =
  | { ok: true; manifest: SkillManifest; files: SkillFileContent[] }
  | { ok: false; reasons: string[] }

// frontmatter 解析（极简 `---` 块）：首行 `---` → 逐行 `key: value` → 次行 `---` 结束。
// 不引 yaml 依赖——manifest 只需 name/description/category 三个标量（#787 旧形态同款）。
export function parseSkillFrontmatter(body: string): { name?: string; description?: string; category?: string } {
  const lines = body.split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== '---') return {}
  const out: Record<string, string> = {}
  for (let i = 1; i < lines.length && (lines[i] ?? '').trim() !== '---'; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i] ?? '')
    if (m) out[m[1]!.toLowerCase()] = m[2]!.trim()
  }
  return {
    ...(out.name !== undefined ? { name: out.name } : {}),
    ...(out.description !== undefined ? { description: out.description } : {}),
    ...(out.category !== undefined ? { category: out.category } : {}),
  }
}

function isAllowedExtension(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  const ext = path.slice(dot).toLowerCase()
  return (SKILL_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)
}

// 拒绝穿越面：`..` 段 / 绝对路径 / 反斜杠 / 空段 / NUL。zip 条目名按 `/` 分隔逐段校验。
// 注意区分两面：adm-zip **写入**时归一化坏路径（addFile 语义），但**读取**外来 zip 原样保留
// 条目名——恶意客户端构造的 `../` 条目会在解析侧原样出现，本函数即该攻击面的守卫
//（S3 用例以手工 STORE 法 zip 构造原始名条目覆盖）。
export function safeRelativePath(raw: string): string | null {
  // 拒绝穿越面：`..` 段 / 绝对路径 / 反斜杠 / 空段 / NUL。zip 条目名按 `/` 分隔逐段校验。
  if (raw === '' || raw.includes('\\') || raw.includes('\u0000')) return null
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
  const segs = raw.split('/')
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return null
  }
  return segs.join('/')
}

// 解析并校验一个 skill 包 zip。buffer 即上传字节（调用方已限定 ≤SKILL_PACKAGE_MAX_BYTES；
// 此处复核双保险）。
export function parseSkillPackage(zipBuf: Buffer): SkillPackageParseResult {
  const reasons: string[] = []
  if (zipBuf.length > SKILL_PACKAGE_MAX_BYTES) {
    reasons.push(`整包过大（≤${SKILL_PACKAGE_MAX_BYTES / 1024 / 1024}MB）`)
  }
  let zip: AdmZip
  try {
    zip = new AdmZip(zipBuf)
  } catch {
    return { ok: false, reasons: ['不是合法的 zip 压缩包'] }
  }
  const entries = zip.getEntries().filter((e) => !e.isDirectory)
  if (entries.length > SKILL_ENTRY_MAX) {
    reasons.push(`文件数超限（≤${SKILL_ENTRY_MAX}）`)
  }
  const files: SkillFileContent[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const path = safeRelativePath(entry.entryName)
    if (path === null) {
      reasons.push(`非法路径（穿越/绝对路径/反斜杠）: ${entry.entryName.slice(0, 120)}`)
      continue
    }
    if (seen.has(path)) {
      reasons.push(`重复路径: ${path}`)
      continue
    }
    seen.add(path)
    if (!isAllowedExtension(path)) {
      reasons.push(`不允许的文件类型（白名单 ${SKILL_ALLOWED_EXTENSIONS.join(' ')}）: ${path}`)
      continue
    }
    const content = entry.getData()
    if (content.length > SKILL_FILE_MAX_BYTES) {
      reasons.push(`单文件过大（≤${SKILL_FILE_MAX_BYTES / 1024}KB）: ${path}`)
      continue
    }
    if (path === SKILL_MANIFEST_PATH && content.length > SKILL_BODY_MAX_BYTES) {
      reasons.push(`SKILL.md 正文过大（≤${SKILL_BODY_MAX_BYTES / 1024}KB）`)
      continue
    }
    files.push({
      path,
      mime: mimeFromSkillExtension(path),
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      content,
    })
  }
  const manifest = files.find((f) => f.path === SKILL_MANIFEST_PATH)
  if (!manifest) {
    reasons.push('缺少 SKILL.md（必须在 zip 根目录）')
  } else {
    const fm = parseSkillFrontmatter(manifest.content.toString('utf8'))
    const name = (fm.name ?? '').trim()
    const description = (fm.description ?? '').trim()
    const category = (fm.category ?? '').trim()
    if (name === '') reasons.push('SKILL.md frontmatter 缺少 name')
    else if (name.length > SKILL_NAME_MAX) reasons.push(`name 过长（≤${SKILL_NAME_MAX}）`)
    else if (RESERVED_SKILL_NAMES.has(name)) reasons.push(`name 为保留字: ${name}`)
    if (description === '') reasons.push('SKILL.md frontmatter 缺少 description')
    else if (description.length > SKILL_DESCRIPTION_MAX) reasons.push(`description 过长（≤${SKILL_DESCRIPTION_MAX}）`)
    if (category === '') reasons.push('SKILL.md frontmatter 缺少 category')
    else if (!(SKILL_CATEGORIES as readonly string[]).includes(category)) {
      reasons.push(`category 不在枚举内（${SKILL_CATEGORIES.join('/')}）: ${category}`)
    }
    if (reasons.length === 0) {
      return {
        ok: true,
        manifest: { name, description, category: category as SkillCategory },
        files,
      }
    }
  }
  return { ok: false, reasons }
}

// 打包（下载端点还原）：files = skill_files 行投影（path + content）。
export function packSkillZip(files: ReadonlyArray<{ path: string; content: Buffer }>): Buffer {
  const zip = new AdmZip()
  for (const f of files) {
    zip.addFile(f.path, f.content)
  }
  return zip.toBuffer()
}
