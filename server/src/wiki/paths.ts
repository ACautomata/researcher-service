// wiki path 请求层校验（#335 · #315 §4 第①层，平移 backend/wiki/serializers.py RelPathField）。
// 这是双保险的第一层：拒绝对路径/反斜杠/`..` 穿越/非 .md，归一化重 join。
// 第二层在 NodeWikiFileSystem._resolve（managed 黑名单 + realpath 落 root 内）。
// 返回 Result（不抛），调用方统一转 90002 + data.path。

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

// POST/PUT page body 校验（Django WikiPageWriteSerializer）：{path, content}。
// content allow_blank=True、trim_whitespace=False（逐字保留首尾空白/尾换行）。收集双字段错误
// 一次性转 90002（对齐 DRF 聚合 field errors）。
//
// 未配对 surrogate（如 JSON 里的 "\ud800"）：JS 字符串可携带，但 Node 的 UTF-8 编码器写盘时静默替换为
// U+FFFD——PUT 报告成功、后续 GET 返回不同内容，破坏 byte-exact 编辑契约。迁移的 DRF CharField 在文件
// 系统访问前即拒绝，这里校验并返回 90002（codex 第六轮 P2）。合法 surrogate 对（emoji 等）放行。
const UNPAIRED_SURROGATE_RE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/

export function parseWikiWriteBody(body: unknown): { path: string; content: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const contentError =
    typeof b.content !== 'string'
      ? ['content 不能为空']
      : UNPAIRED_SURROGATE_RE.test(b.content)
        ? ['content 含未配对代理字符']
        : undefined
  const pathRes = normalizeRelPath(b.path)
  if (!pathRes.ok) {
    // 对齐 DRF：path 与 content 双字段错误一次性收集进 data。
    throw fail(CODE.VALIDATION_FAILED, undefined, contentError ? { path: pathRes.errors, content: contentError } : { path: pathRes.errors })
  }
  if (contentError) throw fail(CODE.VALIDATION_FAILED, undefined, { content: contentError })
  return { path: pathRes.path, content: b.content as string }
}

// query path 校验（GET/DELETE page）：非法 → 抛 90002 + data.path（normalizeRelPath 的抛形态）。
export function requireRelPath(raw: unknown): string {
  const res = normalizeRelPath(raw)
  if (!res.ok) throw fail(CODE.VALIDATION_FAILED, undefined, { path: res.errors })
  return res.path
}
