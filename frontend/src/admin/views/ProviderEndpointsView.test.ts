// seam: ProviderEndpointsView —— admin 端点白名单管理页（#800）。
// 覆盖：列表渲染、新建（POST）、删除（二次确认 + 引用提示）、错误 toast。Element Plus stub
// （贴 AdminUsersView 模式）；行内动作经 defineExpose 方法级驱动。
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/providerEndpoints', () => ({
  listProviderEndpoints: vi.fn(),
  createProviderEndpoint: vi.fn(),
  removeProviderEndpoint: vi.fn(),
}))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn() },
  }
})

import ProviderEndpointsView from '@/admin/views/ProviderEndpointsView.vue'
import {
  listProviderEndpoints,
  createProviderEndpoint,
  removeProviderEndpoint,
} from '@/api/providerEndpoints'
import { ElMessage, ElMessageBox } from 'element-plus'

const ROWS = [
  {
    id: 'e1',
    scheme: 'https',
    host: 'api.openai.com',
    port: null,
    note: '官方',
    created_by: 'admin-id',
    created_at: '2026-10-01T00:00:00Z',
  },
  {
    id: 'e2',
    scheme: 'https',
    host: 'proxy.example.com',
    port: 8443,
    note: '',
    created_by: 'admin-id',
    created_at: '2026-10-02T00:00:00Z',
  },
]

const stubs = {
  ElButton: {
    props: ['type', 'loading', 'size'],
    template: '<button @click="$emit(\'click\')"><slot /></button>',
  },
  ElTable: { template: '<table><slot /></table>', props: ['data'] },
  ElTableColumn: { template: '<col />' },
  ElDialog: {
    props: ['modelValue', 'title'],
    template: '<div v-if="modelValue"><slot /><slot name="footer" /></div>',
  },
  ElForm: { template: '<form><slot /></form>' },
  ElFormItem: { template: '<div><slot /></div>', props: ['label'] },
  ElInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  ElInputNumber: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  ElSelect: { props: ['modelValue'], template: '<select><slot /></select>' },
  ElOption: { props: ['value', 'label'], template: '<option />' },
}

function mountView() {
  return mount(ProviderEndpointsView, { global: { stubs } })
}

describe('ProviderEndpointsView（#800 admin 白名单管理页）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('挂载加载列表 → 渲染行数', async () => {
    ;(listProviderEndpoints as ReturnType<typeof vi.fn>).mockResolvedValue(ROWS)
    const wrapper = mountView()
    await flushPromises()
    expect(listProviderEndpoints).toHaveBeenCalledTimes(1)
    expect((wrapper.vm as unknown as { rows: unknown[] }).rows).toHaveLength(2)
  })

  it('新建：submitCreate 校验 host 非空 → POST 成功后刷新列表', async () => {
    ;(listProviderEndpoints as ReturnType<typeof vi.fn>).mockResolvedValue(ROWS)
    ;(createProviderEndpoint as ReturnType<typeof vi.fn>).mockResolvedValue(ROWS[0])
    const wrapper = mountView()
    await flushPromises()
    const vm = wrapper.vm as unknown as {
      openCreate: () => void
      submitCreate: () => Promise<void>
      createVisible: boolean
      form: { scheme: string; host: string; port?: number; note: string }
    }
    vm.openCreate()
    expect(vm.createVisible).toBe(true)
    // host 为空 → 警告且不发请求
    await vm.submitCreate()
    expect(createProviderEndpoint).not.toHaveBeenCalled()
    expect(ElMessage.warning).toHaveBeenCalled()
    // 填 host → 创建成功 → dialog 关 + 刷新（2 次 list：挂载 + 刷新）
    vm.form.host = 'api.anthropic.com'
    vm.form.note = 'anthropic'
    await vm.submitCreate()
    expect(createProviderEndpoint).toHaveBeenCalledWith({
      scheme: 'https',
      host: 'api.anthropic.com',
      note: 'anthropic',
    })
    expect(vm.createVisible).toBe(false)
    expect(listProviderEndpoints).toHaveBeenCalledTimes(2)
    expect(ElMessage.success).toHaveBeenCalled()
  })

  it('删除：二次确认 → DELETE → 刷新；取消则不删', async () => {
    ;(listProviderEndpoints as ReturnType<typeof vi.fn>).mockResolvedValue(ROWS)
    const wrapper = mountView()
    await flushPromises()
    const vm = wrapper.vm as unknown as { removeRow: (id: string) => Promise<void> }
    // 取消（Once：不覆盖后续调用的 resolve）
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('cancel'))
    await vm.removeRow('e1')
    expect(removeProviderEndpoint).not.toHaveBeenCalled()
    // 确认 → DELETE + 刷新（list 共 2 次：挂载 + 删除后 refresh；取消分支不 refresh）
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await vm.removeRow('e1')
    expect(removeProviderEndpoint).toHaveBeenCalledWith('e1')
    expect(listProviderEndpoints).toHaveBeenCalledTimes(2)
  })

  it('列表加载失败 → 错误 toast', async () => {
    ;(listProviderEndpoints as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    mountView()
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalled()
  })
})
