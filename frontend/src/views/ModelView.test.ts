// seam: ModelView Model 配置页 —— issue #47 前端（spec §9.5）+ #857 owner 级（容器选择器
// 下线：provider 配置面扁平挂本人，mount 直拉本人 providers）。
// 覆盖：mount 拉 providers 渲染、重载竞态保最新响应、新建/编辑保存调 API + 热加载提示、
// 删除二次确认调 removeProvider。EP 组件用 stub；动作经 defineExpose 走方法级 seam
// （el-table row slot / el-form 在 stub 下渲染脆弱，以 expose 动作经 VM 驱动的既定做法）。
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/models', () => ({
  listProviders: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  removeProvider: vi.fn(),
}))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn() },
  }
})

import ModelView from '@/views/ModelView.vue'
import {
  createProvider,
  listProviders,
  removeProvider,
  updateProvider,
  type ModelProviderDTO,
} from '@/api/models'

const PROVIDER: ModelProviderDTO = {
  id: 1, provider_id: 'my-openai', api: 'openai-completions',
  base_url: 'https://open.bigmodel.cn/api/paas/v4', api_key_env_id: 'LLM_API_KEY',
  auth_header: true, models: [{ id: 'glm-4-plus', name: 'GLM-4 Plus' }],
  created_at: '2026-07-24T00:00:00Z',
}

const PAYLOAD = {
  provider_id: 'my-openai',
  api: 'openai-completions' as const,
  base_url: 'https://open.bigmodel.cn/api/paas/v4',
  api_key_env_id: 'LLM_API_KEY',
  auth_header: true,
  models: [{ id: 'glm-4-plus', name: 'GLM-4 Plus' }],
}

const stubs = {
  ElButton: {
    props: ['type', 'loading', 'size', 'disabled'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  ElTable: {
    props: { data: { type: Array, default: () => [] } },
    template:
      '<div data-test="provider-table">{{ (data||[]).map((r) => r.provider_id).join(",") }}</div>',
  },
  ElTableColumn: { template: '<span />' },
  ElDialog: {
    props: ['modelValue', 'title', 'width'],
    template:
      '<div v-if="modelValue" data-test="provider-dialog"><slot /></div>',
  },
  ElForm: { template: '<form><slot /></form>' },
  ElFormItem: { props: ['label'], template: '<div><slot /></div>' },
  ElInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  ElSelect: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>',
  },
  ElOption: { props: ['value', 'label'], template: '<option :value="value">{{ label }}</option>' },
  ElSwitch: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ModelView（#857 owner 级配置面）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads own providers on mount（owner 直取认证身份，无容器维度）', async () => {
    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([PROVIDER])
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(listProviders).toHaveBeenCalledWith()
    expect(wrapper.find('[data-test="provider-table"]').text()).toContain('my-openai')
  })

  it('keeps the latest response when a reload races an in-flight load', async () => {
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const slow = deferred<ModelProviderDTO[]>()
    const latestProvider = { ...PROVIDER, provider_id: 'latest-provider' }
    ;(listProviders as ReturnType<typeof vi.fn>).mockImplementation(
      () => slow.promise,
    )

    const vm = wrapper.vm as unknown as { loadProviders: () => Promise<void> }
    const first = vm.loadProviders()
    await flushPromises()
    expect(wrapper.find('[data-test="providers-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="provider-table"]').text()).not.toContain('my-openai')

    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([latestProvider])
    await vm.loadProviders()
    await flushPromises()
    expect(wrapper.find('[data-test="provider-table"]').text()).toContain('latest-provider')
    slow.resolve([PROVIDER])
    await first
    await flushPromises()
    expect(wrapper.find('[data-test="provider-table"]').text()).toContain('latest-provider')
    expect(wrapper.find('[data-test="provider-table"]').text()).not.toContain('my-openai')
  })

  it('opens create dialog', async () => {
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await wrapper.find('[data-test="open-create"]').trigger('click')
    expect(wrapper.find('[data-test="provider-dialog"]').exists()).toBe(true)
  })

  it('save in create mode calls createProvider and toasts hot-reload notice', async () => {
    ;(createProvider as ReturnType<typeof vi.fn>).mockResolvedValue(PROVIDER)
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as { save: (p: typeof PAYLOAD) => Promise<void> }).save(PAYLOAD)
    await flushPromises()
    expect(createProvider).toHaveBeenCalledWith(PAYLOAD)
    const { ElMessage } = await import('element-plus')
    expect(ElMessage.success).toHaveBeenCalled()
    // spec §9.5：保存提示「热加载即时生效」
    const toast = (ElMessage.success as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(String(toast)).toMatch(/热加载/)
  })

  it('save in edit mode calls updateProvider with pid', async () => {
    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([PROVIDER])
    ;(updateProvider as ReturnType<typeof vi.fn>).mockResolvedValue(PROVIDER)
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as {
      openEdit: (p: ModelProviderDTO) => void
      save: (p: typeof PAYLOAD) => Promise<void>
    }).openEdit(PROVIDER)
    await (wrapper.vm as unknown as { save: (p: typeof PAYLOAD) => Promise<void> }).save(PAYLOAD)
    await flushPromises()
    expect(updateProvider).toHaveBeenCalledWith('my-openai', PAYLOAD)
  })

  it('removes provider after confirmation', async () => {
    const { ElMessageBox } = await import('element-plus')
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockResolvedValue('confirm')
    ;(removeProvider as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as { confirmRemove: (pid: string) => Promise<void> }).confirmRemove('my-openai')
    await flushPromises()
    expect(removeProvider).toHaveBeenCalledWith('my-openai')
  })

  it('does not remove when user cancels confirmation', async () => {
    const { ElMessageBox } = await import('element-plus')
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cancel'))
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as { confirmRemove: (pid: string) => Promise<void> }).confirmRemove('my-openai')
    expect(removeProvider).not.toHaveBeenCalled()
  })

  it('warns and aborts save when required fields missing', async () => {
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as { save: (p: typeof PAYLOAD) => Promise<void> }).save({
      ...PAYLOAD, provider_id: '', base_url: '', api_key_env_id: '',
    })
    await flushPromises()
    const { ElMessage } = await import('element-plus')
    expect(ElMessage.warning).toHaveBeenCalled()
    expect(createProvider).not.toHaveBeenCalled()
  })
})
