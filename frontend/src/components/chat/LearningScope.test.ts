import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import LearningScope from './LearningScope.vue'
const api = vi.hoisted(() => ({ status: vi.fn(), courses: vi.fn(), scope: vi.fn(), set: vi.fn() }))
vi.mock('@/api/chaoxing', () => ({ getChaoxingStatus: api.status, listChaoxingCourses: api.courses, getLearningScope: api.scope, setLearningScope: api.set }))
describe('可选课程范围', () => {
  it('默认自动推荐，用户可以限定并解除课程范围', async () => {
    api.status.mockResolvedValue({ configured: true, connected: true })
    api.courses.mockResolvedValue({ rows: [{ id: 'c', name: '机器学习' }], truncated: false })
    api.scope.mockResolvedValue({ courseId: null })
    api.set.mockImplementation((_id: string, courseId: string | null) => Promise.resolve({ courseId }))
    const wrapper = mount(LearningScope, { props: { sessionId: 's', disabled: false }, global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain('自动推荐')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    await wrapper.get('select').setValue('c')
    await flushPromises()
    expect(api.set).toHaveBeenLastCalledWith('s', 'c')
    await wrapper.get('select').setValue('')
    await flushPromises()
    expect(api.set).toHaveBeenLastCalledWith('s', null)
  })
})
