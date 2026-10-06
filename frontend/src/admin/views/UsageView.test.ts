// seam: UsageView —— admin Usage 核算页（#800）：按 user × provider × model 聚合（时间窗过滤）
// + 行合计。Element Plus stub；行为经 defineExpose 驱动。
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/usage', () => ({
  aggregateUsage: vi.fn(),
}))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  }
})

import UsageView from '@/admin/views/UsageView.vue'
import { aggregateUsage } from '@/api/usage'
import { ElMessage } from 'element-plus'

const ROWS = [
  {
    user_id: 'u1',
    username: 'alice',
    provider_id: 'p1',
    lc_provider: 'openai',
    model: 'gpt-x',
    calls: 2,
    input_tokens: 300,
    output_tokens: 130,
    cache_read_tokens: 10,
    cache_write_tokens: 0,
  },
  {
    user_id: 'u1',
    username: 'alice',
    provider_id: 'p1',
    lc_provider: 'openai',
    model: 'gpt-y',
    calls: 1,
    input_tokens: 100,
    output_tokens: 40,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  },
]

const stubs = {
  ElButton: {
    props: ['type', 'loading', 'size'],
    template: '<button @click="$emit(\'click\')"><slot /></button>',
  },
  ElTable: { template: '<table><slot /></table>', props: ['data'] },
  ElTableColumn: { template: '<col />' },
  ElForm: { template: '<form><slot /></form>', props: ['inline'] },
  ElFormItem: { template: '<div><slot /></div>', props: ['label'] },
  ElInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  ElDatePicker: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input />',
  },
}

function mountView() {
  return mount(UsageView, { global: { stubs } })
}

describe('UsageView（#800 admin Usage 核算页）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(aggregateUsage as ReturnType<typeof vi.fn>).mockResolvedValue(ROWS)
  })

  it('挂载加载聚合 → rows + 合计行（calls/tokens 求和）', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(aggregateUsage).toHaveBeenCalledTimes(1)
    const vm = wrapper.vm as unknown as { rows: unknown[]; totals: { calls: number; inputTokens: number; outputTokens: number } }
    expect(vm.rows).toHaveLength(2)
    expect(vm.totals).toEqual({ calls: 3, inputTokens: 400, outputTokens: 170 })
  })

  it('search 透传 userId 与时间窗 [from, to)；缺省不带参', async () => {
    const wrapper = mountView()
    await flushPromises()
    const vm = wrapper.vm as unknown as {
      filters: { userId: string; range: [Date, Date] | null }
      search: () => Promise<void>
    }
    const from = new Date('2026-10-01T00:00:00Z')
    const to = new Date('2026-10-08T00:00:00Z')
    vm.filters.userId = 'u1'
    vm.filters.range = [from, to]
    await vm.search()
    const [lastQuery] = (aggregateUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!
    expect(lastQuery).toEqual({ userId: 'u1', from, to })
    // 清空后 → 裸查询
    vm.filters.userId = ''
    vm.filters.range = null
    await vm.search()
    const [bare] = (aggregateUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!
    expect(bare).toEqual({})
  })

  it('加载失败 → 错误 toast', async () => {
    ;(aggregateUsage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    mountView()
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalled()
  })
})
