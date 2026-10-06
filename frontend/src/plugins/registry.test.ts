// #788 前端 vitest：插件渲染注册表（#752 §2.4）——查找/回退/ToolLine 挂点。
import { describe, expect, it, afterEach } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { definePluginWeb } from './api'
import { pluginComponentFor, registerPluginWeb, unregisterPluginWeb } from './registry'
import ToolLine from '@/components/chat/ToolLine.vue'

const DemoCard = defineComponent({
  props: { details: { type: null, required: false }, state: { type: String, required: false }, toolCallId: { type: String, required: false } },
  template: '<div data-test="demo-card">{{ details.figureId }}:{{ state }}</div>',
})

const demoWeb = definePluginWeb({ components: { demo_tool: DemoCard } })

afterEach(() => unregisterPluginWeb(demoWeb))

describe('#788 plugin render registry (web face)', () => {
  it('looks up registered tool components and falls back to undefined otherwise', () => {
    expect(pluginComponentFor('demo_tool')).toBeUndefined()
    registerPluginWeb(demoWeb)
    expect(pluginComponentFor('demo_tool')).toBe(DemoCard)
    expect(pluginComponentFor('other_tool')).toBeUndefined()
  })

  it('ToolLine renders the registered component with parsed details in the expanded area', async () => {
    registerPluginWeb(demoWeb)
    const wrapper = mount(ToolLine, {
      props: { tool: { id: 'c1', name: 'demo_tool', state: 'done', title: 'demo_tool', input: '{"x":1}', result: '{"figureId":"f1"}' } },
    })
    await wrapper.find('summary').trigger('click')
    const card = wrapper.find('[data-test="demo-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('f1')
    expect(card.text()).toContain('done')
    // 默认输入/输出详情不渲染（custom-render 分支替换，非并存第二条管线）
    expect(wrapper.find('[data-test="tool-detail"]').text()).not.toContain('输入')
  })

  it('ToolLine keeps the default rendering (input/output detail) for unregistered tools', async () => {
    const wrapper = mount(ToolLine, {
      props: { tool: { id: 'c2', name: 'core_tool', state: 'done', title: 'core_tool', input: '{}', result: 'plain' } },
    })
    await wrapper.find('summary').trigger('click')
    expect(wrapper.find('[data-test="demo-card"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="tool-detail"]').text()).toContain('输出')
  })
})
