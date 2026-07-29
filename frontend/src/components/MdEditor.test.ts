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
})

describe('MdEditor — issue #202 问题1 回归（受控回写循环）', () => {
  it('echo write-back does not rebuild editor DOM (skip replaceAll on self-echo)', async () => {
    // 模拟宿主受控用法（WikiView: :content=draft + update 回写 store.edit）：
    // 用户编辑 → emit → 父级把同一 markdown 写回 content prop → watch 必须跳过 replaceAll，
    // 否则每次击键全文重建、选区锚定 DOM 被销毁（评审实测复现：h1 DOM 引用变化）。
    const wrapper = mount(MdEditor, { props: { content: '# A' } })
    await flushPromises()
    const h1Before = wrapper.find('.milkdown h1').element
    expect(h1Before.textContent).toBe('A')

    // 用户敲了一个字符：编辑器 emit 新 markdown，父级受控回写同一值
    await (wrapper.vm as unknown as { _emitMarkdown: (m: string) => void })._emitMarkdown('# A改')
    await wrapper.setProps({ content: '# A改' })
    await flushPromises()

    // DOM 引用必须保持不变（未触发 replaceAll 重建）
    expect(wrapper.find('.milkdown h1').element).toBe(h1Before)
    wrapper.unmount()
  })

  it('still reloads when switching to a different page (content != lastEmitted)', async () => {
    const wrapper = mount(MdEditor, { props: { content: '# A' } })
    await flushPromises()
    await (wrapper.vm as unknown as { _emitMarkdown: (m: string) => void })._emitMarkdown('# A改')
    // 换页：父级传入与 lastEmitted 不同的内容 → 仍须 replaceAll 重载
    await wrapper.setProps({ content: '# B' })
    await flushPromises()
    expect(wrapper.find('.milkdown h1').element.textContent).toBe('B')
    wrapper.unmount()
  })
})
