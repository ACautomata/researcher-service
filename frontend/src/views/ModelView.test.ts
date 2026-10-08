// seam: ModelView Model 配置页 —— #881 预设制换形：平台默认端点只读卡 + BYOK 端点 CRUD
//（预设下拉锁定协议/地址，无自由 baseURL 输入；key 掩码回显、编辑留空 = 保持不变）。
// EP 组件用 stub；动作经 defineExpose 走方法级 seam（el-table row slot / el-form 在 stub 下
// 渲染脆弱，以 expose 动作经 VM 驱动的既定做法）。
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/models', () => ({
  listPresets: vi.fn(),
  getPlatformEndpoint: vi.fn(),
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
  getPlatformEndpoint,
  listPresets,
  listProviders,
  removeProvider,
  updateProvider,
  type EndpointPresetDTO,
  type ModelProviderDTO,
  type PlatformEndpointDTO,
} from '@/api/models'

const PLATFORM: PlatformEndpointDTO = {
  provider_id: 'platform',
  preset_id: 'minimax',
  protocol: 'anthropic-messages',
  lc_provider: 'anthropic',
  base_url: 'https://api.minimaxi.com/anthropic',
  default_model: 'MiniMax-M3',
  key_configured: true,
}

const PRESETS: EndpointPresetDTO[] = [
  { id: 'minimax', name: 'MiniMax（平台默认）', protocol: 'anthropic-messages', base_url: 'https://api.minimaxi.com/anthropic', default_models: [{ id: 'MiniMax-M3', name: 'MiniMax M3' }] },
  { id: 'openai', name: 'OpenAI', protocol: 'openai-completions', base_url: 'https://api.openai.com/v1', default_models: [{ id: 'gpt-5.1', name: 'GPT-5.1' }] },
]

