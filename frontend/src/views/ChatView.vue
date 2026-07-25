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
const disconnected = ref(false) // ws 意外关闭：禁用发送，提示重连/切容器（codex P2 #4）
let ws: ChatWebSocket | null = null
let disposed = false
// runId 路由：仅当前 run 的增量写入回复；切会话/容器时把旧 run 标记 abandoned，丢弃其迟到帧（codex P2）
let activeRunId = '' // 已收到首帧的当前 run
const abandonedRunIds = new Set<string>() // 切换前遗留的 runId：迟到帧丢弃（codex P2 #3）
let pendingSend = false // 已 send 但首帧未到（runId 未知）
let pendingAbandonCount = 0 // 切会话时仍 pending 的 run 数；其迟到首帧按 FIFO 视为孤儿丢弃（codex P2 #3）
// selectContainer 的请求代：丢弃切容器途中迟到的 listSessions 响应（codex P2）
let containerGen = 0

const currentSessionTitle = computed(() => {
  const s = sessions.value.find((x) => x.session_key === selectedSession.value)
  return s?.title || (s ? s.session_key.slice(0, 8) : '') || ''
})

// 是否有助手消息正在流式；并发 send 会让旧 streaming 消息永久卡住光标，故流式中禁发
const streaming = computed(() => messages.value.some((m) => m.role === 'assistant' && m.streaming))

// 切会话/容器时调用：旧 run（已 claim 或仍 pending）标记 abandoned，其迟到帧按 runId 丢弃
function abandonActiveRun() {
  if (activeRunId) abandonedRunIds.add(activeRunId)
  else if (pendingSend) pendingAbandonCount++ // 首帧未到、runId 未知：迟到首帧按 FIFO 计数丢弃
  activeRunId = ''
  pendingSend = false
}

// 收尾最后一条 streaming 助手消息（done/error/关闭时）
function finalizeLast() {
  const last = messages.value[messages.value.length - 1]
  if (last && last.streaming) last.streaming = false
}

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
  const gen = ++containerGen // 每次切换自增，await 后据此丢弃过期响应
  selectedContainer.value = name
  // 立即停用旧连接 + 禁用 composer + 清空 session：避免 listSessions pending 期间经旧 socket
  // 用旧 sessionKey 发送（UI 已显示新容器）（codex P2 #5）
  const oldWs = ws
  ws = null
  oldWs?.close() // 旧 ws 的 onClose 见 ws(null) !== myWs → 不报断线
  connecting.value = true
  disconnected.value = false
  selectedSession.value = ''
  sessions.value = []
  messages.value = []
  abandonActiveRun()
  errorMsg.value = ''
  try {
    const list = await listSessions(name)
    if (gen !== containerGen) return // 切容器途中迟到的响应：丢弃（codex P2）
    sessions.value = list
    selectedSession.value = sessions.value[0]?.session_key ?? ''
    if (!selectedSession.value) await newSession()
    if (gen !== containerGen) return // newSession 期间又切容器：不连
    if (!selectedSession.value) return // 会话创建失败（newSession 已显示错误）：不连接（codex P2）
    connect()
  } catch (e) {
    if (gen !== containerGen) return
    connecting.value = false // 出错解除 connecting（composer 解禁后用户可重试）
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  }
}

async function newSession() {
  if (!selectedContainer.value) return
  abandonActiveRun()
  messages.value = []
  try {
    const s = await createSession(selectedContainer.value)
    sessions.value = [s, ...sessions.value]
    selectedSession.value = s.session_key
    errorMsg.value = ''
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  }
}

function pickSession(key: string) {
  if (!key || selectedSession.value === key) return
  abandonActiveRun()
  selectedSession.value = key
  messages.value = []
  errorMsg.value = ''
}

function connect() {
  ws?.close()
  connecting.value = true
  disconnected.value = false
  errorMsg.value = ''
  // 每个 ws 闭包捕获自身；旧 ws 的 onClose 触发时 ws 已指向新连接 → 不报误断线
  const myWs = new ChatWebSocket('/ws/chat/', auth.token, {
    onReady: () => {
      if (ws === myWs) {
        connecting.value = false
        errorMsg.value = ''
      }
    },
    onText: (runId, delta, replace) => {
      if (ws !== myWs) return  // stale guard：切换容器后旧 ws 回调不污染新会话
      if (abandonedRunIds.has(runId)) return  // 切换前遗留 run 的增量：丢弃
      if (activeRunId && runId !== activeRunId) return  // 仅当前 run 的增量写入回复
      if (!activeRunId) {
        // 首帧到达：若属于切会话时仍 pending 的孤儿 run（FIFO 先到）→ 标记 abandoned 丢弃（codex P2 #3）
        if (pendingAbandonCount > 0) {
          pendingAbandonCount--
          abandonedRunIds.add(runId)
          return
        }
        activeRunId = runId
        pendingSend = false
      }
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        last.text = replace ? delta : last.text + delta  // replace=true：整段替换（codex P2 #1）
      }
    },
    onDone: (runId) => {
      if (ws !== myWs) return
      if (abandonedRunIds.has(runId)) { abandonedRunIds.delete(runId); return }
      if (activeRunId && runId !== activeRunId) return
      if (activeRunId === runId) {
        finalizeLast()
        activeRunId = ''
        return
      }
      // activeRunId 空：run 首帧即终态（无 delta）
      if (pendingAbandonCount > 0) { pendingAbandonCount--; return }  // 孤儿 run 终态：计数丢弃
      if (pendingSend) { finalizeLast(); pendingSend = false }  // 当前 pending run 无 delta 收尾
    },
    onError: (msg, runId) => {
      if (ws !== myWs) return
      // 消费者级错误（无 runId，如「请先选择容器」）照常显示；run 级错误按 runId 过滤
      if (runId) {
        if (abandonedRunIds.has(runId)) { abandonedRunIds.delete(runId); return }
        if (activeRunId && runId !== activeRunId) return
      }
      errorMsg.value = msg
      connecting.value = false
      finalizeLast()
      if (runId) {
        if (activeRunId === runId) activeRunId = ''
        else if (pendingAbandonCount > 0) pendingAbandonCount--
        else if (pendingSend) pendingSend = false
      } else {
        activeRunId = ''
        pendingSend = false
      }
    },
    onClose: () => {
      if (ws !== myWs) return  // 旧 ws 的关闭（切容器）不报断线
      connecting.value = false
      disconnected.value = true  // 意外断线：禁用发送（codex P2 #4）
      if (!disposed) errorMsg.value = '连接已断开，请重试或切换容器'
    },
  })
  ws = myWs
  myWs.start(selectedContainer.value)
}

function send() {
  const text = input.value.trim()
  if (!text || !ws || !selectedSession.value || connecting.value || streaming.value || disconnected.value) return
  messages.value.push({ role: 'user', text, streaming: false })
  messages.value.push({ role: 'assistant', text: '', streaming: true })
  activeRunId = '' // 等首帧 onText 锚定新 run
  pendingSend = true // 首帧未到前，切会话会按 pending 孤儿计数（codex P2 #3）
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
          @click="pickSession(s.session_key)"
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
        <button data-test="send" :disabled="connecting || streaming || disconnected" @click="send">发送</button>
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
