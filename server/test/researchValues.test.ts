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
  BUCKETS_FIXED,
  BUCKETS_OPT_IN,
  IDEA_CANDIDATES_MIN,
  IDEA_CANDIDATES_MAX,
  IDEA_CANDIDATES_SCHEMA_MAX,
  CHALLENGE_CARDS_MAX,
  CONTEXT_PACK_SEARCH_LIMIT,
  EVIDENCE_EXCERPT_MAX_CHARS,
  TARGET_PROBLEM_MIN_CHARS,
  MIN_EXPERIMENT_WARN_CHARS,
  IDEA_ANCHORS_MAX,
  PLAN_TEXT_MAX_CHARS,
  SPEC_DELIVERABLES_MAX,
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

  it('W3 常量表字面值锁定（#911 · 853 §4.3）：桶档位 / 候选数 / 挑战上界 / 检索与节选 / 校验阈值', () => {
    expect(BUCKETS_FIXED).toEqual(['gap', 'contradiction', 'failure', 'transfer', 'constraint'])
    expect(BUCKETS_OPT_IN).toEqual(['ablation', 'metric', 'assumption-challenge'])
    // 固定 5 + opt-in 3 = BUCKETS_MAX（853 §4.3 桶档位钉面）
    expect(BUCKETS_FIXED.length + BUCKETS_OPT_IN.length).toBe(BUCKETS_MAX)
    expect(IDEA_CANDIDATES_MIN).toBe(1)
    expect(IDEA_CANDIDATES_MAX).toBe(3)
    expect(IDEA_CANDIDATES_SCHEMA_MAX).toBe(5)
    // challenge 逐卡上界 = 桶 ≤8 × 每桶 ≤3 = 24（853 §4.3 ≤35 口径面：classify 1 + brief 1 + 桶 8 + challenge 24 ≈ 34）
    expect(CHALLENGE_CARDS_MAX).toBe(BUCKETS_MAX * IDEA_CANDIDATES_MAX)
    expect(CONTEXT_PACK_SEARCH_LIMIT).toBe(10)
    expect(EVIDENCE_EXCERPT_MAX_CHARS).toBe(4_000)
    // validate_idea_cards.py 字面迁移阈值（#848 §3.3）
    expect(TARGET_PROBLEM_MIN_CHARS).toBe(30)
    expect(MIN_EXPERIMENT_WARN_CHARS).toBe(20)
    expect(IDEA_ANCHORS_MAX).toBe(4)
    // W4（#912）：plan.text 内联「几 KB 载荷」面（16k chars ≈ 8k tokens——审批卡渲染可承受）；
    // 交付物声明件数硬上限（对账逐件处理防失控值）。
    expect(PLAN_TEXT_MAX_CHARS).toBe(16_000)
    expect(SPEC_DELIVERABLES_MAX).toBe(20)
  })
})
