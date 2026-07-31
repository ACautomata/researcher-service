<script setup lang="ts">
// 对话页（spec §9.4，照 docs/prototypes/oc-chat-page.html，MVP 简化）。
// 左栏容器+会话；主区消息流式逐字 + 末尾闪烁光标；断线/错误提示。
// WS 经 /ws/chat/（JWT subprotocol，复用 T02 中间件）；多容器切换 = 切 ChatWebSocket。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { listInstances, type InstanceDTO } from '@/api/containers'
import {
  createSession,
  deleteSession,
  getSessionHistory,
  listCommands,
  listSessions,
  type CommandDTO,
  type HistoryMessageDTO,
  type SessionDTO,
} from '@/api/chat'
import { useAuthStore, isTokenExpired } from '@/stores/auth'
import { ApiError } from '@/api/client'
import { ChatWebSocket } from '@/chat/ws'
import { splitThinking } from '@/chat/thinking'
import { ElMessage, ElMessageBox } from 'element-plus'

interface Msg {
  role: 'user' | 'assistant'
  raw: string // 原始累积文本（含 <thinking> 标签）；user 与 text 相同。thinking 由此剥离
  text: string // 展示正文（已剥离 thinking）
  thinking: string // T08 思考链（spec §8.3 (a)）：从 raw 内 <thinking> 标签剥离出的思考内容，折叠卡渲染
  thinkingOpen: boolean // 流式中 <thinking> 未闭合（思考中）
  streaming: boolean
  tools: ToolRow[] // T08 工具行（仅 assistant 会有，user 恒空；保持接口统一）
}

// T08 工具行（issue #44 / spec §9.4 / r26 §3）：一行一个——工具名(mono) + 关键参数 + 状态，不展开细节。
interface ToolRow {
  id: string | null // 工具调用 id（codex P2：同名并发调用按 id 配对 result，无 id 退 name）
  name: string
  state: 'running' | 'done' | 'error'
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
  decision: '' | 'allow-once' | 'allow-always' | 'deny' | 'unknown' // codex P1 (issue #154)：网关权威值 allow-once/allow-always/deny
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
// codex #249 P2：loadHistory 的请求代。仅 containerGen+selectedSession 守卫拦不住「同一会话并发
// 两次 loadHistory」（如断线重连 onReady 恢复时上一次历史请求仍在途）——两次守卫值相同、响应都被
// 接受，后落地的快照 prepend 到先落地的已渲染历史上 → 转录重复/混杂。每次 loadHistory 自增并捕获
// 请求代，只有最新一次才允许提交其快照，其余（被取代的在途请求）落地即丢弃。
let historyGen = 0
// codex #249 R5 (id 3690750253)：断线重连恢复在途 run。onClose 把断线时在途 runId 标记 abandoned +
// 收尾气泡；但重连握手**恢复同一 run**（后端续流其剩余增量/终态帧）——若残留 abandoned 标记，
// onText/onDone 把恢复帧按「切换前遗留 run」丢弃；若气泡已收尾（streaming=false），恢复帧也被
// last.streaming 守卫跳过渲染，可见回答停在断线快照。
// 状态机：connect() 重连（reconnectAttempts>0）置 resumePending；恢复首帧（onText/onTool 认领）解除
// abandoned 标记 + 重新续流尾部气泡 + 锚定 activeRunId；onReady 的 loadHistory（同会话）完成后清除。
// 恢复帧在 ready 之前到达（后端 resume_active_session → 回放 → ready），故认领在 loadHistory 之前；
// loadHistory 以「保留 streaming 尾」方式加载（见 loadHistory），不覆盖被恢复的在途 run。
// 用户切会话/切容器走 abandonActiveRun 对称清 resumePending——恢复帧按旧 run 丢弃（abandoned 标记仍在）。
let resumePending = false // 重连已建、恢复窗口内（connect() 置位，认领/loadHistory/切走时清除）
let resumeClaimed = false // 已认领恢复 run（首帧到达）——尾部气泡在流式续流，loadHistory 须保留
let resumeRunSession = '' // connect() 重连时选中的会话（认领须仍在该会话；切走则恢复帧按旧 run 丢弃）

// issue #239 / 评审 #198 问题 1：断线自动重连——指数退避（对齐 GATEWAY_RECONNECT_POLICY 与
// 后端 pool.ReconnectPolicy：初始 1s、每次翻倍、封顶 30s，重连成功即重置）。仅普通断线触发
// （4401 JWT 过期走 #240 的刷新重连链路 recoverUnauthorized，不经退避）；切容器/卸载时取消 pending 定时器。
const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_CAP_MS = 30_000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null // pending 的重连定时器
let reconnectAttempts = 0 // 本未成功周期内已尝试次数（决定退避时长）；onReady 重置

// T3 会话历史回看（issue #82 / spec #76）：分页态——hasMore 标记可向回翻更旧消息，
// historyAnchor=nextOffset 为下一更旧页的 messageId 锚点；historyLoading 控「加载更多」禁用。
const historyHasMore = ref(false)
const historyAnchor = ref<string | number | null>(null)
const historyLoading = ref(false)
// T3 未配对引导（issue #82）：容器未完成设备配对时网关回 409，对话/历史/新建均不可用——
// 展示引导指引用户先去「容器」页完成配对（spec §8.1 设备配对为 chat 前置）。
const pairingNeeded = ref(false)

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
  // codex #249 R5：切会话/切容器 = 不再恢复断线前那个 run——清除重连恢复态（恢复帧按旧 run 丢弃）
  resumePending = false
  resumeClaimed = false
  resumeRunSession = ''
}

