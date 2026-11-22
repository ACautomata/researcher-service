// #1088 评测输入的真实存储/执行接缝，不对脚本模型输出作语义评分。
import { describe, it, expect } from 'vitest'
import data from './fixtures/reflection-analysis.json'
import { AnalysisCaseSchema, createAnalysisFixture } from '../scripts/acceptance/reflection-fixtures'

describe('RF09/RF19/RF22 固定分析场景可复现状态', () => {
  it.each(data.cases)('$id 的历史权限、已有经验、截断与恢复状态实际生效', async raw => {
    const item = AnalysisCaseSchema.parse(raw)
    const f = await createAnalysisFixture(item)
    try {
      const read = await f.history.execute(f.context, { operation: 'read', targets: [{ session_id: f.past.id }] })
      if (item.setup.access === 'own') {
        expect(read.outcome, JSON.stringify(read)).toBe('success')
        expect(JSON.stringify(read)).toContain(item.setup.experience === 'invalid' ? '原消息已更正：这条旧经验的支撑不再有效。' : item.setup.source)
        if (item.setup.truncated) expect(JSON.stringify(read)).toContain('source_truncated')
      } else {
        expect(read.groups[0]?.error?.code).toBe('unreadable')
        expect(JSON.stringify(read)).not.toContain(item.setup.source)
      }
      const experience = await f.reflection.service.execute(f.context, { operation: 'search' })
      expect(experience.outcome, JSON.stringify(experience)).toBe('success')
      expect(experience.count).toBe(['active', 'conflicting'].includes(item.setup.experience) ? 1 : 0)
      if (item.setup.experience === 'invalid') {
        const managed = await f.reflection.service.execute({ ...f.context, managementIntent: true }, { operation: 'read', purpose: 'management', targets: [{ record_id: f.priorRecordIds[0] }] })
        expect(managed.records).toMatchObject([{ evidence_status: 'review_required' }])
      }
      expect(await f.reflection.store.analysisCompleted(f.context)).toBe(item.setup.completedEpisode)
    } finally { await f.dispose() }
  }, 30_000)
})
