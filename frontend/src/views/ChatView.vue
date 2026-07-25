<script setup lang="ts">
// 对话页（spec §9.4，照 docs/prototypes/oc-chat-page.html，MVP 简化）。
// 左栏容器+会话；主区消息流式逐字 + 末尾闪烁光标；断线/错误提示。
// WS 经 /ws/chat/（JWT subprotocol，复用 T02 中间件）；多容器切换 = 切 ChatWebSocket。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { listInstances, type InstanceDTO } from '@/api/containers'
import { createSession, listCommands, listSessions, type CommandDTO, type SessionDTO } from '@/api/chat'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/client'
import { ChatWebSocket } from '@/chat/ws'

interface Msg {
  role: 'user' | 'assistant'
  text: string
  streaming: boolean
  tools: ToolRow[] // T08 工具行（仅 assistant 会有，user 恒空；保持接口统一）
}

// T08 工具行（issue #44 / spec §9.4 / r26 §3）：一行一个——工具名(mono) + 关键参数 + 状态，不展开细节。
interface ToolRow {
  name: string
  state: 'running' | 'done'
  title: string | null // 网关 toolTitles 用途短标题（待实测），有则优先显示
  input: unknown
  result: unknown
}

// T06 审批卡（连接级，无 runId）：独立列表渲染，不混入 messages——避免破坏流式锚定/finalizeLast
// （审查 #5），并可独立按 sessionKey 过滤、随会话/容器切换清空（codex P1 / 审查 #6）。
interface ApprovalItem {
  id: string
  kind: string
  command: string
  sessionKey: string | null
  status: 'pending' | 'resolving' | 'resolved' // pending 待处理 / resolving 已点击等回执 / resolved 已处理
  decision: '' | 'approve' | 'deny' | 'unknown' // codex R2 P2：未知权威值不默认批准
  detailOpen: boolean
}

const auth = useAuthStore()
const instances = ref<InstanceDTO[]>([])
const sessions = ref<SessionDTO[]>([])
const selectedContainer = ref('')
const selectedSession = ref('')
const messages = ref<Msg[]>([])
const approvals = ref<ApprovalItem[]>([])
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

// codex R2 P1：审批卡按 sessionKey **留存全部**（不丢弃非当前会话的），仅渲染时按当前会话过滤——
// 切到该会话即可看到/回覆，agent 不再因切会话而永久丢失待审批卡。无 sessionKey（连接级）任何会话可见。
const visibleApprovals = computed(() =>
  approvals.value.filter((a) => !a.sessionKey || a.sessionKey === selectedSession.value),
)

// ---- T07 斜杠命令补全（issue #43 / spec §9.4，照原型 oc-chat-page.html）----
// 清单经 listCommands（后端代理网关 commands.list）按容器拉取并缓存；输入 `/` 弹补全菜单（前缀过滤，
// cmd mono + 描述），点选/键盘选中填入后经普通 send() 发 `/cmd`（r26 §2：命令走普通 chat.send）。
// 拉取失败静默降级（commands 空、菜单不弹），不影响普通对话。
interface SlashOption {
  alias: string // 展示/填入的精确斜杠别名（含前导 /）
  description: string
}

const commands = ref<CommandDTO[]>([])
const slashIndex = ref(0)
const slashDismissed = ref(false) // Esc 临时关闭：内容再变化（slashActive 重算）时自动复位

// 当前斜杠前缀：仅当输入形如 `/xxx`（无空格）时激活，返回去掉前导 / 的小写查询；否则 null
const slashQuery = computed<string | null>(() => {
  const v = input.value
  if (!v.startsWith('/') || v.includes(' ')) return null
  return v.slice(1).toLowerCase()
})

const slashActive = computed(() => slashQuery.value !== null)

// 把命令清单拍平为「别名×描述」选项并按当前前缀过滤（/m 命中 /model 与 /m）
const slashMatches = computed<SlashOption[]>(() => {
  const q = slashQuery.value
  if (q === null) return []
  const out: SlashOption[] = []
  for (const c of commands.value) {
    for (const a of c.aliases) {
      if (a.slice(1).toLowerCase().startsWith(q)) out.push({ alias: a, description: c.description })
    }
  }
  return out
})

const slashOpen = computed(
  () => slashActive.value && !slashDismissed.value && slashMatches.value.length > 0,
)

