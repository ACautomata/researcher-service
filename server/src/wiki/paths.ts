// wiki path 请求层校验（#335 · #315 §4 第①层，平移 backend/wiki/serializers.py RelPathField）。
// 这是双保险的第一层：拒绝对路径/反斜杠/`..` 穿越/非 .md，归一化重 join。
// 第二层在 DockerWikiFileSystem（managed 黑名单 SKIP_DIRS 段 / SKIP_FILES 末段 →
// WikiInvalidPath）；realpath 锚定无 Docker 等价物也无必要（getArchive 以容器为视角，
// symlink 逃逸不到控制面——安全模型差异见 dockerFs.ts 头注）。
// 返回 Result（不抛），调用方统一转 90002 + data.path。
//
// 写体校验（parseWikiWriteBody）已随 REST 写面退役（#758 Q3，wiki 写面收归 agent）删除——
// 读面只剩 query path 校验（requireRelPath）。

import { fail } from '../envelope'
import { CODE } from '../codes'

export type RelPathResult = { ok: true; path: string } | { ok: false; errors: string[] }

const PATH_MAX = 512 // Django CharField max_length=512

export function normalizeRelPath(raw: unknown): RelPathResult {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, errors: ['path 不能为空'] }
  const v = raw.trim()
  if (v.startsWith('/') || v.startsWith('\\')) return { ok: false, errors: ['path 须为相对路径'] }
  if (v.includes('\\')) return { ok: false, errors: ['path 不允许反斜杠'] }
  // NUL 字节（body/query 可携带 %00）：Node fs 会抛 ERR_INVALID_ARG_VALUE，且 GET 被误译为
  // 页不存在/POST 走 90000 —— 这里统一拒为 90002（codex PR#346）。
  if (v.includes('\u0000')) return { ok: false, errors: ['path 不允许空字节'] }
  const parts = v.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) return { ok: false, errors: ['path 不允许目录穿越'] }
  if (parts.length === 0 || !parts[parts.length - 1].endsWith('.md')) {
    return { ok: false, errors: ['path 须指向 .md 文件'] }
  }
  const norm = parts.join('/')
  // 按 Unicode code points 计长（Django CharField max_length=512 契约）：`String.length` 按 UTF-16
  // code units，含 emoji 等非 BMP 字符的合法路径会被误拒——codex PR#346。
  if (Array.from(norm).length > PATH_MAX) return { ok: false, errors: ['path 过长'] }
  return { ok: true, path: norm }
}

// query path 校验（GET page/claims）：非法 → 抛 90002 + data.path（normalizeRelPath 的抛形态）。
export function requireRelPath(raw: unknown): string {
  const res = normalizeRelPath(raw)
  if (!res.ok) throw fail(CODE.VALIDATION_FAILED, undefined, { path: res.errors })
  return res.path
}
