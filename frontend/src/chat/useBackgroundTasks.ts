import { onBeforeUnmount, ref, watch } from 'vue'
import { cancelBackgroundTask, getBackgroundOutput, listBackgroundTasks, type BackgroundTask, type BackgroundOutput } from '@/api/backgroundTasks'

export function useBackgroundTasks(sessionId: () => string | null) {
  const tasks = ref<BackgroundTask[]>([])
  const output = ref<BackgroundOutput | null>(null)
  const expanded = ref<string | null>(null)
  const error = ref('')
  const busy = ref(false)
  let generation = 0
  let fetching = false
  let offset = 0
  async function refresh() {
    const session = sessionId(), token = generation
    if (!session || fetching) return
    fetching = true
    try {
      const rows = await listBackgroundTasks(session)
      if (token !== generation) return
      tasks.value = rows
      if (expanded.value) {
        const id = expanded.value
        const page = await getBackgroundOutput(session, id, offset)
        if (token === generation && id === expanded.value) output.value = page
      }
      error.value = ''
    } catch (e) { if (token === generation) error.value = String(e) }
    finally { fetching = false }
  }
  function open(id: string) {
    expanded.value = expanded.value === id ? null : id
    output.value = null
    offset = 0
    void refresh()
  }
  function page(next: boolean) {
    offset = next ? (output.value?.nextOffset ?? offset) : Math.max(0, offset - 16384)
    void refresh()
  }
  async function cancel(id: string) {
    const session = sessionId(), token = generation
    if (!session) return
    busy.value = true
    try { await cancelBackgroundTask(session, id); if (token === generation) await refresh() }
    catch (e) { if (token === generation) error.value = String(e) }
    finally { busy.value = false }
  }
  watch(sessionId, () => {
    generation++
    tasks.value = []; output.value = null; expanded.value = null; error.value = ''; offset = 0
    void refresh()
  }, { immediate: true })
  // Polling also covers missed SSE events and reconnects. Inactive panels do not retain requests.
  const timer = setInterval(() => { void refresh() }, 3000)
  onBeforeUnmount(() => { generation++; clearInterval(timer) })
  return { tasks, output, expanded, error, busy, refresh, open, page, cancel }
}
