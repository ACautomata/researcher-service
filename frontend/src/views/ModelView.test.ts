// seam: ModelView Model 配置页 —— #881 预设制换形：平台默认端点只读卡 + BYOK 端点 CRUD
//（预设下拉锁定协议/地址，无自由 baseURL 输入；key 掩码回显、编辑留空 = 保持不变）。
// EP 组件用 stub；动作经 defineExpose 走方法级 seam（el-table row slot / el-form 在 stub 下
// 渲染脆弱，以 expose 动作经 VM 驱动的既定做法）。
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/plugins', () => ({
  listLlmAssignments: vi.fn(),
  setLlmAssignment: vi.fn(),
  clearLlmAssignment: vi.fn(),
}))
vi.mock('@/api/models', () => ({
  listPresets: vi.fn(),
  getPlatformEndpoint: vi.fn(),
  listProviders: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  removeProvider: vi.fn(),
  getProviderImpact: vi.fn(),
  testConnection: vi.fn(),
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
import { clearLlmAssignment, listLlmAssignments, setLlmAssignment } from '@/api/plugins'
import {
  createProvider,
  getPlatformEndpoint,
  listPresets,
  listProviders,
  removeProvider,
  getProviderImpact,
  testConnection,
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
    // 行标识列：端点表 provider_id / 指派表 plugin_id 双形兼容（stub 双表共用）
    template:
      '<div data-test="provider-table">{{ (data||[]).map((r) => r.provider_id ?? r.plugin_id).join(",") }}</div>',
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
    ;(getProviderImpact as ReturnType<typeof vi.fn>).mockResolvedValue({ sessions: 2, teammates: 1, plugins: 3, judge: 1, total: 7 })
    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(listPresets as ReturnType<typeof vi.fn>).mockResolvedValue(PRESETS)
    ;(getPlatformEndpoint as ReturnType<typeof vi.fn>).mockResolvedValue(PLATFORM)
    ;(listLlmAssignments as ReturnType<typeof vi.fn>).mockResolvedValue({ targets: [], assignments: [] })
    ;(setLlmAssignment as ReturnType<typeof vi.fn>).mockResolvedValue({})
    ;(clearLlmAssignment as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
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
    expect(ElMessageBox.confirm).toHaveBeenCalledWith(expect.stringContaining('7 项将回落平台默认端点'), '删除端点', expect.any(Object))
    expect(ElMessageBox.confirm).toHaveBeenCalledWith(expect.stringContaining('会话偏好 2、插件指派 3、judge 指派 1、teammate 模型钉 1'), '删除端点', expect.any(Object))
    expect(removeProvider).toHaveBeenCalledWith('my-openai')
  })

  it('影响计数读取失败时提示错误，停止删除', async () => {
    const { ElMessageBox, ElMessage } = await import('element-plus')
    vi.mocked(getProviderImpact).mockRejectedValueOnce(new Error('影响计数读取失败'))
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as { confirmRemove: (pid: string) => Promise<void> }).confirmRemove('my-openai')
    expect(ElMessage.error).toHaveBeenCalledWith('影响计数读取失败')
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
    expect(removeProvider).not.toHaveBeenCalled()
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

  it('runProbe 按表单态试连：成功展示延迟（key 留空不发送）', async () => {
    ;(testConnection as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, latency_ms: 1234 })
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as { openCreate: () => void }).openCreate()
    // openCreate 预填 minimax 默认首条模型
    await (wrapper.vm as unknown as { runProbe: () => Promise<void> }).runProbe()
    await flushPromises()
    const call = (testConnection as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>
    expect(call.preset_id).toBe('minimax')
    expect(call.model).toBe('MiniMax-M3')
    expect('api_key' in call).toBe(false) // key 留空 = 试平台共享 key
    expect(wrapper.find('[data-test="probe-success"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="probe-success"]').text()).toContain('1234')
  })

  it('runProbe 失败：展示净化错误文本（不含 key），成功标记不出现', async () => {
    const { ApiError } = await import('@/api/client')
    ;(testConnection as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(200, 'Error 401: Incorrect API key [REDACTED]', 90003),
    )
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as { openCreate: () => void }).openCreate()
    await (wrapper.vm as unknown as { runProbe: () => Promise<void> }).runProbe()
    await flushPromises()
    expect(wrapper.find('[data-test="probe-success"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="probe-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="probe-error"]').text()).toContain('REDACTED')
  })

  it('runProbe：model 为空 → warning 且不发请求', async () => {
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as { openCreate: () => void }).openCreate()
    const vm = wrapper.vm as unknown as { runProbe: () => Promise<void>; _: { setupState: Record<string, unknown> } }
    const models = vm._.setupState.models as { value: Array<{ id: string }> } | Array<{ id: string }>
    const list = Array.isArray(models) ? models : models.value
    list[0]!.id = ''
    await vm.runProbe()
    const { ElMessage } = await import('element-plus')
    expect(ElMessage.warning).toHaveBeenCalled()
    expect(testConnection).not.toHaveBeenCalled()
  })
})

