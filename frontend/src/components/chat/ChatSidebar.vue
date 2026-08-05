<script setup lang="ts">
// 左栏：容器 + 会话列表（#316：#340 拆分边界，props-in/emits-out 哑组件）。
import type { InstanceDTO } from '@/api/containers'
import type { SessionDTO } from '@/chat/gatewayChat'

defineProps<{
  instances: InstanceDTO[]
  sessions: SessionDTO[]
  selectedContainer: string
  selectedSession: string
}>()

const emit = defineEmits<{
  selectContainer: [name: string]
  selectSession: [key: string]
  removeSession: [key: string]
  newSession: []
}>()

defineSlots<{
  'empty'?: (props: {}) => unknown
}>()

function sessionTitle(s: SessionDTO): string {
  return s.title || s.session_key.slice(0, 8)
}
</script>

<template>
  <aside class="side">
    <h3>容器</h3>
    <ul class="list">
      <li
        v-for="inst in instances"
        :key="inst.name"
        :class="['pill', { active: inst.name === selectedContainer }]"
        :data-test="`container-${inst.name}`"
        @click="emit('selectContainer', inst.name)"
      >
        <span class="dot" :class="{ off: inst.status !== 'running' }"></span>{{ inst.name }}
      </li>
    </ul>
    <h3>会话</h3>
    <ul class="list">
      <li
        v-for="s in sessions"
        :key="s.session_key"
        :class="['sess', { active: s.session_key === selectedSession }]"
        :data-test="`session-${s.session_key}`"
        @click="emit('selectSession', s.session_key)"
      >
        <span class="sess-title">{{ sessionTitle(s) }}</span>
        <!-- T3 删除会话：@click.stop 防止触发 li 的 pickSession；二次确认由父注入（removeSession 内） -->
        <button
          class="sess-del"
          title="删除会话"
          :data-test="`delete-session-${s.session_key}`"
          @click.stop="emit('removeSession', s.session_key)"
        >✕</button>
      </li>
      <slot name="empty" />
    </ul>
    <button class="ghost" data-test="new-session" @click="emit('newSession')">＋ 新会话</button>
  </aside>
</template>

<style scoped>
.side { width: 220px; border-right: 1px solid var(--el-border-color); padding: 12px; overflow-y: auto; }
.side h3 { font-size: 12px; color: var(--el-text-color-secondary); text-transform: uppercase; margin: 8px 0 4px; }
.list { list-style: none; padding: 0; margin: 0; }
.pill, .sess { padding: 7px 10px; border-radius: 7px; cursor: pointer; color: var(--el-text-color-regular); }
.pill { display: flex; align-items: center; gap: 8px; background: var(--el-fill-color-light); margin-bottom: 4px; }
.sess { font-size: 13px; color: var(--el-text-color-secondary); display: flex; align-items: center; gap: 6px; }
.sess .sess-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess .sess-del { flex: none; background: transparent; border: none; color: var(--el-text-color-placeholder); cursor: pointer; font-size: 12px; padding: 0 2px; border-radius: 4px; }
.sess .sess-del:hover { color: var(--el-color-danger); }
.pill.active, .sess.active { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--el-color-success); }
.dot.off { background: var(--el-text-color-disabled); }
.ghost { width: 100%; margin-top: 8px; background: transparent; border: 1px dashed var(--el-border-color); border-radius: 7px; padding: 6px; cursor: pointer; color: var(--el-text-color-secondary); }
</style>
