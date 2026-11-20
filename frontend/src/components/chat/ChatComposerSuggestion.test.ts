import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ChatComposer from './ChatComposer.vue'

const props = { modelValue: '', matches: [], slashOpen: false, slashIndex: 0,
  connecting: false, streaming: false, disconnected: false, nextStepSuggestion: '请设计验证实验' }

enableAutoUnmount(afterEach)

describe('#1040 下一步提示', () => {
  it('空输入展示灰字，Tab 只采用为草稿并保留焦点和末尾光标', async () => {
    const w = mount(ChatComposer, { props, attachTo: document.body })
    const input = w.get('textarea')
    expect(input.element.value).toBe('')
    expect(input.attributes('placeholder')).toBe('请设计验证实验')
    input.element.focus()
    await input.trigger('keydown', { key: 'Tab' })
    expect(w.emitted('acceptSuggestion')).toEqual([[]])
    expect(w.emitted('send')).toBeUndefined()
    await w.setProps({ modelValue: props.nextStepSuggestion })
    expect(input.element.selectionStart).toBe(props.nextStepSuggestion.length)
    expect(document.activeElement).toBe(input.element)
  })
  it('只在输入框获得焦点时拦截普通 Tab，采用后下一次 Tab 放行', async () => {
    const w = mount(ChatComposer, { props, attachTo: document.body })
    const input = w.get('textarea').element
    const tab = (modifiers: KeyboardEventInit = {}) =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, ...modifiers }))

    expect(tab()).toBe(true)
    input.focus()
    for (const modifier of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(tab(modifier)).toBe(true)
    }
    expect(w.emitted('acceptSuggestion')).toBeUndefined()
    expect(tab()).toBe(false)
    await w.setProps({ modelValue: props.nextStepSuggestion })
    expect(tab()).toBe(true)
    expect(w.emitted('acceptSuggestion')).toEqual([[]])
  })

  it('晚到的长提示可撑开输入框，输入后恢复草稿高度上限', async () => {
    const w = mount(ChatComposer, { props: { ...props, nextStepSuggestion: '' } })
    const input = w.get('textarea')
    // jsdom 无布局引擎，模拟浏览器报告的长提示或草稿滚动高度。
    Object.defineProperty(input.element, 'scrollHeight', { value: 210 })

    await w.setProps({ nextStepSuggestion: '请为这个假说设计一组验证实验'.repeat(8) })
    await nextTick()
    expect(input.element.style.height).toBe('210px')
    await w.setProps({ modelValue: '草稿'.repeat(100) })
    await nextTick()
    expect(input.element.style.height).toBe('180px')
  })

  it('已有输入不显示或采用，清空可重显', async () => {
    const w = mount(ChatComposer, { props: { ...props, modelValue: '自己的草稿' } })
    expect(w.get('textarea').attributes('placeholder')).not.toBe(props.nextStepSuggestion)
    await w.get('textarea').trigger('keydown', { key: 'Tab' })
    expect(w.emitted('acceptSuggestion')).toBeUndefined()
    await w.setProps({ modelValue: '' })
    expect(w.get('textarea').attributes('placeholder')).toBe(props.nextStepSuggestion)
  })
})
