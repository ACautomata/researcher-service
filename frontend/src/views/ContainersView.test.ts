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

const SAMPLE = {
  name: 'demo',
  port: 19000,
  status: 'running',
  health: 'healthy',
  image: 'img',
  container_id: 'cid',
  created_at: '2026-07-24T00:00:00Z',
}

const stubs = {
  ElButton: {
    props: ['type', 'loading', 'size'],
    template: '<button @click="$emit(\'click\')"><slot /></button>',
  },
  ElTable: {
    props: { data: { type: Array, default: () => [] } },
    // 渲染默认 slot：列定义（ElTableColumn stub）随之挂载，供「升级」列接线断言；行内容仍不渲染
    template:
      '<div data-test="instance-table"><slot />{{ (data||[]).map((r) => r.name).join(",") }}</div>',
  },
  ElTableColumn: { name: 'ElTableColumn', template: '<span />' },
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
    // 容器状态翻转（creating→running）、被外部停止等运行时变化须靠轮询反映。
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

  it('resumes polling after a timed-out refresh releases the in-flight guard', async () => {
    vi.useFakeTimers()
    ;(listInstances as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () => new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('请求超时', 'TimeoutError')), 15_000)
        }),
      )
      .mockResolvedValueOnce([])
    mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(listInstances).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15_000)
    await flushPromises()
    const callsAfterTimeout = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callsAfterTimeout).toBeGreaterThan(1)
    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterTimeout,
    )
  })

  // ---------------------------- #419-6 轮询可见性 + 错误去闪烁 ----------------------------

  it('#419-6: 标签页隐藏时暂停轮询，回前台恢复并立即刷新', async () => {
    vi.useFakeTimers()
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([])
    mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const callsAfterMount = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length

    // 隐藏 → 不再轮询
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(12_000)
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterMount)

    // 回前台 → 立即刷新一次 + 恢复轮询
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterMount,
    )
    const callsAfterVisible = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length
    await vi.advanceTimersByTimeAsync(6_000)
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterVisible,
    )
  })

  it('#419-6: 错误文案仅在内容变化时更新（同文案不闪烁）', async () => {
    // 后端持续故障：每次 refresh 失败都写入相同错误——文案不得以轮询频率重复更新
    // （旧实现每次 refresh 开头 errorMsg='' 再写回，同文案 3s 闪烁）。
    // 断言 DOM 节点引用：同文案不重建 <p class="error">。
    vi.useFakeTimers()
    ;(listInstances as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('backend down'))
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('backend down')

    const p1 = wrapper.find('p.error').element
    await vi.advanceTimersByTimeAsync(6_000) // 两轮失败（同文案）
    await flushPromises()
    const p2 = wrapper.find('p.error').element
    expect(p2).toBe(p1) // 同文案不重建节点（不闪烁）
    expect(wrapper.text()).toContain('backend down')

    // 文案变化（错误内容不同）→ 更新显示
    ;(listInstances as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))
    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(wrapper.text()).toContain('disk full')
  })

})
