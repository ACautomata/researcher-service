// Skill 市场运行时接入（#1057 C 票 · #1054 D4）：已启用 skill 进 agent 运行时的三件——
// 目录快照（system prompt 注入面）+ `read_skill` 渐进披露工具 + 图缓存键目录版本。
// 机制与常数复用 #787 已验证形态（目录 ≤4KB / 正文 ≤64KB，常数在 A 票 values.ts 预留）。
//
// 注入纪律（#1057）：skill 内容是数据面——目录行单行化（剥换行，防 prompt 结构破坏）；
// 正文原样披露（注入滥用 → D1 演进点待审闸门，不在此清洗）。工具面 Result 信封永不 throw
//（wikiToolPort B4 纪律同源——结构化错误回喂，reject 回喂同哲学）。

import { createHash } from 'node:crypto'
import { tool, type DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { PrismaClient } from '../generated/prisma/client'
import { SKILL_BODY_MAX_BYTES, SKILL_CATALOG_MAX_BYTES, SKILL_MANIFEST_PATH } from './values'

// ---------------------------------------------------------------------------
// 目录快照（prompt 注入面 + 图缓存版本因子）
// ---------------------------------------------------------------------------

export interface SkillCatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly sha256: string
}

export interface SkillCatalog {
  readonly entries: readonly SkillCatalogEntry[]
  /** 目录版本 = {id,name,sha256} 稳定序 JSON 的 sha256——启用集或内容变更 → 图重建。 */
  readonly version: string
}

// 加载启用 skill 的市场目录行（published-only；启用后被删的 id 自然缺行——目录与工具面都
// 不含它，read_skill 侧同样拒绝）。排序 = name 主序（全局唯一）+ id 破并列，稳定可复现。
export async function loadSkillCatalog(prisma: PrismaClient, enabledSkillIds: readonly string[]): Promise<SkillCatalog> {
  if (enabledSkillIds.length === 0) return { entries: [], version: '' }
  const rows = await prisma.skillPackage.findMany({
    where: { id: { in: [...enabledSkillIds] }, status: 'published' },
    select: { id: true, name: true, description: true, sha256: true },
  })
  const entries = rows
    .map((row) => ({ id: row.id, name: row.name, description: row.description, sha256: row.sha256 }))
    .sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1
      if (a.id !== b.id) return a.id < b.id ? -1 : 1
      return 0
    })
  const version = createHash('sha256')
    .update(JSON.stringify(entries.map((entry) => ({ id: entry.id, name: entry.name, sha256: entry.sha256 }))))
    .digest('hex')
  return { entries, version }
}

// 单行化：剥换行并折叠空白（#1057 注入纪律——目录行不得破坏 prompt 分行结构）。
function toSingleLine(text: string): string {
  return text.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim()
}

// 目录快照 prompt 段：`- name (id: xxx): description` 单行目录，整段严格 ≤4KB（超限整行
// 剔除 + 截断标记——行内永不半截；标记自身计入预算：第二遍装配按固定预留收紧，确定性
// 两遍）。name 稳定序保证截断面确定性。空集 = 空串不入拼接（pluginPrompt 先例）。
// id 进目录行是 read_skill 调用前提（模型从目录取 id）。
interface CatalogFit {
  readonly lines: readonly string[]
  readonly dropped: number
}

function fitCatalogLines(entries: readonly SkillCatalogEntry[], budget: number): CatalogFit {
  const lines: string[] = []
  let dropped = 0
  let size = 0
  for (const entry of entries) {
    const line = `- ${entry.name} (id: ${entry.id}): ${toSingleLine(entry.description)}`
    const lineSize = Buffer.byteLength(`\n${line}`, 'utf8')
    if (size + lineSize > budget) {
      dropped += 1
      continue
    }
    size += lineSize
    lines.push(line)
  }
  return { lines, dropped }
}

export function buildSkillCatalogPrompt(rawEntries: readonly SkillCatalogEntry[]): string {
  if (rawEntries.length === 0) return ''
  // name 稳定序（id 破并列）在快照构造器内重排——无论调用方传序如何，目录与截断面确定
  //（loadSkillCatalog 已排序，此处防御性重排使纯函数自足）。
  const entries = [...rawEntries].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })
  const header = 'Enabled skills (load content on demand with the read_skill tool):'
  const first = fitCatalogLines(entries, SKILL_CATALOG_MAX_BYTES)
  if (first.dropped === 0) return [header, ...first.lines].join('\n')
  // 标记行计入预算：固定预留 160 字节（万级 dropped 计数内文案不溢出），第二遍装配后
  // 用第二遍的 dropped 计数出标记——确定性且总量恒 ≤ SKILL_CATALOG_MAX_BYTES。
  const MARKER_RESERVE = 160
  const second = fitCatalogLines(entries, SKILL_CATALOG_MAX_BYTES - MARKER_RESERVE)
  const marker = `- [${second.dropped} more skill(s) omitted: catalog exceeds ${SKILL_CATALOG_MAX_BYTES} bytes]`
  return [header, ...second.lines, marker].join('\n')
}

