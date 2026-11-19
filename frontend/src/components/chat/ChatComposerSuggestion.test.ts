import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatComposer from './ChatComposer.vue'

const props = { modelValue: '', matches: [], slashOpen: false, slashIndex: 0,
  connecting: false, streaming: false, disconnected: false, nextStepSuggestion: '请设计验证实验' }

describe('#1037 下一步提示', () => {
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
    w.unmount()
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
