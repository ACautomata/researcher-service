// 插件建页的 wiki 域核心组装（#908 · 853 §3.3「frontmatter = 核心组装产出」· §11.3C 拍板字段集）。
// 纯逻辑零 IO：assemblePageMarkdown（frontmatter 组装）+ renderAtomicClaimsBlock（页内
// Atomic Claims md 块渲染）+ PageDraft/ClaimDraft zod DTO。页格式单源——四流程建页格式一致
// （防四套模板四个样），插件零格式知识；claims 表示归 wiki 域（插件不知道 .claims 旁车存在）。
//
// frontmatter 字段集（§11.3C · B1 拍板修订）：type/title + OKF 徽章三件（status=draft /
// stale_after / generated{by,at} 时间戳）+ 溯源（source=调用插件 id / toolCallId / workflow）+
// related_pages。status 取 openwiki 合法值集（OKF_STATUS_VALUES=[draft,stable,deprecated]）
// 的 'draft'——生成页进治理 validate/repair 不被摘 status 件（'generated' 非法值会触发
// invalid_status）；「插件生成」语义由 generated{by,at} + source 承载。
// 徽章值形态对齐 openwiki 校验面（okf/frontmatter.ts）：ISO 8601 显式 UTC 偏移（Z），
// generated 单行 flow mapping（JSON-quoted 成员，openwiki setGeneratedEvent 同形）——
// wiki/logic okfBadge 的徽章面直接有数据由 wikiPluginPage.test.ts 往返锁定，openwiki
// validateOkfFrontmatter 直调过验同测锁定。

import { z } from 'zod'
import {
  PLUGIN_PAGE_TYPES,
  type PluginClaimDraft,
  type PluginPageDraft,
  type PluginPageProvenance,
  type PluginPageType,
} from '../plugins/api'
import { GENERATED_STALE_AFTER_MS, PAGE_DRAFT_MAX } from '../../../plugins/research/values'
import { PATH_MAX } from './paths'
import { WIKI_CATEGORIES } from './values'

// PageDraft DTO 尺寸上限的 path 件：values 表不辖 path（wiki 域单源 PATH_MAX），
// 组合进本域 PAGE_DRAFT_MAX 消费形态。
const DRAFT_MAX = { ...PAGE_DRAFT_MAX, pathChars: PATH_MAX } as const

// 四流程名形态（W1–W4 枚举 #909 定稿前先锁小写 kebab/snake，防 frontmatter 垃圾值）。
const WORKFLOW_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/

// type → category 一一映射（#949 spec §1.2：paper→论文 / critique→科学问题 / hypothesis→假说 /
// report→实验报告）。核心组装单点写入（口径归一 R2）——四流程建页格式单源、插件零格式知识
//（853 §3.3「插件只给 PageDraft 元数据」不被触及）；Record<PluginPageType, ...> 使枚举扩值时
// 漏映射 typecheck 即红。
const TYPE_CATEGORY: Record<PluginPageType, (typeof WIKI_CATEGORIES)[number]> = {
  paper: '论文',
  critique: '科学问题',
  hypothesis: '假说',
  report: '实验报告',
}

export const PluginClaimDraftSchema: z.ZodType<PluginClaimDraft> = z.object({
  statement: z.string().min(1),
  evidence: z.array(z.string().min(1)).max(DRAFT_MAX.evidencePerClaim),
})

export const PluginPageDraftSchema: z.ZodType<PluginPageDraft> = z.object({
  path: z.string().min(1).max(DRAFT_MAX.pathChars),
  title: z.string().min(1).max(DRAFT_MAX.titleChars),
  type: z.enum(PLUGIN_PAGE_TYPES),
  content: z.string().min(1).max(DRAFT_MAX.contentChars),
  claims: z.array(PluginClaimDraftSchema).max(DRAFT_MAX.claims).optional(),
})

// createPage 溯源面 zod（port 边界校验，非法 → Result error.code='invalid_draft'）——
// workflow 形态单点在此，组装层信任已验输入不再重复判（插件页错误通道归 runner/wikiToolPort，
// wiki 域纯逻辑不反向依赖）。
export const PluginPageProvenanceSchema: z.ZodType<PluginPageProvenance> = z.object({
  workflow: z.string().regex(WORKFLOW_SHAPE).optional(),
  relatedPages: z.array(z.string().min(1)).optional(),
})

