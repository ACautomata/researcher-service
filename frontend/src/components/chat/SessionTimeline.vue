<script setup lang="ts">
import { ref } from 'vue'
import type { SessionProjection } from '@/api/sessions'
import SessionTurn from './SessionTurn.vue'
const props = defineProps<{ projection: SessionProjection }>()
const expanded = ref(new Set<string>())
function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id); else next.add(id)
  expanded.value = next
}
const statuses: Record<string, string> = { queued: '排队中', running: '运行中', waiting: '等待来信', suspended: '等待审批', completed: '已完成', failed: '已停止', archived: '已归档' }
</script>
<template>
  <div class="session-timeline">
    <section data-test="leader-timeline" aria-label="主对话">
      <article v-for="message in props.projection.messages" :key="message.id" :class="['message', message.role]">
        <span class="speaker">{{ message.role === 'user' ? '你' : '主助手' }}</span>
        <SessionTurn :turn="message" />
      </article>
      <article v-if="projection.inFlight" class="message assistant" data-test="leader-live">
        <span class="speaker">主助手 · 正在运行</span>
        <SessionTurn :turn="projection.inFlight.turn" streaming />
      </article>
    </section>
    <section v-if="projection.teammates?.length" class="team" aria-label="协作队友">
      <article v-for="peer in projection.teammates" :key="peer.id" class="teammate" :data-teammate-id="peer.id">
        <button type="button" data-test="teammate-toggle" :aria-expanded="expanded.has(peer.id)" :aria-controls="`teammate-${peer.id}`" @click="toggle(peer.id)">
          <span>{{ expanded.has(peer.id) ? '▾' : '▸' }} {{ peer.name }}</span>
          <span class="status">{{ statuses[peer.status] ?? peer.status }}</span>
        </button>
        <div v-if="expanded.has(peer.id)" :id="`teammate-${peer.id}`" class="peer-history">
          <p class="task">{{ peer.task }}</p>
          <SessionTurn v-for="message in peer.messages" :key="message.id" :turn="message" />
          <SessionTurn v-if="peer.inFlight" :turn="peer.inFlight.turn" streaming />
          <details v-if="peer.mailbox.length"><summary>通信记录 · {{ peer.mailbox.length }}</summary>
            <p v-for="mail in peer.mailbox" :key="mail.id">{{ mail.senderTeammateId === peer.id ? '发出' : '收到' }}：{{ mail.content }}</p>
          </details>
        </div>
      </article>
    </section>
  </div>
</template>
<style scoped>
.session-timeline { max-width: 880px; margin: auto; padding: 24px; }
.message { padding: 16px; margin: 0 0 16px; border-radius: 12px; background: var(--el-fill-color-light); }
.message.user { margin-left: 12%; }
.speaker, .status, .task { color: var(--el-text-color-secondary); font-size: 13px; }
.team { display: grid; gap: 12px; }
.teammate { border: 1px solid var(--el-border-color); border-radius: 10px; overflow: hidden; }
.teammate > button { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 12px 16px; border: 0; background: var(--el-fill-color-light); color: var(--el-text-color-primary); text-align: left; cursor: pointer; }
.peer-history { padding: 12px 16px; }
.peer-history p { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
