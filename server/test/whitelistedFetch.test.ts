// 白名单 fetch wrapper 单测（#775 · 731 §5.1 第二层 · S3）。
// 覆盖：发出前 origin 复验（未命中不触达 delegate / 40042 码错误对象）、redirect:'manual'
// 强制注入（调用方不得放宽）、重定向响应禁跟随（3xx 与 undici opaqueredirect status 0 两形态）。
// delegate 注入 fake Response——零网络依赖。

import { describe, it, expect } from 'vitest'
import { CODE } from '../src/codes'
import { createWhitelistedFetch, EndpointNotAllowedError, type FetchLike } from '../src/runner/whitelistedFetch'

// 最小 Response 形状（wrapper 只读 status；无 body 消费）。
function fakeResponse(status: number, headers: Record<string, string> = {}): Response {
  return { status, headers } as unknown as Response
}

const allowed = (origin: string): boolean => origin === 'https://api.minimaxi.com'

function recordedDelegate(resp: () => Response): { delegate: FetchLike; calls: Array<{ input: string | URL | Request; init?: RequestInit }> } {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = []
  const delegate: FetchLike = async (input, init) => {
    calls.push({ input, init })
    return resp()
  }
  return { delegate, calls }
}

describe('createWhitelistedFetch（origin 复验 + redirect manual 禁随）', () => {
  it('白名单 origin 透传 delegate（string URL）', async () => {
    const { delegate, calls } = recordedDelegate(() => fakeResponse(200))
    const f = createWhitelistedFetch({ isAllowed: allowed, delegate })
    const resp = await f('https://api.minimaxi.com/anthropic/v1/messages', { method: 'POST' })
    expect(resp.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('URL 对象 / Request 对象输入同样解析 origin', async () => {
    const { delegate, calls } = recordedDelegate(() => fakeResponse(200))
    const f = createWhitelistedFetch({ isAllowed: allowed, delegate })
    await f(new URL('https://api.minimaxi.com/v1'))
    const req = new Request('https://api.minimaxi.com/v1') // Node 22 全局 Request
    await f(req)
    expect(calls).toHaveLength(2)
  })

  it('未命中 origin → EndpointNotAllowedError（code 40042），delegate 不被触达', async () => {
    const { delegate, calls } = recordedDelegate(() => fakeResponse(200))
    const f = createWhitelistedFetch({ isAllowed: allowed, delegate })
    await expect(f('https://evil.io/steal-key')).rejects.toBeInstanceOf(EndpointNotAllowedError)
    await expect(f('https://evil.io/steal-key')).rejects.toMatchObject({ code: CODE.PROVIDER_ENDPOINT_NOT_ALLOWED })
    expect(calls).toHaveLength(0) // 请求未发出——key 无外送面
  })

  it('origin "null"（file: 等）→ 拒', async () => {
    const { delegate, calls } = recordedDelegate(() => fakeResponse(200))
    const f = createWhitelistedFetch({ isAllowed: allowed, delegate })
    await expect(f('file:///etc/passwd')).rejects.toBeInstanceOf(EndpointNotAllowedError)
    expect(calls).toHaveLength(0)
  })

  it('redirect: manual 强制注入——调用方传 eager 也被覆盖', async () => {
    const { delegate, calls } = recordedDelegate(() => fakeResponse(200))
    const f = createWhitelistedFetch({ isAllowed: allowed, delegate })
    await f('https://api.minimaxi.com/v1', { redirect: 'follow' })
    expect(calls[0].init?.redirect).toBe('manual')
  })

  it('3xx 重定向响应 → 抛错禁跟随（即使目标 origin 合法，fail-closed）', async () => {
    const { delegate, calls } = recordedDelegate(() => fakeResponse(302, { location: 'https://api.minimaxi.com/ok' }))
    const f = createWhitelistedFetch({ isAllowed: allowed, delegate })
    await expect(f('https://api.minimaxi.com/v1')).rejects.toMatchObject({
      code: CODE.PROVIDER_ENDPOINT_NOT_ALLOWED,
      message: expect.stringMatching(/重定向/),
    })
    expect(calls).toHaveLength(1) // 恰一次请求，未跟随
  })

  it('undici opaqueredirect（redirect manual 下 status 0）→ 同按重定向拒', async () => {
    const { delegate, calls } = recordedDelegate(() => fakeResponse(0))
    const f = createWhitelistedFetch({ isAllowed: allowed, delegate })
    await expect(f('https://api.minimaxi.com/v1')).rejects.toMatchObject({ code: CODE.PROVIDER_ENDPOINT_NOT_ALLOWED })
    expect(calls).toHaveLength(1)
  })

  it('默认 delegate = globalThis.fetch（缺省注入路径存在性）', () => {
    const f = createWhitelistedFetch({ isAllowed: allowed })
    expect(typeof f).toBe('function')
  })
})
