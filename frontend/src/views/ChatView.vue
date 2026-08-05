<script setup lang="ts">
// 对话页（spec §9.4，照 docs/prototypes/oc-chat-page.html，MVP 简化）。
// 左栏容器+会话；主区消息流式逐字 + 末尾闪烁光标；断线/错误提示。
// #369 M5 前端接线：WS 经隧道（/ws/chat/?container=）跑官方 @openclaw/gateway-client/browser 协议机
// （ADR 0006 B-直连），会话 CRUD/历史/发送/审批/命令全部改协议机 RPC；网关事件经 eventTranslate
// 纯函数翻译驱动现有渲染。多容器切换 = 重建 GatewayChat。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { listInstances, type InstanceDTO } from '@/api/containers'
import { getBootstrapToken } from '@/api/chat'
import { useAuthStore, isTokenExpired } from '@/stores/auth'
import { ApiError } from '@/api/client'
import {
  createGatewayChat,
  type GatewayChat,
  type SessionDTO,
  type CommandDTO,
  type HistoryMessageDTO,
  type ChatFrame,
} from '@/chat/gatewayChat'
import { splitThinking } from '@/chat/thinking'
import { extractMessageText } from '@/chat/eventTranslate'
import { WS_AUTH_FAIL, WS_MUST_CHANGE_PASSWORD, WS_CONTAINER_ACCESS_DENIED, WS_GATEWAY_UNAVAILABLE } from '@/chat/closeCodes'
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
  title: unknown // 网关 toolTitles 用途短标题（待实测），有则优先显示
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
const disconnected = ref(false) // 连接断开：禁用发送，提示重连/切容器（codex P2 #4）
let gateway: GatewayChat | null = null
let disposed = false
// runId 路由：仅当前 run 的增量写入回复；切会话/容器时把旧 run 标记 abandoned，丢弃其迟到帧（codex P2）
let activeRunId = '' // 已收到首帧的当前 run
const abandonedRunIds = new Set<string>() // 切换前遗留的 runId：迟到帧丢弃（codex P2 #3）
// F7: 空闲期（无在途用户 send）观察到的外来自主 run 的 runId——其后（用户 send 后）的续帧/终态
// 按 runId 丢弃，防止外来 run 在用户 send 后劫持 activeRunId、污染用户气泡/吞用户回复。终态清理。
const foreignRunIds = new Set<string>()
let pendingSend = false // 已 send 但首帧未到（runId 未知）
// #53: 本 send 的 RPC ack 返回的 runId（官方 chat.send ackPayload={runId,status:"started"}）——
// pendingSend 期间首帧归属判别信号：首帧 runId ≠ 本 run 时判定为外来/旧 run（切容器后旧连接在途
// run 首帧经新连接到达的唯一判别方式；ack 未回/无 runId 时为空串，沿用旧行为）。
let myRunId = '' // 本 send 的网关 runId（ack 返回）；'' = 未知/无 ack
let pendingAbandonCount = 0 // 切会话时仍 pending 的 run 数；其迟到首帧按 FIFO 视为孤儿丢弃（codex P2 #3）
// selectContainer 的请求代：丢弃切容器途中迟到的响应（codex P2）
let containerGen = 0
// codex #249 P2：loadHistory 的请求代。仅 containerGen+selectedSession 守卫拦不住「同一会话并发
// 两次 loadHistory」（如断线重连 onReady 恢复时上一次历史请求仍在途）——两次守卫值相同、响应都被
// 接受，后落地的快照 prepend 到先落地的已渲染历史上 → 转录重复/混杂。每次 loadHistory 自增并捕获
// 请求代，只有最新一次才允许提交其快照，其余（被取代的在途请求）落地即丢弃。
let historyGen = 0
// #369：协议机内置重连（退避）；openGateway 用 everConnected 区分「首连等待就绪」（pendingConnect
// resolve 供 selectContainer 续流程）与「重连成功恢复」（onReady 拉权威历史重建投影）。
let everConnected = false
let pendingConnect: ((ok: boolean) => void) | null = null
// B3/B4: pendingSend 窗口收尾宽限——pendingSend && !activeRunId 期间收到无法匹配自己 run 的
// error/done 时武装定时器：宽限内用户 run 首帧到达正常认领（复活占位），宽限过仍无首帧才落定占位
// （防 B3 外来 done-first 终结用户空泡；防 B4 外来 error 清 flag 后用户 run 首帧被当 foreign）。
// fire 时置 graceExpired（不保留 pendingSend）——慢 run 首帧 >宽限后仍走认领路径而非 foreign
// （F8 定时器反噬修复），同时避免 fire 后残留 pendingSend 让切会话产生 phantom orphan 吞新 run。
// 切换代际时清除（B4：防旧容器武装的定时器跨容器 fire 终结新容器 pending placeholder）。
const PENDING_RUN_GRACE_MS = 8000
let pendingGraceTimer: ReturnType<typeof setTimeout> | null = null
let graceExpired = false // B4: 宽限已 fire 仍无首帧——后续迟到的首帧仍认领（不 foreign）
function armPendingGrace() {
  if (pendingGraceTimer !== null) return
  pendingGraceTimer = setTimeout(() => {
    pendingGraceTimer = null
    if (pendingSend && !activeRunId) {
      finalizeLast() // 占位落定（防永久 streaming 锁死 composer）
      graceExpired = true // 迟到首帧仍可认领；pendingSend 清（切会话不产生 phantom orphan）
      pendingSend = false
      myRunId = '' // #53: 宽限 fire 放弃本 run 的 ack runId
    }
  }, PENDING_RUN_GRACE_MS)
}
function clearPendingGraceTimer() {
  if (pendingGraceTimer !== null) {
    clearTimeout(pendingGraceTimer)
    pendingGraceTimer = null
  }
}
// B5: 意外断线时在途 run 的恢复信息——网关重连可能 resume 同一 run 补发续帧（session projection）。
// onReady 消费：保留占位等待续帧（不 loadHistory 清空重建）；续帧到达 / 用户主动操作即取消。
// 已删 ws.ts 的 resumePending/claimResumedRun/preserveTail 正是为此存在，本 PR 以简化版重建。
const RESUME_WAIT_MS = 30_000
let resumeRun: { runId: string } | null = null
let resumeTimer: ReturnType<typeof setTimeout> | null = null
// 存活检测 #14: 初始连接期超时兜底——SYN 黑洞（socket 永不 open、onopen/onclose/onerror 均不
// 触发）下协议机无任何信号、pendingConnect 永挂、connecting 永久 true。兜底超时 resolve(false)
// 解锁 UI（提示可重试）+ 主动关隧道触发协议机退避重连（P1：不关 socket 会让用户消息在 CONNECTING
// 下被 tunnelSocket.send 静默丢弃）。阈值 > F10 握手超时 10s + 隧道侧网关连接超时 5s + 认证查询余量。
// P0（code review）：connectTimeoutTimer 收 openGateway 局部作用域——并发 openGateway 互踩模块级
// 单槽会让后调用方的 ready/timeout 双双永不 resolve、selectContainer 续体死锁。
const CONNECT_TIMEOUT_MS = 15_000
function armResumeWait(run: { runId: string }) {
  if (resumeTimer !== null) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    // 窗口内无 resume 续帧（续帧到达会在 handleText/handleTool 取消本 timer）→ run 已死，
    // 恢复为历史重建（清占位与残留投影）。
    if (!disposed && activeRunId === run.runId && selectedSession.value) {
      resumeRun = null
      // R4-6（第四轮）：清 activeRunId——否则残留死 runId 让 loadHistory 重建后，迟到的续帧命中
      // activeRunId===runId 通过 claimRun，append 进历史 assistant 消息（污染）；且后续自主 run 首帧
      // 命中 activeRunId 不同于自身 + claimedEmpty=false 被屏蔽。
      activeRunId = ''
      void loadHistory(selectedSession.value)
    }
  }, RESUME_WAIT_MS)
}
function clearResumeWait() {
  if (resumeTimer !== null) {
    clearTimeout(resumeTimer)
    resumeTimer = null
  }
  resumeRun = null
}