export interface AssembledPageInput {
  readonly draft: PluginPageDraft
  /** 溯源 source 盖章 = 调用插件 id（与 generated.by 同源）。 */
  readonly source: string
  /** 调用方 run 的真实 tool_call_id（filejournal ALS）；缺省省略字段。 */
  readonly toolCallId?: string
  /** 四流程名（W1–W4；形态由 PluginPageProvenanceSchema 在 port 边界锁定，本组装信任已验输入）。 */
  readonly workflow?: string
  readonly relatedPages?: readonly string[]
  /** ms 时间戳（注入时钟——RunService deps.clock 穿线，测试步进钟锁定徽章值）。 */
  readonly now: number
}

// frontmatter + 正文 + claims 块拼装。标量引用形态对齐 openwiki setFrontmatterField
// （JSON-quoted，YAML 特殊字符安全）；枚举态（type/status/source）裸值保人读面。
export function assemblePageMarkdown(input: AssembledPageInput): string {
  const { draft } = input
  const generatedAt = new Date(input.now).toISOString()
  const staleAfter = new Date(input.now + GENERATED_STALE_AFTER_MS).toISOString()
  const fm: string[] = [
    `type: ${draft.type}`,
    // category 按 type 单点映射（中文值域枚举态裸值，与 type/status/source 同款保人读面）。
    `category: ${TYPE_CATEGORY[draft.type]}`,
    `title: ${JSON.stringify(draft.title)}`,
    // B1 拍板：status 用 openwiki 合法值集的 'draft'——'generated' 不在 OKF_STATUS_VALUES，
    // 治理 validate 必摘（invalid_status）；生成溯源由 generated{by,at} + source 承载。
    'status: draft',
    `stale_after: ${JSON.stringify(staleAfter)}`,
    `generated: {by: ${JSON.stringify(input.source)}, at: ${JSON.stringify(generatedAt)}}`,
    // source 同 generated.by 引号化（JSON.stringify）——不依赖注册期 kebab 校验这层外的
    // 防线：YAML 特殊字符（冒号/# 等）进 frontmatter 必须本地安全。FrontmatterParser/
    // okfBadge 的 stripQuotes 对引号值透明。
    `source: ${JSON.stringify(input.source)}`,
  ]
  if (input.toolCallId !== undefined) fm.push(`toolCallId: ${JSON.stringify(input.toolCallId)}`)
  if (input.workflow !== undefined) fm.push(`workflow: ${JSON.stringify(input.workflow)}`)
  if (input.relatedPages !== undefined && input.relatedPages.length > 0) {
    fm.push(`related_pages: [${input.relatedPages.map((p) => JSON.stringify(p)).join(', ')}]`)
  }
  const claims = renderAtomicClaimsBlock(draft.claims ?? [])
  return `---\n${fm.join('\n')}\n---\n\n${draft.content}${claims === '' ? '' : `\n\n${claims}`}`
}

// ClaimDraft[] → 页内 Atomic Claims md 块（V1 人读面 + 检索面可溯源：evidence 引用串
// 是溯源锚）。statement 主 bullet、evidence 子 bullet（反引号代码 span）；空数组 → 空串
// （页内无此节——「无 claims」与「claims 空表」同形，防空节噪声）。
// 渲染面消毒（格式唯一产出点单点承担，zod 不 ban 合法内容）：statement 折叠换行为空格
// （换行可伪造 `##` 节/重复本节/bullet——md 结构注入）；evidence 另剥反引号（code span 断裂面）。
export function renderAtomicClaimsBlock(claims: readonly PluginClaimDraft[]): string {
  if (claims.length === 0) return ''
  const collapseNewlines = (s: string): string => s.replace(/\r?\n/g, ' ')
  const lines: string[] = ['## Atomic Claims', '']
  for (const c of claims) {
    lines.push(`- ${collapseNewlines(c.statement)}`)
    for (const ev of c.evidence) lines.push(`  - Evidence: \`${collapseNewlines(ev).replaceAll('`', '')}\``)
  }
  return lines.join('\n')
}