// codex #249 R5 (id 3690750253)：认领重连后本连接的首个 run 帧——重连恢复的正是断线前在途 run，
// 其帧须解除 abandoned 标记（若在集内）并把 onClose 已收尾的尾部气泡重新置为流式，续流渲染。
// 仅当「重连恢复窗口内 + 会话未切走 + 尚无已锚定 run」才认领；认领即结束窗口（后续帧走正常锚定）。
// 尾部无 assistant 气泡时（首帧在 loadHistory wipe 后才到 / 空 text 恢复 run）补一个流式占位，
// 恢复帧可锚定（对齐 send() 的 user+assistant 占位语义）。返回是否认领成功。
function claimResumedRun(runId: string): boolean {
  if (!resumePending || resumeRunSession !== selectedSession.value) return false
  if (activeRunId) return false
  abandonedRunIds.delete(runId) // 若该 run 恰是被放弃的那个：解除 abandoned 标记（不在集内则 no-op）
  resumePending = false // 已认领：恢复窗口结束
  resumeClaimed = true // loadHistory 据此保留续流中的尾气泡
  const last = messages.value[messages.value.length - 1]
  if (last && last.role === 'assistant') {
    last.streaming = true // 恢复续流：尾部气泡重新流式
  } else {
    // 尾部无 assistant 气泡（首帧在 loadHistory wipe 后才到 / 空 text 恢复 run）：补流式占位
    messages.value.push({ role: 'assistant', raw: '', text: '', thinking: '', thinkingOpen: false, streaming: true, tools: [] })
  }
  return true
}

// 收尾最后一条 streaming 助手消息（done/error/关闭时）
function finalizeLast() {
  const last = messages.value[messages.value.length - 1]
  if (last && last.streaming) {
    last.streaming = false
    last.thinkingOpen = false // 断流时 <thinking> 未闭合也落定：text/thinking 已是剥离结果，思考保留在折叠卡
    // issue #238（评审 #198 Low 5.3）：终态对 raw 做一次最终 splitThinking 重解析——流式中
    // 被隐藏的半截 `<thi…` 残片按普通文本放回正文（终态无「下帧补齐」可言，残片不应被永久吞掉）；
    // 未闭合 <thinking> 内容仍留思考（标签不泄露正文）。
    const parts = splitThinking(last.raw, { terminal: true })
    last.text = parts.text
    last.thinking = parts.thinking
  }
}

// issue #239：安排一次指数退避自动重连。仅在「当前仍选中同一容器」且「组件未卸载」时到点真正重连；
// 重连成功由 onReady 重置 reconnectAttempts（见 connect 的 onReady），loadHistory 在 Ready 后恢复投影。
function scheduleReconnect() {
  cancelReconnect()
  const container = selectedContainer.value
  const delay = Math.min(RECONNECT_INITIAL_MS * 2 ** reconnectAttempts, RECONNECT_CAP_MS)
  reconnectAttempts++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    // 到点再校验：组件已卸载 / 已切走容器（旧容器不重连污染）/ 已有新连接 → 放弃本次重连
    if (disposed || selectedContainer.value !== container || !disconnected.value) return
    connect()
  }, delay)
}

// issue #239：取消 pending 重连定时器（切容器/切会话/卸载/手动重连前调用，避免旧容器重连污染）
function cancelReconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

// issue #240：refresh 确认失效（refreshExhausted，cookie 4xx）——清会话跳登录，复用 api/client.ts 既有语义
// （瞬态失败不走这里）。跳到登录页后路由守卫 hydrate 会再次确认，用户重新登录。
function redirectLogin() {
  auth.clearSession()
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.assign('/login')
  }
}