// 拉取当前容器命令清单（随容器切换调用）；失败静默降级为空清单。
// codex P1：快速切容器时旧容器的迟到响应（resolve 或 catch 拒绝）不得覆盖当前容器清单——
// 与 listSessions 同一 containerGen 守卫：await 后校验代际，过期则丢弃。
async function loadCommands(name: string, gen: number) {
  try {
    const list = await listCommands(name)
    if (gen !== containerGen) return // 切容器途中迟到的响应：丢弃
    commands.value = list
  } catch {
    if (gen !== containerGen) return
    commands.value = []
  }
}

function onComposerInput() {
  // 内容变化：若不再是斜杠前缀（删字符/加空格），复位 Esc 关闭态，下次输 / 可再弹
  if (!slashActive.value) slashDismissed.value = false
  slashIndex.value = 0
}

// 点选/选中：填入别名 + 尾随空格（便于续输参数），关闭菜单并聚焦；发送仍走普通 send()
function pickSlash(o: SlashOption) {
  input.value = `${o.alias} `
  slashDismissed.value = true
}

function onComposerKeydown(e: KeyboardEvent) {
  // 菜单开启：斜杠补全导航/选中/关闭优先于发送
  if (slashOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashIndex.value = (slashIndex.value + 1) % slashMatches.value.length
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashIndex.value =
        (slashIndex.value - 1 + slashMatches.value.length) % slashMatches.value.length
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Enter/Tab 选中高亮项填入（不发送）；发送由菜单关闭后的 Enter 触发
      e.preventDefault()
      const m = slashMatches.value[slashIndex.value]
      if (m) pickSlash(m)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      slashDismissed.value = true
    }
    return
  }
  // 菜单关闭：Enter（无修饰键）发送；Shift+Enter 换行（与原 @keydown.enter.exact 行为一致）
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault()
    send()
  }
}

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
  approvals.value = [] // 切容器：清空审批卡（审查 #6）
  commands.value = [] // 切容器：清空命令缓存（命令按容器隔离，T07），随后为新容器重新拉取
  slashDismissed.value = false
  input.value = '' // 切容器：清空 composer 残留输入（否则旧 `/` 会让新容器菜单误弹，T07）
  abandonActiveRun()
  errorMsg.value = ''
  void loadCommands(name, gen) // T07：后台拉取新容器命令清单（不阻塞会话/连接主流程）；gen 守卫防迟到污染
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
  // codex R3 P1：不清空审批卡——新会话不换容器，切会话特意留存的同容器卡须保留（按 sessionKey 过滤渲染），
  // 否则卡住的 agent 对应那张卡会被这里误清、再也无法回覆
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
  // codex R2 P1：不清空审批卡——同容器其它会话的卡保留，渲染时按 selectedSession 过滤即可
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
    onError: (msg, runId, approvalId) => {
      if (ws !== myWs) return
      // codex R2 P2：resolve 失败的 error 帧带 approval id → 仅复位该卡（并发 resolve 不误复位其它在途卡）
      if (approvalId) {
        recoverPendingApprovals(approvalId)
        return
      }
      // codex R3 P2：无 approval id 的通用连接错误（如 ws.ts 在 CLOSED 态 send 报「连接已断开」）→
      // 恢复所有 resolving 卡为 pending，避免点击后 socket 已死、错误帧无 id 导致卡片永久禁用
      recoverPendingApprovals()
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
      recoverPendingApprovals()  // 连接断开：恢复所有 resolving 卡片可重试
      if (!disposed) errorMsg.value = '连接已断开，请重试或切换容器'
    },
    onApproval: (card) => {
      if (ws !== myWs) return  // stale guard：旧 ws 的审批卡不污染新会话
      // codex R2 P1：按 id 去重后**留存全部**（含其它会话的），仅渲染时按 sessionKey 过滤（visibleApprovals）
      if (approvals.value.some((a) => a.id === card.id)) return  // 幂等（start 补拉 + 实时推送去重）
      approvals.value.push({
        id: card.id,
        kind: card.kind,
        command: card.command || '（网关未提供命令详情）',
        sessionKey: card.sessionKey,
        status: 'pending',
        decision: '',
        detailOpen: false,
      })
    },
    onApprovalResolved: (id, decision) => {
      if (ws !== myWs) return
      // 服务端回执：以网关权威 decision 落定（first-answer-wins，codex P1，可能与请求不同）
      const a = approvals.value.find((x) => x.id === id)
      if (a) {
        a.status = 'resolved'
        // codex R2 P2：仅识别 approve/deny，其它权威值（expired/rejected 等）显示「未知」，不默认批准
        a.decision = decision === 'approve' ? 'approve' : decision === 'deny' ? 'deny' : 'unknown'
      }
    },
    onTool: (tool) => {
      // T08 工具执行（issue #44 / spec §9.4）：工具挂在所属 chat run 内，带 runId。首帧可能是工具
      // （agent 先调工具再回复）→ 与 onText 同款锚定当前 run；按 name 聚合 start→result 渲染一行标题+状态。
      if (ws !== myWs) return
      if (abandonedRunIds.has(tool.runId)) return
      if (activeRunId && tool.runId !== activeRunId) return
      if (!activeRunId) {
        if (pendingAbandonCount > 0) { pendingAbandonCount--; abandonedRunIds.add(tool.runId); return }
        activeRunId = tool.runId
        pendingSend = false
      }
      const last = messages.value[messages.value.length - 1]
      if (!last || last.role !== 'assistant') return
      if (tool.state === 'running') {
        last.tools.push({ name: tool.name, state: 'running', title: tool.title,
                          input: tool.input, result: tool.result })
        return
      }
      // done：匹配最后一个同名 running 行更新（容忍 start→result 配对）；找不到则追加（容忍 result 先到）
      for (let i = last.tools.length - 1; i >= 0; i--) {
        if (last.tools[i].name === tool.name && last.tools[i].state === 'running') {
          last.tools[i].state = 'done'
          last.tools[i].result = tool.result
          return
        }
      }
      last.tools.push({ name: tool.name, state: 'done', title: tool.title,
                        input: tool.input, result: tool.result })
    },
  })
  ws = myWs
  myWs.start(selectedContainer.value)
}

