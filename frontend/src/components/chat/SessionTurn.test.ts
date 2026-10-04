import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import SessionTurn from './SessionTurn.vue'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('downloads a JSON attachment as bytes without treating it as an error envelope', async () => {
  const body = '{"result":42}'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'inline; filename="result.json"' } })))
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:result')
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const wrapper = mount(SessionTurn, { props: { turn: { content: '', media: [{ attachmentId: 'a', fileName: 'result.json', mime: 'application/json', size: body.length }] } }, global: { plugins: [createPinia()] } })
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(createObjectURL).toHaveBeenCalledOnce()
  expect(await createObjectURL.mock.calls[0]![0].text()).toBe(body)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  wrapper.unmount()
})
