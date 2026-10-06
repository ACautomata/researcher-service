// seam: audit API（#800 admin 审计检索页 ↔ 后端 /api/v1/approval-logs + /file-overwrite-logs，
// #783/#785 admin 面）。wire snake_case + 过滤参数透传（null/undefined 不落 URL）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { listApprovalLogs, listFileOverwriteLogs } from '@/api/audit'

function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response
}

describe('audit api（#800）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('listApprovalLogs GETs with trailing slash; filters serialized, empty omitted', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: { total: 0, page: 1, pageSize: 50, items: [] } }),
    )
    await listApprovalLogs({
      userId: 'u1',
      layer: 'judge',
      decision: 'deny',
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-08T00:00:00Z'),
      page: 2,
      pageSize: 20,
    })
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toContain('/api/v1/approval-logs/')
    expect(path).toContain('userId=u1')
    expect(path).toContain('layer=judge')
    expect(path).toContain('decision=deny')
    expect(path).toContain('from=2026-10-01T00%3A00%3A00.000Z')
    expect(path).toContain('page=2')
    expect(path).not.toContain('runId')
  })

  it('listApprovalLogs 全缺省 → 仅分页缺省参数', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: { total: 0, page: 1, pageSize: 50, items: [] } }),
    )
    await listApprovalLogs({})
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/approval-logs/?page=1&pageSize=50')
  })

  it('listFileOverwriteLogs GETs with trailing slash; sessionId/path/from/to 透传', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: { total: 0, page: 1, pageSize: 50, items: [] } }),
    )
    await listFileOverwriteLogs({ sessionId: 's1', path: '/wiki/a.md' })
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toContain('/api/v1/file-overwrite-logs/')
    expect(path).toContain('sessionId=s1')
    expect(path).toContain('path=%2Fwiki%2Fa.md')
  })
})
