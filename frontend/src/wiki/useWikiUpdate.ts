import { computed, onBeforeUnmount, ref } from 'vue'
import { startWikiUpdate } from '@/api/wiki'
import { useEventStream, type SessionEvent } from '@/chat/useEventStream'

export function useWikiUpdate(onFinished: () => Promise<void>) {
  const busy = ref(false)
  const message = ref('')
  const detail = ref('')
  let runId = ''
  let pending = false
  let alive = true
  let interrupted = false
  const earlyEvents: SessionEvent[] = []
  const stages: Record<string, string> = {
    planning: '规划中', generating: '生成中', finalizing: '收尾中',
    replanning: '重新规划中', noop: '无需更新',
  }
  function receive(event: SessionEvent) {
    if (!event.type.startsWith('wiki_run.')) return
    if (pending) {
      if (earlyEvents.length < 200) earlyEvents.push(event)
      return
    }
    if (!runId || event.runId !== runId) return
    if (event.type === 'wiki_run.progress') {
      const p = event.payload
      message.value = stages[String(p.stage)] ?? '更新中'
      detail.value = [typeof p.page === 'string' ? p.page : '',
        typeof p.completedCount === 'number' && typeof p.pageCount === 'number' ? `${p.completedCount}/${p.pageCount}` : '',
      ].filter(Boolean).join(' · ')
    } else if (event.type === 'wiki_run.finished') {
      busy.value = false
      runId = ''
      message.value = event.payload.outcome === 'completed' ? '更新完成'
        : event.payload.outcome === 'conflict' ? '更新冲突，请重试' : '更新失败，请重试'
      detail.value = ''
      void onFinished().catch(() => { message.value += '；页面刷新失败，请重新打开' })
    }
  }
  function lostProgress() {
    if (!busy.value) return
    interrupted = true
    // No replay/status endpoint exists for independent runs. Never claim success after a gap.
    // A launch request keeps its lock until its HTTP response settles.
    if (!pending) busy.value = false
    runId = ''
    message.value = '更新进度连接中断，结果未知；请刷新查看，或重试检查是否仍在更新'
    void onFinished().catch(() => {})
  }
  const stream = useEventStream({ onEvent: receive, onDisconnect: lostProgress, onGap: lostProgress })
  onBeforeUnmount(() => { alive = false; stream.close() })
  async function start(container: string) {
    if (busy.value || pending || !container) return
    if (stream.status.value !== 'open') {
      message.value = '正在连接更新进度，请稍后重试'
      return
    }
    interrupted = false
    busy.value = true
    pending = true
    message.value = '正在启动更新…'
    detail.value = ''
    try {
      const result = await startWikiUpdate(container)
      if (!alive || interrupted) return
      runId = result.runId
      message.value = '规划中'
      pending = false
      for (const event of earlyEvents.splice(0)) receive(event)
    } catch (error) {
      busy.value = false
      message.value = '更新未启动'
      throw error
    } finally {
      pending = false
      if (interrupted) busy.value = false
      earlyEvents.length = 0
    }
  }
  return { busy, message, detail, start, connected: computed(() => stream.status.value === 'open') }
}
