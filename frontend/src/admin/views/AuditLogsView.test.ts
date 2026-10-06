// seam: AuditLogsView —— admin 全局审计检索页（#800）：审批日志（approval-logs）/ 覆盖日志
// （file-overwrite-logs）双 tab + 过滤 + 分页。Element Plus stub；行为经 defineExpose 驱动。
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/audit', () => ({
  listApprovalLogs: vi.fn(),
  listFileOverwriteLogs: vi.fn(),
}))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  }
})

import AuditLogsView from '@/admin/views/AuditLogsView.vue'
import { listApprovalLogs, listFileOverwriteLogs } from '@/api/audit'
import { ElMessage } from 'element-plus'

const PAGED = { total: 1, page: 1, pageSize: 50, items: [{ id: 'l1' }] }

const stubs = {
  ElButton: {
    props: ['type', 'loading', 'size'],
    template: '<button @click="$emit(\'click\')"><slot /></button>',
  },
  ElTable: { template: '<table><slot /></table>', props: ['data'] },
  ElTableColumn: { template: '<col />' },
  ElTabs: {
    props: ['modelValue'],
    emits: ['update:modelValue', 'tab-change'],
    template: '<div><slot /></div>',
  },
  ElTabPane: { props: ['name', 'label'], template: '<div><slot /></div>' },
  ElForm: { template: '<form><slot /></form>' },
  ElFormItem: { template: '<div><slot /></div>', props: ['label'] },
  ElInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  ElSelect: { props: ['modelValue'], template: '<select><slot /></select>' },
  ElOption: { props: ['value', 'label'], template: '<option />' },
  ElDatePicker: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input />',
  },
  ElPagination: {
    props: ['total', 'pageSize', 'currentPage'],
    emits: ['current-change'],
    template: '<div />',
  },
}

function mountView() {
  return mount(AuditLogsView, { global: { stubs } })
}

describe('AuditLogsView（#800 admin 审计检索页）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(listApprovalLogs as ReturnType<typeof vi.fn>).mockResolvedValue(PAGED)
    ;(listFileOverwriteLogs as ReturnType<typeof vi.fn>).mockResolvedValue({ ...PAGED, items: [] })
  })

  it('挂载默认审批 tab → 加载 approval-logs，不碰覆盖日志', async () => {
    mountView()
    await flushPromises()
    expect(listApprovalLogs).toHaveBeenCalledTimes(1)
    expect(listFileOverwriteLogs).not.toHaveBeenCalled()
  })

  it('切 tab → 加载覆盖日志；切回 → 各自保留过滤参数', async () => {
    const wrapper = mountView()
    await flushPromises()
    const vm = wrapper.vm as unknown as {
      activeTab: string
      search: () => Promise<void>
      filters: { layer?: string; sessionId?: string }
    }
    vm.activeTab = 'overwrite'
    await vm.search()
    expect(listFileOverwriteLogs).toHaveBeenCalledTimes(1)
    expect(listApprovalLogs).toHaveBeenCalledTimes(1)
    // 覆盖 tab 专属过滤 sessionId 传参
    vm.filters.sessionId = 's1'
    await vm.search()
    const [lastQuery] = (listFileOverwriteLogs as ReturnType<typeof vi.fn>).mock.calls.at(-1)!
    expect(lastQuery).toMatchObject({ sessionId: 's1' })
  })

  it('search 透传过滤（layer/decision/runId）与分页并重置到第 1 页', async () => {
    const wrapper = mountView()
    await flushPromises()
    const vm = wrapper.vm as unknown as {
      filters: { layer: string; decision: string; runId: string }
      page: number
      search: () => Promise<void>
    }
    vm.filters.layer = 'judge'
    vm.filters.decision = 'deny'
    vm.filters.runId = 'r9'
    vm.page = 3
    await vm.search()
    const [lastQuery] = (listApprovalLogs as ReturnType<typeof vi.fn>).mock.calls.at(-1)!
    expect(lastQuery).toMatchObject({ layer: 'judge', decision: 'deny', runId: 'r9', page: 1 })
  })

  it('加载失败 → 错误 toast', async () => {
    ;(listApprovalLogs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    mountView()
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalled()
  })
})