// ---------------------------------------------------------------------------
// read_skill 渐进披露工具（#1054 D4：≤64KB 正文截断）
// ---------------------------------------------------------------------------

export type SkillReadResult =
  | {
      ok: true
      data: { skillId: string; path: string; mime: string; truncated: boolean; content: string }
    }
  | {
      ok: false
      error: {
        code: 'not_enabled' | 'unknown_skill' | 'unknown_resource' | 'binary_resource'
        message: string
      }
    }

// 正文/资源读取决策面（S3 参数校验矩阵：未启用/未知 skill/未知资源/二进制资源/64KB 截断）。
// enabledSkillIds 是 run 启动快照（per-run 语义：启用集变更不进去飞 run，capabilities 同源）；
// 越权与未启用同判——不在快照集 = 不可读，不区分报错面（防探测）。
export async function readSkillContent(
  prisma: PrismaClient,
  p: { enabledSkillIds: readonly string[]; skillId: string; path?: string },
): Promise<SkillReadResult> {
  if (!p.enabledSkillIds.includes(p.skillId)) {
    return {
      ok: false,
      error: { code: 'not_enabled', message: `skill is not enabled for this run: ${p.skillId}` },
    }
  }
  const pkg = await prisma.skillPackage.findUnique({
    where: { id: p.skillId },
    select: { status: true },
  })
  if (!pkg || pkg.status !== 'published') {
    return {
      ok: false,
      error: { code: 'unknown_skill', message: `skill is no longer available: ${p.skillId}` },
    }
  }
  const path = p.path ?? SKILL_MANIFEST_PATH
  const file = await prisma.skillFile.findUnique({
    where: { packageId_path: { packageId: p.skillId, path } },
    select: { mime: true, size: true, content: true },
  })
  if (!file) {
    // 未知资源回喂附带可用清单（≤20 条，截断标注）——模型可直接换正确路径重试。
    const all = await prisma.skillFile.findMany({
      where: { packageId: p.skillId },
      select: { path: true },
      orderBy: { path: 'asc' },
    })
    const listed = all.slice(0, 20).map((row) => row.path).join(', ')
    const suffix = all.length > 0 ? `; available: ${listed}${all.length > 20 ? ` (+${all.length - 20} more)` : ''}` : ''
    return {
      ok: false,
      error: { code: 'unknown_resource', message: `resource not in skill package: ${path}${suffix}` },
    }
  }
  if (!file.mime.startsWith('text/')) {
    // 渐进披露是文本工具面：二进制资源（图片等）回结构化说明而非字节（工具结果进
    // transcript，二进制垃圾不入对话）——取用走市场下载端点（B 票）。
    return {
      ok: false,
      error: {
        code: 'binary_resource',
        message: `resource is binary (${file.mime}, ${file.size} bytes); only text resources are readable here`,
      },
    }
  }
  const buf = Buffer.from(file.content)
  if (buf.byteLength > SKILL_BODY_MAX_BYTES) {
    // UTF-8 按字节截断（半字符容忍——decode 替换损伤码点），附截断标记。
    const capped = buf.subarray(0, SKILL_BODY_MAX_BYTES).toString('utf8')
    return {
      ok: true,
      data: {
        skillId: p.skillId,
        path,
        mime: file.mime,
        truncated: true,
        content: `${capped}\n\n[skill content truncated to ${SKILL_BODY_MAX_BYTES} bytes]`,
      },
    }
  }
  return {
    ok: true,
    data: { skillId: p.skillId, path, mime: file.mime, truncated: false, content: buf.toString('utf8') },
  }
}

const ReadSkillSchema = z.object({
  skillId: z.string().min(1),
  // 资源参数刻意命名 `resource`（非 path/file_path）：避开漏斗 FILE_PATH_PARAM_NAMES，
  // 包内相对路径不进容器路径白名单判定——read_skill 归 FILE_TOOLS 后规则层零 LLM 直放
  //（openwiki_search/read 先例；approval/values.ts FILE_TOOLS 注释同口径）。
  resource: z.string().min(1).optional(),
})

// read_skill 渐进披露工具（per-run 启用集闭包——工具实例随 run 快照入图，同键必同工具面）。
export function createSkillReadTool(deps: {
  readonly prisma: PrismaClient
  readonly enabledSkillIds: readonly string[]
}): DynamicStructuredTool {
  return tool(
    async ({ skillId, resource }) =>
      JSON.stringify(
        await readSkillContent(deps.prisma, {
          enabledSkillIds: deps.enabledSkillIds,
          skillId,
          ...(resource !== undefined ? { path: resource } : {}),
        }),
      ),
    {
      name: 'read_skill',
      description:
        "Read an enabled skill's content: SKILL.md body by default, or a packaged resource by its path " +
        '(text resources only, truncated at 64KB). Use the skill id exactly as listed in the ' +
        'enabled-skills catalog of your system prompt.',
      schema: ReadSkillSchema,
    },
  )
}
