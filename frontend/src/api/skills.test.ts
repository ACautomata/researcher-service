// seam: Skill 市场 API client（#1058 D 票 · #1056 B 票契约）——enablement PUT wire 契约、
// 上传 multipart + 拒收结构化直返（reasons 不抛）、下载认证字节通道防误判。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { deleteSkill, setSkillEnablement, uploadSkill } from './skills'

function mockResp(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('skills api（#1058）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('PUT /api/v1/skills/:id/enablement，body {enabled}', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ skillId: 'sk-1', enabled: true }))
    const result = await setSkillEnablement('sk-1', true)
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/skills/sk-1/enablement')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ enabled: true })
    expect(result).toEqual({ skillId: 'sk-1', enabled: true })
  })

  it('DELETE /api/v1/skills/:id', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(null))
    await deleteSkill('sk-9')
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/skills/sk-9')
    expect(init.method).toBe('DELETE')
  })

  it('上传 multipart：FormData field file；拒收 → 结构化直返（reasons 不抛）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 80002, message: 'Skill 包校验未通过', data: { reasons: ['缺少 SKILL.md（必须在 zip 根目录）', 'name 过长（≤64）'] } }),
    )
    const file = new File(['zip-bytes'], 'demo.zip', { type: 'application/zip' })
    const result = await uploadSkill(file)
    expect(result).toEqual({
      ok: false,
      code: 80002,
      message: 'Skill 包校验未通过',
      reasons: ['缺少 SKILL.md（必须在 zip 根目录）', 'name 过长（≤64）'],
    })
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/skills')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('file')).toBeInstanceOf(File)
    expect(init.headers.get('Content-Type')).toBeNull() // multipart boundary 由浏览器注入
  })

  it('上传成功 → 解包 data {id,name,category}', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: { id: 'sk-1', name: 'demo', category: 'writing' } }),
    )
    const file = new File(['zip-bytes'], 'demo.zip', { type: 'application/zip' })
    const result = await uploadSkill(file)
    expect(result).toEqual({ ok: true, id: 'sk-1', name: 'demo', category: 'writing' })
  })
})
