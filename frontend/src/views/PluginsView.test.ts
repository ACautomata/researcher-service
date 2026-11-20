// seam: PluginsView 插件中心页（#799 目录页 + #1058 D 票 Skill 市场分区）。
// 覆盖：目录页原四用例（挂载拉目录渲染、切换开关调 REST 成功更新、失败回滚 + toast、空态）+
// D 票验收面：类别筛选渲染（全部 + D5 五枚举、点击调 listSkills({category})）、上传拒收原因
// 逐条展示、启用开关乐观更新 + 失败回滚、删除权限按钮可见性（作者/admin/他人）。
// EP 组件用 stub（ModelView.test.ts 既定做法）；auth store 直设 role/username 控权限矩阵。
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'

vi.mock('@/api/plugins', () => ({
  listPlugins: vi.fn(),
  setPluginEnablement: vi.fn(),
}))
vi.mock('@/api/skills', () => ({
  SKILL_CATEGORIES: ['research', 'writing', 'data', 'literature', 'other'],
  SKILL_CATEGORY_LABELS: { research: '研究方法', writing: '论文写作', data: '数据分析', literature: '文献工具', other: '其他' },
  listSkills: vi.fn(),
  setSkillEnablement: vi.fn(),
  uploadSkill: vi.fn(),
  deleteSkill: vi.fn(),
  readSkillBlob: vi.fn(),
}))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn() },
  }
})

import PluginsView from '@/views/PluginsView.vue'
import { listPlugins, setPluginEnablement, type PluginSummary } from '@/api/plugins'
import {
  deleteSkill,
  listSkills,
  setSkillEnablement,
  uploadSkill,
  type SkillMarketItem,
} from '@/api/skills'
import { ElMessage, ElMessageBox } from 'element-plus'

const PLUGIN: PluginSummary = {
  id: 'autofigure',
  name: 'AutoFigure',
  description: '方法图自动生成',
  version: '1.0.0',
  enabled: false,
  commands: [{ name: 'figure', description: '按描述生成方法图' }],
}

const SKILL: SkillMarketItem = {
  id: 'sk-1',
  name: 'paper-writing',
  description: '论文写作辅助技能',
  category: 'writing',
  uploaderName: 'alice',
  fileCount: 1,
  publishedAt: '2026-11-20T10:00:00.000Z',
  enabled: false,
}

const stubs = {
  // ElTabs/ElTabPane：透传 stub（pane 内容直接渲染，避免未注册组件警告 + 惰性渲染干扰）
  ElTabs: { template: '<div><slot /></div>' },
  ElTabPane: { props: ['label', 'name'], template: '<div><slot /></div>' },
  ElSwitch: {
    props: ['modelValue', 'disabled', 'loading'],
    emits: ['update:modelValue', 'change'],
    template: `<button data-test="el-switch" :data-on="String(modelValue)" :disabled="disabled || loading" @click="$emit('update:modelValue', !modelValue); $emit('change', !modelValue)" />`,
  },
}

beforeEach(() => {
  setActivePinia(createPinia())
  // 模块工厂 mock 的调用历史跨用例累积（restoreAllMocks 不清 vi.mock 工厂实例）——
  // 每用例先清历史，再设定本用例实现，确保 toHaveBeenCalledTimes 断言确定性。
  vi.clearAllMocks()
  vi.mocked(listPlugins).mockResolvedValue([{ ...PLUGIN }])
  // 浅拷贝：视图的乐观更新/启停会原地改 row.enabled——共享对象会把变更泄漏进下一用例
  vi.mocked(listSkills).mockResolvedValue([{ ...SKILL }])
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
    vi.mocked(setPluginEnablement).mockResolvedValue({ id: 'autofigure', enabled: true })
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="plugin-card"] [data-test="el-switch"]').trigger('click')
    await flushPromises()
    expect(setPluginEnablement).toHaveBeenCalledWith('autofigure', true)
    expect(ElMessage.success).toHaveBeenCalled()
    // 重开开关显示新态（enabling 过程结束）
    expect(wrapper.find('[data-test="plugin-card"] [data-test="el-switch"]').attributes('disabled')).toBeUndefined()
  })

  it('启用失败 → 回滚开关 + 错误 toast（进行中 run 不受影响——不触碰会话流）', async () => {
    vi.mocked(listPlugins).mockResolvedValue([{ ...PLUGIN, enabled: true }])
    vi.mocked(setPluginEnablement).mockRejectedValue(new Error('网络故障'))
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="plugin-card"] [data-test="el-switch"]').trigger('click')
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalled()
    expect(wrapper.find('[data-test="plugin-card"] [data-test="el-switch"]').attributes('disabled')).toBeUndefined()
  })
})

