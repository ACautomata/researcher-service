import { describe, it, expect, vi } from 'vitest'
import { createDeepAgent } from 'deepagents'
import { tool } from '@langchain/core/tools'
import { AIMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { RunProjector } from '../src/runner/runtime/projector'
import { ScriptedChatModel, toolCallAi } from './runnerFakes'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ProviderConfigSnapshot } from '../src/runner/providerRegistry'
import { defaultFactory } from '../src/models/chatFactory'
import { createUserJudgeClient } from '../src/runner/approval/userJudge'

const providers = ['byok', 'platform'].map((providerId) => ({
  providerId, lcProvider: 'openai' as const, baseUrl: 'https://api.openai.com/v1',
  authHeader: true, credentialCipher: null, models: [{ id: `${providerId}-model` }, { id: 'other' }],
}))
function snapshot(assignment?: { providerId: string | null; modelId: string | null }): ProviderConfigSnapshot {
  return { ownerId: 'owner', version: 1, providers, pluginAssignments: new Map(assignment ? [['judge', assignment]] : []) }
}
describe('judge 用户端点链（#884）', () => {
  it.each([
    [undefined, 'byok'],
    [{ providerId: null, modelId: null }, 'byok'],
    [{ providerId: 'platform', modelId: null }, 'platform'],
  ] as const)('指派优先，其次默认链 primary', async (assignment, expected) => {
    const getModel = vi.fn().mockResolvedValue({ withConfig: vi.fn().mockReturnValue({ invoke: vi.fn() }) })
    await createUserJudgeClient({ getModel }, snapshot(assignment))
    expect(getModel).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner' }), expected)
  })
  it('零用户端点落平台默认', async () => {
    const getModel = vi.fn().mockResolvedValue({ withConfig: vi.fn().mockReturnValue({ invoke: vi.fn() }) })
    await createUserJudgeClient({ getModel }, { ...snapshot(), providers: providers.slice(1) })
    expect(getModel.mock.calls[0]?.[1]).toBe('platform')
  })
  it('显式非首模型绑定，不切换端点', async () => {
    const withConfig = vi.fn().mockReturnValue({ invoke: vi.fn() })
    await createUserJudgeClient({ getModel: vi.fn().mockResolvedValue({ withConfig } as unknown as BaseChatModel) }, snapshot({ providerId: 'byok', modelId: 'other' }))
    expect(withConfig).toHaveBeenCalledWith({ configurable: { model: 'other', temperature: 0 } })
  })
  it.each([
    { providerId: 'deleted', modelId: 'missing' },
    { providerId: 'byok', modelId: 'removed-model' },
  ])('悬挂指派回落平台默认', async (assignment) => {
    const getModel = vi.fn().mockResolvedValue({ withConfig: vi.fn().mockReturnValue({ invoke: vi.fn() }) })
    await createUserJudgeClient({ getModel }, snapshot(assignment))
    expect(getModel.mock.calls[0]?.[1]).toBe('platform')
  })
  it('Anthropic 真工厂的请求携带温度 0 和指定模型', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'other',
        content: [{ type: 'text', text: '{"decision":"approve","policy_class":null,"reason":""}' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
        { headers: { 'content-type': 'application/json' } })
    }
    const model = await defaultFactory('first', { lcProvider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'user-key', authHeader: false, fetch: fetchImpl })
    const judge = await createUserJudgeClient({ getModel: async () => model }, {
      ...snapshot({ providerId: 'byok', modelId: 'other' }),
      providers: [{ ...providers[0]!, lcProvider: 'anthropic', models: [{ id: 'first' }, { id: 'other' }] }],
    })
    expect((await judge.run({ rendered: 'call', inputHash: 'hash' })).kind).toBe('verdict')
    expect(body).toMatchObject({ model: 'other', temperature: 0 })
  })

})

// S1：真 LangGraph v3 流 + 真 judge 客户端；仅模型响应脚本化。
// 审批在工具调用的异步上下文内执行，覆盖生产隐式回调继承路径。
it('judge 判定不进入会话正文或会话用量，判定 token 仍返回审批审计', async () => {
  const verdict = '{"decision":"approve","policy_class":null,"reason":""}'
  const judgeModel = new ScriptedChatModel([new AIMessage({
    content: verdict, usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  })])
  const judge = await createUserJudgeClient({ getModel: async () => judgeModel }, snapshot())
  let outcome: Awaited<ReturnType<typeof judge.run>> | undefined
  const checkedTool = tool(async () => {
    outcome = await judge.run({ rendered: 'checked call', inputHash: 'hash' })
    return 'tool succeeded'
  }, { name: 'checked_tool', description: 'test approval boundary', schema: z.object({}) })
  const agent = createDeepAgent({
    model: new ScriptedChatModel([toolCallAi('call', 'checked_tool', {}), new AIMessage('文件测试完成')]),
    tools: [checkedTool],
  })
  const usage = vi.fn()
  const stream = await agent.streamEvents({ messages: [{ role: 'user', content: 'test' }] }, {
    version: 'v3', callbacks: [{ handleLLMEnd: usage }],
  })
  const projector = new RunProjector()
  let text = ''
  for await (const raw of stream) {
    for (const event of projector.feed(raw, 0)) {
      if (event.type === 'text.delta') text += String((event.payload as { delta: string }).delta)
    }
  }
  expect(text).toBe('文件测试完成')
  expect(usage).toHaveBeenCalledTimes(2)
  expect(outcome).toMatchObject({ kind: 'verdict', verdict: { decision: 'approve' }, tokens: 3 })
})
