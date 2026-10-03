// 规则层（#783 · 729 §1）：确定性前置判定——纯逻辑，零 IO（接缝 S3）。
//
// 命中语义三分（§1.1）：黑名单命中 → 直接拒（终态不升级）；白名单命中 → 直接放行（零 LLM）；
// 未命中 → 灰区进 judge。本文件产出判定，落库/回喂/升级由 funnel.ts 编排。
//
// 判定绝不抛——畸形输入按「未命中（灰区）」处理，规则层自身故障不放大为 run 故障；
// 灰区兜底 = judge 政策（§2.4），漏网即此语义。

import { createHash } from 'node:crypto'
import { parse } from 'shell-quote'
import {
  DEVICE_WRITE_COMMANDS,
  DOCKER_SOCK_MARKERS,
  EXEC_TOOLS,
  FILE_PATH_PARAM_NAMES,
  FILE_TOOLS,
  FORK_BOMB_PATTERNS,
  CONTAINER_ESCAPE_COMMANDS,
  PATH_WHITELIST_PREFIXES,
  PATH_WHITELIST_ROOTS,
  RM_PROTECTED_TARGETS,
  SHELL_PARSE_MAX_DEPTH,
  SHELL_RULE_CONTAINER_ESCAPE,
  SHELL_RULE_DEVICE_WRITE,
  SHELL_RULE_FORK_BOMB,
  SHELL_RULE_RM,
} from './values'

// ---------------------------------------------------------------------------
// 工具类别（729 §1.5 映射表）
// ---------------------------------------------------------------------------

export type ToolCategory = 'file' | 'exec' | 'other'

export function classifyTool(name: string): ToolCategory {
  if (FILE_TOOLS.includes(name)) return 'file'
  if (EXEC_TOOLS.includes(name)) return 'exec'
  return 'other'
}

// ---------------------------------------------------------------------------
// 判定形状：allow = 白名单放行；pass = 规则层未命中（灰区进 judge）；
// deny = 黑名单命中（直接拒，终态）。路径白名单永不 deny（无路径黑名单），命令黑名单
// 永不 allow（无命令白名单）。
// ---------------------------------------------------------------------------

export type RuleVerdict =
  | { kind: 'allow'; rule: string }
  | { kind: 'pass' }
  | { kind: 'deny'; rule: string; reason: string }

// ---------------------------------------------------------------------------
// 路径白名单（§1.2）：只判文件类工具的字面路径参数；normalizeFilePath 语义（files/paths.ts
// 同源——拒 .. 段/反斜杠/NUL，折叠 . 与空段）归一化后做段级前缀匹配。
// ---------------------------------------------------------------------------

function normalizeRulePath(raw: string): string | null {
  if (raw === '') return ''
  if (raw.includes('\\') || raw.includes('\u0000')) return null
  const stripped = raw.startsWith('/') ? raw.slice(1) : raw
  const parts = stripped.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) return null
  return parts.join('/')
}

function pathInWhitelist(normalized: string): boolean {
  if (normalized === '') return true // 根列目录（ls 默认 / 等）——两根顶层列表无内容访问
  if (PATH_WHITELIST_ROOTS.includes(normalized)) return true
  return PATH_WHITELIST_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export const RULE_PATH_WHITELIST = 'path_whitelist'

export function filePathVerdict(args: Record<string, unknown>): RuleVerdict {
  const values: unknown[] = []
  let sawParam = false
  for (const key of FILE_PATH_PARAM_NAMES) {
    if (!(key in args)) continue
    sawParam = true
    values.push(args[key])
  }
  // 缺省/根列目录（ls 默认 / 等）视为命中——两根顶层列表无内容访问（决策注释见测试）。
  if (!sawParam) return { kind: 'allow', rule: RULE_PATH_WHITELIST }
  for (const v of values) {
    if (v === null || v === undefined) continue // 视同缺省
    if (typeof v !== 'string') return { kind: 'pass' } // 畸形 → 灰区
    const normalized = normalizeRulePath(v)
    if (normalized === null) return { kind: 'pass' } // 非法路径（.. 段等）不放行
    if (!pathInWhitelist(normalized)) return { kind: 'pass' }
  }
  return { kind: 'allow', rule: RULE_PATH_WHITELIST }
}

// ---------------------------------------------------------------------------
// 命令黑名单（§1.3）：shell 词法解析（shell-quote）+ 命令替换/子壳/列表递归拆解为简单命令，
// 逐一判定「命令名 + 危险 flag 组合」。纯子串匹配被否决——grep "rm -rf" 不得拦。
// fork bomb 是跨 token 语法形态，按已知模式正则匹配原始串（§1.3 #3）。
// ---------------------------------------------------------------------------

interface SimpleCommand {
  readonly name: string
  readonly args: readonly string[]
}

const SEGMENT_OPS = new Set([';', '|', '&&', '||', '&', '(', ')'])

// 从字符串 token 内提取命令替换片段（双引号内的 $(…)/反引号——shell-quote 不展开引号内
// 替换，留原串）：按 ` 与 $( 配对截取，交递归解析。单引号内替换不执行，但词法层不区分
// 引号语义——误差方向是多判（内容再过一遍黑名单，需全规则命中才拒），无放行风险。
function extractSubstitutions(text: string): string[] {
  const out: string[] = []
  const re = /`([^`]*)`|\$\(([^)]*)\)/g
  for (const m of text.matchAll(re)) {
    const inner = m[1] ?? m[2] ?? ''
    if (inner.trim() !== '') out.push(inner)
  }
  return out
}

function decompose(raw: string, depth: number, out: SimpleCommand[]): void {
  if (depth > SHELL_PARSE_MAX_DEPTH) return
  let tokens: unknown[]
  try {
    tokens = parse(raw) as unknown[]
  } catch {
    return
  }
  let current: string[] = []
  const flush = (): void => {
    if (current.length > 0) out.push(segmentCommand(current, depth, out))
    current = []
  }
  for (const tok of tokens) {
    if (typeof tok === 'string') {
      for (const sub of extractSubstitutions(tok)) decompose(sub, depth + 1, out)
      current.push(tok)
      continue
    }
    const op = (tok as { op?: unknown }).op
    if (typeof op === 'string' && SEGMENT_OPS.has(op)) {
      flush()
      continue
    }
    if (op === 'glob' && typeof (tok as { pattern?: unknown }).pattern === 'string') {
      // shell-quote 把未引用的 glob（如 rm -rf /*）折叠为 {op:'glob',pattern}——还原字面，
      // 否则根级展开目标在判定面隐形。
      current.push((tok as { pattern: string }).pattern)
      continue
    }
    // 其余 op 形态按普通 token 保留
    current.push(typeof op === 'string' ? op : String(tok))
  }
  flush()
}

// 一段 token 流 → 简单命令（剥 VAR= 赋值前缀；段内替换已递归展开）。
function segmentCommand(tokens: string[], depth: number, out: SimpleCommand[]): SimpleCommand {
  // 反引号替换跨 token（shell-quote 保留 `` ` `` 于串内，如 ['`rm','-rf','/`']）——按空格
  // 重join后成对提取，交递归解析；提取内容须完整命中黑名单规则才拒，误差方向安全。
  const joined = tokens.join(' ')
  for (const sub of extractSubstitutions(joined)) decompose(sub, depth + 1, out)
  let start = 0
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!)) start += 1
  const rest = tokens.slice(start)
  return { name: rest[0] ?? '', args: rest.slice(1) }
}

