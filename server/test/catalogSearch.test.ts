import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchCourseCatalog } from '../src/chaoxing/catalogSearch'
import type { ChaoxingRemote, LearningResult } from '../src/chaoxing/remote'
const courses = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), classId: String(i + 10), name: `课程${i}` }))
const empty: LearningResult = { resources: [], limitations: [] }
const remoteWith = (learn: ChaoxingRemote['learn']): ChaoxingRemote => ({ learn, async inspect() { return { tools: [], capabilities: [] } }, async exchange() { throw new Error() }, async refresh() { throw new Error() } })
afterEach(() => vi.restoreAllMocks())
describe('跨课程查询预算', () => {
  it('最多三个并发且每门课一次进入查询', async () => {
    const pending: Array<() => void> = []
    let active = 0
    let peak = 0
    const remote = remoteWith(async () => {
      active++; peak = Math.max(peak, active)
      await new Promise<void>(resolve => pending.push(resolve))
      active--; return empty
    })
    const result = searchCourseCatalog(remote, 'token', courses, { topic: '关键词', target: 'resources' })
    expect(pending).toHaveLength(3)
    pending.slice(0, 3).forEach(release => release())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pending).toHaveLength(5)
    pending.slice(3).forEach(release => release())
    expect((await result).limitations.join(' ')).toContain('5 个成功')
    expect(peak).toBe(3)
  })
  it('用户取消时不返回成功结果', async () => {
    const remote = remoteWith(async (_token, _topic, id, signal) => {
      if (id === '1') return empty
      await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      return empty
    })
    const controller = new AbortController()
    const result = searchCourseCatalog(remote, 'token', courses, { topic: '关键词', target: 'resources', signal: controller.signal })
    const rejected = expect(result).rejects.toThrow()
    controller.abort(new Error('user cancelled'))
    await rejected
  })
  it('总时限到达时保留已经成功的课程，并明确结果不完整', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const remote = remoteWith(async (_token, _topic, id, signal) => {
      if (id === '1') return empty
      await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
      return empty
    })
    const result = searchCourseCatalog(remote, 'token', courses, { topic: '关键词', target: 'resources' })
    await new Promise(resolve => setTimeout(resolve, 0))
    deadline.abort()
    expect((await result).limitations.join(' ')).toContain('达到总时限')
  })
})
