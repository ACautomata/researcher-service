import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import MediaAttachment from './MediaAttachmentHost.vue'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const media = { attachmentId: '123', fileName: 'result.png', mime: 'image/png', size: 12 }
function setup(body = 'bytes', headers: Record<string, string> = { 'Content-Type': 'image/png', 'Content-Disposition': 'inline' }) {
  const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(body, { headers }))
  vi.stubGlobal('fetch', fetch)
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:media')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  return { fetch, createObjectURL, revokeObjectURL }
}
it.each([['image/png', 'img'], ['audio/mpeg', 'audio'], ['video/mp4', 'video']])('嵌入 %s 媒体，经认证下载字节并在卸载时释放 URL', async (mime, tag) => {
  const { fetch, revokeObjectURL } = setup()
  const wrapper = mount(MediaAttachment, { props: { media: { ...media, mime } }, global: { plugins: [createPinia()] } })
  await flushPromises()
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/attachments/123/download')
  expect(wrapper.get(tag).attributes('src')).toBe('blob:media')
  if (tag !== 'img') expect(wrapper.get(tag).attributes('controls')).toBeDefined()
  wrapper.unmount()
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:media')
})
it('就位前不访问沙箱；就位成功后才加载媒体，失败可见', async () => {
  const { fetch } = setup()
  const wrapper = mount(MediaAttachment, { props: { media, readiness: 'pending' }, global: { plugins: [createPinia()] } })
  expect(wrapper.text()).toContain('正在就位')
  expect(fetch).not.toHaveBeenCalled()
  await wrapper.setProps({ readiness: 'ready' }); await flushPromises()
  expect(wrapper.find('img').exists()).toBe(true)
  await wrapper.setProps({ readiness: 'error' })
  expect(wrapper.text()).toContain('就位失败')
  wrapper.unmount()
})
it('JSON 文件按字节下载，业务错误信封显示错误', async () => {
  const { createObjectURL } = setup('{"result":42}', { 'Content-Type': 'application/json', 'Content-Disposition': 'inline; filename=result.json' })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const wrapper = mount(MediaAttachment, { props: { media: { ...media, mime: 'application/json', fileName: 'result.json' } }, global: { plugins: [createPinia()] } })
  await wrapper.get('[data-test="media-download"]').trigger('click'); await flushPromises()
  expect(await createObjectURL.mock.calls[0]![0].text()).toBe('{"result":42}')
  wrapper.unmount()
  setup('{"code":50002,"message":"附件不可用","data":null}', { 'Content-Type': 'application/json' })
  const failed = mount(MediaAttachment, { props: { media }, global: { plugins: [createPinia()] } })
  await flushPromises()
  expect(failed.get('[role="alert"]').text()).toContain('附件不可用')
  expect(failed.find('img').exists()).toBe(false)
  failed.unmount()
})
