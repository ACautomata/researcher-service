// sessions api client —— #913 reason 链的线缝锁（review S9）：resolveSessionApproval 请求体断言。
// 分工：编排层（useChatSession.test.ts）断到 api 函数的参数面；本文件断到 wire 面——
// reason 随行时 body 携带、缺省时 body 无 reason 键（undefined 不落线，0 信任序列化逐字锁）。
// mock 形态镜像 wiki.test.ts：#312 信封响应建模 Content-Type（apiFetch 按头 sniff）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { resolveSessionApproval } from '@/api/sessions'

function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response
}

describe('sessions api client — resolveSessionApproval（#913 reason 线缝）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn())
  })

  function lastCall(): [string, RequestInit] {
    const m = globalThis.fetch as ReturnType<typeof vi.fn>
    return [m.mock.calls[0][0] as string, (m.mock.calls[0][1] ?? {}) as RequestInit]
  }

  it('deny 带 reason → POST approvals/:escId，body 恰为 {decision, reason}', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ code: 0, data: null }))
    await resolveSessionApproval('sess-1', 'e1', 'deny', '样本量不足')
    expect(lastCall()[0]).toBe('/api/v1/sessions/sess-1/approvals/e1')
    expect(lastCall()[1].method).toBe('POST')
    expect(JSON.parse(lastCall()[1].body as string)).toStrictEqual({ decision: 'deny', reason: '样本量不足' })
  })

  it('两键调用（无 reason）→ body 仅 {decision}，无 reason 键', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ code: 0, data: null }))
    await resolveSessionApproval('sess-1', 'e1', 'allow')
    expect(JSON.parse(lastCall()[1].body as string)).toStrictEqual({ decision: 'allow' })
  })
})
