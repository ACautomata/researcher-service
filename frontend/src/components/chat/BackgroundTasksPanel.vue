<script setup lang="ts">
import { computed } from 'vue'
import type { BackgroundTask, BackgroundOutput } from '@/chat/backgroundTaskTypes'

const props = defineProps<{
  tasks: BackgroundTask[]; sessionId: string; expanded: string | null
  output: BackgroundOutput | null; error: string; busy: boolean
}>()
defineEmits<{ open: [id: string]; cancel: [id: string]; page: [next: boolean]; refresh: [] }>()
const labels: Record<string, string> = { starting: '启动中', running: '运行中', succeeded: '成功', failed: '失败', timed_out: '超时', cancelled: '已取消', interrupted: '中断' }
const delivery: Record<string, string> = { pending: '结果待处理', delivered: '结果已送达', suppressed: '不再自动处理' }
const active = computed(() => props.tasks.filter(t => ['starting', 'running'].includes(t.state)).length)
function elapsed(task: BackgroundTask) {
  const seconds = Math.max(0, Math.floor((Date.parse(task.finishedAt ?? task.updatedAt) - Date.parse(task.createdAt)) / 1000))
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
</script>

<template>
  <details class="background-panel" data-test="background-tasks">
    <summary>后台任务 <span>{{ active }} 个运行中 · {{ tasks.length }} 个任务</span></summary>
    <div class="panel-body">
      <p v-if="error" role="alert">{{ error }} <button @click="$emit('refresh')">重试</button></p>
      <p v-if="!tasks.length" class="empty">暂无后台任务。超过前台等待时限的命令将在此显示。</p>
      <article v-for="task in tasks" :key="task.id" class="task" :data-state="task.state">
        <div class="task-heading">
          <button class="command" :aria-expanded="expanded === task.id" @click="$emit('open', task.id)">{{ task.command }}</button>
          <strong>{{ labels[task.state] ?? task.state }}</strong>
          <button v-if="['starting', 'running'].includes(task.state)" :disabled="busy" @click="$emit('cancel', task.id)">取消</button>
        </div>
        <div class="metadata">
          <span>{{ task.executorName ?? (task.threadId === sessionId ? '主助手' : '协作者') }}</span>
          <span>{{ elapsed(task) }}</span>
          <span v-if="task.exitCode !== null">退出码 {{ task.exitCode }}</span>
          <span v-if="!['starting', 'running'].includes(task.state)">{{ delivery[task.delivery] }}</span>
        </div>
        <div v-if="expanded === task.id" class="output">
          <small>任务 {{ task.id }}</small>
          <template v-if="output">
            <p v-if="output.truncated" class="notice">输出已达到保存或显示上限。</p>
            <h4>标准输出</h4><pre>{{ output.stdout || '（暂无输出）' }}</pre>
            <h4>标准错误</h4><pre>{{ output.stderr || '（暂无输出）' }}</pre>
            <button @click="$emit('page', false)">上一页</button>
            <button :disabled="output.nextOffset === null" @click="$emit('page', true)">下一页</button>
          </template>
          <p v-else>正在加载输出…</p>
        </div>
      </article>
    </div>
  </details>
</template>

<style scoped>
.background-panel { margin: 8px 20px; border: 1px solid var(--el-border-color); border-radius: 10px; font-size: 13px; }
summary { cursor: pointer; padding: 10px 12px; font-weight: 600; }
summary span, .metadata, .empty { color: var(--el-text-color-secondary); font-weight: 400; }
.panel-body { max-height: 40vh; overflow: auto; padding: 0 12px 12px; }
.task { padding: 10px 0; border-top: 1px solid var(--el-border-color-lighter); }
.task-heading, .metadata { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.command { flex: 1; text-align: left; overflow-wrap: anywhere; min-width: 140px; font-family: monospace; }
button { cursor: pointer; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-bg-color); color: var(--el-text-color-primary); padding: 4px 8px; }
button:disabled { opacity: .5; cursor: default; }
.metadata { margin-top: 6px; font-size: 12px; }
.output { margin-top: 10px; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto; padding: 8px; background: var(--el-fill-color-light); }
h4 { margin: 8px 0 4px; }
.notice { color: var(--el-color-warning); }
</style>
