// #853 §7.1 常量表两层锁定（#909）：字面数字行为锁定 + 归口单源导入断言（approval values 先例）。
// values.ts 是科研工作流插件全部护栏数字的单一来源——测试锁字面值，防实现漂移 silently 改语义。
import { describe, expect, it } from 'vitest'
import {
  MIN_CONFIDENCE,
  CONTEXT_PACK_BUDGET_TOKENS,
  PAGE_OUTPUT_MAX_TOKENS,
  PAGE_GENERATE_MAX_RETRIES,
  BUCKETS_MAX,
  PLAN_REVIEW_MAX_ROUNDS,
  PDF_EXTRACT_MAX_CHARS,
  GENERATED_STALE_AFTER_MS,
  PAGE_DRAFT_MAX,
  SOURCE_PATHS_V1_MAX,
  SUMMARY_MAX_CHARS,
  CRITIC_CANDIDATES_MIN,
  CRITIC_CANDIDATES_MAX,
  CRITIC_CANDIDATES_SCHEMA_MAX,
  RESOLVE_INPUTS_SEARCH_LIMIT,
  PAPER_PAGE_MIN_LINES,
} from '../../plugins/research/values'

describe('research values 常量表（853 §7.1 · #909）', () => {
  it('七件字面值锁定', () => {
    expect(MIN_CONFIDENCE).toBe(0.6)
    expect(CONTEXT_PACK_BUDGET_TOKENS).toBe(16_000)
    expect(PAGE_OUTPUT_MAX_TOKENS).toBe(32_000)
    expect(PAGE_GENERATE_MAX_RETRIES).toBe(1)
    expect(BUCKETS_MAX).toBe(8)
    expect(PLAN_REVIEW_MAX_ROUNDS).toBe(3)
    expect(PDF_EXTRACT_MAX_CHARS).toBe(1_000_000)
  })

  it('PR #917 review 归口常量字面值锁定（单源/阈值/过滤面）', () => {
    expect(SOURCE_PATHS_V1_MAX).toBe(1)
    expect(SUMMARY_MAX_CHARS).toBe(1000)
    expect(CRITIC_CANDIDATES_MIN).toBe(2)
    expect(CRITIC_CANDIDATES_MAX).toBe(4)
    expect(CRITIC_CANDIDATES_SCHEMA_MAX).toBe(10)
    expect(RESOLVE_INPUTS_SEARCH_LIMIT).toBe(5)
    expect(PAPER_PAGE_MIN_LINES).toBe(100)
  })

  it('MIN_CONFIDENCE 阈值行为锚点（#866 定标：0.60 恰放行，0.55 坏放行档拒入）', () => {
    // 阈值语义 = confidence < MIN_CONFIDENCE 拦：0.60 与 0.99 放行、0.59/0.55 拦。
    expect(0.6 < MIN_CONFIDENCE).toBe(false)
    expect(0.59 < MIN_CONFIDENCE).toBe(true)
    expect(0.55 < MIN_CONFIDENCE).toBe(true)
  })

  it('GENERATED_STALE_AFTER_MS = 180 天（生成页陈旧地平线，#908 复审 B3 拍板）', () => {
    expect(GENERATED_STALE_AFTER_MS).toBe(180 * 24 * 60 * 60 * 1000)
  })

  it('PAGE_DRAFT_MAX 尺寸边界（853 §7.1 拍板 B5）', () => {
    expect(PAGE_DRAFT_MAX.titleChars).toBe(512)
    expect(PAGE_DRAFT_MAX.contentChars).toBe(2_000_000)
    expect(PAGE_DRAFT_MAX.claims).toBe(100)
    expect(PAGE_DRAFT_MAX.evidencePerClaim).toBe(20)
  })
})
