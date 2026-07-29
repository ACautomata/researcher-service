// seam: ContainersView 容器管理页 —— issue #39 前端（spec §9.3）。
// 覆盖：mount 拉列表渲染、新建对话框提交调 createInstance、删除二次确认调 removeInstance。
// Element Plus 组件用 stub（聚焦交互逻辑）；删除经 defineExpose 暴露的 confirmRemove 走 seam
// （el-table row scoped slot 在 stub 下渲染脆弱，故删除走方法级 seam）。
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/containers', () => ({
  listInstances: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
}))
vi.mock('@/api/chat', () => ({
  triggerPair: vi.fn(),
}))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn() },
  }
})

import ContainersView from '@/views/ContainersView.vue'
import { createInstance, listInstances, removeInstance } from '@/api/containers'
import { triggerPair } from '@/api/chat'

const SAMPLE = {
  name: 'demo',
  port: 19000,
  status: 'running',
  health: 'healthy',
  image: 'img',
  container_id: 'cid',
  created_at: '2026-07-24T00:00:00Z',
  pairing: { status: 'unpaired', device_id: '', scopes: [], pairing_request_id: '' },
}

const stubs = {
  ElButton: {
    props: ['type', 'loading', 'size'],
    template: '<button @click="$emit(\'click\')"><slot /></button>',
  },
  ElTable: {
    props: { data: { type: Array, default: () => [] } },
    template:
      '<div data-test="instance-table">{{ (data||[]).map((r) => r.name).join(",") }}</div>',
  },
  ElTableColumn: { template: '<span />' },
  ElDialog: {
    props: ['modelValue', 'title', 'width'],
    template:
      '<div v-if="modelValue" data-test="create-dialog"><slot /><slot name="footer" /></div>',
  },
  ElForm: { template: '<form><slot /></form>' },
  ElFormItem: { props: ['label'], template: '<div><slot /></div>' },
  ElInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input data-test="name-input" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
}

describe('ContainersView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches and renders instances on mount', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE])
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(listInstances).toHaveBeenCalled()
    expect(wrapper.find('[data-test="instance-table"]').text()).toContain('demo')
  })

  it('shows error message when list fails', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('未登录或登录已过期'))
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('未登录或登录已过期')
  })

  it('opens dialog, submits name, and creates instance', async () => {
    ;(createInstance as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE)
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()

    await wrapper.find('[data-test="open-create"]').trigger('click')
    expect(wrapper.find('[data-test="create-dialog"]').exists()).toBe(true)

    await wrapper.find('[data-test="name-input"]').setValue('demo')
    await wrapper.find('[data-test="submit-create"]').trigger('click')
    await flushPromises()

    expect(createInstance).toHaveBeenCalledWith('demo')
  })

  it('removes instance after confirmation', async () => {
    const { ElMessageBox } = await import('element-plus')
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockResolvedValue('confirm')
    ;(removeInstance as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()

    await (wrapper.vm as unknown as { confirmRemove: (n: string) => Promise<void> }).confirmRemove(
      'demo',
    )
    await flushPromises()
    expect(removeInstance).toHaveBeenCalledWith('demo')
  })

  it('does not remove when user cancels confirmation', async () => {
    const { ElMessageBox } = await import('element-plus')
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cancel'))
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()

    await (wrapper.vm as unknown as { confirmRemove: (n: string) => Promise<void> }).confirmRemove(
      'demo',
    )
    expect(removeInstance).not.toHaveBeenCalled()
  })

  it('polls the list periodically while mounted and stops on unmount (codex R2 :78)', async () => {
    // 新起 gateway 由 unhealthy 转 healthy、容器被外部停止等运行时变化须靠轮询反映。
    vi.useFakeTimers()
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const callsAfterMount = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callsAfterMount).toBeGreaterThanOrEqual(1) // mount 时已拉一次

    await vi.advanceTimersByTimeAsync(3000) // 一个轮询周期
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterMount,
    )

    const callsBeforeUnmount = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(9000) // 卸载后多过一个周期也不再调
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeUnmount)
  })

  it('skips a poll tick while the previous refresh is still in flight (codex R3 :89)', async () => {
    // 一次 list 超过 3s（多个不可达实例串行 2s 健康探测）时，下一 tick 须跳过，
    // 避免叠加并发 Docker/health 请求、乱序完成覆盖较新状态。
    vi.useFakeTimers()
    // listInstances 一直 pending（模拟慢请求），永不 resolve
    ;(listInstances as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    // mount 触发的第一次 refresh 仍在飞
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    // 推进多个轮询周期：因上一次未完成，后续 tick 全被跳过，不再新增调用
    await vi.advanceTimersByTimeAsync(9000)
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  // issue #202 问题6 回归：标签页隐藏时暂停轮询，恢复可见时立即补拉并恢复周期
  it('pauses polling while the tab is hidden and resumes on visibility (issue #202)', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    ;(listInstances as ReturnType<typeof vi.fn>).mockClear() // 相对计数（隔离 mount 首拉与其他用例残留）

    // 切到后台：轮询暂停，推进多个周期也零请求
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(9000)
    expect(listInstances).not.toHaveBeenCalled()

    // 恢复可见：立即补拉，随后周期恢复
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    const resumed = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length
    expect(resumed).toBeGreaterThanOrEqual(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(resumed)
    wrapper.unmount()
  })

  // issue #202 问题6 回归：持续故障时错误文案稳定（仅变化时更新），不以 3s 频率闪烁
  it('keeps error text stable across failing poll ticks (no flicker)', async () => {
    vi.useFakeTimers()
    ;(listInstances as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('后端不可达'))
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(wrapper.find('.error').text()).toContain('后端不可达')
    // 多个失败 tick 后文案仍在（修复前每 tick 开头清空→失败重写，视觉上 3s 闪烁）
    await vi.advanceTimersByTimeAsync(6000)
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(wrapper.find('.error').text()).toContain('后端不可达')
    // 恢复成功后错误被清除
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE])
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(wrapper.find('.error').exists()).toBe(false)
    wrapper.unmount()
  })

  // ---------------------------- 配对状态（issue #40）----------------------------

  it('loads pairing status from listInstances payload', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...SAMPLE, pairing: { status: 'paired', scopes: ['operator.read'] } },
    ])
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(listInstances).toHaveBeenCalled()
    expect((wrapper.vm as unknown as { pairingStatus: (n: string) => string }).pairingStatus('demo')).toBe('paired')
  })

  it('triggerPair calls the api and refreshes pairing status', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE])
    ;(triggerPair as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'pending', pairing_request_id: 'r1' })
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()

    await (wrapper.vm as unknown as { pair: (n: string) => Promise<void> }).pair('demo')
    await flushPromises()
    expect(triggerPair).toHaveBeenCalledWith('demo')
    // pending 态提示宿主 approve（验收 3 重试路径）
    const { ElMessage } = await import('element-plus')
    expect(ElMessage.warning).toHaveBeenCalled()
  })
})