// issue #240：4401（access token 过期）断线的刷新重连链路——区别于普通断线的退避重连。
// forceRefresh 换到新 token 后立即重连（socket 本身健康，只是凭证过期，无需退避）；
// refresh 确认失效（refreshExhausted）→ 清会话跳登录，不再重连（防 4401 重连死循环）；
// 瞬态失败（网络异常/5xx，token 仍空）→ 不踢人，按 #239 指数退避重试（scheduleReconnect 到点调 connect，
// 其前置检查再过 isTokenExpired → 再 forceRefresh），直到 refresh 成功或确认失效为止。
async function recoverUnauthorized() {
  await auth.forceRefresh()
  if (disposed) return
  if (auth.refreshExhausted) {
    redirectLogin()
    return
  }
  if (auth.token) {
    connect() // 新 token 已就绪：connect 前置检查通过 → 同步直建（无退避，socket 本身健康仅凭证过期）
  } else {
    scheduleReconnect() // 瞬态失败：退避重试（到点 connect 前置刷新），退避链与普通断线一致
  }
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
  cancelReconnect() // issue #239：切容器取消旧容器 pending 重连（旧容器不重连污染）
  reconnectAttempts = 0 // 新容器从初始退避起算
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
  pairingNeeded.value = false // T3：切容器重置未配对引导（新容器可能已配对）
  void loadCommands(name, gen) // T07：后台拉取新容器命令清单（不阻塞会话/连接主流程）；gen 守卫防迟到污染
  try {
    const list = await listSessions(name)
    if (gen !== containerGen) return // 切容器途中迟到的响应：丢弃（codex P2）
    sessions.value = list
    selectedSession.value = sessions.value[0]?.session_key ?? ''
    if (!selectedSession.value) await newSession()
    if (gen !== containerGen) return // newSession 期间又切容器：不连
    if (!selectedSession.value) return // 会话创建失败（newSession 已显示错误）：不连接（codex P2）
    void loadHistory(selectedSession.value) // T3：加载首个会话历史（不阻塞 WS 连接）
    connect()
  } catch (e) {
    if (gen !== containerGen) return
    connecting.value = false // 出错解除 connecting（composer 解禁后用户可重试）
    if (e instanceof ApiError && e.status === 401) return
    if (e instanceof ApiError && e.status === 409) {
      pairingNeeded.value = true // T3：未配对 → 引导用户先去完成设备配对，不连 WS
      return
    }
    errorMsg.value = (e as Error).message
  }
}

async function newSession() {
  if (!selectedContainer.value) return
  // issue #239：新会话取消 pending 重连定时器（断线时仍可由重连入口手动重连）。
  // codex #249 R3 P2：仅「已连上」时取消；若正处在断线退避中（disconnected），新会话（同容器）不得取消
  // 唯一自动重连——断的是同一连接、重连恢复的是同一 socket，与切容器「旧容器不重连」语义不同。
  if (!disconnected.value) cancelReconnect()
  abandonActiveRun()
  messages.value = []
  // codex R3 P1：不清空审批卡——新会话不换容器，切会话特意留存的同容器卡须保留（按 sessionKey 过滤渲染），
  // 否则卡住的 agent 对应那张卡会被这里误清、再也无法回覆
  try {
    const { session_key } = await createSession(selectedContainer.value)
    // 网关权威新建仅回 {session_key}：本地补全占位项（title 空 → 渲染回退 key 前 8 位，
    // 派生标题待下次 listSessions 刷新），避免引用已删除的 DB 字段（id/created_at）
    const s: SessionDTO = { session_key, title: '', updated_at: '' }
    sessions.value = [s, ...sessions.value]
    selectedSession.value = s.session_key
    errorMsg.value = ''
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    if (e instanceof ApiError && e.status === 409) {
      pairingNeeded.value = true // T3：未配对 → 引导（新建亦需先配对）
      return
    }
    errorMsg.value = (e as Error).message
  }
}

