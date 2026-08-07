import { readFileSync } from 'node:fs'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import App from '@/App.vue'

describe('application shell layout', () => {
  it('renders navigation and the routed page inside one height owner', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
        mocks: { $route: { name: 'chat' } },
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          RouterView: { template: '<section data-test="route-page" />' },
        },
      },
    })

    expect(wrapper.find('.app-shell').exists()).toBe(true)
    expect(wrapper.find('.app-nav').exists()).toBe(true)
    expect(wrapper.find('.app-content [data-test="route-page"]').exists()).toBe(true)
  })

  it('lets routed workspaces consume the shell content height instead of the viewport', () => {
    const app = readFileSync('src/App.vue', 'utf8')
    const pages = ['ChatView.vue', 'WikiView.vue', 'CategoriesView.vue']
      .map((name) => readFileSync(`src/views/${name}`, 'utf8'))
      .join('\n')

    expect(app).toMatch(/\.app-shell\s*{[^}]*height: 100svh/s)
    expect(app).toMatch(/\.app-content\s*{[^}]*flex: 1;[^}]*min-height: 0/s)
    expect(pages).not.toContain('100vh')
    expect(pages.match(/height: 100%;/g)).toHaveLength(3)
  })
})
