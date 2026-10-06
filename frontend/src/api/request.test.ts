import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from '@/api/request'

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('adds a 15 second timeout signal to every request', async () => {
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await fetchWithTimeout('/api/v1/x', { method: 'POST' })

    expect(timeoutSpy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', signal: timeout.signal })
  })

  it('大附件可使用 300 秒超时，内部选项不传给 fetch', async () => {
    const timeout = new AbortController()
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const fetchMock = vi.fn().mockResolvedValue(new Response())
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithTimeout('/api/v1/attachments/123/download', { timeoutMs: 300_000 })
    expect(spy).toHaveBeenCalledWith(300_000)
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('timeoutMs')
  })

  it('combines caller cancellation with the timeout signal', async () => {
    const timeout = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response)
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()

    await fetchWithTimeout('/api/v1/x', { signal: caller.signal })
    const combined = fetchMock.mock.calls[0][1].signal as AbortSignal
    expect(combined.aborted).toBe(false)
    caller.abort()
    expect(combined.aborted).toBe(true)
  })
})
