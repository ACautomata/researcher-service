<script setup lang="ts">
// 对话页（spec §9.4，照 docs/prototypes/oc-chat-page.html，MVP 简化）。
// 左栏容器+会话；主区消息流式逐字 + 末尾闪烁光标；断线/错误提示。
// WS 经 /ws/chat/（JWT subprotocol，复用 T02 中间件）；多容器切换 = 切 ChatWebSocket。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { listInstances, type InstanceDTO } from '@/api/containers'
import { createSession, listSessions, type SessionDTO } from '@/api/chat'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/client'
import { ChatWebSocket } from '@/chat/ws'

interface Msg {
  role: 'user' | 'assistant'
  text: string
  streaming: boolean
}

const auth = useAuthStore()
const instances = ref<InstanceDTO[]>([])
const sessions = ref<SessionDTO[]>([])
const selectedContainer = ref('')
const selectedSession = ref('')
const messages = ref<Msg[]>([])
const input = ref('')
const errorMsg = ref('')
const connecting = ref(false)
let ws: ChatWebSocket | null = null
let disposed = false

const currentSessionTitle = computed(() => {
  const s = sessions.value.find((x) => x.session_key === selectedSession.value)
  return s?.title || (s ? s.session_key.slice(0, 8) : '') || ''
})

// 是否有助手消息正在流式；并发 send 会让旧 streaming 消息永久卡住光标，故流式中禁发
const streaming = computed(() => messages.value.some((m) => m.role === 'assistant' && m.streaming))

async function loadInstances() {
  try {
    instances.value = await listInstances()
    if (instances.value.length && !selectedContainer.value) {
      await selectContainer(instances.value[0].name)
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  }
}

async function selectContainer(name: string) {
  if (!name || selectedContainer.value === name) return
  selectedContainer.value = name
  messages.value = []
  errorMsg.value = ''
  try {
    sessions.value = await listSessions(name)
    selectedSession.value = sessions.value[0]?.session_key ?? ''
    if (!selectedSession.value) await newSession()
    connect()
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  }
}

async function newSession() {
  if (!selectedContainer.value) return
  try {
    const s = await createSession(selectedContainer.value)
    sessions.value = [s, ...sessions.value]
    selectedSession.value = s.session_key
    messages.value = []
    errorMsg.value = ''
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  }
}

function connect() {
  ws?.close()
  connecting.value = true
  errorMsg.value = ''
  // 每个 ws 闭包捕获自身；旧 ws 的 onClose 触发时 ws 已指向新连接 → 不报误断线
  const myWs = new ChatWebSocket('/ws/chat/', auth.token, {
    onReady: () => {
      if (ws === myWs) {
        connecting.value = false
        errorMsg.value = ''
      }
    },
    onText: (_runId, delta) => {
      if (ws !== myWs) return  // stale guard：切换容器后旧 ws 回调不污染新会话
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant' && last.streaming) last.text += delta
    },
    onDone: () => {
      if (ws !== myWs) return
      const last = messages.value[messages.value.length - 1]
      if (last && last.streaming) last.streaming = false
    },
    onError: (msg) => {
      if (ws !== myWs) return
      errorMsg.value = msg
      connecting.value = false
      const last = messages.value[messages.value.length - 1]
      if (last && last.streaming) last.streaming = false
    },
    onClose: () => {
      if (ws !== myWs) return
      connecting.value = false
      if (!disposed) errorMsg.value = '连接已断开，请重试或切换容器'
    },
  })
  ws = myWs
  myWs.start(selectedContainer.value)
}

function send() {
  const text = input.value.trim()
  if (!text || !ws || !selectedSession.value || connecting.value || streaming.value) return
  messages.value.push({ role: 'user', text, streaming: false })
  messages.value.push({ role: 'assistant', text: '', streaming: true })
  ws.send(selectedSession.value, text)
  input.value = ''
}

onMounted(loadInstances)
onBeforeUnmount(() => {
  disposed = true
  ws?.close()
})

defineExpose({ selectContainer, send, newSession })
</script>

<template>
  <div class="chat">
    <aside class="side">
      <h3>容器</h3>
      <ul class="list">
        <li
          v-for="inst in instances"
          :key="inst.name"
          :class="['pill', { active: inst.name === selectedContainer }]"
          :data-test="`container-${inst.name}`"
          @click="selectContainer(inst.name)"
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
          @click="selectedSession = s.session_key; messages = []"
        >
          {{ s.title || s.session_key.slice(0, 8) }}
        </li>
      </ul>
      <button class="ghost" data-test="new-session" @click="newSession">＋ 新会话</button>
    </aside>

    <main class="main">
      <div class="topbar">
        <span class="title">{{ currentSessionTitle || '对话' }}</span>
        <span v-if="selectedContainer" class="tag">{{ selectedContainer }}</span>
        <span v-if="connecting" class="tag warn">连接中…</span>
      </div>
      <p v-if="errorMsg" class="error" data-test="error-bar">{{ errorMsg }}</p>
      <div class="stream" data-test="stream">
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div class="bubble">{{ m.text }}<span v-if="m.streaming" class="cursor"></span></div>
        </div>
      </div>
      <div class="composer">
        <textarea
          v-model="input"
          data-test="input"
          rows="2"
          placeholder="发消息…（Enter 发送 / Shift+Enter 换行）"
          @keydown.enter.exact.prevent="send"
        ></textarea>
        <button data-test="send" :disabled="connecting || streaming" @click="send">发送</button>
      </div>
    </main>
  </div>
</template>

<style scoped>
.chat { display: flex; height: calc(100vh - 40px); }
.side { width: 220px; border-right: 1px solid var(--el-border-color); padding: 12px; overflow-y: auto; }
.side h3 { font-size: 12px; color: var(--el-text-color-secondary); text-transform: uppercase; margin: 8px 0 4px; }
.list { list-style: none; padding: 0; margin: 0; }
.pill, .sess { padding: 7px 10px; border-radius: 7px; cursor: pointer; color: var(--el-text-color-regular); }
.pill { display: flex; align-items: center; gap: 8px; background: var(--el-fill-color-light); margin-bottom: 4px; }
.sess { font-size: 13px; color: var(--el-text-color-secondary); }
.pill.active, .sess.active { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--el-color-success); }
.dot.off { background: var(--el-text-color-disabled); }
.ghost { width: 100%; margin-top: 8px; background: transparent; border: 1px dashed var(--el-border-color); border-radius: 7px; padding: 6px; cursor: pointer; color: var(--el-text-color-secondary); }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar { display: flex; align-items: center; gap: 10px; padding: 10px 18px; border-bottom: 1px solid var(--el-border-color); }
.title { font-weight: 600; }
.tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); }
.tag.warn { color: var(--el-color-warning); }
.error { margin: 0; padding: 8px 18px; color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
.stream { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.msg { display: flex; max-width: 840px; }
.msg.user { align-self: flex-end; }
.bubble { padding: 10px 14px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
.msg.assistant .bubble { background: var(--el-fill-color-light); }
.msg.user .bubble { background: var(--el-color-primary-light-8); }
.cursor { display: inline-block; width: 7px; height: 14px; background: var(--el-color-primary); vertical-align: -2px; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.composer { display: flex; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--el-border-color); }
.composer textarea { flex: 1; resize: none; padding: 8px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.composer button { padding: 8px 16px; background: var(--el-color-primary); color: #fff; border: none; border-radius: 8px; cursor: pointer; }
</style>
