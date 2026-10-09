import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive, ref } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useWikiUpdate } from '@/wiki/useWikiUpdate'
import type { EventStreamHandlers } from '@/chat/useEventStream'

import App from '@/App.vue'

const { auth, replace } = vi.hoisted(() => ({
  auth: {
    role: '',
    isAuthenticated: false,
    logout: vi.fn(),
  },
  replace: vi.fn(),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => reactive(auth),
}))

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ replace }),
}))

describe('App navigation', () => {
  beforeEach(() => {
    auth.role = ''
    auth.isAuthenticated = false
    auth.logout.mockReset()
    replace.mockReset()
  })

  it('主动退出后跳转登录页', async () => {
    auth.logout.mockResolvedValue(undefined)
    replace.mockResolvedValue(undefined)
    const wrapper = mount(App, {
      global: {
        mocks: { $route: { name: 'chat' } },
        stubs: { RouterLink: true, RouterView: true },
      },
    })

    await wrapper.get('[data-test="nav-logout"]').trigger('click')
    await flushPromises()

    expect(auth.logout).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith('/login')
    expect(auth.logout.mock.invocationCallOrder[0]).toBeLessThan(replace.mock.invocationCallOrder[0])
  })

})

vi.mock('@/api/wiki', () => ({ startWikiUpdate: vi.fn(async () => ({ runId: 'wiki-run' })) }))
let wikiHandlers: EventStreamHandlers
const closeWikiStream = vi.fn()
vi.mock('@/chat/useEventStream', () => ({ useEventStream: vi.fn((handlers: EventStreamHandlers) => {
  wikiHandlers = handlers
  return { status: ref('open'), close: closeWikiStream }
}) }))

it('Wiki 更新跨路由保持进度并收到终态；退出登录销毁缓存和订阅', async () => {
  auth.isAuthenticated = true
  closeWikiStream.mockClear()
  auth.logout.mockImplementation(async () => { reactive(auth).isAuthenticated = false })
  const refreshWiki = vi.fn(async () => {})
  const Wiki = defineComponent({ name: 'WikiView', setup() {
    const update = useWikiUpdate(refreshWiki)
    return () => h('div', [
      h('button', { 'data-test': 'start-wiki', onClick: update.start }, '更新'),
      h('span', { 'data-test': 'wiki-status' }, update.message.value),
    ])
  } })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/wiki', component: Wiki },
    { path: '/models', component: { template: '<div>模型配置</div>' } },
  ] })
  await router.push('/wiki')
  const wrapper = mount(App, { global: { plugins: [router] } })
  await flushPromises()
  await wrapper.get('[data-test="start-wiki"]').trigger('click')
  await flushPromises()
  await router.push('/models')
  await flushPromises()
  expect(closeWikiStream).not.toHaveBeenCalled()
  wikiHandlers.onEvent({ type: 'wiki_run.progress', runId: 'wiki-run', payload: { stage: 'generating' } })
  await router.push('/wiki')
  await flushPromises()
  expect(wrapper.get('[data-test="wiki-status"]').text()).toBe('生成中')
  await router.push('/models')
  wikiHandlers.onEvent({ type: 'wiki_run.finished', runId: 'wiki-run', payload: { outcome: 'completed' } })
  await router.push('/wiki')
  await flushPromises()
  expect(wrapper.get('[data-test="wiki-status"]').text()).toBe('更新完成')
  expect(refreshWiki).toHaveBeenCalledOnce()
  await router.push('/models')
  await wrapper.get('[data-test="nav-logout"]').trigger('click')
  await flushPromises()
  expect(closeWikiStream).toHaveBeenCalledOnce()
  wrapper.unmount()
})
