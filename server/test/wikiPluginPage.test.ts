// #908 S3 纯逻辑：插件建页的 wiki 域核心组装（853 §3.3 · §11.3C 拍板字段集）——
// frontmatter 组装 + 页内 Atomic Claims 块渲染 + PageDraft/ClaimDraft zod DTO。
// 页格式单源（四流程建页格式一致，853 §3.3）：插件零格式知识，只给 PageDraft 元数据。
// 断言独立真源 = 853 §11.3C 字段集 + wiki/logic FrontmatterParser/okfBadge 真实消费面
// （徽章面「直接有数据」的往返锁定——#789 数据面）。

import { describe, it, expect } from 'vitest'
import {
  assemblePageMarkdown,
  renderAtomicClaimsBlock,
  GENERATED_STALE_AFTER_MS,
  PluginPageDraftSchema,
  PluginClaimDraftSchema,
} from '../src/wiki/pluginPage'
import { FrontmatterParser, okfBadge } from '../src/wiki/logic'

const NOW = Date.parse('2026-10-11T08:00:00Z')

const DRAFT = {
  path: 'papers/attention-survey.md',
  title: 'Attention 综述研读',
  type: 'paper' as const,
  content: '# 正文\n\n插件给出的正文。',
  claims: [
    { statement: 'Attention 机制是 Transformer 的核心。', evidence: ['repo://sources/attention.md#L10-L20'] },
    { statement: '第二论断。', evidence: ['repo://sources/b.md#L1-L3', 'repo://sources/c.md#L5-L9'] },
  ],
}

