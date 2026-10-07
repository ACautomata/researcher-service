// seam: PluginsView 插件目录页（#799 · #752 §4 能力可见性唯一入口 / 默认未启用一键启用）。
// 覆盖：挂载拉目录渲染（名称/描述/版本/命令/启用态）、切换开关调 REST 成功更新、失败回滚 +
// toast。EP 组件用 stub（ModelView.test.ts 既定做法）。
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/plugins', () => ({
  listPlugins: vi.fn(),
  setPluginEnablement: vi.fn(),
}))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  }
})

import PluginsView from '@/views/PluginsView.vue'
import { listPlugins, setPluginEnablement, type PluginSummary } from '@/api/plugins'
import { ElMessage } from 'element-plus'

const PLUGIN: PluginSummary = {
  id: 'autofigure',
  name: 'AutoFigure',
  description: '方法图自动生成',
  version: '1.0.0',
  enabled: false,
  commands: [{ name: 'figure', description: '按描述生成方法图' }],
}

const stubs = {
  ElSwitch: {
    props: ['modelValue', 'disabled', 'loading'],
    emits: ['update:modelValue', 'change'],
    template: `<button data-test="el-switch" :data-on="String(modelValue)" :disabled="disabled || loading" @click="$emit('update:modelValue', !modelValue); $emit('change', !modelValue)" />`,
  },
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mountView() {
  return mount(PluginsView, { global: { stubs } })
}

describe('PluginsView 目录页（#799）', () => {
  it('挂载拉目录：渲染名称/描述/版本/命令与启用态', async () => {
    vi.mocked(listPlugins).mockResolvedValue([PLUGIN])
    const wrapper = mountView()
    await flushPromises()
    const card = wrapper.find('[data-test="plugin-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('AutoFigure')
    expect(card.text()).toContain('方法图自动生成')
    expect(card.text()).toContain('1.0.0')
    expect(card.text()).toContain('/figure')
    // 默认未启用（Q16：无行 = 未启用）——开关初始态与 enabled 同步
    expect(wrapper.find('[data-test="el-switch"]').attributes('data-on')).toBe('false')
  })

  it('目录为空 → 空态', async () => {
    vi.mocked(listPlugins).mockResolvedValue([])
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="plugin-empty"]').exists()).toBe(true)
  })

  it('一键启用：切换调 PUT 成功 → 本地态更新 + 成功 toast', async () => {
    vi.mocked(listPlugins).mockResolvedValue([PLUGIN])
    vi.mocked(setPluginEnablement).mockResolvedValue({ id: 'autofigure', enabled: true })
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="el-switch"]').trigger('click')
    await flushPromises()
    expect(setPluginEnablement).toHaveBeenCalledWith('autofigure', true)
    expect(ElMessage.success).toHaveBeenCalled()
    // 重开开关显示新态（enabling 过程结束）
    expect(wrapper.find('[data-test="el-switch"]').attributes('disabled')).toBeUndefined()
  })

  it('启用失败 → 回滚开关 + 错误 toast（进行中 run 不受影响——不触碰会话流）', async () => {
    vi.mocked(listPlugins).mockResolvedValue([{ ...PLUGIN, enabled: true }])
    vi.mocked(setPluginEnablement).mockRejectedValue(new Error('网络故障'))
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="el-switch"]').trigger('click')
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalled()
    expect(wrapper.find('[data-test="el-switch"]').attributes('disabled')).toBeUndefined()
  })
})
