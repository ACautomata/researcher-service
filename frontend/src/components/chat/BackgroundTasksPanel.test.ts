import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BackgroundTasksPanel from './BackgroundTasksPanel.vue'

describe('BackgroundTasksPanel', () => {
  it('shows status, bounded literal output, pagination and cancellation', async () => {
    const wrapper = mount(BackgroundTasksPanel, { props: {
      sessionId: 's', expanded: 'job', busy: false, error: '',
      tasks: [{ id: 'job', threadId: 's', runId: 'r', command: 'sleep 900', state: 'running', delivery: 'pending', exitCode: null,
        truncated: false, createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:11:00Z', finishedAt: null }],
      output: { stdout: '<script>alert(1)</script>', stderr: 'diagnostic', nextOffset: 16384, truncated: true },
    } })
    expect(wrapper.text()).toContain('1 个运行中')
    expect(wrapper.text()).toContain('11 分 0 秒')
    expect(wrapper.find('script').exists()).toBe(false)
    await wrapper.findAll('button').find(b => b.text() === '取消')!.trigger('click')
    expect(wrapper.emitted('cancel')).toEqual([['job']])
    await wrapper.findAll('button').find(b => b.text() === '下一页')!.trigger('click')
    expect(wrapper.emitted('page')).toEqual([[true]])
  })
})
