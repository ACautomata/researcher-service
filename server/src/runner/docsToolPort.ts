// ctx.docs 核心实现（#908 · 853 §3.2#2 PluginDocsPort）：窄域 PDF 文本提取口——
// `extractPdfText({sandboxPath}) → {pages}`。仅此窄域端口，无通用 exec/fs 透传（#752 已钉）。
//
// 纪律（approval 同款）：
//   - sandboxPath 强制 /lab/ 前缀白名单 + 穿越/反斜杠/空字节拒止（normalizeLabPath 纯逻辑，
//     wiki/paths.ts RelPathField 同形纪律的绝对路径版）——argv 直达不经 shell 也要防
//     '/lab/../…' 逃逸读沙箱任意文件。
//   - 存在性校验：pdftotext 前先 `test -f`——文件缺失给 not_found 明确报错（不触发提取、
//     不把 pdftotext 的 "Couldn't open file" 语义当提取失败混传）。
//   - 核心固定命令（沙箱内执行）：pdftotext <path> -（stdout 输出，天然按 \f 分页——
//     按页数组返回，PDF 全文不进主上下文）；超时 = EXEC_DEFAULT_TIMEOUT_MS 全局口径。
//   - 字符上限 PDF_EXTRACT_MAX_CHARS（plugins/research/values，853 §7.1）：超限明确报错不
//     静默截断——截断致 extract 缺节 → validate 拒 → 重试循环浪费 token。判定发生在提取
//     全文回流之后（exec stdout 全量收集是 Docker 原语固定形态）——「不进主上下文」指 LLM
//     上下文；控制面内存峰值 ≈ 2×PDF 文本字节（1M chars 上限 ≈ 2MB，可接受）。
//   - 沙箱镜像含 poppler 是镜像验收项（#908）：exit 127（pdftotext 不在镜像）报错文案明示
//     poppler-utils 缺位，引导部署设 SANDBOX_IMAGE 指向 poppler 镜像。

import { PDF_EXTRACT_MAX_CHARS } from '../../../plugins/research/values'
import { EXEC_DEFAULT_TIMEOUT_MS } from './backend/values'
import type { SandboxFilePrimitives } from './backend/primitives'
import type { PluginDocsPort } from '../plugins/api'

export type PluginDocsPortErrorCode =
  | 'invalid_path' // 非 /lab/ 前缀 / 穿越 / 反斜杠 / 空字节
  | 'not_found' // 存在性校验失败
  | 'extract_failed' // pdftotext 非零退出（含镜像缺 poppler 的 127）
  | 'too_large' // 提取全文超 PDF_EXTRACT_MAX_CHARS（不静默截断）

export class PluginDocsPortError extends Error {
  constructor(
    readonly code: PluginDocsPortErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PluginDocsPortError'
  }
}

const LAB_PREFIX = '/lab/'

// /lab/ 前缀白名单 + 归一化（绝对路径版 RelPathField 纪律）：剥空段与 '.' 段、拒 '..' 穿越、
// 反斜杠、NUL。'/lab' 根本身拒（PDF 是文件，必在 lab 树内）。返回归一化绝对路径。
export function normalizeLabPath(raw: string): string {
  const invalid = (): never => {
    throw new PluginDocsPortError('invalid_path', `sandboxPath 须为 /lab/ 前缀的合法路径: ${JSON.stringify(raw)}`)
  }
  if (typeof raw !== 'string' || raw.trim() === '') invalid()
  const v = raw.trim()
  if (!v.startsWith(LAB_PREFIX)) invalid()
  if (v.includes('\\') || v.includes('\u0000')) invalid()
  const parts = v.split('/').filter((p) => p !== '' && p !== '.')
  if (parts[0] !== 'lab' || parts.length < 2) invalid()
  if (parts.some((p) => p === '..')) invalid()
  return `/${parts.join('/')}`
}

// pdftotext stdout 按页切分：\f（form feed）天然分页；尾部 form-feed artifact（pdftotext
// 恒以 \f 收尾）丢弃；页内空文本（图片页/空版式）保留——「页 i 无文本」是事实不是缺失。
export function splitPdfPages(text: string): string[] {
  const parts = text.split('\f')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  if (parts.length === 1 && parts[0] === '') return []
  return parts
}

export interface PluginDocsToolPortDeps {
  /** run 的沙箱容器（/lab 工具根；RunService 沙箱 ensure 后的 labContainer）。 */
  readonly container: string
  /** Docker exec 原语（S2 接缝；测试 fake）。 */
  readonly primitives: Pick<SandboxFilePrimitives, 'exec'>
  /** 字符上限覆盖（缺省 PDF_EXTRACT_MAX_CHARS；smoke 用小上限验超限）。 */
  readonly maxChars?: number
  /** 提取超时毫秒（缺省 EXEC_DEFAULT_TIMEOUT_MS 全局口径；可注入缩短）。 */
  readonly timeoutMs?: number
}

export function createPluginDocsPort(deps: PluginDocsToolPortDeps): PluginDocsPort {
  const maxChars = deps.maxChars ?? PDF_EXTRACT_MAX_CHARS
  const timeoutMs = deps.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS
  return {
    async extractPdfText({ sandboxPath }) {
      const path = normalizeLabPath(sandboxPath)
      const probe = await deps.primitives.exec(deps.container, ['test', '-f', path])
      if (probe.exitCode !== 0) {
        throw new PluginDocsPortError('not_found', `文件不存在或不可读: ${path}`)
      }
      const out = await deps.primitives.exec(deps.container, ['pdftotext', path, '-'], { timeoutMs })
      if (out.exitCode !== 0) {
        const stderr = out.stderr.trim()
        const suffix = stderr === '' ? '' : `: ${stderr}`
        const detail = out.exitCode === 127
          ? `沙箱镜像缺 pdftotext（poppler-utils）——部署以 SANDBOX_IMAGE 指向含 poppler 的沙箱镜像后可用${suffix}`
          : `pdftotext 退出码 ${out.exitCode}${suffix}`
        throw new PluginDocsPortError('extract_failed', `PDF 文本提取失败: ${detail}`)
      }
      const pages = splitPdfPages(out.stdout)
      const total = pages.reduce((n, p) => n + p.length, 0)
      if (total > maxChars) {
        throw new PluginDocsPortError(
          'too_large',
          `提取文本 ${total} 字符超上限 ${maxChars}——超限明确报错不静默截断（防 extract 缺节 → validate 拒 → 重试循环浪费 token）`,
        )
      }
      return { pages }
    },
  }
}
