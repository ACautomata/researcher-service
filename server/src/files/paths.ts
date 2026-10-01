// files 请求层校验（#589 · 平移 wiki/paths.ts normalizeRelPath，#586 US10 穿越防护）。
// 拒绝对路径/反斜杠/`..` 穿越/NUL 字节/超长，归一化重 join；**放宽 wiki 的 .md 限制**
// （workspace 含任意文本扩展），并允许缺省/空串 = 树根（列根目录）。root 经枚举校验。
// 返回 Result（不抛），调用方统一转 90002 + data.path / data.root。

import { fail } from '../envelope'
import { CODE } from '../codes'
import type { FileRoot, LegacyFileRoot } from './fsPort'
import { FILE_ROOTS } from './values'

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

export type RootResult = { ok: true; root: FileRoot } | { ok: false; errors: string[] }

// #776 root 契约：wiki（legacy 容器树，读写暂留退役归 T0）| workspace（legacy 只读消费值——
// 现存前端 fileTabs 硬发此值，迁 lab 归 #793；写面拒）| lab（会话沙箱 /lab 只读面）。
export function normalizeFileRoot(raw: unknown): RootResult {
  if (raw === 'wiki' || raw === 'workspace' || raw === 'lab') return { ok: true, root: raw }
  return { ok: false, errors: ['root 仅支持 wiki / workspace(legacy 只读) / lab'] }
}

// 未配对 surrogate（如 JSON 里的 "\ud800"）：JS 字符串可携带，但 UTF-8 编码器写盘时静默替换为
// U+FFFD——PUT 报告成功、后续 GET 返回不同内容，破坏 byte-exact 编辑契约。对齐 wiki 校验
// （合法 surrogate 对 emoji 等放行）。
const UNPAIRED_SURROGATE_RE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/

// 只读 root 的拒绝文案单一来源：lab / workspace 均只读（#776 写面收敛，唯一可写 root = wiki）。
// wiki → undefined（可写）。
export function readonlyRootError(root: Exclude<FileRoot, 'wiki'>): string {
  return root === 'lab'
    ? 'root=lab 为只读面（文件写经对话让 agent 改）'
    : 'root=workspace 为 legacy 只读面（写经对话让 agent 改）'
}

// POST/PUT files body 校验（#589）：{root, path, content}。root 枚举 + path 防护 + content
// 字符串性，双字段错误一次性收集进 data（对齐 wiki parseWikiWriteBody / DRF 聚合）。
// #776 写面收敛：唯一可写 root = wiki（lab 只读——/lab 字节写收敛为 runner 工具 + 上传端点，
// #769；workspace legacy 只读消费值，写拒——改前前端从不写，v1 tabs 只读）。
export function parseFileWriteBody(body: unknown): { root: 'wiki'; path: string; content: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const contentError =
    typeof b.content !== 'string'
      ? ['content 不能为空']
      : UNPAIRED_SURROGATE_RE.test(b.content)
        ? ['content 含未配对代理字符']
        : undefined
  const rootRes = normalizeFileRoot(b.root)
  const pathRes = normalizeFilePath(b.path)
  const errors: Record<string, string[]> = {}
  if (!rootRes.ok) errors.root = rootRes.errors
  else if (rootRes.root !== 'wiki') errors.root = [readonlyRootError(rootRes.root)]
  if (!pathRes.ok) errors.path = pathRes.errors
  // 写操作必须指向文件：空 path（树根）无覆写/新建语义
  else if (pathRes.path === '') errors.path = ['path 不能为空']
  if (contentError) errors.content = contentError
  if (!rootRes.ok || rootRes.root !== 'wiki' || !pathRes.ok || pathRes.path === '' || contentError) {
    throw fail(CODE.VALIDATION_FAILED, undefined, errors)
  }
  return { root: 'wiki', path: pathRes.path, content: b.content as string }
}

// WebChat 媒体端点（files/raw）的绝对路径解析：agent mediaUrls 携带容器内绝对路径
//（如 /home/node/.openclaw/workspace/test.png）——校验必须落在 workspace 树根前缀内（单一来源
// FILE_ROOTS.workspace，legacy 专用通道 T0 退役），剥离前缀得相对路径后复用 normalizeFilePath
// 防穿越/反斜杠/NUL/超长。非 workspace 前缀一律拒绝（不暴露 wiki 或其它容器内路径）；缺省/非字符串
// → 拒绝。
export function resolveWorkspaceAbsPath(raw: unknown): RelPathResult {
  if (typeof raw !== 'string' || !raw) return { ok: false, errors: ['path 须为容器内 workspace 绝对路径'] }
  const prefix = `${FILE_ROOTS.workspace}/`
  if (!raw.startsWith(prefix)) return { ok: false, errors: ['仅允许读取 workspace 目录内文件'] }
  return normalizeFilePath(raw.slice(prefix.length))
}

// query 形态（GET/DELETE）：root / path 各自校验，非法 → 抛 90002 + data 字段明细。
export function requireFileRoot(raw: unknown): FileRoot {
  const res = normalizeFileRoot(raw)
  if (!res.ok) throw fail(CODE.VALIDATION_FAILED, undefined, { root: res.errors })
  return res.root
}

// legacy 面专用（GET read 的 root）：lab 不在其中——lab 分支在路由层已按 query 原值分派
//（resolveLabSession → readLab），走到这里的一定是 legacy 容器面。类型收窄即文档：
// read(name,'lab') 会错探 openclaw-gw-<name>/lab，此处静态排除。
export function requireLegacyFileRoot(raw: unknown): LegacyFileRoot {
  const root = requireFileRoot(raw)
  if (root === 'lab') throw fail(CODE.VALIDATION_FAILED, undefined, { root: [readonlyRootError(root)] })
  return root
}

// 写面专用（DELETE/PUT/POST 的可写判定，query 与 body 两形态共用文案来源）：唯一可写
// root = wiki；lab/workspace 即抛（readonlyRootError 单一来源）。
export function requireWritableFileRoot(raw: unknown): 'wiki' {
  const root = requireFileRoot(raw)
  if (root !== 'wiki') throw fail(CODE.VALIDATION_FAILED, undefined, { root: [readonlyRootError(root)] })
  return root
}

// allowEmpty=true（GET 列树根）时空串合法；DELETE 用默认（空 path 无删除语义 → 90002）。
export function requireFilePath(raw: unknown, opts: { allowEmpty?: boolean } = {}): string {
  const res = normalizeFilePath(raw)
  if (!res.ok) throw fail(CODE.VALIDATION_FAILED, undefined, { path: res.errors })
  if (!opts.allowEmpty && res.path === '') throw fail(CODE.VALIDATION_FAILED, undefined, { path: ['path 不能为空'] })
  return res.path
}