function basename(name: string): string {
  const i = name.lastIndexOf('/')
  return i >= 0 ? name.slice(i + 1) : name
}

// rm 目标归一：去尾 '/*'（根级展开）、去根 '/'、去尾 '/'，循环至稳定后与受保护族比对。
function protectedRmTarget(target: string): boolean {
  let t = target
  for (;;) {
    if (t.endsWith('/*')) t = t.slice(0, -2)
    else if (t.startsWith('/')) t = t.slice(1)
    else if (t.endsWith('/')) t = t.slice(0, -1)
    else break
  }
  return RM_PROTECTED_TARGETS.includes(t)
}

function hasRecursiveFlag(args: readonly string[]): boolean {
  return args.some((a) => {
    if (!a.startsWith('-') || a === '-' || a === '--') return false
    if (a.startsWith('--')) return a === '--recursive'
    return a.includes('r') || a.includes('R')
  })
}

export function commandVerdict(command: string): RuleVerdict {
  if (typeof command !== 'string' || command.trim() === '') return { kind: 'pass' }
  // 规则③ fork bomb：原始串正则（跨 token 形态，词法拆解后不可判定）
  for (const re of FORK_BOMB_PATTERNS) {
    if (re.test(command)) {
      return {
        kind: 'deny',
        rule: SHELL_RULE_FORK_BOMB,
        reason: '命令命中 fork bomb 模式（自我复制进程炸弹），已被确定性拒绝。请说明真实意图后换用常规命令。',
      }
    }
  }
  const cmds: SimpleCommand[] = []
  decompose(command, 0, cmds)
  for (const c of cmds) {
    const name = basename(c.name)
    // 规则① rm 递归删根族
    if (name === 'rm' && hasRecursiveFlag(c.args) && c.args.some((a) => !a.startsWith('-') && protectedRmTarget(a))) {
      return {
        kind: 'deny',
        rule: SHELL_RULE_RM,
        reason: 'rm 递归删除根/系统目录被拒绝（受保护目标族）。请改为删除具体文件或子目录。',
      }
    }
    // 规则② 设备写
    const deviceWrite =
      (name === 'dd' && c.args.some((a) => /^of=\/dev\//.test(a))) ||
      name.startsWith('mkfs') ||
      DEVICE_WRITE_COMMANDS.slice(1).includes(name)
    if (deviceWrite) {
      return {
        kind: 'deny',
        rule: SHELL_RULE_DEVICE_WRITE,
        reason: '设备写命令（dd of=/dev、mkfs、fdisk 等）被拒绝——沙箱内无此权限且有系统破坏风险。',
      }
    }
    // 规则④ 容器逃逸
    const socketHit =
      c.args.some((a) => DOCKER_SOCK_MARKERS.some((m) => a.includes(m))) ||
      DOCKER_SOCK_MARKERS.some((m) => c.name.includes(m))
    if (socketHit || CONTAINER_ESCAPE_COMMANDS.includes(name)) {
      return {
        kind: 'deny',
        rule: SHELL_RULE_CONTAINER_ESCAPE,
        reason: '访问容器运行时控制面（docker.sock / nsenter）被拒绝——容器逃逸是确定性禁止动作。',
      }
    }
  }
  return { kind: 'pass' }
}

// ---------------------------------------------------------------------------
// 工具调用 hash（§2.6）：同 hash = 工具名 + 规范化参数（键序归一 JSON）的 sha256。
// ---------------------------------------------------------------------------

export function toolCallHash(toolName: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(`${toolName}\u0000${canonicalArgsJson(args)}`).digest('hex')
}

// 规范化参数 JSON（键序归一）——hash 身份与审计 toolCall 快照共用同一形态。
export function canonicalArgsJson(args: Record<string, unknown>): string {
  return canonicalJson(args)
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}
