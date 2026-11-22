// #1088 评测脚手架护栏：采样参数必须在实际 wire 请求中生效；预算在发网前硬拦截；
// provider 返回的模型版本可被采集。测试不访问真实网络。
import { describe, expect, it, vi } from 'vitest'
import { defaultFactory } from '../src/models/chatFactory'
import {
  createEvalHarness, createEvalModel, EvalHarnessError, maxRequestsFromEnv, type ModelVersionCollector,
} from '../scripts/acceptance/reflectionEvalHarness'

type CapturedRequest = { body: Record<string, unknown> }

function captureFetch(respond: () => unknown): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = []
  const fake = async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    calls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return new Response(JSON.stringify(respond()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fake as typeof fetch, calls }
}

function openAiResponse(content = 'ok'): unknown {
  return {
    id: 'chatcmpl-eval', object: 'chat.completion', created: 1, model: 'deepseek-v4-flash',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function anthropicResponse(content = 'ok'): unknown {
  return {
    id: 'msg_eval', type: 'message', role: 'assistant', model: 'my-anthropic-compat',
    content: [{ type: 'text', text: content }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function wireMaxTokens(body: Record<string, unknown>): unknown {
  return body.max_tokens ?? body.max_completion_tokens
}

describe('#1088 真实模型评测护栏', () => {
  it('OpenAI 兼容面：temperature=0 / maxTokens=500 / thinking=disabled 进入真实请求体，版本被采集', async () => {
    const sampling = { temperature: 0, maxTokens: 500, thinking: 'disabled' as const }
    const harness = createEvalHarness({ maxRequests: 600, modelId: 'deepseek-v4-flash', sampling })
    const captured = captureFetch(() => openAiResponse('{"decision":"unrelated"}'))
    const model = await createEvalModel(defaultFactory, 'deepseek-v4-flash', {
      lcProvider: 'openai', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9/v1', authHeader: true,
      fetch: harness.wrapFetch(captured.fetch),
    }, sampling, harness.collector)
    await model.invoke('判断这条消息')
    expect(captured.calls).toHaveLength(1)
    expect(captured.calls[0].body.model).toBe('deepseek-v4-flash')
    expect(captured.calls[0].body.temperature).toBe(0)
    expect(wireMaxTokens(captured.calls[0].body)).toBe(500)
    expect(captured.calls[0].body.thinking).toEqual({ type: 'disabled' })
    expect(harness.budget.requestsUsed).toBe(1)
    expect(harness.samplingVerification.verified).toBe(true)
    expect(harness.samplingVerification.mismatch).toEqual([])
    expect(harness.samplingVerification.observed[0]).toMatchObject({ model: 'deepseek-v4-flash', temperature: 0, maxTokens: 500, thinking: 'disabled' })
    expect(harness.modelVersion()).toBe('deepseek-v4-flash')
  })

  it('Anthropic 兼容面：temperature=0 / maxTokens=6000 进入真实请求体', async () => {
    const harness = createEvalHarness({ maxRequests: 600, modelId: 'my-anthropic-compat', sampling: { temperature: 0, maxTokens: 6000 } })
    const captured = captureFetch(() => anthropicResponse())
    const model = await createEvalModel(defaultFactory, 'my-anthropic-compat', {
      lcProvider: 'anthropic', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9', authHeader: false,
      fetch: harness.wrapFetch(captured.fetch),
    }, { temperature: 0, maxTokens: 6000 }, harness.collector)
    await model.invoke('判断这条消息')
    expect(captured.calls).toHaveLength(1)
    expect(captured.calls[0].body.model).toBe('my-anthropic-compat')
    expect(captured.calls[0].body.temperature).toBe(0)
    expect(captured.calls[0].body.max_tokens).toBe(6000)
    expect(harness.modelVersion()).toBe('my-anthropic-compat')
  })

  it('报文参数不符时在发网前拒绝，不消耗预算', async () => {
    const harness = createEvalHarness({ maxRequests: 600, modelId: 'deepseek-v4-flash', sampling: { temperature: 0, maxTokens: 500 } })
    const fake = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> => new Response('{}'))
    const wrapped = harness.wrapFetch(fake as unknown as typeof fetch)
    await expect(wrapped('http://127.0.0.1:9/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ model: 'deepseek-v4-flash', temperature: 1, max_tokens: 500 }),
    })).rejects.toMatchObject({ code: 'sampling_parameter_mismatch' })
    expect(fake).not.toHaveBeenCalled()
    expect(harness.budget.requestsUsed).toBe(0)
    expect(harness.samplingVerification.verified).toBe(false)
    expect(harness.samplingVerification.mismatch).toContain('temperature:1')
  })

  it('硬预算按实际发网请求计数，超额在发网前阻断', async () => {
    const harness = createEvalHarness({ maxRequests: 1, modelId: 'deepseek-v4-flash', sampling: { temperature: 0, maxTokens: 500 } })
    const fake = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> => new Response('{}'))
    const wrapped = harness.wrapFetch(fake as unknown as typeof fetch)
    const body = JSON.stringify({ model: 'deepseek-v4-flash', temperature: 0, max_tokens: 500 })
    await wrapped('http://127.0.0.1:9/v1/chat/completions', { method: 'POST', body })
    await expect(wrapped('http://127.0.0.1:9/v1/chat/completions', { method: 'POST', body }))
      .rejects.toBeInstanceOf(EvalHarnessError)
    expect(fake).toHaveBeenCalledTimes(1)
    expect(harness.budget.requestsUsed).toBe(1)
    expect(harness.budget.exhausted).toBe(true)
  })

  it('预算上限默认 600，非法值拒绝', () => {
    expect(maxRequestsFromEnv({} as NodeJS.ProcessEnv)).toBe(600)
    expect(maxRequestsFromEnv({ RF_EVAL_MAX_REQUESTS: '420' } as NodeJS.ProcessEnv)).toBe(420)
    expect(() => maxRequestsFromEnv({ RF_EVAL_MAX_REQUESTS: '0' } as NodeJS.ProcessEnv)).toThrow()
    expect(() => maxRequestsFromEnv({ RF_EVAL_MAX_REQUESTS: '1.5' } as NodeJS.ProcessEnv)).toThrow()
  })

  it('collector 从 generations 的 response_metadata 提取模型版本', async () => {
    const harness = createEvalHarness({ maxRequests: 1, modelId: 'deepseek-v4-flash', sampling: { temperature: 0, maxTokens: 500 } })
    const collector = harness.collector as ModelVersionCollector
    await collector.handleLLMEnd({
      generations: [[{ message: { response_metadata: { model_name: 'deepseek-v4-flash' } } }]],
      llmOutput: { model_name: 'deepseek-v4-flash' },
    } as never)
    expect(collector.all).toEqual(['deepseek-v4-flash'])
  })
})