// T3 会话历史回看（issue #82 / spec #76）：分页态——hasMore 标记可向回翻更旧消息，
// historyAnchor=nextOffset 为下一更旧页的 messageId 锚点；historyLoading 控「加载更多」禁用。
const historyHasMore = ref(false)
const historyAnchor = ref<string | number | null>(null)
const historyLoading = ref(false)

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
// 清单经网关 commands.list RPC 按容器拉取并缓存；输入 `/` 弹补全菜单（前缀过滤，
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

// 拉取当前容器命令清单（协议机就绪后 onReady 首连触发）；失败静默降级为空清单。
// F12: 绑定容器名+代际——旧 gateway stop() flush reject 会走 catch 置空 commands，若发生在
// （另一容器的）新命令已填充后即误清空；快速切容器时旧 gateway 在途响应也会覆盖新命令。
async function loadCommands() {
  const name = selectedContainer.value
  const gen = containerGen
  if (!gateway) return
  try {
    const list = await gateway.listCommands()
    if (name === selectedContainer.value && gen === containerGen) commands.value = list
  } catch {
    if (name === selectedContainer.value && gen === containerGen) commands.value = []
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
  graceExpired = false // 切会话/容器：宽限过期的「迟到认领」语义作废（新 run 语境）
  activeRunId = ''
  pendingSend = false
  myRunId = '' // #53: 切会话/容器放弃本 run 的 ack runId
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

// issue #240：refresh 确认失效（refreshExhausted，cookie 4xx）——清会话跳登录，复用 api/client.ts 既有语义
// （瞬态失败不走这里）。跳到登录页后路由守卫 hydrate 会再次确认，用户重新登录。
function redirectLogin() {
  auth.clearSession()
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.assign('/login')
  }
}

// issue #240：4401（access token 过期）断线的刷新重连链路——区别于普通断线的退避重连。
// forceRefresh 换到新 token 后立即重建 gateway（socket 本身健康，只是凭证过期，无需退避）；
// refresh 确认失效（refreshExhausted）→ 清会话跳登录，不再重连；瞬态失败（token 仍空）→ 显示
// 错误留手动重连入口（协议机对 4401 决策 retry:false，不自动重连防死循环）。
async function recoverUnauthorized() {
  await auth.forceRefresh()
  if (disposed) return
  if (auth.refreshExhausted) {
    redirectLogin()
    return
  }
  if (auth.token) {
    void openGateway() // 新 token 已就绪：同步重建（无退避，socket 本身健康仅凭证过期）
  } else if (!disposed) {
    errorMsg.value = '登录状态刷新失败，请重试'
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
  selectedContainer.value = name
  // 立即停用旧连接 + 清空状态：避免旧 gateway 迟到帧/迟到响应污染新容器（codex P2 #5 同款）
  const oldGw = gateway
  gateway = null
  oldGw?.stop()
  connecting.value = true
  disconnected.value = false
  selectedSession.value = ''
  sessions.value = []
  messages.value = []
  approvals.value = [] // 切容器：清空审批卡（审查 #6）
  commands.value = [] // 切容器：清空命令缓存（命令按容器隔离，T07），随后 onReady 为新容器重新拉取
  slashDismissed.value = false
  input.value = '' // 切容器：清空 composer 残留输入（否则旧 `/` 会让新容器菜单误弹，T07）
  abandonActiveRun()
  clearPendingGraceTimer() // B4: 切容器清除旧容器武装的延迟收尾定时器（防跨容器 fire）
  clearResumeWait() // B5: 切容器放弃在途 run 的 resume 等待（新容器连接是新 run 语境）
  pendingAbandonCount = 0 // B1: 切容器后孤儿计数清零（旧连接的 run 永不再来帧，防吞新容器首帧）
  errorMsg.value = ''
  try {
    // F5: 只等首连决议（openGateway 内部由 onReady/onClose/onError resolve）；会话列表/历史加载
    // 统一由 syncSessions 在 onReady 完成（首连成功与重连成功同路径）——首连失败后协议机自连/
    // 「重新连接」也都能补拉会话，否则「看似已连接」的空 chat 无会话、send 静默 no-op。
    const ok = await openGateway()
    if (gen !== containerGen) return
    if (!ok) return // openGateway 已显示错误（容器不可访问/连接失败）
  } catch (e) {
    if (gen !== containerGen) return
    connecting.value = false // 出错解除 connecting（composer 解禁后用户可重试）
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  }
}

// F5: 会话列表 + 当前会话历史加载（B-直连下会话 CRUD 全走协议机 RPC）。首连成功、自动重连成功、
// 手动重连成功都在 onReady 触发（统一路径）；带 name+gen 守卫丢弃切容器途中迟到的响应。
// C1: 保留原选中会话——4401 重建 / 手动重连不把用户踢回 session[0]（仅当原会话已删除才回退首个）。
// C2: 无论首连还是重连都恢复当前会话历史（首连瞬败后跨自动重连也能补拉，防「看似已连接」空 chat）。
async function syncSessions(name: string, gen: number) {
  if (gen !== containerGen || selectedContainer.value !== name || !gateway) return
  try {
    const list = await gateway.listSessions()
    if (gen !== containerGen || selectedContainer.value !== name) return // 切容器途中迟到：丢弃
    const prev = selectedSession.value
    sessions.value = Array.isArray(list) ? list : [] // 对网关输入 0 信任：非数组回退空列表
    if (prev && sessions.value.some((s) => s.session_key === prev)) {
      selectedSession.value = prev // C1: 原会话仍在列表中 → 保留选中
    } else {
      selectedSession.value = sessions.value[0]?.session_key ?? ''
    }
    if (!selectedSession.value) await newSession()
    if (gen !== containerGen) return // newSession 期间又切容器：不连
    if (!selectedSession.value) return // 会话创建失败（newSession 已显示错误）：不加载历史
    void loadHistory(selectedSession.value) // T3：加载当前会话历史（C2：重连补拉也恢复投影）
  } catch (e) {
    if (gen !== containerGen) return
    connecting.value = false // 出错解除 connecting（composer 解禁后用户可重试）
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  }
}

// 建连主体（token 就绪后调用）：取 bootstrap token → 建 GatewayChat → 协议机握手。
// 返回连接是否就绪（首连 onReady/onClose/onError 决议）；4401 刷新重建 / 手动重连复用。
async function openGateway(): Promise<boolean> {
  const name = selectedContainer.value
  const gen = containerGen
  if (!name) return false
  // 先把当前引用置空再停旧 gateway：旧 gateway 的 onClose 触发时 gateway!==myGw（stale guard
  // 判定为旧连接），不报误断线（与 selectContainer 同款「先置空再停」模式）
  const oldGw = gateway
  gateway = null
  // F6: 替换前决议旧等待方——旧 openGateway 的 pendingConnect（await ready 挂起者）立即 resolve：
  // 旧 gateway.stop() 不触发 onClose（协议机未配 notifyStoppedClose）+ ChatView stale guard 也拦截
  // 旧连接回调，无任何 resolve 路径；不在这里决议会让并发 openGateway 的早调用者 await ready 永挂
  // （泄漏 async frame + 切容器续体死锁）。
  if (pendingConnect) {
    pendingConnect(false)
    pendingConnect = null
  }
  oldGw?.stop()
  connecting.value = true
  disconnected.value = false
  errorMsg.value = ''
  everConnected = false
  pendingConnect = null
  clearPendingGraceTimer() // B4: 建连代际切换清除延迟收尾定时器（防跨代 fire）
  clearResumeWait() // B5: 新连接是新 run 语境，旧连接在途 run 的 resume 等待作废
  pendingAbandonCount = 0 // B1: 新连接孤儿计数清零（防吞新 run 首帧；切容器/4401重建/手动重连同路径）
  myRunId = '' // #53: 新连接生命周期边界，本 run 的 ack runId 作废
  graceExpired = false // #11（第四轮）：宽限过期标记是 run 语境，连接边界复位——防重连后首个自主 run 被 lateClaim 认领进旧占位
  // 协议机首连须 bootstrap auth（ADR 事实 2）；归属门/不存在 → 20040（前端显示容器不可访问）。
  // 信封错误（HTTP 200 + code）经 apiJson 抛 ApiError(code)——status 分支不再需要（P0 code review）。
  let bootstrapToken: string
  try {
    bootstrapToken = await getBootstrapToken(name)
  } catch (e) {
    if (gen !== containerGen || disposed) return false
    connecting.value = false
    if (e instanceof ApiError && (e.status === 401 || e.code === 10001)) return false
    if (e instanceof ApiError && e.code === 20040) {
      errorMsg.value = '容器不可访问，请切换容器'
      return false
    }
    // #13：容器非 running（creating/stopped/removing）——bootstrap-token 前置门，给清晰文案而非
    // 陷入隧道 4402 退避循环后显示通用「连接失败」。
    if (e instanceof ApiError && e.code === 20046) {
      errorMsg.value = '容器未运行，请启动后再对话'
      return false
    }
    errorMsg.value = (e as Error).message
    return false
  }
  if (gen !== containerGen || disposed) return false
  const ready = new Promise<boolean>((resolve) => {
    pendingConnect = resolve
  })
  const myGw = createGatewayChat({
    container: name,
    jwt: auth.token!,
    bootstrapToken,
    handlers: {
      // 协议机完成 v4 握手（hello-ok）——首连与自动重连成功都会触发。首连：resolve 连接就绪 +
      // 拉命令清单；重连：以权威历史恢复投影（断线期间在途 run 已 abandoned 丢弃迟到帧）。
      onReady: () => {
        if (gateway !== myGw) return // stale guard：切容器后旧 gateway 回调不污染新会话
        connecting.value = false
        disconnected.value = false
        errorMsg.value = ''
        // #11（第四轮）：宽限过期标记是 run 语境，重连（新连接生命周期边界）复位——协议机自动重连
        // 走此路径（非 openGateway），不重置会让重连后首个自主 run 被 lateClaim（!pendingSend &&
        // graceExpired）认领进历史 assistant 占位。
        graceExpired = false
        if (everConnected) {
          // 自动重连成功：B5 若断线时在途 run 需 resume → 保留占位等续帧（不 loadHistory 清空
          // 重建，续帧继续渲染）；否则 syncSessions 恢复会话/历史（C2：重连补拉，首连瞬败后不再
          // 永久空列表、也不再只 loadHistory 空转）。
          if (resumeRun) {
            const r = resumeRun
            resumeRun = null
            armResumeWait(r)
          } else {
            void syncSessions(name, gen)
          }
          void loadCommands() // C2: 重连补拉命令清单（首连瞬败后斜杠菜单不再永久死）
        } else {
          everConnected = true
          pendingConnect?.(true)
          pendingConnect = null
          // F5: 会话列表/历史加载与首连解耦——首连成功与首连失败后的重连成功都在这里补拉会话，
          // 否则失败后 selectContainer 已 return、重连 onReady 也不 listSessions → 空 chat 假连接。
          void syncSessions(name, gen)
          void loadCommands()
        }
      },
      // 网关事件经 eventTranslate 翻译成渲染帧，按 type 分派到对应处理（runId 路由在 handle* 内）
      onFrame: (frame: ChatFrame) => {
        if (gateway !== myGw) return
        switch (frame.type) {
          case 'text':
            handleText(frame.runId, frame.delta, frame.replace)
            break
          case 'done':
            handleDone(frame.runId)
            break
          case 'error':
            handleError(frame.message, frame.runId)
            break
          case 'approval':
            handleApproval(frame)
            break
          case 'approvalResolved':
            handleApprovalResolved(frame.id, frame.decision)
            break
          case 'tool':
            handleTool(frame)
            break
        }
      },
      onClose: (code, _reason, retry, pairingRequired) => {
        if (gateway !== myGw) return // 旧 gateway 的关闭（切容器）不报断线
        connecting.value = false
        disconnected.value = true // 意外断线：禁用发送（codex P2 #4）
        recoverPendingApprovals() // 连接断开：恢复所有 resolving 卡片可重试
        const authGate =
          code === WS_AUTH_FAIL || code === WS_MUST_CHANGE_PASSWORD || code === WS_CONTAINER_ACCESS_DENIED
        // 占位落定（所有断开路径，光标不闪烁）：授权门拒绝（4401/4403/4404）也要落定——旧实现
        // 授权门分支不 finalizeLast，流式占位永久闪烁（composer 因 streaming 禁发）（P1-1）。
        if (activeRunId || pendingSend) finalizeLast()
        // R4-7（第四轮）：清 pendingSend——首帧未到的 send 在本连接已死，重连是新 run 语境（resumeRun
        // 仅在 activeRunId 非空时记，pendingSend 期间断线本就不期望 resume）。泄漏会让 4401 重建后
        // 切会话 abandonActiveRun 走 `else if (pendingSend)` → pendingAbandonCount++ → 下次 send 首帧
        // 被孤儿计数吞。
        pendingSend = false
        myRunId = '' // #53: 连接已死，本 run 的 ack runId 作废
        // B5: 意外断线不永久 abandon 在途 run——网关重连可能 resume 同一 run 补发续帧
        // （session projection）。记录 resumeRun 供 onReady 保留占位等待续帧（而非 loadHistory
        // 清空重建）；授权门拒绝（4401/4403/4404）不记录（连接未建立/不可恢复，无续帧可等）。
        if (authGate) {
          // P1-1: 授权门清残留 activeRunId——否则 loadHistory 清 messages 但不清 runId，跨重连
          // 存活的 runId 让自主 run 首帧被静默丢弃（claimedEmpty=false）。
          activeRunId = ''
        } else {
          // P1-3（code review）：仅 activeRunId 非空才记录 resumeRun——pendingSend=true 但首帧未到
          // （activeRunId===''）时断线，该 run 无法 resume（网关从未处理/无 runId 可投影），记录
          // {runId:''} 会让重连 30s 后 armResumeWait 以 '' 匹配 → loadHistory 清空用户刚发的消息。
          if (activeRunId) resumeRun = { runId: activeRunId }
          // 保留 activeRunId + 占位（不清空），等重连 onReady 消费 resumeRun（B5 续帧匹配）
        }
        pendingAbandonCount = 0 // 连接已死：孤儿计数是「同连接内迟到首帧」语义，清零防吞新 run
        if (!everConnected) {
          // 握手就绪前关闭（连接建立失败）→ 决议 openGateway 失败
          pendingConnect?.(false)
          pendingConnect = null
        }
        // issue #240：4401（access token 过期）走刷新重连链路（forceRefresh → 新 token 重建），
        // refresh 确认失效才跳登录——协议机对 4401 决策 retry:false，防拿过期 token 死循环。
        if (code === WS_AUTH_FAIL) {
          if (!disposed) void recoverUnauthorized()
          return
        }
        // D1: 4403 强制改密是账号级门（非容器归属）——切任何容器都 4403，误导「切换容器」让用户
        // 永远得不到「去改密码」指引，故独立文案。
        if (code === WS_MUST_CHANGE_PASSWORD) {
          if (!disposed) errorMsg.value = '账号需先修改密码后才能使用对话（请前往账号设置修改密码）'
          return
        }
        // 4404（容器归属门拒绝）：提示切换容器
        if (code === WS_CONTAINER_ACCESS_DENIED) {
          if (!disposed) errorMsg.value = '容器不可访问，请切换容器'
          return
        }
        // P1-7 + #377：PAIRING_REQUIRED 已由 gatewayChat 自动配对编排接管（approve → 重连）——
        // 此处 pairingRequired 仅在「自动配对失败」（approve HTTP 错误 / requestId 无效 / 预算用尽）
        // 时透传，如实提示重试而非让用户去容器详情页手动配对（详情页无 approve 入口，配对是自动的）。
        if (pairingRequired) {
          if (!disposed) errorMsg.value = '设备配对失败，请重试连接'
          return
        }
        // #376: 4402 网关不可达预算超限（retry:false = 连续 4402 达重试预算）→ 提示「容器网关不可用」
        // （容器 stopped/重启中/端口不通，容器恢复前重试无益；disconnected 条的「重新连接」= 手动重连
        // 入口，切容器/重连即新建 GatewayChat 重置预算）。预算内（retry:true）不在此分支，落下方
        // 「自动重连中…」。
        if (code === WS_GATEWAY_UNAVAILABLE && !retry) {
          if (!disposed) errorMsg.value = '容器网关不可用，请确认容器已启动后手动重连'
          return
        }
        // 其他断开：D2 按协议机 retry 决策如实提示——false = 已停止自动重连（非恢复错误 /
        // 连续失败 give-up / 未配对），true = 退避重连中。不再对已停重连谎报「自动重连中…」。
        if (!disposed) {
          errorMsg.value = retry ? '连接已断开，自动重连中…' : '连接已断开，自动重连已停止，请手动重连'
        }
      },
      onError: (message) => {
        if (gateway !== myGw) return
        if (!everConnected) {
          connecting.value = false
          pendingConnect?.(false)
          pendingConnect = null
        }
        if (!disposed) errorMsg.value = message
      },
    },
  })
  gateway = myGw
  myGw.start()
  // P0（code review）：连接期超时竞速——SYN 黑洞初始连接（socket 永不 open）下 onReady/onClose/
  // onError 都不触发，pendingConnect 永挂、connecting 永久 true。timer 收本调用局部作用域（闭包
  // 持有），并发 openGateway 不再互踩模块级单槽。超时：resolve(false) 解锁 UI + 主动关隧道触发
  // 协议机退避重连（P1：不关 socket 则 CONNECTING 下用户消息被 tunnelSocket.send 静默丢弃）。
  let resolveTimeout: (ok: boolean) => void
  const timeout = new Promise<boolean>((resolve) => {
    resolveTimeout = resolve
  })
  const connectTimeoutTimer = setTimeout(() => {
    if (gen === containerGen && !disposed) {
      connecting.value = false
      errorMsg.value = '连接建立超时，请检查容器状态后重试'
      myGw.closeSocket(1000, 'connect timeout') // P1-5: 触发协议机退避重连自愈
    }
    resolveTimeout(false)
  }, CONNECT_TIMEOUT_MS)
  const ok = await Promise.race([ready, timeout])
  clearTimeout(connectTimeoutTimer) // race 已 settle：清自己的 timer 防泄漏
  if (!ok && pendingConnect) pendingConnect = null // 超时分支：迟到的 onReady 不再影响本决议
  return ok && gateway === myGw
}

// 建连入口（token 就绪后调用；手动重连/刷新重建复用）：过期/缺失 token 先 forceRefresh 换新再建连。
function connect() {
  if (!auth.token || isTokenExpired(auth.token)) {
    void (async () => {
      await auth.forceRefresh()
      if (disposed) return
      if (auth.refreshExhausted) {
        redirectLogin()
        return
      }
      void openGateway()
    })()
    return
  }
  void openGateway()
}

// ---- 渲染帧处理（runId 路由 / 消息投影 / 审批卡 / 工具行）----
// P2-3（code review）：run-claim 单一助手——handleText/handleTool 共用（原两处 ~37 行逐行复制，
// 漂移会静默吞用户回复；如 claimedEmpty 判定一处改动另一处不随）。
// 返回 true = 本帧应继续渲染（已认领 activeRunId / 已是当前 run）；false = 本帧应丢弃
// （abandoned/foreign/孤儿计数）。
// P1-4（code review）+ R4-8（第四轮）：B2 claimedEmpty 用「渲染可见正文/思考」判定——半截
// <thinking 残片（splitThinking 实测 {text:'',thinking:'',inThinking:false} 视觉空白但 raw!==''）
// 不阻挡切换认领。**不要求 tools.length===0**：工具优先的外来 run 首帧（agent 先调工具再回复，
// 常见）会在占位留 tool 行，若把 tool 行当内容占用，用户 run 首帧的切换认领被拒 → 回复被静默吞。
// tool 行不是「回复正文」，不算占位已被占用。
function claimRun(runId: string): boolean {
  if (abandonedRunIds.has(runId)) return false // 切换前遗留 run 的帧：丢弃
  if (foreignRunIds.has(runId)) return false // #53: 已判定外来/旧 run 的续帧：丢弃（含 B2 切换认领前）
  if (activeRunId && runId !== activeRunId) {
    // B2: 已认领 run 但占位仍无可见正文（先到者可能是同会话自主 run 的预热/status 首帧）→
    // 切换认领到后到 run（更像用户 send 触发的 run），防用户回复被静默丢弃（原代码直接 return）。
    const last = messages.value[messages.value.length - 1]
    const claimedEmpty = Boolean(
      last &&
        last.role === 'assistant' &&
        last.text === '' && // P1-4: 渲染可见正文（splitThinking 剥离后空）
        last.thinking === '',
    )
    if (claimedEmpty) {
      foreignRunIds.add(activeRunId) // 先到空 run 降级为外来
      activeRunId = runId
      clearPendingGraceTimer()
      clearResumeWait()
    } else {
      return false // 仅当前 run 的帧写入回复
    }
  }
  if (!activeRunId) {
    // 首帧到达：若属于切会话时仍 pending 的孤儿 run（FIFO 先到）→ 标记 abandoned 丢弃（codex P2 #3）
    if (pendingAbandonCount > 0) {
      pendingAbandonCount--
      abandonedRunIds.add(runId)
      return false
    }
    // #53: pendingSend 期间本 run ack 已知（myRunId）且首帧 runId 非本 run → 外来/旧 run 首帧
    //（切容器后旧连接在途 run 首帧经新连接到达，runId 不在 abandonedRunIds——切走时首帧未到）
    // 丢弃，不抢占 activeRunId（否则用户 run 首帧因 claimedEmpty=false 被静默丢弃）。
    if (pendingSend && myRunId && runId !== myRunId) {
      foreignRunIds.add(runId) // 记外来 run：其续帧/终态按 runId 过滤
      return false
    }
    // B4: 宽限已 fire（graceExpired）后迟到的用户 run 首帧——pendingSend 已清，但仍认领不 foreign
    const lateClaim = !pendingSend && graceExpired
    // F7: 空闲（无在途用户 send 且非迟到认领）时的首帧——外来自主 run 不认领：记录其 runId 供
    // 后续帧过滤（用户 send 后其续帧按 runId 丢弃，防劫持 activeRunId / 污染用户气泡 / 吞回复）。
    if (!pendingSend && !lateClaim) {
      foreignRunIds.add(runId)
      return false
    }
    // F7: 空闲期已观察到的外来 run 的续帧（用户 send 后到达）——丢弃，不抢占 activeRunId
    if (foreignRunIds.has(runId)) return false
    clearPendingGraceTimer() // B3/B4: 在途 error/done 的延迟收尾取消——首帧已到，本 run 正常
    clearResumeWait() // B5: resume 等待期间收到本 run 首帧 → 续帧已到，取消超时重建
    if (lateClaim) graceExpired = false
    activeRunId = runId
    pendingSend = false
    myRunId = '' // #53: 首帧已认领，归属判别信号不再需要
    // B4: 占位可能已被宽限 finalize（streaming=false）——认领后复活占位继续追加（慢 run 首帧
    // >宽限后仍正常渲染，而非被当作 foreign 丢弃）。
    const ph = messages.value[messages.value.length - 1]
    if (ph && ph.role === 'assistant' && !ph.streaming) ph.streaming = true
  }
  return true
}

// 增量文本：chat.delta 事件（deltaText 追加；replace 快照整段替换）。thinking 剥离纯函数无跨帧态。
function handleText(runId: string, delta: string, replace?: boolean) {
  if (!claimRun(runId)) return
  const last = messages.value[messages.value.length - 1]
  // B5: 追加条件放宽到 activeRunId===runId（本 run 帧）——断线 onClose 已 finalizeLast 落定占位
  //（streaming=false），resume 续帧到达时若只认 streaming 会丢帧；本 run 帧允许复活占位继续追加。
  if (last && last.role === 'assistant' && (last.streaming || activeRunId === runId)) {
    if (!last.streaming) last.streaming = true // 复活（B4 宽限 fire / B5 断线落定后）
    clearResumeWait() // B5: resume 续帧到达 → 取消超时重建（否则 30s 后误触发 loadHistory 打断）
    // T08 思考链剥离（spec §8.3 (a) / r26 §4）：思考以 <thinking> 标签内联在 text 增量里 →
    // 累积原始串 raw，再整体重解析拆出 thinking/text（replace 快照与 delta 追加统一走重解析）
    last.raw = replace ? delta : last.raw + delta
    const parts = splitThinking(last.raw)
    last.thinking = parts.thinking
    last.thinkingOpen = parts.inThinking
    last.text = parts.text
  }
}

function handleDone(runId: string) {
  if (abandonedRunIds.has(runId)) {
    abandonedRunIds.delete(runId)
    return
  }
  if (foreignRunIds.has(runId)) {
    foreignRunIds.delete(runId) // F7: 外来 run 终态：清理记录
    return
  }
  if (activeRunId && runId !== activeRunId) return
  if (activeRunId === runId) {
    finalizeLast()
    activeRunId = ''
    clearResumeWait() // B5: run 正常终态，resume 无需继续
    return
  }
  // activeRunId 空：run 首帧即终态（无 delta）
  if (pendingAbandonCount > 0) {
    pendingAbandonCount--
    return // 孤儿 run 终态：计数丢弃
  }
  if (pendingSend) {
    // B3: 无 delta 外来 run 的 done-first 不立即终结用户空 placeholder/清 pendingSend（原代码
    // 直接 finalize——外来 run 首帧即终态会吞掉用户回复、placeholder 空终结）。武装宽限：
    // 宽限内用户 run 首帧到达正常认领，宽限过仍无动静才落定占位。
    armPendingGrace()
    return
  }
}

function handleError(message: string, runId?: string) {
  // codex R3 P2：通用连接错误 → 恢复所有 resolving 卡（协议 v4 chat.error 不带 approvalId；
  // 审批 resolve 失败经 RPC catch 按 id 复位，见 resolveApproval）
  recoverPendingApprovals()
  // 消费者级错误（无 runId，如「会话不存在」）照常显示；run 级错误按 runId 过滤
  if (runId) {
    if (abandonedRunIds.has(runId)) {
      abandonedRunIds.delete(runId)
      return
    }
    if (foreignRunIds.has(runId)) {
      foreignRunIds.delete(runId) // F7: 外来 run error 终态：清理记录，不终结占位
      return
    }
    if (activeRunId && runId !== activeRunId) return
    if (!activeRunId) {
      // 切会话孤儿 run（首帧未到）的 error：计数丢弃（同 handleDone 的孤儿 done）
      if (pendingAbandonCount > 0) {
        pendingAbandonCount--
        return
      }
      // B3/B4: 无在途 activeRunId——不终结占位/清 flag：
      //  - 空闲（!pendingSend）：外来/自主 run 的 error，不动当前占位（防误伤）
      //  - 在途（pendingSend）：可能是本 run 失败也可能是外来 run；只显示错误，宽限内无首帧
      //    才落定占位（防外来 error 清 flag 后用户 run 首帧被静默丢弃）。fire 时保留 pendingSend，
      //    慢 run 首帧 >宽限后仍走认领路径而非 foreign（F8 定时器反噬修复）。
      if (!pendingSend) return
      errorMsg.value = message
      connecting.value = false
      armPendingGrace()
      return
    }
    // activeRunId === runId：在途 run 失败 → 收尾占位 + 清 flag
    errorMsg.value = message
    connecting.value = false
    finalizeLast()
    activeRunId = ''
    clearResumeWait() // B5: run 失败终态，resume 无需继续
    return
  }
  // 消费者级错误（无 runId，如「会话不存在」/连接级故障）：照常显示。
  // #14（第四轮）：终结在途占位 + 清 activeRunId/pendingSend 是**可辩护行为**——会话级错误意味着
  // 该会话/连接已坏，在途 run 不应再有续帧（网关不会在会话错误后继续推流）。即便随后有迟到帧，
  // 因 activeRunId 已清会被 claimRun 当 foreign 丢弃，是安全降级而非回复丢失。保留行为。
  errorMsg.value = message
  connecting.value = false
  finalizeLast()
  activeRunId = ''
  pendingSend = false
  clearResumeWait() // B5: 消费者级错误（如会话不存在）→ 放弃 resume 等待
}

function handleApproval(card: { id: string; kind: string; command: string; sessionKey: string | null }) {
  // codex R2 P1：按 id 去重后**留存全部**（含其它会话的），仅渲染时按 sessionKey 过滤（visibleApprovals）
  if (approvals.value.some((a) => a.id === card.id)) return // 幂等（重连补拉 + 实时推送去重）
  approvals.value.push({
    id: card.id,
    kind: card.kind,
    command: card.command || '（网关未提供命令详情）',
    sessionKey: card.sessionKey,
    status: 'pending',
    decision: '',
    detailOpen: false,
  })
}

function handleApprovalResolved(id: string, decision: string) {
  // 网关回执：以权威 decision 落定（first-answer-wins，codex P1，可能与请求不同）
  const a = approvals.value.find((x) => x.id === id)
  if (a) {
    a.status = 'resolved'
    // codex P1 (issue #154)：识别 allow-once/allow-always/deny，其它权威值显示「未知」
    a.decision = decision === 'allow-once' || decision === 'allow-always' || decision === 'deny' ? decision : 'unknown'
  }
}

// T08 工具执行（issue #44 / spec §9.4）：工具挂在所属 chat run 内，带 runId。首帧可能是工具
// （agent 先调工具再回复）→ 与 handleText 同款锚定当前 run（共用 claimRun 助手，P2-3）；
// 按 name 聚合 start→result 渲染一行标题+状态。
function handleTool(tool: { runId: string; name: string; state: 'running' | 'done' | 'error'; id: string | null; title: unknown; input: unknown; result: unknown }) {
  if (!claimRun(tool.runId)) return
  const last = messages.value[messages.value.length - 1]
  if (!last || last.role !== 'assistant') return
  clearResumeWait() // B5: 本 run 工具续帧到达 → 取消 resume 超时重建
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
}

// T06：批准/拒绝 → 回发 exec.approval.resolve RPC + 进 resolving 态（禁用按钮等回执，不乐观假成功，
// codex P2）。成功由 handleApprovalResolved 落定；RPC 失败由 catch 恢复 pending 让卡片可重试。
function resolveApproval(a: ApprovalItem, decision: 'allow-once' | 'deny') {
  // codex R3 P2：socket 已断（disconnected）则不可点——否则会进 resolving 后 request 抛错
  if (!gateway || disconnected.value || a.status !== 'pending') return
  a.status = 'resolving'
  a.decision = decision
  void gateway.resolveApproval(a.id, a.kind ?? 'exec', decision).catch(() => {
    recoverPendingApprovals(a.id)
  })
}

// resolve 失败（带 approval id 的 RPC 错误）或断线（无 id → 全部）：恢复 resolving 卡片为 pending 可重试
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
  if (!text || !gateway || !selectedSession.value || connecting.value || streaming.value || disconnected.value) return
  slashDismissed.value = true // 发送后关闭补全菜单（输入已被清空，下次输 / 时经 onComposerInput 复位）
  clearResumeWait() // B5: 用户发新消息 = 放弃旧 run 的 resume 等待（新 run 是新语境）
  messages.value.push({ role: 'user', raw: text, text, thinking: '', thinkingOpen: false, streaming: false, tools: [] })
  messages.value.push({ role: 'assistant', raw: '', text: '', thinking: '', thinkingOpen: false, streaming: true, tools: [] })
  activeRunId = '' // 等首帧 onText 锚定新 run
  graceExpired = false // B4: 新 run 语境，宽限过期标记作废
  pendingSend = true // 首帧未到前，切会话会按 pending 孤儿计数（codex P2 #3）
  myRunId = '' // #53: 新 send 语境，ack runId 未知
  const myGw = gateway
  // chat.send RPC（幂等 key 在 gatewayChat 内生成）；网关拒绝（未配对/scope 不足）→ catch 收尾提示
  void myGw
    .send(selectedSession.value, text)
    .then((runId) => {
      // #53: ack 返回本 run 的网关 runId（官方 chat.send ackPayload）——供首帧归属判别。
      // stale-gateway 守卫同 catch：切容器后旧 gateway 的 ack 不污染新 run 语境。
      if (gateway !== myGw || !pendingSend) return
      myRunId = runId ?? ''
    })
    .catch((e) => {
      if (disposed) return
      // P1-2（code review）：stale-gateway 守卫——旧 gateway stop() flush-reject 在途 send 时，当前
      // 容器可能已切换（gateway !== myGw）；无守卫会对新容器 state 执行 finalizeLast + 写旧连接停止
      // 错误进新容器的 errorMsg（对齐 onFrame/onClose 的 stale guard）。
      if (gateway !== myGw) return
      errorMsg.value = (e as Error).message
      // R4-5（第四轮）：run 已 claim 且仍在流（activeRunId 非空——首帧已到）时，RPC 超时但网关可能
      // 继续流式续帧。此时 finalize 占位会落定 streaming，续帧要么被当下次 send 的占位认领（跨 run
      // 文本污染 + 吞用户回复），要么占位永久卡。仅在「首帧未到即失败」（activeRunId 空，run 没起来）
      // 时 finalize + 清 pendingSend 放弃占位。
      if (activeRunId) return
      // F3: RPC 失败复位 pendingSend——泄漏会让切会话变 phantom orphan（pendingAbandonCount++），
      // 下次发送首帧被当作孤儿丢弃、composer 永久锁死。
      pendingSend = false
      myRunId = '' // #53: RPC 失败，ack runId 无意义
      finalizeLast()
    })
  input.value = ''
}

// 新建会话（issue #81 / spec #76）：经协议机 sessions.create RPC；网关权威新建仅回 session_key。
async function newSession() {
  if (!selectedContainer.value || !gateway || disconnected.value) return // E2: 断线不操作（防裸错误）
  abandonActiveRun()
  clearResumeWait() // B5: 主动建会话 = 放弃 resume 等待
  messages.value = []
  // codex R3 P1：不清空审批卡——新会话不换容器，切会话特意留存的同容器卡须保留（按 sessionKey 过滤渲染），
  // 否则卡住的 agent 对应那张卡会被这里误清、再也无法回覆
  try {
    const sessionKey = await gateway.createSession()
    const s: SessionDTO = { session_key: sessionKey, title: '', updated_at: '' }
    sessions.value = [s, ...sessions.value]
    selectedSession.value = s.session_key
    errorMsg.value = ''
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  }
}

// T3 删除会话（issue #82 / spec #76，admin 级提升权限）：二次确认后调 sessions.delete（archivedOnly），
// 网关先写压缩归档（可恢复）再删。成功 → 从列表移除；删的是当前会话则切到剩余首个（无则新建）。
async function removeSession(key: string) {
  if (!key || !gateway || disconnected.value) return // E2: 断线不操作（防裸错误）
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
    await gateway.deleteSession(key)
  } catch (e) {
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
  if (!key || selectedSession.value === key || disconnected.value) return // E2: 断线不切换（防裸错误）
  abandonActiveRun()
  clearResumeWait() // B5: 主动切会话 = 放弃 resume 等待
  selectedSession.value = key
  // codex R2 P1：不清空审批卡——同容器其它会话的卡保留，渲染时按 selectedSession 过滤即可
  void loadHistory(key) // T3：切会话加载该会话历史（loadHistory 内部清空 messages + 维护分页态）
}

// T3 会话历史回看（issue #82 / spec #76）：经协议机 chat.history RPC 渲染历史消息 + 维护分页态。
// stale 守卫：切会话/容器后迟到的 history 响应按 containerGen + selectedSession 双校验丢弃
// （同 selectContainer 的 containerGen 套路）。401 由 client 处理；其它失败落 errorMsg。
// codex #249 P2：另加 historyGen 请求代——同一会话并发两次 loadHistory（如重连恢复撞上在途请求）
// 时只让最新一次提交快照，被取代的在途请求落地即丢弃，避免两份快照各自 prepend 造成转录重复。
async function loadHistory(key: string) {
  const gen = containerGen
  const hgen = ++historyGen // codex #249 P2：本请求代；之后再有 loadHistory 即取代本请求
  if (!gateway || disconnected.value) return // E2: 断线不重载（防先清空 transcript 再 RPC 失败留白）
  clearResumeWait() // B5: 主动重载历史 = 放弃 resume 等待
  messages.value = []
  historyHasMore.value = false
  historyAnchor.value = null
  historyLoading.value = true
  errorMsg.value = ''
  try {
    const res = await gateway.getHistory(key)
    if (gen !== containerGen || selectedSession.value !== key) return // 切走了：丢弃迟到响应
    if (hgen !== historyGen) return // codex #249 P2：已被更新的 loadHistory 取代：丢弃本在途响应
    // codex P2 #108：保留 await 期间 send() 追加的进行中 turn（user + 流式 assistant 占位）。
    // 直接整体替换会被历史快照覆盖 → delta 找不到 streaming 尾，整轮实时回复从 UI 消失。
    const inFlight = messages.value
    messages.value = [...res.messages.map(translateHistoryMessage), ...inFlight]
    historyHasMore.value = res.hasMore
    historyAnchor.value = res.nextOffset
  } catch (e) {
    if (gen !== containerGen || selectedSession.value !== key) return
    if (hgen !== historyGen) return // codex #249 P2：被取代的请求：不落错误、不干扰新请求
    if (e instanceof ApiError && e.status === 401) return // 401 由 client 处理会话
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
  // E1: 网关 history 消息 content 多态（user=string / assistant=[{type:text},{type:thinking}]，
  // ADR 0003）——复用 eventTranslate.extractMessageText（已处理 string/数组 content 并跳过
  // thinking 块），不再只认 string 导致 assistant 历史渲染成空泡。text 字段回退保留（旧透传 shape）。
  const text = extractMessageText(m) || (typeof m.text === 'string' ? m.text : '')
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
  if (!historyHasMore.value || historyAnchor.value == null || historyLoading.value || !gateway || disconnected.value) return // E2: 断线不翻页（防裸错误）
  const key = selectedSession.value
  const gen = containerGen
  const hgen = historyGen // codex #249 R3 P2：捕获当前代；不自增（分页不得取代进行中的完整 loadHistory）
  const anchor = String(historyAnchor.value)
  historyLoading.value = true
  try {
    const res = await gateway.getHistory(key, undefined, anchor)
    if (gen !== containerGen || selectedSession.value !== key) return // 切走了：丢弃迟到响应
    if (hgen !== historyGen) return // codex #249 R3 P2：已被完整 loadHistory 取代：丢弃本在途分页
    messages.value = [...res.messages.map(translateHistoryMessage), ...messages.value]
    historyHasMore.value = res.hasMore
    historyAnchor.value = res.nextOffset
  } catch (e) {
    if (gen !== containerGen || selectedSession.value !== key) return
    if (hgen !== historyGen) return // codex #249 R3 P2：被取代的分页：不落错误、不干扰新请求
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  } finally {
    // codex #249 R3 P2：仅当代际未变才复位——被取代的分页不得关掉完整 reload 的 loading
    if (gen === containerGen && selectedSession.value === key && hgen === historyGen) {
      historyLoading.value = false
    }
  }
}

onMounted(loadInstances)
onBeforeUnmount(() => {
  disposed = true
  clearPendingGraceTimer() // B4: 卸载清延迟收尾 timer，防组件销毁后触发
  clearResumeWait() // B5: 卸载清 resume 等待 timer
  // #14: 连接期超时 timer 已收 openGateway 局部作用域（P0：闭包内 clearTimeout，并发 openGateway
  // 不再互踩模块级单槽），组件卸载无需清理——gateway.stop() 停协议机即可。
  gateway?.stop()
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
                 不展开输入输出细节。 -->
            <div
              v-for="(t, ti) in m.tools"
              :key="`tool-${ti}`"
              class="tool"
              :class="t.state"
              data-test="tool-line"
            >
              <span class="t-icon">🔧</span>
              <span class="t-name" :title="typeof t.title === 'string' ? t.title : ''">{{ typeof t.title === 'string' ? t.title : t.name }}</span>
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
             网关 commands.list RPC，按容器隔离；拉取失败菜单不弹、不影响对话。 -->
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
