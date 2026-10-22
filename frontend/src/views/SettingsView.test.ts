import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import SettingsView from './SettingsView.vue'
const api = vi.hoisted(() => ({ status: vi.fn(), unlink: vi.fn(), authorize: vi.fn() }))
vi.mock('@/api/chaoxing', () => ({ getChaoxingStatus: api.status, unlinkChaoxing: api.unlink, authorizeChaoxing: api.authorize }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))
describe('超星账号设置', () => {
  it('展示绑定状态，解绑后恢复绑定入口', async () => {
    api.status.mockResolvedValueOnce({ configured: true, connected: true }).mockResolvedValueOnce({ configured: true, connected: false })
    api.unlink.mockResolvedValue(null)
    const wrapper = mount(SettingsView)
    await flushPromises()
    expect(wrapper.text()).toContain('已绑定')
    await wrapper.get('[data-test="chaoxing-unlink"]').trigger('click')
    await flushPromises()
    expect(api.unlink).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-test="chaoxing-bind"]').text()).toContain('绑定超星')
  })
})