// T06：批准/拒绝 → 回发 resolve 帧 + 进 resolving 态（禁用按钮等回执，不乐观假成功，codex P2）。
// 成功由 onApprovalResolved 落定；失败由 onError 恢复 pending 让卡片可重试。
function resolveApproval(a: ApprovalItem, decision: 'approve' | 'deny') {
  // codex R3 P2：socket 已断（disconnected）则不可点——否则会进 resolving 后 sendRaw 走 CLOSED 分支，
  // 报无 id 通用错误；虽 E 的 recover 会复位，但直接禁点更清楚（按钮也经 :disabled 联动 disconnected）
  if (!ws || disconnected.value || a.status !== 'pending') return
  a.status = 'resolving'
  a.decision = decision
  ws.resolve(a.id, a.kind ?? 'exec', decision)
}

// resolve 失败（带 approval id 的 error 帧）或断线（无 id → 全部）：恢复 resolving 卡片为 pending 可重试
// （codex R2 P2：仅复位匹配卡，不误复位并发在途的其它卡）
function recoverPendingApprovals(id?: string) {
  for (const a of approvals.value) {
    if (a.status === 'resolving' && (id === undefined || a.id === id)) a.status = 'pending'
  }
}

// 查看细节：展开/收起命令全文
function toggleDetail(a: ApprovalItem) {
  a.detailOpen = !a.detailOpen
}

// 审批卡副标题（说明 agent 请求执行 elevated 命令）
function approvalSubtitle(a: ApprovalItem) {
  return `${a.kind ?? 'exec'} agent 请求执行一条 elevated 命令，请确认后批准或拒绝：`
}

// T08 工具行关键参数摘要（spec §9.4）：把网关透传的 input（dict/str）压成一行短串，不逐字段展开细节。
// 字段名待配对后实测校准（见后端 event_translate._translate_tool）；MVP 取前两个键值对，避免占满气泡。
function formatToolInput(input: unknown): string {
  if (input == null || input === '') return ''
  if (typeof input === 'string') return input
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    return Object.keys(obj)
      .slice(0, 2)
      .map((k) => `${k}=${typeof obj[k] === 'string' ? obj[k] : JSON.stringify(obj[k])}`)
      .join(' ')
  }
  return String(input)
}

