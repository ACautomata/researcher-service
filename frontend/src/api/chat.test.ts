// seam: chat pairing + bootstrap-token API —— issue #40 设备配对 + ADR 0006 D1（#369）。
// 覆盖：getPairing 拉状态、triggerPair 触发配对、getBootstrapToken 取容器首连凭证（归属门）。
// #369：会话 CRUD/历史/命令不再走 REST 代理（#339 作废），改协议机 RPC（见 chat/gatewayChat.test.ts）。
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/api/client', () => ({
  apiJson: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

import { apiJson } from '@/api/client'
import { getPairing, triggerPair, getBootstrapToken } from '@/api/chat'

describe('chat pairing api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getPairing hits the pairing endpoint', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'unpaired' })
    await getPairing('demo')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/demo/pairing/')
  })

  it('triggerPair posts to the pairing endpoint', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'paired',
      scopes: ['operator.read'],
    })
    const result = await triggerPair('demo')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/demo/pairing/', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(result.status).toBe('paired')
  })

  it('encodes the container name in the URL', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'unpaired' })
    await getPairing('a b')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/a%20b/pairing/')
  })
})

describe('getBootstrapToken（ADR 0006 D1 / #369）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('POST bootstrap-token and unwraps envelope data.bootstrapToken', async () => {
    // P0 回归：apiJson 返回整个信封 body（{code,message,data}），token 在 data 下——mock 必须
    // 用信封 shape（旧的 {bootstrapToken} 顶层 shape 是 apiJson 永不产生的，两端各自 mock 对方绿）。
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      message: 'ok',
      data: { bootstrapToken: 'tok-1' },
    })
    const token = await getBootstrapToken('demo')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/demo/bootstrap-token', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(token).toBe('tok-1')
  })

  it('信封缺少 data.bootstrapToken → 抛错（防首连 auth.token 为空静默失败）', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, message: 'ok', data: {} })
    await expect(getBootstrapToken('demo')).rejects.toThrow('bootstrap-token 响应缺少')
  })

  it('encodes the container name in the URL', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      message: 'ok',
      data: { bootstrapToken: 'tok-1' },
    })
    await getBootstrapToken('a b')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/a%20b/bootstrap-token', {
      method: 'POST',
      body: JSON.stringify({}),
    })
  })
})