// T3 删除会话（issue #82 / spec #76，admin 级提升权限）：二次确认后调 deleteSession，
// 网关先写压缩归档（可恢复）再删。成功 → 从列表移除；删的是当前会话则切到剩余首个（无则新建）。
async function removeSession(key: string) {
  if (!key) return
  try {
    await ElMessageBox.confirm(
      '确认删除该会话？网关会先归档（可恢复）再删除。',
      '删除会话',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return // 用户取消
  }
  try {
    await deleteSession(selectedContainer.value, key)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    if (e instanceof ApiError && e.status === 409) { pairingNeeded.value = true; return }
    ElMessage.error((e as Error).message)
    return
  }
  sessions.value = sessions.value.filter((s) => s.session_key !== key)
  ElMessage.success('会话已删除')
  // 删的是当前会话：切到剩余首个（无则新建），复用切会话/新建逻辑加载历史
  if (selectedSession.value === key) {
    const next = sessions.value[0]?.session_key ?? ''
    if (next) pickSession(next)
    else { selectedSession.value = ''; await newSession() }
  }
}

function pickSession(key: string) {
  if (!key || selectedSession.value === key) return
  // issue #239：切会话清理重连定时器。
  // codex #249 R3 P2：仅「已连上」时取消（连上状态下不会有 pending 重连，此为保险）；若正处在断线退避中
  // （disconnected），切会话（同容器）不得取消唯一自动重连——断的是同一连接、重连恢复的是同一 socket，
  // 取消后错误条又被 loadHistory 清空、重连入口消失，单容器用户只能刷新页面。切「容器」才无条件取消。
  if (!disconnected.value) cancelReconnect()
  abandonActiveRun()
  selectedSession.value = key
  // codex R2 P1：不清空审批卡——同容器其它会话的卡保留，渲染时按 selectedSession 过滤即可
  void loadHistory(key) // T3：切会话加载该会话历史（loadHistory 内部清空 messages + 维护分页态）
}

// T3 会话历史回看（issue #82 / spec #76）：拉 chat.history 渲染历史消息 + 维护分页态。
// stale 守卫：切会话/容器后迟到的 history 响应按 containerGen + selectedSession 双校验丢弃
// （同 listSessions 的 containerGen 套路）。401 由 client 处理；其它失败落 errorMsg。
// codex #249 P2：另加 historyGen 请求代——同一会话并发两次 loadHistory（如重连恢复撞上在途请求）
// 时只让最新一次提交快照，被取代的在途请求落地即丢弃，避免两份快照各自 prepend 造成转录重复。
async function loadHistory(key: string) {
  const gen = containerGen
  const hgen = ++historyGen // codex #249 P2：本请求代；之后再有 loadHistory 即取代本请求
  const cname = selectedContainer.value
  // codex #249 R5 (id 3690750253)：重连恢复会话的 loadHistory 不得 wipe 已认领续流的在途 run——
  // 恢复帧（replace 快照）在 ready 之前已到达并写入尾气泡，历史快照是**断线前**的旧投影，整体替换
  // 会清掉恢复中的流式尾（续流 delta 无处锚定 → 可见回答停在断线快照）。resumeClaimed 且同会话时
  // 保留断线前投影作 inFlight（含已认领续流的流式尾），历史快照 prepend 在前（对齐 codex P2 #108）。
  const preserveTail = resumeClaimed && resumeRunSession === key
  if (preserveTail) {
    resumePending = false // 恢复投影已由本 loadHistory 接管：窗口结束
    resumeClaimed = false
  } else {
    messages.value = []
  }
  historyHasMore.value = false
  historyAnchor.value = null
  historyLoading.value = true
  errorMsg.value = ''
  pairingNeeded.value = false // T3：加载新会话重置未配对引导
  try {
    const res = await getSessionHistory(cname, key)
    if (gen !== containerGen || selectedSession.value !== key) return // 切走了：丢弃迟到响应
    if (hgen !== historyGen) return // codex #249 P2：已被更新的 loadHistory 取代：丢弃本在途响应
    // codex P2 #108：保留 await 期间 send() 追加的进行中 turn（user + 流式 assistant 占位）。
    // 直接整体替换会被历史快照覆盖 → WS delta 找不到 streaming 尾，整轮实时回复从 UI 消失。
    // 历史在前、进行中 turn 留在尾，streaming 尾仍是 onText 路由的目标。
    const inFlight = messages.value
    messages.value = [...res.messages.map(translateHistoryMessage), ...inFlight]
    historyHasMore.value = res.hasMore
    historyAnchor.value = res.nextOffset
  } catch (e) {
    if (gen !== containerGen || selectedSession.value !== key) return
    if (hgen !== historyGen) return // codex #249 P2：被取代的请求：不落错误、不干扰新请求
    if (e instanceof ApiError && e.status === 401) return // 401 由 client 处理会话
    if (e instanceof ApiError && e.status === 409) {
      pairingNeeded.value = true // T3：未配对 → 引导（容器可能在会话期间被解配）
      return
    }
    errorMsg.value = (e as Error).message
  } finally {
    if (gen === containerGen && selectedSession.value === key && hgen === historyGen) {
      historyLoading.value = false // codex #249 P2：只有最新请求才复位（被取代的不得关新请求的 loading）
    }
  }
}

// T3 历史消息翻译（防腐层，issue #82）：网关 display-normalized 消息字段名「待实测」（对齐后端
// _parse_history 透传策略），前端单点容错——role 归一 operator/user/human→user、其余→assistant；
// text 主取 text、回退 content/message。历史消息为终态：streaming=false、无 tools、thinking 暂不剥离。
// 实测确认字段名后改此处即可。
function translateHistoryMessage(m: HistoryMessageDTO): Msg {
  const text =
    typeof m.text === 'string' ? m.text
    : typeof m.content === 'string' ? m.content
    : typeof m.message === 'string' ? m.message
    : ''
  return {
    role: historyRole(m.role),
    raw: text,
    text,
    thinking: '',
    thinkingOpen: false,
    streaming: false,
    tools: [],
  }
}

function historyRole(role: unknown): 'user' | 'assistant' {
  const r = typeof role === 'string' ? role.toLowerCase() : ''
  return r === 'operator' || r === 'user' || r === 'human' ? 'user' : 'assistant'
}

// T3 历史分页（issue #82）：顶部「加载更多」向回翻更旧消息——用 historyAnchor(=nextOffset) 作
// messageId 锚点请求更旧一页，prepend 到列表头部（消息流按时间旧→新，更旧的在上）。
// stale 守卫同 loadHistory（containerGen + selectedSession 双校验）。
// codex #249 R3 P2：与 loadHistory 共用 historyGen 请求代——完整 reload（如重连恢复）会 ++historyGen
// 取代在途分页；若分页只校验不变的 container/session，其迟到响应会 prepend 旧页并覆盖 historyAnchor
// 回第一页锚点，下次「加载更多」重复拉取/prepend 同一旧页（转录重复）。故分页也捕获并校验请求代。
async function loadMoreHistory() {
  if (!historyHasMore.value || historyAnchor.value == null || historyLoading.value) return
  const key = selectedSession.value
  const gen = containerGen
  const hgen = historyGen // codex #249 R3 P2：捕获当前代；不自增（分页不得取代进行中的完整 loadHistory）
  const cname = selectedContainer.value
  const anchor = String(historyAnchor.value)
  historyLoading.value = true
  try {
    const res = await getSessionHistory(cname, key, undefined, anchor)
    if (gen !== containerGen || selectedSession.value !== key) return // 切走了：丢弃迟到响应
    if (hgen !== historyGen) return // codex #249 R3 P2：已被完整 loadHistory 取代：丢弃本在途分页
    messages.value = [...res.messages.map(translateHistoryMessage), ...messages.value]
    historyHasMore.value = res.hasMore
    historyAnchor.value = res.nextOffset
  } catch (e) {
    if (gen !== containerGen || selectedSession.value !== key) return
    if (hgen !== historyGen) return // codex #249 R3 P2：被取代的分页：不落错误、不干扰新请求
    if (e instanceof ApiError && e.status === 401) return
    if (e instanceof ApiError && e.status === 409) { pairingNeeded.value = true; return }
    errorMsg.value = (e as Error).message
  } finally {
    // codex #249 R3 P2：仅当代际未变才复位——被取代的分页不得关掉完整 reload 的 loading
    if (gen === containerGen && selectedSession.value === key && hgen === historyGen) {
      historyLoading.value = false
    }
  }
}

function connect() {
  cancelReconnect() // 手动/自动重连都先取消 pending 定时器，避免并发两条重连链
  // issue #240 前置防护：过期/缺失的 token 不直接建连（后端握手 accept 后立即 4401 关闭，白跑一次）——
  // 先 forceRefresh 换新再建连。token 有效时同步直建（无调用方在 connect() 后同步读 ws，同步入口只为
  // 测试/手动重连的对称性，非承载契约；建连主体 openSocket 内含 myWs.start）。refresh 确认失效
  // （refreshExhausted）→ 清会话跳登录，不再建连；瞬态失败（网络异常/5xx）不置 exhausted、不踢人：
  // token 已空，建连由后端 4401 兜底走刷新重连链路。
  if (!auth.token || isTokenExpired(auth.token)) {
    void (async () => {
      await auth.forceRefresh()
      if (disposed) return
      if (auth.refreshExhausted) { redirectLogin(); return }
      openSocket()
    })()
    return
  }
  openSocket()
}

// connect 的建连主体（token 就绪后调用）：关旧 socket → 记恢复会话 → 建 ChatWebSocket → start。
// 从 connect 抽出以便前置 token 刷新的异步路径复用同一建连逻辑（issue #240）。
function openSocket() {
  // 先把当前引用置空再关旧 socket：旧 ws 的 onClose 触发时 ws!==myWs（stale guard 判定为旧连接），
  // 不报误断线、也不调度重连（与 selectContainer 同款「先置空再 close」模式）
  const oldWs = ws
  ws = null
  oldWs?.close()
  // 记录断线重连前的会话：重连 Ready 后用 loadHistory 恢复该会话权威投影（issue #239）
  const resumeSession = selectedSession.value
  // codex #249 R5 (id 3690750253)：断线重连（reconnectAttempts>0）置恢复窗口——恢复的正是 onClose
  // 标记 abandoned 的那个在途 run。首帧认领（claimResumedRun）解除其 abandoned 标记并重新续流；
  // 仅当前仍选中同一会话才认领（resumeRunSession 守卫），切会话/容器时 abandonActiveRun 已清空。
  const isReconnect = reconnectAttempts > 0
  resumePending = isReconnect
  resumeRunSession = isReconnect ? resumeSession : ''
  connecting.value = true
  disconnected.value = false
  errorMsg.value = ''
  // 每个 ws 闭包捕获自身；旧 ws 的 onClose 触发时 ws 已指向新连接 → 不报误断线
  const myWs = new ChatWebSocket('/ws/chat/', auth.token, {
    onReady: () => {
      if (ws === myWs) {
        connecting.value = false
        errorMsg.value = ''
        const attempts = reconnectAttempts
        reconnectAttempts = 0 // 连接成功：重置退避（契约「重连成功即重置退避」）
        // issue #239：断线重连成功（attempts>0 表示上一轮在退避重连）→ 以权威历史恢复投影，
        // 找回断线期间的流式文本（对齐 OpenClaw「重连后恢复状态」：重连视为基于持久历史的新投影）。
        // codex #249 P2：重连 socket 创建后、ready 到达前用户可能已切会话——resumeSession 仍指旧会话，
        // 若仍 loadHistory(resumeSession) 会同步清空新会话消息并置 historyLoading（其 stale 守卫因
        // selectedSession 已变直接 return、不复位该 flag）→ 新会话空白且「加载更多」永久禁用。
        // 仅当当前会话仍是重连前捕获的那会话才恢复；否则跳过（pickSession 已自行 loadHistory 新会话）。
        // codex #249 R5：resumePending/resumeClaimed 由 loadHistory 在恢复会话时消费清除（preserveTail
        // 分支）；若恢复窗口仍在但 ready 不触发 loadHistory（切走了会话），在此兜底结束窗口防泄漏。
        if (attempts > 0 && resumeSession && selectedSession.value === resumeSession) {
          void loadHistory(resumeSession)
        } else if (resumePending) {
          resumePending = false
          resumeClaimed = false
        }
      }
    },
    onText: (runId, delta, replace) => {
      if (ws !== myWs) return  // stale guard：切换容器后旧 ws 回调不污染新会话
      // codex #249 R5：恢复 run 的首帧认领——解除 abandoned 标记 + 重新续流尾部气泡。须在
      // abandonedRunIds 守卫之前（该 run 正被标记着）。新 run 不认领（不在 abandoned 集）。
      if (claimResumedRun(runId)) {
        activeRunId = runId
        pendingSend = false
      } else if (abandonedRunIds.has(runId)) {
        return  // 切换前遗留 run 的增量：丢弃
      }
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
        // T08 思考链剥离（spec §8.3 (a) / r26 §4）：思考以 <thinking> 标签内联在 text 增量里 →
        // 累积原始串 raw，再整体重解析拆出 thinking/text（replace 快照与 delta 追加统一走重解析，纯函数无跨帧态）
        last.raw = replace ? delta : last.raw + delta
        const parts = splitThinking(last.raw)
        last.thinking = parts.thinking
        last.thinkingOpen = parts.inThinking
        last.text = parts.text
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
    onError: (msg, runId, approvalId, retryable) => {
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
      // Django socket can be healthy while start/resume fails to reach OpenClaw.  A retryable
      // startup error must re-enter the sole onClose/backoff path; otherwise this open browser
      // socket strands the UI with neither automatic nor manual recovery.
      if (retryable) myWs.close()
    },
    onClose: (code) => {
      if (ws !== myWs) return  // 旧 ws 的关闭（切容器）不报断线
      connecting.value = false
      disconnected.value = true  // 意外断线：禁用发送（codex P2 #4）
      recoverPendingApprovals()  // 连接断开：恢复所有 resolving 卡片可重试
      // issue #238（评审 #198 问题 3）：断线若正在流式——收尾气泡（光标落定、不被 streaming 永久锁死）
      // + 把在途 run 标记 abandoned（activeRunId/pendingSend 清理干净），迟到帧按既有体系丢弃；
      // 重连/恢复后新 run 首帧不被残留 activeRunId 静默丢弃。
      finalizeLast()
      abandonActiveRun()
      pendingAbandonCount = 0 // socket 已死：孤儿计数是「同 socket 内迟到首帧」语义，不会再投递，清零防吞新 run
      if (!disposed) errorMsg.value = '连接已断开，请重试或切换容器'
      // issue #240：4401（access token 过期）走刷新重连链路（forceRefresh → 新 token 立即重连），
      // refresh 确认失效才跳登录——不走普通退避重连，避免拿过期 token 空转形成 4401 死循环。
      if (code === 4401) {
        if (!disposed) void recoverUnauthorized()
        return
      }
      // issue #239：意外断线（非 4401 JWT 过期、非卸载）→ 调度指数退避自动重连，Ready 后恢复历史投影。
      if (!disposed) scheduleReconnect()
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
        // codex P1 (issue #154)：识别 allow-once/allow-always/deny，其它权威值显示「未知」
        a.decision = decision === 'allow-once' || decision === 'allow-always' || decision === 'deny' ? decision : 'unknown'
      }
    },
    onTool: (tool) => {
      // T08 工具执行（issue #44 / spec §9.4）：工具挂在所属 chat run 内，带 runId。首帧可能是工具
      // （agent 先调工具再回复）→ 与 onText 同款锚定当前 run；按 name 聚合 start→result 渲染一行标题+状态。
      if (ws !== myWs) return
      // codex #249 R5：恢复 run 首帧是工具帧时同样认领（解除 abandoned 标记），续流不丢
      if (claimResumedRun(tool.runId)) {
        activeRunId = tool.runId
        pendingSend = false
      } else if (abandonedRunIds.has(tool.runId)) {
        return
      }
      if (activeRunId && tool.runId !== activeRunId) return
      if (!activeRunId) {
        if (pendingAbandonCount > 0) { pendingAbandonCount--; abandonedRunIds.add(tool.runId); return }
        activeRunId = tool.runId
        pendingSend = false
      }
      const last = messages.value[messages.value.length - 1]
      if (!last || last.role !== 'assistant') return
      if (tool.state === 'running') {
        last.tools.push({ id: tool.id, name: tool.name, state: 'running', title: tool.title,
                          input: tool.input, result: tool.result })
        return
      }
      // running/error/done：优先按工具调用 id 配对；无 id 退 name 匹配最后一个 running 行
      for (let i = last.tools.length - 1; i >= 0; i--) {
        const row = last.tools[i]
        const match = tool.id ? row.id === tool.id : row.name === tool.name && row.state === 'running'
        if (match && row.state === 'running') {
          row.state = tool.state
          row.result = tool.result
          return
        }
      }
      last.tools.push({ id: tool.id, name: tool.name, state: tool.state, title: tool.title,
                        input: tool.input, result: tool.result })
    },
  })
  ws = myWs
  // codex #249 P1 (id 3690452668)：仅**断线重连**（reconnectAttempts>0，上一轮在退避重连）才把当前会话
  // 随握手带给后端——后端 _handle_start 据此 record_active_session 重新注册该会话恢复回调，让断线前
  // 进行中的 run 的剩余增量/终态帧投给重连的新 consumer。取**当前** selectedSession（非断线前捕获的
  // resumeSession）：断线退避中切会话（R3 ①）时注册的是切后的新会话，旧会话迟到帧由 onText/onDone 的
  // stale/abandon 守卫丢弃。首连/切容器（reconnectAttempts==0）不带 sessionKey：维持 plain start。
  const resumeKey = reconnectAttempts > 0 ? selectedSession.value : ''
  myWs.start(selectedContainer.value, resumeKey || undefined)
}

// T06：批准/拒绝 → 回发 resolve 帧 + 进 resolving 态（禁用按钮等回执，不乐观假成功，codex P2）。
// 成功由 onApprovalResolved 落定；失败由 onError 恢复 pending 让卡片可重试。
function resolveApproval(a: ApprovalItem, decision: 'allow-once' | 'deny') {
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
  messages.value.push({ role: 'user', raw: text, text, thinking: '', thinkingOpen: false, streaming: false, tools: [] })
  messages.value.push({ role: 'assistant', raw: '', text: '', thinking: '', thinkingOpen: false, streaming: true, tools: [] })
  activeRunId = '' // 等首帧 onText 锚定新 run
  pendingSend = true // 首帧未到前，切会话会按 pending 孤儿计数（codex P2 #3）
  ws.send(selectedSession.value, text)
  input.value = ''
}

onMounted(loadInstances)
onBeforeUnmount(() => {
  disposed = true
  cancelReconnect() // issue #239：卸载清理 pending 重连定时器（防泄漏/卸载后误重连）
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
          <span class="sess-title">{{ s.title || s.session_key.slice(0, 8) }}</span>
          <!-- T3 删除会话（issue #82）：@click.stop 防止触发 li 的 pickSession；二次确认在 removeSession 内。 -->
          <button
            class="sess-del"
            title="删除会话"
            :data-test="`delete-session-${s.session_key}`"
            @click.stop="removeSession(s.session_key)"
          >✕</button>
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
      <!-- T3 未配对引导（issue #82 / spec §8.1）：容器未完成设备配对时网关回 409，
           对话/历史/新建均不可用——指引用户先去「容器」页完成配对。 -->
      <div v-if="pairingNeeded" class="pair-guide" data-test="pairing-guide">
        ⚠️ 该容器尚未完成设备配对，对话与历史暂不可用。请先在「容器」页完成设备配对后再回来。
      </div>
      <p v-if="errorMsg" class="error" data-test="error-bar">{{ errorMsg }}</p>
      <!-- issue #239：断线手动重连入口——直接调 connect()（绕开 selectContainer 同名 early-return）。
           codex #249 R3 P2：由 disconnected 独立渲染，不套在 errorMsg 的 <p v-if> 里——断线后切会话
           loadHistory 会清 errorMsg，若入口随错误条消失则 disconnected 仍 true、发送仍禁用，单容器用户
           只能刷新页面。断开期间始终提供重连路径。 -->
      <p v-if="disconnected" class="error" data-test="reconnect-bar">
        连接已断开
        <button class="reconnect" data-test="reconnect" @click="connect()">重新连接</button>
      </p>
      <div class="stream" data-test="stream">
        <!-- T3 历史分页（issue #82）：hasMore 时顶部「加载更多」向回翻更旧消息，prepend 到头部。 -->
        <button
          v-if="historyHasMore"
          class="load-more"
          :disabled="historyLoading"
          data-test="load-more"
          @click="loadMoreHistory"
        >
          {{ historyLoading ? '加载中…' : '加载更多' }}
        </button>
        <div v-for="(m, i) in messages" :key="`m-${i}`" class="msg" :class="m.role">
          <div class="bubble">
            <!-- T08 思考链折叠卡（spec §8.3 (a) / r26 §4）：思考以 <thinking> 标签内联在 text 增量里，
                 前端内容层剥离后独立渲染真实思考；流式中（thinkingOpen）标注「思考中…」。 -->
            <details v-if="m.role === 'assistant' && m.thinking" class="cot" data-test="cot-card">
              <summary class="cot-head">
                <span class="caret">▶</span> 思考过程
                <span v-if="m.thinkingOpen" class="cot-flag thinking">思考中…</span>
              </summary>
              <div class="cot-body">{{ m.thinking }}</div>
            </details>
            <!-- T08 工具执行（spec §9.4 / 原型 oc-chat-page）：一行一个——图标+工具标题/名(mono)+关键参数+状态，
                 不展开输入输出细节。事件名/payload 待配对后实测校准（r26 §3）。 -->
            <div
              v-for="(t, ti) in m.tools"
              :key="`tool-${ti}`"
              class="tool"
              :class="t.state"
              data-test="tool-line"
            >
              <span class="t-icon">🔧</span>
              <span class="t-name" :title="t.title ? t.name : ''">{{ t.title ?? t.name }}</span>
              <span v-if="formatToolInput(t.input)" class="t-args">{{ formatToolInput(t.input) }}</span>
              <span class="t-state">{{ t.state === 'running' ? '⟳ 运行中' : t.state === 'error' ? '✗ 失败' : '✓ 完成' }}</span>
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
              {{ a.decision === 'allow-once' ? '已批准' : a.decision === 'allow-always' ? '已批准（始终）' : a.decision === 'deny' ? '已拒绝' : '未知' }}
            </span>
          </div>
          <div class="a-sub">{{ approvalSubtitle(a) }}</div>
          <div class="a-cmd">{{ a.command }}</div>
          <div v-if="a.detailOpen" class="a-detail" :data-test="`approval-detail-${a.id}`">
            命令全文：<code>{{ a.command }}</code><br>
            审批 id：<code>{{ a.id }}</code> · 类型：<code>{{ a.kind }}</code>
            · 经审批事件推送，审批接口回覆
          </div>
          <div v-if="a.status !== 'resolved'" class="a-actions">
            <button class="btn-approve" :disabled="a.status !== 'pending' || disconnected" :data-test="`approve-${a.id}`" @click="resolveApproval(a, 'allow-once')">批准</button>
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
.sess { font-size: 13px; color: var(--el-text-color-secondary); display: flex; align-items: center; gap: 6px; }
.sess .sess-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess .sess-del { flex: none; background: transparent; border: none; color: var(--el-text-color-placeholder); cursor: pointer; font-size: 12px; padding: 0 2px; border-radius: 4px; }
.sess .sess-del:hover { color: var(--el-color-danger); }
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
.error .reconnect { margin-left: 10px; background: transparent; border: 1px solid currentColor; border-radius: 6px; padding: 1px 10px; cursor: pointer; color: inherit; font-size: 12.5px; }
.pair-guide { margin: 0; padding: 10px 18px; color: var(--el-color-warning); background: var(--el-color-warning-light-9); border-bottom: 1px solid var(--el-color-warning-light-7); font-size: 13px; }
.stream { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.load-more { align-self: center; background: transparent; border: 1px dashed var(--el-border-color); border-radius: 8px; padding: 5px 18px; cursor: pointer; color: var(--el-text-color-secondary); font-size: 12.5px; }
.load-more:disabled { cursor: default; opacity: .6; }
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

/* T08 思考链折叠卡（spec §8.3 (a) / 原型 oc-chat-page）：虚线卡，折叠渲染剥离出的真实思考 */
.cot { border: 1px dashed var(--el-border-color); background: var(--el-fill-color-light); border-radius: 10px; margin-bottom: 8px; }
.cot-head { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; font-size: 12.5px; color: var(--el-color-primary); user-select: none; list-style: none; }
.cot-head::-webkit-details-marker { display: none; }
.cot .caret { display: inline-block; transition: transform .18s; }
.cot[open] .cot-head .caret { transform: rotate(90deg); }
.cot-flag { margin-left: auto; font-size: 10.5px; border-radius: 6px; padding: 1px 6px; }
.cot-flag.thinking { color: var(--el-color-primary); border: 1px dashed var(--el-color-primary); }
.cot-body { padding: 0 12px 8px; color: var(--el-text-color-secondary); font-size: 12.5px; white-space: pre-wrap; }

/* T08 工具执行（spec §9.4 / 原型）：一行一个——图标+工具名(mono)+参数+状态，不展开细节 */
.tool { display: flex; align-items: center; gap: 9px; background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 9px; padding: 6px 12px; margin: 4px 0; font-size: 12.5px; }
.tool .t-icon { color: var(--el-color-primary); }
.tool .t-name { font-family: ui-monospace, monospace; }
.tool .t-args { color: var(--el-text-color-secondary); }
.tool .t-state { margin-left: auto; display: flex; align-items: center; gap: 5px; }
.tool.running .t-state { color: var(--el-color-warning); }
.tool.error .t-state { color: var(--el-color-danger); }
.tool.done .t-state { color: var(--el-color-success); }
</style>