describe('frontmatter 核心组装（853 §3.3 · §11.3C 字段集）', () => {
  it('字段集齐全：type/title + OKF 徽章三件 + source/toolCallId/workflow/related_pages', () => {
    const md = assemblePageMarkdown({
      draft: DRAFT,
      source: 'research',
      toolCallId: 'tc-123',
      workflow: 'ingest',
      relatedPages: ['papers/a.md', 'papers/b.md'],
      now: NOW,
    })
    // 逐行字面断言（独立真源 = 规格字段集，不自造渲染器对拍）
    expect(md).toContain('type: paper')
    expect(md).toContain('title: "Attention 综述研读"')
    expect(md).toContain('status: generated')
    expect(md).toMatch(/stale_after: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/)
    expect(md).toMatch(/generated: \{by: "research", at: "\d{4}-\d{2}-\d{2}T[^"]+"\}/)
    expect(md).toContain('source: "research"')
    expect(md).toContain('toolCallId: "tc-123"')
    expect(md).toContain('workflow: "ingest"')
    expect(md).toContain('related_pages: ["papers/a.md", "papers/b.md"]')
    // 正文原样保留（内容忠实，不裁剪不改写）
    expect(md).toContain('# 正文\n\n插件给出的正文。')
  })

  it('wiki 消费面往返：FrontmatterParser 读出 title/related_pages，okfBadge 读出徽章三件', () => {
    const md = assemblePageMarkdown({
      draft: DRAFT,
      source: 'research',
      toolCallId: 'tc-123',
      workflow: 'discover',
      relatedPages: ['papers/a.md'],
      now: NOW,
    })
    const { frontmatter } = new FrontmatterParser().parse(md)
    expect(frontmatter['title']).toBe('Attention 综述研读')
    expect(frontmatter['type']).toBe('paper')
    expect(frontmatter['related_pages']).toEqual(['papers/a.md'])
    const badge = okfBadge(md)
    expect(badge?.status).toBe('generated')
    expect(badge?.staleAfter).toBe(new Date(NOW + GENERATED_STALE_AFTER_MS).toISOString())
    expect(badge?.generatedAt).toBe(new Date(NOW).toISOString())
  })

  it('stale_after = 生成时刻 + 180 天（显式 UTC 偏移 Z 形态，openwiki 日历校验可过）', () => {
    const md = assemblePageMarkdown({ draft: DRAFT, source: 'research', now: NOW })
    const badge = okfBadge(md)
    expect(badge?.staleAfter).toBe('2027-04-09T08:00:00.000Z')
  })

  it('可选溯源缺省省略：toolCallId/workflow/related_pages 不传则字段不落', () => {
    const md = assemblePageMarkdown({ draft: DRAFT, source: 'research', now: NOW })
    expect(md).not.toContain('toolCallId:')
    expect(md).not.toContain('workflow:')
    expect(md).not.toContain('related_pages:')
    expect(md).toContain('source: "research"')
  })

  it('source 盖章 = 调用方插件 id（frontmatter source 与 generated.by 同源）', () => {
    const md = assemblePageMarkdown({ draft: DRAFT, source: 'rknow', now: NOW })
    expect(md).toContain('source: "rknow"')
    expect(md).toContain('generated: {by: "rknow"')
  })
})

describe('页内 Atomic Claims md 块渲染（表示归 wiki 域 · V1 人读面）', () => {
  it('ClaimDraft[] → 确定性 md 块：statement 主 bullet + evidence 子 bullet', () => {
    expect(renderAtomicClaimsBlock(DRAFT.claims!)).toBe(
      [
        '## Atomic Claims',
        '',
        '- Attention 机制是 Transformer 的核心。',
        '  - Evidence: `repo://sources/attention.md#L10-L20`',
        '- 第二论断。',
        '  - Evidence: `repo://sources/b.md#L1-L3`',
        '  - Evidence: `repo://sources/c.md#L5-L9`',
      ].join('\n'),
    )
  })

  it('空 claims → 空串（页内无 Atomic Claims 节）', () => {
    expect(renderAtomicClaimsBlock([])).toBe('')
    const md = assemblePageMarkdown({ draft: { ...DRAFT, claims: undefined }, source: 'research', now: NOW })
    expect(md).not.toContain('## Atomic Claims')
  })

  it('claims 经 assemblePageMarkdown 附在正文之后', () => {
    const md = assemblePageMarkdown({ draft: DRAFT, source: 'research', now: NOW })
    const bodyIdx = md.indexOf('# 正文')
    const claimsIdx = md.indexOf('## Atomic Claims')
    expect(claimsIdx).toBeGreaterThan(bodyIdx)
  })

  it('workflow 形态校验：小写 kebab/snake 放行，大写/越界字符拒（frontmatter 垃圾值防线）', () => {
    for (const ok of ['ingest', 'discover', 'hypothesize', 'experiment', 'idea-card', 'w4_report']) {
      expect(() => assemblePageMarkdown({ draft: DRAFT, source: 'research', workflow: ok, now: NOW })).not.toThrow()
    }
    for (const bad of ['Ingest', 'INGEST', 'a'.repeat(33), 'has space', 'x:y']) {
      expect(() => assemblePageMarkdown({ draft: DRAFT, source: 'research', workflow: bad, now: NOW })).toThrow(/workflow/)
    }
  })
})

describe('PageDraft/ClaimDraft zod DTO（853 §3.2 · 图内校验与 port 边界同构）', () => {
  it('PageType 枚举值集 = 论文页/ critic 页/ idea-card/ 实验报告（§11.3C）', () => {
    for (const t of ['paper', 'critic', 'idea-card', 'experiment-report']) {
      expect(PluginPageDraftSchema.safeParse({ ...DRAFT, type: t }).success).toBe(true)
    }
    for (const bad of ['Paper', 'experiment_report', 'report', '']) {
      expect(PluginPageDraftSchema.safeParse({ ...DRAFT, type: bad }).success).toBe(false)
    }
  })

  it('形状校验：statement/evidence/path/title/content 必填非空，claims 可选', () => {
    expect(PluginPageDraftSchema.safeParse({ ...DRAFT, claims: [] }).success).toBe(true)
    expect(PluginPageDraftSchema.safeParse({ ...DRAFT, claims: undefined }).success).toBe(true)
    expect(PluginPageDraftSchema.safeParse({ ...DRAFT, path: '' }).success).toBe(false)
    expect(PluginPageDraftSchema.safeParse({ ...DRAFT, title: '' }).success).toBe(false)
    expect(PluginPageDraftSchema.safeParse({ ...DRAFT, content: '' }).success).toBe(false)
    expect(PluginPageDraftSchema.safeParse({ ...DRAFT, claims: [{ statement: '', evidence: [] }] }).success).toBe(false)
    expect(PluginPageDraftSchema.safeParse({ ...DRAFT, claims: [{ statement: 'x', evidence: [''] }] }).success).toBe(false)
    expect(PluginClaimDraftSchema.safeParse({ statement: 'x', evidence: [] }).success).toBe(true)
  })
})

describe('常量字面锁定', () => {
  it('GENERATED_STALE_AFTER_MS = 180 天（生成页陈旧地平线平台策略值）', () => {
    expect(GENERATED_STALE_AFTER_MS).toBe(180 * 24 * 60 * 60 * 1000)
  })
})
