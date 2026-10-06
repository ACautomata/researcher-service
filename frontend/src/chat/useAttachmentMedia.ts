// #795 媒体读取宿主：管理认证字节读取、取消和 Blob URL 生命周期。
import { computed, onScopeDispose, ref, watch } from 'vue'
import type { MediaRef } from '@/api/sessions'
import { readAttachmentBlob } from '@/api/attachments'

export function useAttachmentMedia(props: { media: MediaRef; readiness: 'pending' | 'ready' | 'error' }) {
  const url = ref('')
  const error = ref('')
  const loading = ref(false)
  const kind = computed(() => {
    const mime = props.media.mime.toLowerCase().split(';')[0] ?? ''
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(mime)) return 'image'
    if (mime.startsWith('audio/')) return 'audio'
    if (mime.startsWith('video/')) return 'video'
    return 'file'
  })
  let generation = 0
  let controller: AbortController | undefined
  let inflight: Promise<void> | undefined
  function reset(): void {
    generation++
    controller?.abort()
    if (url.value) URL.revokeObjectURL(url.value)
    url.value = ''; error.value = ''; loading.value = false; inflight = undefined
  }
  async function load(): Promise<void> {
    if (url.value || props.readiness !== 'ready') return
    if (inflight) return inflight
    const current = generation
    controller = new AbortController()
    loading.value = true
    error.value = ''
    inflight = (async () => {
      try {
        const blob = await readAttachmentBlob(props.media.attachmentId, controller?.signal)
        if (current !== generation) return
        url.value = URL.createObjectURL(blob)
      } catch (cause) {
        if (current === generation) error.value = cause instanceof Error ? cause.message : '附件加载失败'
      } finally {
        if (current === generation) { loading.value = false; inflight = undefined }
      }
    })()
    return inflight
  }
  watch(() => [props.media.attachmentId, props.media.mime, props.readiness], () => {
    reset()
    if (kind.value !== 'file') void load()
  }, { immediate: true })
  onScopeDispose(reset)
  async function download(): Promise<void> {
    const current = generation
    await load()
    if (!url.value || current !== generation) return
    const link = document.createElement('a')
    link.href = url.value
    link.download = props.media.fileName || '附件'
    link.click()
  }
  return { url, error, loading, kind, load, download }
}
