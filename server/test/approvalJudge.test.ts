// S3 纯逻辑单测（#783 · 729 §2）：judge 灰区判定——输入契约截断（§2.2）/ 输出契约 zod 校验
// 与语义归一（§2.3）/ 校验失败重试一次再败 fail-closed（§2.3）/ 列拒四类政策文本（§2.4）。

import { describe, it, expect } from 'vitest'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import {
  buildJudgeInput,
  parseJudgeOutput,
  truncateToTokenBudget,
  extractJudgeContext,
  ToolCallJudgeClient,
  type JudgeModelLike,
} from '../src/runner/approval/judge'
import {
  JUDGE_POLICY_MARKDOWN,
  JUDGE_POLICY_VERSION,
  APPROVAL_REASON_MAX_CHARS,
} from '../src/runner/approval/values'

describe('truncateToTokenBudget（token 预算截断，§2.2）', () => {
  it('按 chars/token 因子换算截断；未超限原样返回', () => {
    expect(truncateToTokenBudget('abcdefgh', 2)).toBe('abcd')
    expect(truncateToTokenBudget('ab', 2)).toBe('ab')
    expect(truncateToTokenBudget('一二三四五六', 2)).toHaveLength(4) // 2 tokens × 2 chars
  })
})

describe('extractJudgeContext（从消息历史构造输入，§2.2）', () => {
  it('user_input = 最后一条 HumanMessage；prior_tool_calls = 最近 10 条按时间序', () => {
    const messages = [
      new HumanMessage('第一轮问题'),
      new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'read_file', args: { file_path: '/lab/a.md' } }] }),
      new ToolMessage({ tool_call_id: 'c1', content: '文件内容 A' }),
      new HumanMessage('本轮问题'),
      new AIMessage({ content: '', tool_calls: [{ id: 'c2', name: 'execute', args: { command: 'ls /lab' } }] }),
      new ToolMessage({ tool_call_id: 'c2', content: 'a.md\nb.md' }),
    ]
    const ctx = extractJudgeContext(messages as unknown[])
    expect(ctx.userInput).toBe('本轮问题')
    expect(ctx.priorCalls).toHaveLength(2)
    expect(ctx.priorCalls[0]).toMatchObject({ tool: 'read_file', result: '文件内容 A' })
    expect(ctx.priorCalls[1]).toMatchObject({ tool: 'execute' })
  })

  it('prior 条数上限 N=10：只保留最近 10 条', () => {
    const messages: unknown[] = [new HumanMessage('hi')]
    for (let i = 0; i < 15; i++) {
      messages.push(new AIMessage({ content: '', tool_calls: [{ id: `c${i}`, name: 'execute', args: { command: `cmd${i}` } }] }))
      messages.push(new ToolMessage({ tool_call_id: `c${i}`, content: `out${i}` }))
    }
    const ctx = extractJudgeContext(messages)
    expect(ctx.priorCalls).toHaveLength(10)
    expect(ctx.priorCalls[0]?.result).toBe('out5') // 最早的被裁掉
    expect(ctx.priorCalls[9]?.result).toBe('out14')
  })

  it('无配对结果的调用（reject 回喂等）args 可见、result 为空串', () => {
    const messages = [
      new HumanMessage('hi'),
      new AIMessage({ content: '', tool_calls: [{ id: 'cx', name: 'execute', args: { command: 'x' } }] }),
    ]
    const ctx = extractJudgeContext(messages)
    expect(ctx.priorCalls[0]).toMatchObject({ tool: 'execute', result: '' })
  })
})