function send() {
  const text = input.value.trim()
  if (!text || !ws || !selectedSession.value || connecting.value || streaming.value || disconnected.value) return
  slashDismissed.value = true // 发送后关闭补全菜单（输入已被清空，下次输 / 时经 onComposerInput 复位）
  messages.value.push({ role: 'user', text, streaming: false, tools: [] })
  messages.value.push({ role: 'assistant', text: '', streaming: true, tools: [] })
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
        <div v-for="(m, i) in messages" :key="`m-${i}`" class="msg" :class="m.role">
          <div class="bubble">
            <!-- T08 思考链折叠卡（spec §8.3 / r26 §4）：protocol v4 无独立 thinking 帧（官方文档已证）→
                 定型 (b) 降级透传——整段按正文 text 透传（无法协议层分离），折叠卡标注降级，不伪造思考步骤。 -->
            <details v-if="m.role === 'assistant'" class="cot" data-test="cot-card">
              <summary class="cot-head">
                <span class="caret">▶</span> 思考过程
                <span class="cot-flag">⚠ protocol v4 无独立 thinking 帧 · 降级透传（待配对实测）</span>
              </summary>
              <div class="cot-body">
                当前协议无法将「思考」与正文分离，思考内容已并入下方正文。待容器配对后实测确认是否存在独立
                thinking 帧——若有则升级为独立渲染（spec §8.3 (a)）。
              </div>
            </details>
            <!-- T08 工具执行（spec §9.4 / 原型 oc-chat-page）：一行一个——图标+工具名(mono)+关键参数+状态，
                 不展开输入输出细节。事件名/payload 待配对后实测校准（r26 §3）。 -->
            <div
              v-for="(t, ti) in m.tools"
              :key="`tool-${ti}`"
              class="tool"
              :class="t.state"
              data-test="tool-line"
            >
              <span class="t-icon">🔧</span>
              <span class="t-name" :title="t.title ?? ''">{{ t.name }}</span>
              <span v-if="formatToolInput(t.input)" class="t-args">{{ formatToolInput(t.input) }}</span>
              <span class="t-state">{{ t.state === 'running' ? '⟳ 运行中' : '✓ 完成' }}</span>
            </div>
            {{ m.text }}<span v-if="m.streaming" class="cursor"></span>
          </div>
        </div>
        <!-- T06 权限审批卡（spec §9.4）：独立于 messages 的列表，橙边待处理，处理后变淡显示结果。
             拆出 messages 是为不破坏流式锚定/finalizeLast（审查 #5），并可独立按 sessionKey 过滤、
             随会话/容器切换清空（codex P1 / 审查 #6）。 -->
        <div
          v-for="a in visibleApprovals"
          :key="a.id"
          class="approval"
          :class="{ resolved: a.status === 'resolved' }"
          :data-test="`approval-${a.id}`"
        >
          <div class="a-head">
            ⚠️ 请求提升权限
            <span v-if="a.status === 'resolved'" class="resolved-tag" :class="a.decision">
              {{ a.decision === 'approve' ? '已批准' : a.decision === 'deny' ? '已拒绝' : '未知' }}
            </span>
          </div>
          <div class="a-sub">{{ approvalSubtitle(a) }}</div>
          <div class="a-cmd">{{ a.command }}</div>
          <div v-if="a.detailOpen" class="a-detail" :data-test="`approval-detail-${a.id}`">
            命令全文：<code>{{ a.command }}</code><br>
            审批 id：<code>{{ a.id }}</code> · 类型：<code>{{ a.kind }}</code>
            · 经 <code>exec.approval.requested</code> 推送，<code>approval.resolve</code> 回覆
          </div>
          <div v-if="a.status !== 'resolved'" class="a-actions">
            <button class="btn-approve" :disabled="a.status !== 'pending' || disconnected" :data-test="`approve-${a.id}`" @click="resolveApproval(a, 'approve')">批准</button>
            <button class="btn-deny" :disabled="a.status !== 'pending' || disconnected" :data-test="`deny-${a.id}`" @click="resolveApproval(a, 'deny')">拒绝</button>
            <button class="btn-ghost" :data-test="`detail-${a.id}`" @click="toggleDetail(a)">查看细节</button>
          </div>
        </div>
      </div>
      <div class="composer">
        <!-- T07 斜杠命令补全（spec §9.4 / 原型 oc-chat-page.html）：输入 `/` 弹菜单（前缀过滤，
             cmd mono + 描述），点选/↑↓+Enter 选中填入后经普通 send() 发 `/cmd`。清单来自
             listCommands（后端代理网关 commands.list），按容器隔离；拉取失败菜单不弹、不影响对话。 -->
        <div v-if="slashOpen" class="slash-menu" data-test="slash-menu">
          <div
            v-for="(o, i) in slashMatches"
            :key="o.alias"
            class="slash-item"
            :class="{ sel: i === slashIndex }"
            data-test="slash-item"
            @mousedown.prevent="pickSlash(o)"
          >
            <span class="cmd">{{ o.alias }}</span><span class="desc">{{ o.description }}</span>
          </div>
        </div>
        <textarea
          v-model="input"
          data-test="input"
          rows="2"
          placeholder="发消息…（Enter 发送 / Shift+Enter 换行；输 / 弹命令补全）"
          @input="onComposerInput"
          @keydown="onComposerKeydown"
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
.composer { position: relative; display: flex; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--el-border-color); }
.composer textarea { flex: 1; resize: none; padding: 8px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.composer button { padding: 8px 16px; background: var(--el-color-primary); color: #fff; border: none; border-radius: 8px; cursor: pointer; }

/* T07 斜杠补全菜单（spec §9.4 / 原型 oc-chat-page.html）：弹在输入框上方，cmd mono + 描述 */
.slash-menu { position: absolute; bottom: calc(100% + 6px); left: 18px; right: 18px; max-height: 280px; overflow-y: auto; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color); border-radius: 11px; box-shadow: 0 -8px 30px rgba(0, 0, 0, .18); z-index: 10; }
.slash-item { display: flex; align-items: center; gap: 10px; padding: 9px 14px; cursor: pointer; }
.slash-item.sel, .slash-item:hover { background: var(--el-fill-color); }
.slash-item .cmd { font-family: ui-monospace, monospace; color: var(--el-color-primary); font-size: 13px; }
.slash-item .desc { margin-left: auto; color: var(--el-text-color-secondary); font-size: 12px; }

/* T06 权限审批卡（spec §9.4 / 原型 oc-chat-page.html）：橙边待处理，处理后变淡 */
.approval { align-self: flex-start; border: 1px solid var(--el-color-warning); background: var(--el-color-warning-light-9); border-radius: 11px; padding: 12px 14px; margin: 4px 0; max-width: 560px; }
.approval .a-head { display: flex; align-items: center; gap: 8px; color: var(--el-color-warning); font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.approval .resolved-tag { margin-left: auto; font-size: 11.5px; color: var(--el-color-success); font-weight: 600; }
.approval .resolved-tag.deny { color: var(--el-color-danger); }
.approval .resolved-tag.unknown { color: var(--el-text-color-secondary); }
.approval .a-sub { color: var(--el-text-color-secondary); font-size: 13px; }
.approval .a-cmd { font-family: ui-monospace, monospace; background: var(--el-fill-color-darker); border: 1px solid var(--el-border-color); border-radius: 7px; padding: 8px 10px; margin: 8px 0; font-size: 12.5px; white-space: pre-wrap; word-break: break-all; }
.approval .a-detail { font-size: 11px; color: var(--el-text-color-secondary); margin-bottom: 6px; }
.approval .a-detail code { background: var(--el-fill-color); border-radius: 4px; padding: 1px 4px; }
.approval .a-actions { display: flex; gap: 9px; margin-top: 8px; }
.approval .a-actions button { border: none; border-radius: 7px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.approval .btn-approve { background: var(--el-color-success); color: #fff; }
.approval .btn-deny { background: transparent; border: 1px solid var(--el-color-danger); color: var(--el-color-danger); }
.approval .btn-ghost { background: transparent; border: 1px solid var(--el-border-color); color: var(--el-text-color-secondary); }
.approval.resolved { opacity: .55; border-color: var(--el-border-color); }

/* T08 思考链折叠卡（spec §8.3/§9.4 / 原型 oc-chat-page）：(b) 降级透传，虚线卡 + flag 标注 */
.cot { border: 1px dashed var(--el-border-color); background: var(--el-fill-color-light); border-radius: 10px; margin-bottom: 8px; }
.cot-head { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; font-size: 12.5px; color: var(--el-color-primary); user-select: none; list-style: none; }
.cot-head::-webkit-details-marker { display: none; }
.cot .caret { display: inline-block; transition: transform .18s; }
.cot[open] .cot-head .caret { transform: rotate(90deg); }
.cot-flag { margin-left: auto; font-size: 10.5px; color: var(--el-color-warning); border: 1px dashed var(--el-color-warning); border-radius: 6px; padding: 1px 6px; }
.cot-body { padding: 0 12px 8px; color: var(--el-text-color-secondary); font-size: 12.5px; }

/* T08 工具执行（spec §9.4 / 原型）：一行一个——图标+工具名(mono)+参数+状态，不展开细节 */
.tool { display: flex; align-items: center; gap: 9px; background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 9px; padding: 6px 12px; margin: 4px 0; font-size: 12.5px; }
.tool .t-icon { color: var(--el-color-primary); }
.tool .t-name { font-family: ui-monospace, monospace; }
.tool .t-args { color: var(--el-text-color-secondary); }
.tool .t-state { margin-left: auto; display: flex; align-items: center; gap: 5px; }
.tool.running .t-state { color: var(--el-color-warning); }
.tool.done .t-state { color: var(--el-color-success); }
</style>