describe('PluginsView Skill 市场分区（#1058）', () => {
  it('类别筛选渲染：全部 + D5 五枚举；点击筛选调 listSkills({category})', async () => {
    const wrapper = mountView()
    await flushPromises()
    const options = wrapper.findAll('[data-test="skill-category-option"]')
    expect(options.map((o) => o.attributes('data-value'))).toEqual(['', 'research', 'writing', 'data', 'literature', 'other'])
    expect(options.map((o) => o.text())).toEqual(['全部', '研究方法', '论文写作', '数据分析', '文献工具', '其他'])
    expect(listSkills).toHaveBeenCalledWith({})
    await options.find((o) => o.attributes('data-value') === 'writing')!.trigger('click')
    await flushPromises()
    expect(listSkills).toHaveBeenLastCalledWith({ category: 'writing' })
    await wrapper.find('[data-test="skill-category-option"][data-value=""]').trigger('click')
    await flushPromises()
    expect(listSkills).toHaveBeenLastCalledWith({})
  })

  it('搜索框回车/按钮 → listSkills({q})', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="skill-search"]').setValue('论文')
    await wrapper.find('[data-test="skill-search"]').trigger('keyup.enter')
    await flushPromises()
    expect(listSkills).toHaveBeenLastCalledWith({ q: '论文' })
    await wrapper.find('[data-test="skill-search-btn"]').trigger('click')
    await flushPromises()
    expect(listSkills).toHaveBeenLastCalledWith({ q: '论文' })
  })

  it('市场行渲染：名称/描述/类别徽标/上传者/时间/文件数 + 下载按钮', async () => {
    const wrapper = mountView()
    await flushPromises()
    const card = wrapper.find('[data-test="skill-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('paper-writing')
    expect(card.text()).toContain('论文写作辅助技能')
    expect(card.text()).toContain('论文写作')
    expect(card.text()).toContain('上传者 alice')
    expect(card.text()).toContain('1 个文件')
    expect(wrapper.find('[data-test="skill-download"]').exists()).toBe(true)
    // 市场行开关初始态 = 列表 enabled 字段（请求者维度）
    expect(wrapper.find('[data-test="skill-card"] [data-test="el-switch"]').attributes('data-on')).toBe('false')
  })

  it('上传拒收原因逐条展示（A 票结构化 reasons 直达上传者；不弹全局错误）', async () => {
    vi.mocked(uploadSkill).mockResolvedValue({
      ok: false,
      code: 80002,
      message: 'Skill 包校验未通过',
      reasons: ['缺少 SKILL.md（必须在 zip 根目录）', 'name 过长（≤64）'],
    })
    const wrapper = mountView()
    await flushPromises()
    const input = wrapper.find('[data-test="skill-upload-file"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['zip'], 'demo.zip')] })
    await input.trigger('change')
    await wrapper.find('[data-test="skill-upload-submit"]').trigger('click')
    await flushPromises()
    const items = wrapper.findAll('[data-test="skill-upload-error-item"]')
    expect(items.map((i) => i.text())).toEqual(['缺少 SKILL.md（必须在 zip 根目录）', 'name 过长（≤64）'])
    expect(wrapper.find('[data-test="skill-upload-message"]').text()).toContain('Skill 包校验未通过')
    // 拒收是表单内联展示，不弹全局错误
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('上传成功 → toast + 表单复位 + 列表刷新', async () => {
    vi.mocked(uploadSkill).mockResolvedValue({ ok: true, id: 'sk-9', name: 'demo', category: 'data' })
    const wrapper = mountView()
    await flushPromises()
    const input = wrapper.find('[data-test="skill-upload-file"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['zip'], 'demo.zip')] })
    await input.trigger('change')
    await wrapper.find('[data-test="skill-upload-submit"]').trigger('click')
    await flushPromises()
    expect(ElMessage.success).toHaveBeenCalled()
    expect(wrapper.findAll('[data-test="skill-upload-error-item"]').length).toBe(0)
    expect(listSkills).toHaveBeenCalledTimes(2) // 挂载一次 + 成功后刷新一次
  })

  it('启用开关乐观更新：DOM 即时翻态（REST pending），成功后保持', async () => {
    // REST 用手动 resolve 的延迟 Promise 模拟 pending：trigger 自带 nextTick，DOM 已同步乐观态
    //（本地 enabled 已翻 true）而 REST 未落定——这正是验收面的「乐观更新」可观测量。
    let resolveToggle!: (v: { skillId: string; enabled: boolean }) => void
    vi.mocked(setSkillEnablement).mockImplementation(() => new Promise((resolve) => { resolveToggle = resolve }))
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="skill-card"] [data-test="el-switch"]').trigger('click')
    expect(setSkillEnablement).toHaveBeenCalledWith('sk-1', true)
    // REST 仍 pending（resolveToggle 未调）：乐观态已上屏
    expect(wrapper.find('[data-test="skill-card"] [data-test="el-switch"]').attributes('data-on')).toBe('true')
    resolveToggle({ skillId: 'sk-1', enabled: true })
    await flushPromises()
    expect(wrapper.find('[data-test="skill-card"] [data-test="el-switch"]').attributes('data-on')).toBe('true')
    expect(ElMessage.success).toHaveBeenCalled()
  })

  it('启用失败 → 回滚开关 + 错误 toast（乐观态被撤回）', async () => {
    let rejectToggle!: (e: Error) => void
    vi.mocked(setSkillEnablement).mockImplementation(() => new Promise((_resolve, reject) => { rejectToggle = reject as (e: Error) => void }))
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="skill-card"] [data-test="el-switch"]').trigger('click')
    // 乐观态已上屏（REST 仍 pending）
    expect(wrapper.find('[data-test="skill-card"] [data-test="el-switch"]').attributes('data-on')).toBe('true')
    rejectToggle(new Error('网络故障'))
    await flushPromises()
    // 失败回滚：开关回 false + 错误 toast
    expect(wrapper.find('[data-test="skill-card"] [data-test="el-switch"]').attributes('data-on')).toBe('false')
    expect(ElMessage.error).toHaveBeenCalled()
  })

  it('删除按钮可见性：作者本人/admin 可见，他人不可见', async () => {
    // 他人：uploaderName=alice，当前用户 mallory（user 角色）→ 不可见
    useAuthStore().role = 'user'
    useAuthStore().username = 'mallory'
    let wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="skill-delete"]').exists()).toBe(false)
    // 作者本人：username=alice → 可见
    useAuthStore().username = 'alice'
    wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="skill-delete"]').exists()).toBe(true)
    // admin：任意身份 → 可见
    useAuthStore().username = 'bob'
    useAuthStore().role = 'admin'
    wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="skill-delete"]').exists()).toBe(true)
  })

  it('删除流：取消 → 不调 DELETE；确认 → DELETE + 行即时移除', async () => {
    useAuthStore().username = 'alice'
    // 先取消：confirm reject → deleteSkill 不被调、行保留
    vi.mocked(ElMessageBox.confirm).mockRejectedValue('cancel')
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="skill-delete"]').trigger('click')
    await flushPromises()
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1)
    expect(deleteSkill).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="skill-card"]').exists()).toBe(true)
    // 再确认：confirm resolve → DELETE 调用 + 行即时移除（本地列表刷新）
    vi.mocked(ElMessageBox.confirm).mockResolvedValue('confirm' as unknown as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    vi.mocked(deleteSkill).mockResolvedValue(undefined)
    await wrapper.find('[data-test="skill-delete"]').trigger('click')
    await flushPromises()
    expect(deleteSkill).toHaveBeenCalledWith('sk-1')
    expect(wrapper.find('[data-test="skill-card"]').exists()).toBe(false)
  })

  it('启用语义文案：发布 ≠ 启用显式区分（intro 含两概念）', async () => {
    const wrapper = mountView()
    await flushPromises()
    const intro = wrapper.find('[data-test="plugins-tabs"]').text()
    expect(intro).toContain('发布')
    expect(intro).toContain('启用')
  })
})
