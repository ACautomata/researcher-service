// S3：独立 run 触发、事件隔离、断线与终帧。
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventStreamHandlers } from '@/chat/useEventStream'
vi.mock('@/api/wiki', () => ({ startWikiUpdate: vi.fn() }))
vi.mock('@/chat/useEventStream', () => ({ useEventStream: vi.fn() }))
import { startWikiUpdate } from '@/api/wiki'
import { useEventStream } from '@/chat/useEventStream'
import { useWikiUpdate } from './useWikiUpdate'
import { ref } from 'vue'
let handlers: EventStreamHandlers
const close = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useEventStream).mockImplementation(hooks => { handlers = hooks; return { status: ref('open'), close } })
  vi.mocked(startWikiUpdate).mockResolvedValue({ runId: 'run' })
})
function setup() {
  let update!: ReturnType<typeof useWikiUpdate>
  const refresh = vi.fn(async () => {})
  const wrapper = mount(defineComponent({ setup() { update = useWikiUpdate(refresh); return () => h('div') } }))
  return { update, refresh, wrapper }
}
describe('wiki update', () => {
  it('shows matching stages and counts, refreshes on completion and closes the stream on unmount', async () => {
    const { update, refresh, wrapper } = setup()
    await update.start('demo')
    expect(startWikiUpdate).toHaveBeenCalledWith('demo')
    handlers.onEvent({ type: 'wiki_run.progress', runId: 'other', payload: { stage: 'finalizing' } })
    expect(update.message.value).toBe('规划中')
    for (const [stage, label] of [['planning', '规划中'], ['generating', '生成中'], ['finalizing', '收尾中']]) {
      handlers.onEvent({ type: 'wiki_run.progress', runId: 'run', payload: { stage, completedCount: 2, pageCount: 3 } })
      expect(update.message.value).toBe(label)
      expect(update.detail.value).toBe('2/3')
    }
    handlers.onEvent({ type: 'wiki_run.finished', runId: 'run', payload: { outcome: 'completed' } })
    await flushPromises()
    expect(update.busy.value).toBe(false)
    expect(refresh).toHaveBeenCalledOnce()
    wrapper.unmount()
    expect(close).toHaveBeenCalledOnce()
  })
  it('handles events arriving before the trigger response and prevents double submission', async () => {
    vi.mocked(startWikiUpdate).mockImplementationOnce(async () => {
      handlers.onEvent({ type: 'wiki_run.finished', runId: 'run', payload: { outcome: 'conflict' } })
      return { runId: 'run' }
    })
    const { update, wrapper } = setup()
    const first = update.start('demo')
    await update.start('demo')
    await first
    expect(startWikiUpdate).toHaveBeenCalledOnce()
    expect(update.message.value).toContain('冲突')
    expect(update.busy.value).toBe(false)
    wrapper.unmount()
  })
  it('reports unknown results after a sequence gap and handles failed launches', async () => {
    const { update, wrapper } = setup()
    await update.start('demo')
    handlers.onGap?.()
    expect(update.message.value).toContain('结果未知')
    expect(update.busy.value).toBe(false)
    vi.mocked(startWikiUpdate).mockRejectedValueOnce(new Error('30042'))
    await expect(update.start('demo')).rejects.toThrow('30042')
    expect(update.busy.value).toBe(false)
    wrapper.unmount()
  })
})
