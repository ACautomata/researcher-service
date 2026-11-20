import { describe, expect, it } from 'vitest'
import { suggestionContext } from '../src/sessions/nextStepSuggestion'
import { nextStepTextSchema } from '../src/validation/schemas'
import { HumanMessage } from '@langchain/core/messages'
import { defaultFactory } from '../src/models/chatFactory'
import { trackModelFetch, withModelTransport } from '../src/runner/modelTransport'

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
    for (const invalid of ['😀'.repeat(121), '请分析\n请实验', '# 下一步', '**请分析**', '下一步建议：请分析', '“请分析”', '_请设计实验_', '~~请设计实验~~', '---', '建议：请分析', '请分析\u0085请实验', '[请分析](https://x)']) {
      expect(nextStepTextSchema.safeParse(invalid).success, invalid).toBe(false)
    }
  })
})

describe('#1039 模型协议传输', () => {
  it.each([
    ['https://api.deepseek.com', true],
    ['https://api.deepseek.com/v1', true],
    ['https://compatible.example/v1', false],
  ] as const)('提示调用在 %s 仅对官方协议关闭思考，并保留 512 token 预算', async (baseUrl, disableThinking) => {
    const bodies: Record<string, unknown>[] = []
    const model = await defaultFactory('deepseek-flash', {
      lcProvider: 'openai', apiKey: 'test-key', baseUrl, authHeader: false,
      fetch: trackModelFetch(async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        bodies.push(body)
        const exhausted = disableThinking && body.max_tokens === 512 && body.thinking?.type !== 'disabled'
        return Response.json({
          id: 'test', model: 'deepseek-flash', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: exhausted ? '' : '请补充两组样本量和标准差' },
            finish_reason: exhausted ? 'length' : 'stop' }],
        })
      }),
    })
    const messages = [new HumanMessage('只有两组均值，还缺哪些统计量？')]
    const signal = new AbortController().signal
    const result = await withModelTransport(signal, () => model.withConfig({ configurable: { maxTokens: 512 } })
      .invoke(messages, { signal }), { purpose: 'next-step-suggestion' })
    expect(result.text).toBe('请补充两组样本量和标准差')
    expect(bodies[0]).toMatchObject({ model: 'deepseek-flash', max_tokens: 512 })
    expect(bodies[0].thinking).toEqual(disableThinking ? { type: 'disabled' } : undefined)
    await model.invoke(messages)
    expect(bodies[1]).not.toHaveProperty('thinking')
  })

  it.each([
    ['openai', 'gpt-4o', 'max_tokens'],
    ['openai', 'gpt-5.1', 'max_completion_tokens'],
    ['anthropic', 'claude-sonnet-5-5', 'max_tokens'],
  ] as const)('%s %s 发送输出上限，取消后等 fetch 收尾', async (lcProvider, modelName, budgetField) => {
    const controller = new AbortController()
    let finishFetch: (() => void) | undefined
    let wireSignal: AbortSignal | null | undefined
    let wireBody: unknown
    let notifyFetch!: () => void
    const fetchStarted = new Promise<void>(resolve => { notifyFetch = resolve })
    const model = await defaultFactory(modelName, {
      lcProvider, apiKey: 'test-key', baseUrl: 'https://model.example/v1', authHeader: false,
      fetch: trackModelFetch(async (_input, init) => {
        wireSignal = init?.signal
        wireBody = JSON.parse(String(init?.body))
        return new Promise<Response>((_resolve, reject) => {
          finishFetch = () => reject(new DOMException('transport cancelled', 'AbortError'))
          notifyFetch()
        })
      }),
    })
    let settled = false
    const invoke = withModelTransport(controller.signal, () => model.withConfig({ configurable: { maxTokens: 512 } })
      .invoke([new HumanMessage('hello')], { signal: controller.signal }))
    const outcome = invoke.then(
      () => { settled = true; return 'success' },
      () => { settled = true; return 'cancelled' },
    )
    try {
      await Promise.race([fetchStarted, outcome])
      expect(wireBody).toMatchObject({ [budgetField]: 512 })
      controller.abort()
      expect(wireSignal?.aborted).toBe(true)
      await new Promise(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
    } finally {
      controller.abort()
      finishFetch?.()
    }
    expect(await outcome).toBe('cancelled')
  })

  it('收到响应头后仍等待被取消的响应体收尾', async () => {
    const controller = new AbortController()
    let releaseBody!: () => void
    let signalBodyCancelled!: () => void
    let signalBodyRead!: () => void
    const bodyCancelled = new Promise<void>(resolve => { signalBodyCancelled = resolve })
    const bodyRead = new Promise<void>(resolve => { signalBodyRead = resolve })
    const fetch = trackModelFetch(async () => new Response(new ReadableStream({
      pull: () => { signalBodyRead() },
      cancel: () => new Promise<void>(resolve => {
        releaseBody = resolve
        signalBodyCancelled()
      }),
    })))
    let settled = false
    const invoke = withModelTransport(controller.signal, async () => {
      const response = await fetch('https://model.example')
      const reading = response.json().catch(() => undefined)
      await bodyRead
      return reading
    }).finally(() => { settled = true })
    await bodyRead
    controller.abort()
    await bodyCancelled
    await new Promise(resolve => setImmediate(resolve))
    try {
      expect(settled).toBe(false)
    } finally {
      releaseBody()
    }
    await invoke
  })

})
