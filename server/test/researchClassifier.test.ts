// #909 S3 纯逻辑：IntentClassifier 生产封装（853 §1.2 · §3.2#3「端口构造在 generateStructured
// 之上」）。文本退化双保险（#866 发现①，120 次零失败）：①prompt 内 JSON 输出约束（本测锁）
// + ②raw 文本通道提取 JSON + zod 校验兜底（核心 parseStructuredOutput 承载，llmToolPort.test
// 已锁——此处以 INTENT_SCHEMA 消费退化通道作锚点）。
import { describe, expect, it, vi } from 'vitest'
import {
  INTENT_SCHEMA,
  CLASSIFY_SYSTEM_PROMPT,
  serializeClassifyInput,
  createIntentClassifier,
} from '../../plugins/research/classifier'
import type { PluginLlmPort } from '../src/plugins/api'
import { parseStructuredOutput } from '../src/runner/llmToolPort'

describe('INTENT_SCHEMA（5 值枚举 + confidence ∈ [0,1]）', () => {
  it('合法产物通过；none 是合法标签', () => {
    expect(INTENT_SCHEMA.parse({ label: 'discover', confidence: 0.9 })).toEqual({ label: 'discover', confidence: 0.9 })
    expect(INTENT_SCHEMA.parse({ label: 'none', confidence: 0.82 })).toEqual({ label: 'none', confidence: 0.82 })
  })

  it('secondaryIntent 可选、仅四流程值（none 拒——拒识无次选）', () => {
    expect(INTENT_SCHEMA.parse({ label: 'discover', confidence: 0.6, secondaryIntent: 'experiment' })).toEqual({
      label: 'discover',
      confidence: 0.6,
      secondaryIntent: 'experiment',
    })
    expect(() => INTENT_SCHEMA.parse({ label: 'none', confidence: 0.5, secondaryIntent: 'none' })).toThrow()
  })

  it('非法 label / 越界 confidence / 多余键拒入', () => {
    expect(() => INTENT_SCHEMA.parse({ label: 'literature', confidence: 0.9 })).toThrow()
    expect(() => INTENT_SCHEMA.parse({ label: 'ingest', confidence: 1.5 })).toThrow()
    expect(() => INTENT_SCHEMA.parse({ label: 'ingest', confidence: -0.1 })).toThrow()
  })
})

describe('CLASSIFY_SYSTEM_PROMPT（节结构 checklist 断言——非 golden 全文对照）', () => {
  it('五标签语义 + 边界规则 + confidence 语义齐备', () => {
    for (const keyword of ['ingest', 'discover', 'hypothesize', 'experiment', 'none', 'confidence']) {
      expect(CLASSIFY_SYSTEM_PROMPT).toContain(keyword)
    }
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('多意图')
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('0.6') // 低置信引导阈值（853 §1.2）
  })

  it('文本退化双保险①：prompt 内 JSON 输出约束语句（#866 发现①）', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('JSON')
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('禁止输出')
  })

  it('secondaryIntent 引导：次可能标签说明在案（Top-2 / 多意图尾注信号面）', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('secondaryIntent')
  })
})

describe('serializeClassifyInput（分类输入 = 结构化槽位文本序列化，853 §11.3 解读点 A）', () => {
  it('topic + question 组合序列化', () => {
    expect(serializeClassifyInput({ topic: '扩散模型加速', question: '采样步数能减到多少' })).toContain('扩散模型加速')
    expect(serializeClassifyInput({ topic: '扩散模型加速', question: '采样步数能减到多少' })).toContain('采样步数能减到多少')
  })

  it('单槽位 / 全空形态', () => {
    expect(serializeClassifyInput({ topic: '对比学习' })).toContain('对比学习')
    expect(serializeClassifyInput({})).toBe('')
  })
})

describe('createIntentClassifier（generateStructured 封装参数面）', () => {
  type StructuredCall = { schema: unknown; contents: readonly unknown[]; model?: string; maxTokens?: number }
  const makeLlm = () => ({
    generateStructured: vi.fn(async (_opts: StructuredCall) => ({ label: 'ingest', confidence: 0.9 })),
  })

  it('schema/contents 透传；返回 zod 校验产物', async () => {
    const llm = makeLlm()
    const classify = createIntentClassifier(llm as unknown as PluginLlmPort)
    const verdict = await classify('把这篇论文入库')
    expect(verdict).toEqual({ label: 'ingest', confidence: 0.9 })
    expect(llm.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ schema: INTENT_SCHEMA, contents: ['把这篇论文入库'] }),
    )
  })

  it('RESEARCH_MODEL pin 经 model 参数传入（configSchema 单键，853 §3.1）', async () => {
    const llm = makeLlm()
    const classify = createIntentClassifier(llm as unknown as PluginLlmPort, 'MiniMax-M3')
    await classify('x')
    expect(llm.generateStructured).toHaveBeenCalledWith(expect.objectContaining({ model: 'MiniMax-M3' }))
  })

  it('无 pin：model 不传（缺省 = owner 默认链 primary）', async () => {
    const llm = makeLlm()
    const classify = createIntentClassifier(llm as unknown as PluginLlmPort)
    await classify('x')
    const call = llm.generateStructured.mock.calls[0]![0] as StructuredCall
    expect('model' in call).toBe(false)
  })
})

describe('文本退化双保险②锚点：INTENT_SCHEMA 消费 raw 围栏 JSON 通道', () => {
  it('围栏/噪声文本经 parseStructuredOutput 出 zod 产物', () => {
    const verdict = parseStructuredOutput(
      '好的\n```json\n{"label":"hypothesize","confidence":0.72}\n```',
      INTENT_SCHEMA,
    )
    expect(verdict).toEqual({ label: 'hypothesize', confidence: 0.72 })
  })
})