describe('buildJudgeInput（渲染与 hash，§2.2 总预算 ≤8k）', () => {
  it('分项预算截断 + 超总预算时裁最旧 prior 条目直到不超', () => {
    const big = 'x'.repeat(3000)
    const input = buildJudgeInput({
      userInput: big,
      priorCalls: Array.from({ length: 10 }, (_, i) => ({ tool: 'execute', args: { command: `cmd${i} ${big}` }, result: big })),
      currentCall: { tool: 'write_file', args: { file_path: '/lab/a', content: big } },
    })
    // 渲染体按 2 chars/token 换算 ≤ 8k tokens
    expect(Buffer.byteLength(input.rendered, 'utf8')).toBeLessThanOrEqual(8000 * 2)
    expect(input.inputHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('小输入不裁剪、hash 稳定（同输入同 hash）', () => {
    const parts = {
      userInput: 'hi',
      priorCalls: [{ tool: 'execute', args: { command: 'ls' }, result: 'a' }],
      currentCall: { tool: 'execute', args: { command: 'pwd' } },
    }
    const a = buildJudgeInput(parts)
    const b = buildJudgeInput({ ...parts })
    expect(a.rendered).toBe(b.rendered)
    expect(a.inputHash).toBe(b.inputHash)
    expect(JSON.parse(a.rendered)).toMatchObject({
      user_input: 'hi',
      current_call: { tool: 'execute' },
    })
  })
})

describe('parseJudgeOutput（输出契约 zod 校验 + 语义归一，§2.3）', () => {
  it('合法 approve：policy_class 归一为 null', () => {
    const v = parseJudgeOutput('{"decision":"approve","policy_class":"system_destruction","reason":""}')
    expect(v).toMatchObject({ decision: 'approve', policy_class: null, reason: '' })
  })

  it('合法 reject：四类政策类之一 + 非空理由；reason 超长截断到 100 字', () => {
    const v = parseJudgeOutput(
      JSON.stringify({ decision: 'reject', policy_class: 'data_exfiltration', reason: '拒'.repeat(150) }),
    )
    expect(v.decision).toBe('reject')
    expect(v.policy_class).toBe('data_exfiltration')
    expect(v.reason).toHaveLength(APPROVAL_REASON_MAX_CHARS)
  })

  it('markdown 代码围栏包裹的 JSON 可解析', () => {
    const v = parseJudgeOutput('```json\n{"decision":"approve","policy_class":null,"reason":""}\n```')
    expect(v.decision).toBe('approve')
  })

  it('reject 缺 policy_class / 缺理由 → 抛错（畸形，重试面）', () => {
    expect(() =>
      parseJudgeOutput('{"decision":"reject","policy_class":null,"reason":"x"}'),
    ).toThrow()
    expect(() =>
      parseJudgeOutput('{"decision":"reject","policy_class":"credential_access","reason":""}'),
    ).toThrow()
  })

  it('决策越界 / 非法 JSON / 政策类越界 → 抛错', () => {
    expect(() => parseJudgeOutput('{"decision":"maybe","policy_class":null,"reason":""}')).toThrow()
    expect(() => parseJudgeOutput('not json at all')).toThrow()
    expect(() =>
      parseJudgeOutput('{"decision":"reject","policy_class":"unknown_class","reason":"x"}'),
    ).toThrow()
  })
})

describe('ToolCallJudgeClient（重试一次再败 fail-closed，§2.3）', () => {
  function modelOf(outputs: string[]): JudgeModelLike & { calls: number } {
    let i = 0
    const m = {
      calls: 0,
      async invoke(_messages: unknown[]) {
        m.calls += 1
        return new AIMessage({ content: outputs[Math.min(i++, outputs.length - 1)] ?? '' })
      },
    }
    return m
  }

  const input = buildJudgeInput({
    userInput: 'hi',
    priorCalls: [],
    currentCall: { tool: 'execute', args: { command: 'ls' } },
  })

  it('首次合法输出：直接采纳，模型调用 1 次', async () => {
    const model = modelOf(['{"decision":"approve","policy_class":null,"reason":""}'])
    const client = new ToolCallJudgeClient(model, { policy: JUDGE_POLICY_MARKDOWN })
    const result = await client.run(input)
    expect(model.calls).toBe(1)
    expect(result.kind).toBe('verdict')
    if (result.kind === 'verdict') expect(result.verdict.decision).toBe('approve')
  })

  it('畸形 → 回灌校验错误重试一次成功', async () => {
    const model = modelOf([
      '垃圾输出',
      '{"decision":"reject","policy_class":"credential_access","reason":"读取密钥被拒"}',
    ])
    const client = new ToolCallJudgeClient(model, { policy: JUDGE_POLICY_MARKDOWN })
    const result = await client.run(input)
    expect(model.calls).toBe(2)
    expect(result.kind).toBe('verdict')
    if (result.kind === 'verdict') {
      expect(result.verdict.decision).toBe('reject')
      expect(result.verdict.policy_class).toBe('credential_access')
    }
    // 重试时回灌了首次原始输出（messages 4 条：system+human+ai+human）
    expect(model.calls).toBe(2)
  })

  it('两次皆畸形 → malformed（fail-closed 升级人工），不抛错', async () => {
    const model = modelOf(['bad1', 'bad2'])
    const client = new ToolCallJudgeClient(model, { policy: JUDGE_POLICY_MARKDOWN })
    const result = await client.run(input)
    expect(model.calls).toBe(2)
    expect(result.kind).toBe('malformed')
  })

  it('模型异常 → malformed（fail-closed），不抛错', async () => {
    const client = new ToolCallJudgeClient(
      {
        async invoke() {
          throw new Error('502 from provider')
        },
      },
      { policy: JUDGE_POLICY_MARKDOWN },
    )
    const result = await client.run(input)
    expect(result.kind).toBe('malformed')
  })

  it('system prompt 携政策文本，user 消息携渲染输入', async () => {
    let seen: unknown[] = []
    const client = new ToolCallJudgeClient(
      {
        async invoke(messages: unknown[]) {
          seen = messages
          return new AIMessage({ content: '{"decision":"approve","policy_class":null,"reason":""}' })
        },
      },
      { policy: JUDGE_POLICY_MARKDOWN },
    )
    await client.run(input)
    expect(seen[0]).toBeInstanceOf(SystemMessage)
    expect((seen[0] as SystemMessage).content).toContain('列拒')
    expect(seen[1]).toBeInstanceOf(HumanMessage)
    expect((seen[1] as HumanMessage).content).toContain('current_call')
  })
})

describe('judge 政策文本（§2.4 版本化 markdown）', () => {
  it('列拒四类 + 版本标记 + 默认放行语义在案', () => {
    expect(JUDGE_POLICY_VERSION).toBe('v1')
    for (const cls of ['system_destruction', 'data_exfiltration', 'persistence_backdoor', 'credential_access']) {
      expect(JUDGE_POLICY_MARKDOWN).toContain(cls)
    }
    expect(JUDGE_POLICY_MARKDOWN).toContain('一律 approve')
  })
})
