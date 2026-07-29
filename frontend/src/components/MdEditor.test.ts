// seam: MdEditor 组件 —— issue #45 Milkdown 实时渲染编辑器（spec §9.6）。
// 覆盖：挂载后用 content 初始化 Milkdown（Typora 式实时渲染，所见即所得）、
// 编辑器内 markdown 变化冒泡 update 事件（供 store 防抖自动保存）。
// Milkdown 在 jsdom 下真实初始化（ProseMirror DOM 可用），不测其内部，只测组件契约。
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MdEditor from '@/components/MdEditor.vue'

describe('MdEditor', () => {
  it('renders content into a milkdown editor (typora-style live render)', async () => {
    const wrapper = mount(MdEditor, { props: { content: '# 标题\n\n正文 [[link]]' } })
    await flushPromises()
    // Milkdown 把 markdown 渲染为 ProseMirror DOM（.milkdown 容器 + 可编辑区）
    expect(wrapper.find('.milkdown').exists()).toBe(true)
    // 标题被实时渲染为 h1（Typora 式所见即所得，非源码 + 预览分栏）
    expect(wrapper.find('h1').exists()).toBe(true)
    wrapper.unmount()
  })

  it('emits update with markdown when editor content changes', async () => {
    const wrapper = mount(MdEditor, { props: { content: '' } })
    await flushPromises()
    // 直接经组件暴露的方法注入新 markdown（模拟用户输入后 Milkdown 触发 markdownUpdated）
    await (wrapper.vm as unknown as { _emitMarkdown: (m: string) => void })._emitMarkdown('# 新')
    expect(wrapper.emitted('update')).toBeTruthy()
    expect(wrapper.emitted('update')![0]).toEqual(['# 新'])
    wrapper.unmount()
  })

  it('reloads when content prop changes to a different page', async () => {
    const wrapper = mount(MdEditor, { props: { content: '# A' } })
    await flushPromises()
    expect(wrapper.find('h1').text()).toBe('A')
    // 切换到另一页（打开新 md）→ 编辑器重载内容
    await wrapper.setProps({ content: '# B' })
    await flushPromises()
    expect(wrapper.find('h1').text()).toBe('B')
    wrapper.unmount()
  })

  it('is editable by default (contenteditable=true)', async () => {
    const wrapper = mount(MdEditor, { props: { content: '# A' } })
    await flushPromises()
    expect(wrapper.find('.ProseMirror').attributes('contenteditable')).toBe('true')
    wrapper.unmount()
  })

  it('readonly renders content but is not editable', async () => {
    const wrapper = mount(MdEditor, { props: { content: '# 只读', readonly: true } })
    await flushPromises()
    // 内容照常渲染为 ProseMirror DOM（只读 ≠ 不渲染）
    expect(wrapper.find('h1').exists()).toBe(true)
    // 但 ProseMirror 编辑区不可编辑（Categories 栏目只读阅读，issue #85）
    expect(wrapper.find('.ProseMirror').attributes('contenteditable')).toBe('false')
    wrapper.unmount()
  })

  // issue #202 问题1 回归（评审复现用例转正）：宿主受控用法（:content=draft + update 回写）
  // 下，emit 后的自回流不得触发 replaceAll——断言 .milkdown h1 的 DOM 引用不变
  it('skips replaceAll on controlled echo: h1 DOM reference stays stable (issue #202)', async () => {
    const wrapper = mount(MdEditor, { props: { content: '# A' } })
    await flushPromises()
    const h1Before = wrapper.find('.milkdown h1')
    expect(h1Before.exists()).toBe(true)
    // 模拟宿主受控回写：用户编辑 → emit → 父级把同一 markdown 写回 content prop（自回流）
    await (wrapper.vm as unknown as { _emitMarkdown: (m: string) => void })._emitMarkdown('# A 改')
    await wrapper.setProps({ content: '# A 改' })
    await flushPromises()
    // 自回流被豁免：未 replaceAll，h1 DOM 引用不变（修复前每次击键全文重建，引用必变）
    expect(wrapper.find('.milkdown h1').element).toBe(h1Before.element)
    expect(wrapper.find('.milkdown h1').text()).toBe('A')
    wrapper.unmount()
  })

  it('consecutive echoed keystrokes never rebuild the editor DOM (issue #202)', async () => {
    const wrapper = mount(MdEditor, { props: { content: '# A' } })
    await flushPromises()
    const pmBefore = wrapper.find('.ProseMirror').element
    const vm = wrapper.vm as unknown as { _emitMarkdown: (m: string) => void }
    // 连续击键的受控回写序列：每次都应命中 lastEmitted 豁免
    for (const m of ['# A1', '# A12', '# A123']) {
      await vm._emitMarkdown(m)
      await wrapper.setProps({ content: m })
      await flushPromises()
    }
    expect(wrapper.find('.ProseMirror').element).toBe(pmBefore)
    wrapper.unmount()
  })

  it('still reloads on real page switch after echoed edits (issue #202)', async () => {
    const wrapper = mount(MdEditor, { props: { content: '# A' } })
    await flushPromises()
    const vm = wrapper.vm as unknown as { _emitMarkdown: (m: string) => void }
    await vm._emitMarkdown('# A 改')
    await wrapper.setProps({ content: '# A 改' }) // 自回流：跳过
    await wrapper.setProps({ content: '# B' }) // 真换页（≠ lastEmitted）：必须重载
    await flushPromises()
    expect(wrapper.find('h1').text()).toBe('B')
    wrapper.unmount()
  })
})
