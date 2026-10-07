// files 请求层校验（#589 · 平移 wiki/paths.ts normalizeRelPath，#586 US10 穿越防护；
// T0 #801 只读化收缩）。
// 拒绝对路径/反斜杠/`..` 穿越/NUL 字节/超长，归一化重 join；允许缺省/空串 = 树根（列根目录）。
// 返回 Result（不抛），调用方统一转 90002 + data.path / data.root。
//
// root 契约（T0 #801）：lab = 会话沙箱 /lab 只读面（唯一保留读面）；wiki/workspace = 退役根
//（读走 wiki 域 REST / 字眼退役）——合法值但退役 → 60042（FILE_ROOT_RETIRED），非 90002。

import { fail } from '../envelope'
import { CODE } from '../codes'

export type RelPathResult = { ok: true; path: string } | { ok: false; errors: string[] }

// 与 wiki 同源：Django CharField max_length=512（Unicode code points 计长）
const PATH_MAX = 512

export function normalizeFilePath(raw: unknown): RelPathResult {
  // 缺省（undefined/null，如 query 未传 path）= 树根，与空串等价——GET 列根目录时前端不传 path
  if (raw === undefined || raw === null) return { ok: true, path: '' }
  if (typeof raw !== 'string') return { ok: false, errors: ['path 须为字符串'] }
  // 空串 = 树根（列根目录 / 不适用文件读写的 target）；不做 trim（文件名首尾空白合法）
  if (raw === '') return { ok: true, path: '' }
  const v = raw
  if (v.startsWith('/') || v.startsWith('\\')) return { ok: false, errors: ['path 须为相对路径'] }
  if (v.includes('\\')) return { ok: false, errors: ['path 不允许反斜杠'] }
  // NUL 字节（body/query 可携带 %00）：对齐 wiki 统一拒为 90002（codex PR#346）。
  if (v.includes('\u0000')) return { ok: false, errors: ['path 不允许空字节'] }
  const parts = v.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) return { ok: false, errors: ['path 不允许目录穿越'] }
  if (parts.length === 0) return { ok: true, path: '' } // "a//b" 折叠后为空 → 根
  const norm = parts.join('/')
  // 按 Unicode code points 计长（Django max_length=512 契约）：String.length 按 UTF-16 code
  // units，非 BMP 字符合法路径会被误拒（codex PR#346 同源修复）。
  if (Array.from(norm).length > PATH_MAX) return { ok: false, errors: ['path 过长'] }
  return { ok: true, path: norm }
}

// root 三态（T0 #801）：lab = 现役只读面；wiki/workspace = 退役根（60042）。
export type FileRootQuery = 'lab' | 'wiki' | 'workspace'

export type RootResult = { ok: true; root: FileRootQuery } | { ok: false; errors: string[] }

export function normalizeFileRoot(raw: unknown): RootResult {
  if (raw === 'lab' || raw === 'wiki' || raw === 'workspace') return { ok: true, root: raw }
  return { ok: false, errors: ['root 仅支持 lab（wiki/workspace 已退役）'] }
}

// query 形态 root 校验（GET）：非法值 → 90002 + data.root；wiki/workspace 合法但退役 →
// 调用方转 60042（本函数不抛退役码，保持「校验 ≠ 判定」单一职责）。
export function requireFileRoot(raw: unknown): FileRootQuery {
  const res = normalizeFileRoot(raw)
  if (!res.ok) throw fail(CODE.VALIDATION_FAILED, undefined, { root: res.errors })
  return res.root
}

// allowEmpty=true（GET 列树根）时空串合法。
export function requireFilePath(raw: unknown, opts: { allowEmpty?: boolean } = {}): string {
  const res = normalizeFilePath(raw)
  if (!res.ok) throw fail(CODE.VALIDATION_FAILED, undefined, { path: res.errors })
  if (!opts.allowEmpty && res.path === '') throw fail(CODE.VALIDATION_FAILED, undefined, { path: ['path 不能为空'] })
  return res.path
}