describe('ModelView 插件 LLM 指派区（#883 T3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(listProviders as ReturnType<typeof vi.fn>).mockResolvedValue([PROVIDER])
    ;(listPresets as ReturnType<typeof vi.fn>).mockResolvedValue(PRESETS)
    ;(getPlatformEndpoint as ReturnType<typeof vi.fn>).mockResolvedValue(PLATFORM)
    ;(setLlmAssignment as ReturnType<typeof vi.fn>).mockResolvedValue({})
    ;(clearLlmAssignment as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })

  const vm = (wrapper: { vm: unknown }) =>
    wrapper.vm as unknown as {
      openAssign: (t: { plugin_id: string; description: string }) => Promise<void>
      submitAssign: () => Promise<void>
      confirmClearAssign: (t: { plugin_id: string; description: string }) => Promise<void>
    }

  it('指派区渲染 targets（声明插件 ∪ judge）与当前指派显示', async () => {
    ;(listLlmAssignments as ReturnType<typeof vi.fn>).mockResolvedValue({
      targets: [
        { plugin_id: 'autofigure', description: 'SVG 模板多模态生成', default_model: 'MiniMax-M3' },
        { plugin_id: 'judge', description: '审批判定器（审批灰区调用的 LLM 模型）' },
      ],
      assignments: [{ plugin_id: 'autofigure', provider_id: 'my-openai', model_id: 'gpt-5.1', updated_at: '2026-10-01T00:00:00Z' }],
    })
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="assignment-table"]').exists()).toBe(true)
    // ElTable stub 行体渲染行标识（provider_id ?? plugin_id）——指派显示串在 row slot 内，
    // stub 不展开（本文件 seam 纪律：断言止于 stub 可渲染面）
    expect(wrapper.text()).toContain('autofigure')
    expect(wrapper.text()).toContain('judge')
    expect(wrapper.find('[data-test="assignment-table"]').text()).toBe('judge,autofigure')
    expect(wrapper.text()).toContain('默认链 primary（首端点首模型）')
  })

  it('指派动作：选端点+模型 → PUT {provider_id, model_id}；空端点 = 跟随默认链（null 行）', async () => {
    ;(listLlmAssignments as ReturnType<typeof vi.fn>).mockResolvedValue({
      targets: [{ plugin_id: 'autofigure', description: 'SVG' }],
      assignments: [],
    })
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const actions = vm(wrapper)
    await actions.openAssign({ plugin_id: 'autofigure', description: 'SVG' })
    // 端点/模型状态经 VM 直写（el-select stub 双向绑定脆弱，expose 动作既定做法）
    ;(wrapper.vm as unknown as { assignEndpoint: string }).assignEndpoint = 'my-openai'
    ;(wrapper.vm as unknown as { assignModel: string }).assignModel = 'gpt-5.1'
    await actions.submitAssign()
    expect(setLlmAssignment).toHaveBeenCalledWith('autofigure', { provider_id: 'my-openai', model_id: 'gpt-5.1' })
    ;(wrapper.vm as unknown as { assignEndpoint: string }).assignEndpoint = ''
    ;(wrapper.vm as unknown as { assignModel: string }).assignModel = ''
    await actions.submitAssign()
    expect(setLlmAssignment).toHaveBeenLastCalledWith('autofigure', { provider_id: null, model_id: null })
  })

  it('撤回指派 → DELETE 回默认链', async () => {
    ;(listLlmAssignments as ReturnType<typeof vi.fn>).mockResolvedValue({
      targets: [{ plugin_id: 'judge', description: '审批判定器' }],
      assignments: [{ plugin_id: 'judge', provider_id: 'platform', model_id: 'MiniMax-M3', updated_at: 'x' }],
    })
    const wrapper = mount(ModelView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await vm(wrapper).confirmClearAssign({ plugin_id: 'judge', description: '审批判定器' })
    expect(clearLlmAssignment).toHaveBeenCalledWith('judge')
  })
})
