import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import NotFoundView from '@/views/NotFoundView.vue'

describe('NotFoundView', () => {
  it('explains the unknown route and links back to the application', () => {
    const wrapper = mount(NotFoundView, {
      global: {
        stubs: {
          RouterLink: {
            props: ['to'],
            template: '<a :href="to"><slot /></a>',
          },
        },
      },
    })

    expect(wrapper.get('[data-test="not-found"]').text()).toContain('404')
    expect(wrapper.text()).toContain('页面不存在')
    expect(wrapper.get('a').attributes('href')).toBe('/')
  })
})
