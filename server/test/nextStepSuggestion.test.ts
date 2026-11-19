import { describe, expect, it } from 'vitest'
import { suggestionContext } from '../src/sessions/nextStepSuggestion'
import { nextStepTextSchema } from '../src/validation/schemas'

describe('#1037 建议生成契约', () => {
  it('短轮次保持原文；长轮次按码点保留两侧首尾并标明截断', () => {
    expect(suggestionContext('请求', '回答')).toEqual({ user: '请求', answer: '回答' })
    const context = suggestionContext('😀'.repeat(7000), '终'.repeat(9000))
    expect(Array.from(context.user + context.answer)).toHaveLength(12_000)
    expect(context.user).toBe('😀'.repeat(2997) + '…[已截断]…' + '😀'.repeat(2996))
    expect(context.answer).toBe('终'.repeat(2997) + '…[已截断]…' + '终'.repeat(2996))
    const unbalanced = suggestionContext('短请求', '长'.repeat(14000))
    expect(unbalanced.user).toBe('短请求')
    expect(Array.from(unbalanced.user + unbalanced.answer)).toHaveLength(12_000)
  })
  it('空结果成功；去首尾空白、按码点校验单行纯文本，不截短非法结果', () => {
    expect(nextStepTextSchema.parse('  ')).toBe('')
    expect(nextStepTextSchema.parse(' 请验证假说 ')).toBe('请验证假说')
    expect(nextStepTextSchema.safeParse('😀'.repeat(120)).success).toBe(true)
    for (const invalid of ['😀'.repeat(121), '请分析\n请实验', '# 下一步', '**请分析**', '下一步建议：请分析', '“请分析”', '_请设计实验_', '~~请设计实验~~', '[请分析](https://x)']) {
      expect(nextStepTextSchema.safeParse(invalid).success, invalid).toBe(false)
    }
  })
})
