// 插件建页的 wiki 域核心组装（#908 · 853 §3.3「frontmatter = 核心组装产出」· §11.3C 拍板字段集）。
// 纯逻辑零 IO：assemblePageMarkdown（frontmatter 组装）+ renderAtomicClaimsBlock（页内
// Atomic Claims md 块渲染）+ PageDraft/ClaimDraft zod DTO。页格式单源——四流程建页格式一致
// （防四套模板四个样），插件零格式知识；claims 表示归 wiki 域（插件不知道 .claims 旁车存在）。
//
// frontmatter 字段集（§11.3C）：type/title + OKF 徽章三件（status=generated / stale_after /
// generated{by,at} 时间戳）+ 溯源（source=调用插件 id / toolCallId / workflow）+ related_pages。
// 徽章值形态对齐 openwiki 校验面（okf/frontmatter.ts）：ISO 8601 显式 UTC 偏移（Z），
// generated 单行 flow mapping（JSON-quoted 成员，openwiki setGeneratedEvent 同形）——
// wiki/logic okfBadge 的徽章面直接有数据由 wikiPluginPage.test.ts 往返锁定。

import { z } from 'zod'
import { PLUGIN_PAGE_TYPES, type PluginClaimDraft, type PluginPageDraft } from '../plugins/api'

// 生成页陈旧地平线（stale_after = 生成时刻 + 180 天）：规格未定数值的平台策略值——
// 生成页进治理检索面，徽章面过期标记由此驱动；校准归治理/规格后续票。
export const GENERATED_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000

export const PluginClaimDraftSchema: z.ZodType<PluginClaimDraft> = z.object({
  statement: z.string().min(1),
  evidence: z.array(z.string().min(1)),
})

export const PluginPageDraftSchema: z.ZodType<PluginPageDraft> = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  type: z.enum(PLUGIN_PAGE_TYPES),
  content: z.string().min(1),
  claims: z.array(PluginClaimDraftSchema).optional(),
})

export interface AssembledPageInput {
  readonly draft: PluginPageDraft
  /** 溯源 source 盖章 = 调用插件 id（与 generated.by 同源）。 */
  readonly source: string
  /** 调用方 run 的真实 tool_call_id（filejournal ALS）；缺省省略字段。 */
  readonly toolCallId?: string
  /** 四流程名（W1–W4；#909 骨架票定稿枚举前先锁小写 kebab/snake 形态防 frontmatter 垃圾值）。 */
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
    `title: ${JSON.stringify(draft.title)}`,
    'status: generated',
    `stale_after: ${JSON.stringify(staleAfter)}`,
    `generated: {by: ${JSON.stringify(input.source)}, at: ${JSON.stringify(generatedAt)}}`,
    // source 同 generated.by 引号化（JSON.stringify）——不依赖注册期 kebab 校验这层外的
    // 防线：YAML 特殊字符（冒号/# 等）进 frontmatter 必须本地安全。FrontmatterParser/
    // okfBadge 的 stripQuotes 对引号值透明。
    `source: ${JSON.stringify(input.source)}`,
  ]
  if (input.toolCallId !== undefined) fm.push(`toolCallId: ${JSON.stringify(input.toolCallId)}`)
  if (input.workflow !== undefined) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.workflow)) {
      throw new Error(`workflow 须为小写 kebab/snake 形态（≤32 字符）: ${JSON.stringify(input.workflow)}`)
    }
    fm.push(`workflow: ${JSON.stringify(input.workflow)}`)
  }
  if (input.relatedPages !== undefined && input.relatedPages.length > 0) {
    fm.push(`related_pages: [${input.relatedPages.map((p) => JSON.stringify(p)).join(', ')}]`)
  }
  const claims = renderAtomicClaimsBlock(draft.claims ?? [])
  return `---\n${fm.join('\n')}\n---\n\n${draft.content}${claims === '' ? '' : `\n\n${claims}`}`
}

// ClaimDraft[] → 页内 Atomic Claims md 块（V1 人读面 + 检索面可溯源：evidence 引用串
// 是溯源锚）。statement 主 bullet、evidence 子 bullet（反引号代码_span_）；空数组 → 空串
// （页内无此节——「无 claims」与「claims 空表」同形，防空节噪声）。
export function renderAtomicClaimsBlock(claims: readonly PluginClaimDraft[]): string {
  if (claims.length === 0) return ''
  const lines: string[] = ['## Atomic Claims', '']
  for (const c of claims) {
    lines.push(`- ${c.statement}`)
    for (const ev of c.evidence) lines.push(`  - Evidence: \`${ev}\``)
  }
  return lines.join('\n')
}
