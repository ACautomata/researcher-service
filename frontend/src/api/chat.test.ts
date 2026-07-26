// seam: chat pairing API —— issue #40 设备配对（spec §8.1）。
// 覆盖：getPairing 拉状态、triggerPair 触发配对（paired/pending/error 三态出参）。
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/api/client', () => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

import { apiJson, apiFetch } from '@/api/client'
import {
  getPairing,
  triggerPair,
  listSessions,
  createSession,
  getSessionHistory,
  deleteSession,
  listCommands,
} from '@/api/chat'

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

describe('chat sessions api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listSessions hits the sessions endpoint and unwraps the envelope', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessions: [{ session_key: 'sk-1', title: '文献综述', updated_at: '2026-07-20T10:00:00Z' }],
    })
    const result = await listSessions('demo')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/demo/chat/sessions/')
    expect(result).toEqual([{ session_key: 'sk-1', title: '文献综述', updated_at: '2026-07-20T10:00:00Z' }])
  })

  it('createSession posts label to the sessions endpoint and returns session_key', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({ session_key: 'sk-1' })
    const result = await createSession('demo', '文献综述')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/demo/chat/sessions/', {
      method: 'POST',
      body: JSON.stringify({ label: '文献综述' }),
    })
    expect(result.session_key).toBe('sk-1')
  })

  it('createSession defaults label to empty', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({ session_key: 'k' })
    await createSession('demo')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/demo/chat/sessions/', {
      method: 'POST',
      body: JSON.stringify({ label: '' }),
    })
  })

  it('encodes the container name in the sessions URL', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({ sessions: [] })
    await listSessions('a b')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/a%20b/chat/sessions/')
  })
})

// 会话历史回看（issue #82 / spec #76）：GET 代理 chat.history，分页锚点 messageId。
describe('chat session history api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getSessionHistory hits the history endpoint and unwraps {messages,hasMore,nextOffset}', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ role: 'operator', text: '你好' }],
      hasMore: false,
      nextOffset: null,
    })
    const result = await getSessionHistory('demo', 'sk-1')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/demo/chat/sessions/sk-1/history')
    expect(result).toEqual({
      messages: [{ role: 'operator', text: '你好' }],
      hasMore: false,
      nextOffset: null,
    })
  })

  it('getSessionHistory passes limit and messageId as query anchors (分页)', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
      hasMore: false,
      nextOffset: null,
    })
    await getSessionHistory('demo', 'sk-1', 50, 'msg-10')
    expect(apiJson).toHaveBeenCalledWith(
      '/api/v1/containers/demo/chat/sessions/sk-1/history?limit=50&messageId=msg-10',
    )
  })

  it('getSessionHistory omits query when no limit/messageId', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    await getSessionHistory('demo', 'sk-1')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/demo/chat/sessions/sk-1/history')
  })

  it('encodes the container name and key in the history URL', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    await getSessionHistory('a b', 'k/x')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/a%20b/chat/sessions/k%2Fx/history')
  })
})

// 会话删除（issue #82 / spec #76）：DELETE sessions/<key>/（admin 级，网关归档可恢复）。
// 204 空体 → 走 apiFetch（同 removeInstance/removeProvider），不经 apiJson 的 resp.json()。
describe('chat session delete api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 204 })
  })

  it('deleteSession issues DELETE to the session detail endpoint via apiFetch', async () => {
    await deleteSession('demo', 'sk-1')
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/containers/demo/chat/sessions/sk-1/', {
      method: 'DELETE',
    })
  })

  it('encodes the container name and key in the delete URL', async () => {
    await deleteSession('a b', 'k/x')
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/containers/a%20b/chat/sessions/k%2Fx/', {
      method: 'DELETE',
    })
  })

  it('treats 404 as idempotent (concurrent delete by another client)', async () => {
    ;(apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404 })
    await expect(deleteSession('demo', 'sk-1')).resolves.toBeUndefined()
  })
})

// T07 斜杠命令清单（issue #43 / spec §8.4）：GET 代理 commands.list。
describe('chat commands api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listCommands hits the commands endpoint', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'model', description: '切换模型', aliases: ['/model', '/m'] },
    ])
    const result = await listCommands('demo')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/demo/chat/commands')
    expect(result[0].aliases).toContain('/model')
  })

  it('encodes the container name in the commands URL', async () => {
    ;(apiJson as ReturnType<typeof vi.fn>).mockResolvedValue([])
    await listCommands('a b')
    expect(apiJson).toHaveBeenCalledWith('/api/v1/containers/a%20b/chat/commands')
  })
})
