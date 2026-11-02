import { afterEach, expect, it, vi } from 'vitest'
import { EndpointProbeService } from '../src/models/probe'

afterEach(() => vi.unstubAllGlobals())
it('probes through the real configurable model factory with a one-token wire limit', async () => {
  let body: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ id: 'probe', object: 'chat.completion', created: 1, model: 'deepseek-flash', choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '好' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  const probe = new EndpointProbeService()
  await expect(probe.probe({ presetId: 'deepseek', apiKey: 'test-only-key', model: 'deepseek-flash' })).resolves.toMatchObject({ ok: true })
  expect(body?.max_tokens).toBe(1)
})