const PROVIDER: ModelProviderDTO = {
  id: 'row-1', provider_id: 'my-openai', preset_id: 'openai', protocol: 'openai-completions',
  base_url: 'https://api.openai.com/v1', api_key_masked: 'sk-••••abcd', key_error: false,
  models: [{ id: 'gpt-5.1', name: 'GPT-5.1' }],
  created_at: '2026-10-01T00:00:00Z',
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
  ElCard: { template: '<div data-test="platform-card"><slot name="header" /><slot /></div>' },
  ElTag: { props: ['type'], template: '<span data-test="platform-key-status"><slot /></span>' },
  ElDialog: {
    props: ['modelValue', 'title', 'width'],
    template:
      '<div v-if="modelValue" data-test="provider-dialog"><slot /></div>',
  },
  ElForm: { template: '<form><slot /></form>' },
  ElFormItem: { props: ['label'], template: '<div><slot /></div>' },
  ElInput: {
    props: ['modelValue', 'type', 'placeholder'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" :data-placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  ElSelect: {
    props: ['modelValue'],
    emits: ['update:modelValue', 'change'],
    template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value); $emit(\'change\', $event.target.value)"><slot /></select>',
  },
  ElOption: { props: ['value', 'label'], template: '<option :value="value">{{ label }}</option>' },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ModelView（#881 预设制配置面）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(listPresets as ReturnType<typeof vi.fn>).mockResolvedValue(PRESETS)
    ;(getPlatformEndpoint as ReturnType<typeof vi.fn>).mockResolvedValue(PLATFORM)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mount 拉平台卡 + 预设目录 + 本人端点（三面并行）', async () => {
    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([PROVIDER])
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(getPlatformEndpoint).toHaveBeenCalledWith()
    expect(listPresets).toHaveBeenCalledWith()
    expect(wrapper.find('[data-test="platform-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="platform-key-status"]').text()).toContain('平台 key 已配置')
    expect(wrapper.text()).toContain('MiniMax-M3')
    expect(wrapper.find('[data-test="provider-table"]').text()).toContain('my-openai')
  })

  it('platform key 未配置 → 危险态标记（任何展示面无 key 材料）', async () => {
    ;(getPlatformEndpoint as ReturnType<typeof vi.fn>).mockResolvedValue({ ...PLATFORM, key_configured: false })
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="platform-key-status"]').text()).toContain('未配置')
    expect(wrapper.text()).not.toContain('sk-')
  })

  it('key 掩码回显：掩码显示 / 解密失败标记 / 平台共享占位', async () => {
    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      PROVIDER,
      { ...PROVIDER, provider_id: 'broken', key_error: true, api_key_masked: null },
      { ...PROVIDER, provider_id: 'shared', api_key_masked: null, key_error: false },
    ])
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const vm = wrapper.vm as unknown as { _: { setupState: Record<string, unknown> } }
    const keyDisplay = vm._.setupState.keyDisplay as (p: ModelProviderDTO) => string
    expect(keyDisplay(PROVIDER)).toBe('sk-••••abcd')
    expect(keyDisplay({ ...PROVIDER, key_error: true, api_key_masked: null })).toContain('解密失败')
    expect(keyDisplay({ ...PROVIDER, api_key_masked: null })).toBe('平台共享 key')
  })

  it('keeps the latest response when a reload races an in-flight load', async () => {
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const slow = deferred<ModelProviderDTO[]>()
    const latestProvider = { ...PROVIDER, provider_id: 'latest-provider' }
    ;(listProviders as ReturnType<typeof vi.fn>).mockImplementation(
      () => slow.promise,
    )

    const vm = wrapper.vm as unknown as { loadAll: () => Promise<void> }
    const first = vm.loadAll()
    await flushPromises()
    expect(wrapper.find('[data-test="providers-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="provider-table"]').text()).not.toContain('my-openai')

    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([latestProvider])
    await vm.loadAll()
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

  it('save in create mode sends preset-shaped payload (no base_url); empty key omitted', async () => {
    ;(createProvider as ReturnType<typeof vi.fn>).mockResolvedValue(PROVIDER)
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as {
      save: (p: { provider_id: string; preset_id: string; api_key?: string; models: Array<{ id: string }> }) => Promise<void>
    }).save({ provider_id: 'my-openai', preset_id: 'openai', models: [{ id: 'gpt-5.1' }] })
    await flushPromises()
    const call = (createProvider as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>
    expect(call.preset_id).toBe('openai')
    expect('base_url' in call).toBe(false) // 无自由 baseURL 输入
    expect('api_key' in call).toBe(false) // 留空 = 平台共享 key
    const { ElMessage } = await import('element-plus')
    const toast = (ElMessage.success as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(String(toast)).toMatch(/热加载/)
  })

  it('save with plain key passes it through (单向流：只在写请求出现)', async () => {
    ;(createProvider as ReturnType<typeof vi.fn>).mockResolvedValue(PROVIDER)
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as {
      save: (p: { provider_id: string; preset_id: string; api_key?: string; models: Array<{ id: string }> }) => Promise<void>
    }).save({ provider_id: 'k', preset_id: 'openai', api_key: 'sk-plain', models: [{ id: 'g' }] })
    await flushPromises()
    const call = (createProvider as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>
    expect(call.api_key).toBe('sk-plain')
  })

  it('save in edit mode calls updateProvider with pid', async () => {
    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([PROVIDER])
    ;(updateProvider as ReturnType<typeof vi.fn>).mockResolvedValue(PROVIDER)
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as { openEdit: (p: ModelProviderDTO) => void }).openEdit(PROVIDER)
    await (wrapper.vm as unknown as {
      save: (p: { provider_id: string; preset_id: string; api_key?: string; models: Array<{ id: string }> }) => Promise<void>
    }).save({ provider_id: 'my-openai', preset_id: 'openai', models: [{ id: 'gpt-5.1' }] })
    await flushPromises()
    expect(updateProvider).toHaveBeenCalledWith('my-openai', expect.objectContaining({ preset_id: 'openai' }))
  })

  it('preset 切换预填默认模型（锁定协议与地址面）', async () => {
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const vm = wrapper.vm as unknown as { openCreate: () => void; onPresetChange: () => void; _: { setupState: Record<string, unknown> } }
    vm.openCreate()
    await flushPromises()
    vm.onPresetChange()
    const models = vm._.setupState.models as { value: Array<{ id: string }> } | Array<{ id: string }>
    const list = Array.isArray(models) ? models : models.value
    expect(list[0]?.id).toBe('MiniMax-M3') // minimax 预设默认首条
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
    await (wrapper.vm as unknown as {
      save: (p: { provider_id: string; preset_id: string; api_key?: string; models: Array<{ id: string }> }) => Promise<void>
    }).save({ provider_id: '', preset_id: 'openai', models: [{ id: 'g' }] })
    await flushPromises()
    const { ElMessage } = await import('element-plus')
    expect(ElMessage.warning).toHaveBeenCalled()
    expect(createProvider).not.toHaveBeenCalled()
  })
})
