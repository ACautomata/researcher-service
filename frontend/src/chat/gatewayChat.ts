// #369 M5 前端接线：ChatView 走隧道 + 官方协议机的协议客户端 Facade。
// 内部 = GatewayProtocolClient（官方 ./browser 协议机）+ createPanelTunnelSocket（面板隧道 transport）。
// 对外 = ChatView 需要的高层 API：RPC（sessions/list-create-delete、chat/history-send、commands、
// exec.approval.resolve）+ 事件翻译路由（onEvent → ChatEventTranslator → onFrame）+ close 决策。
//
// B-直连（ADR 0006）：协议机握手/重连/帧状态机全在官方包，本模块只做编排与翻译。

import {
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  shouldPauseGatewayReconnect,
} from '@openclaw/gateway-client/browser'
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from '@openclaw/gateway-protocol/connect-error-details'
import { createPanelTunnelSocket } from './tunnelSocket'
import { ChatEventTranslator, type ChatFrame, type GatewayEventFrame } from './eventTranslate'
import { NO_RETRY_CLOSE_CODES } from './closeCodes'

export type { ChatFrame, GatewayEventFrame } from './eventTranslate'

// ---- DTO（对齐旧 api/chat.ts 契约，REST 代理删除后由协议机 RPC 承载）----
export interface SessionDTO {
  session_key: string
  title: string
  updated_at: string
}

export interface HistoryMessageDTO {
  role?: string
  text?: string
  [k: string]: unknown
}

export interface SessionHistoryDTO {
  messages: HistoryMessageDTO[]
  hasMore: boolean
  nextOffset: string | number | null
}

export interface CommandDTO {
  name: string
  description: string
  aliases: string[]
}

// 连接级事件回调（对齐 ChatView 现有 ws handlers 签名，渲染逻辑零改动）。
export interface GatewayChatHandlers {
  // 协议机完成 v4 握手（hello-ok）——首连与自动重连成功后都会触发
  onReady: () => void
  // 翻译后的渲染帧（text/done/error/approval/approvalResolved/tool）
  onFrame: (frame: ChatFrame) => void
  // 连接关闭（隧道/网关 close code；4401 认证失败 / 4404 容器归属拒绝 / 4402 网关不可达 /
  // 4403 强制改密 / 其他传输断开）。retry = 协议机是否将继续自动重连（D2）：
  //   - true：协议机退避重连中，UI 显示「自动重连中…」
  //   - false：协议机已决策不再重连（非恢复错误 / 连续失败 give-up），UI 应如实提示手动重连，
  //     而非继续谎报「自动重连中…」
  // pairingRequired = 本次关闭是否因网关 PAIRING_REQUIRED（未配对）——UI 应提示先完成设备配对
  onClose: (code: number, reason: string, retry: boolean, pairingRequired?: boolean) => void
  // 连接级错误（非 run 级）：如 handshake 超时、socket 工厂失败
  onError: (message: string) => void
}

export interface GatewayChat {
  start(): void
  stop(): void
  // 主动关隧道触发协议机重连决策（连接期超时兜底：SYN 黑洞下 socket 永不 open、无任何信号，
  // 主动关闭让协议机走退避重连自愈——P1 code review）
  closeSocket(code?: number, reason?: string): void
  listSessions(): Promise<SessionDTO[]>
  createSession(label?: string): Promise<string>
  deleteSession(key: string): Promise<void>
  getHistory(sessionKey: string, limit?: number, messageId?: string): Promise<SessionHistoryDTO>
  send(sessionKey: string, message: string): Promise<void>
  listCommands(): Promise<CommandDTO[]>
  resolveApproval(id: string, kind: string, decision: string): Promise<void>
}

interface ConnectPlan {
  role: string
  scopes: string[]
  caps: string[]
  token: string
}

export interface CreateGatewayChatParams {
  container: string
  jwt: string
  bootstrapToken: string
  handlers: GatewayChatHandlers
}

// 面板隧道 close code（单一来源 = closeCodes.ts，F15）：4401 认证失败 / 4404 容器归属 / 4402
// 网关不可达 / 4403 强制改密。协议机对这些 code 的决策：认证/归属/改密 = 非传输问题，不自动重连
// （retry:false，前端决定 forceRefresh 或提示）；其余（网络断开 1006/1005、网关 4402）→ 协议机
// 内置指数退避重连。

// F4: RPC 请求超时——requestTimeoutMs 缺省时 protocol request() 的 promise 无界等待（半开连接下
// catch 永不跑、UI 卡死）。30s 覆盖正常网关响应（对话 send 后 agent 思考不影响 send RPC 本身）。
// 注意（A2）：请求超时只 reject 该 promise（协议机行为，连接保持），不再 teardown 整条连接——
// 慢 history/send 超时不应触发全量重连 + 历史重下载循环。
const REQUEST_TIMEOUT_MS = 30_000
// F10: 握手超时 ≥ 隧道侧网关连接超时（server gatewayConnector CONNECT_TIMEOUT_MS=5000）+ 认证 DB
// 查询余量——browser 在 socket open 后 armed 的 require-challenge 定时器若 < 隧道侧 connect 超时，
// 3–5s 慢网关每次首连先被误判失败（close 1008→重连），而 4402 永远收不到。
const HANDSHAKE_TIMEOUT_MS = 10_000
// F2: 连续重连失败阈值——超过即停止自动重连转手动（防无限空转；协议机 RetrySupervisor 的
// maxAttempts 恒 Infinity 无 give-up，只能前端计数）。
const MAX_RECONNECT_FAILURES = 5
// 沉默看门狗（对齐已删 ws.ts 的 60s 静默超时）：黑洞链路（Wi-Fi 漫游无 RST）下浏览器 WS 不触发
// onclose、协议机不重连。onActivity 每次收到网关帧刷新 lastActivityAt；超过 SILENCE_TIMEOUT_MS
// 无任何帧 → 主动关隧道触发协议机重连自愈（网关侧 hello-ok 承诺 tickIntervalMs≤30s，正常连接
// 60s 内必有帧，不会误杀）。
const SILENCE_TIMEOUT_MS = 60_000
const WATCHDOG_INTERVAL_MS = 15_000

// 连接参数中的 operator scope（协议文档）：sessions/chat 需 read/write；exec.approval.resolve 需
// operator.approvals（审批回覆）。tool-events 声明该连接接收 run 的结构化工具事件。
const OPERATOR_SCOPES = ['operator.read', 'operator.write', 'operator.approvals']
const CONNECT_CAPS = ['tool-events']

// A3: 非安全上下文（http://<lan-ip> 自托管面板常见）下 crypto.randomUUID 不可用（undefined），
// 协议机首个 RPC 的 requestId / 写操作的幂等 key 即抛 → M5 RPC 层全死。
// P2（code review）：兜底统一用 crypto.getRandomValues 编码 32-hex——与 randomUUID.replace 后的
// 32-hex 格式一致（仓库自钉契约 /^[a-z0-9]{32}$/），且比 Math.random 兜底（非 CSPRNG、同毫秒碰撞
// 空间坍缩）安全；createSession 与 chat.send 的幂等 key 共用同一格式（不再跨路径不一致）。
function createRequestId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c?.randomUUID) return c.randomUUID()
  // 兜底：getRandomValues 取 16 随机字节 → 32-hex（btoa 后去填充取 a-z0-9 与 randomUUID 同构）。
  // 直接方法引用调用（c.randomUUID()）保 this 绑定（解构后 this 会丢 Crypto 上下文）。
  const bytes = c?.getRandomValues?.(new Uint8Array(16))
  if (bytes) {
    // Uint8Array → hex（非 btoa：btoa 对 >255 码位抛错，且输出含大小写/+/=，非 32-hex 契约）
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  const rnd = () => Math.random().toString(36).slice(2)
  return `${rnd()}${rnd()}${Date.now().toString(36)}`
}

export function createGatewayChat(params: CreateGatewayChatParams): GatewayChat {
  const { container, jwt, bootstrapToken, handlers } = params
  const translator = new ChatEventTranslator()
  // F2: 连续重连失败计数（闭包）——重连成功（hello）时重置；达阈值 stop 自动重连转手动。
  // P1（code review）：计数器语义改为「按连接存活时长」——只有「未达 hello 的失败」（连接从未
  // 建立即断）累加；hello 后稳定存活过阈值再断（含沉默看门狗自发 closeSocket 的修复动作）不算
  // 故障、不消耗 give-up 预算。反向：crash-loop 型（hello 即崩，存活极短）每次握手成功不得归零
  // ——否则永远到不了 give-up，无限重连空转（违背 #369「退避重连空转」目标）。
  let consecutiveFailures = 0
  // 上次 hello-ok 时刻；稳定存活阈值——hello 后存活超过它，此后断开即视为「已建立过连接」，
  // 不再计失败（见下）。crash-loop（hello 后 <阈值 即崩）不计稳定，计数继续累积。
  let lastHelloAt = 0
  const STABLE_CONNECTION_MS = 30_000
  // 沉默看门狗（A2/黑洞自愈）：onActivity 刷新最后活动时间；watchdog 超时无帧 → 强制重连。
  let lastActivityAt = 0
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  // P2（code review）：translator.sent 累积器无界增长（断线中断/外来 run 永不到终态条目泄漏）+
  // 断线 resume 从头重放会双重追加——每次连接生命周期边界（hello-ok）清空重来。
  const resetTranslator = () => translator.reset()

  let client: GatewayProtocolClient<ConnectPlan>
  client = new GatewayProtocolClient<ConnectPlan>({
    createSocket: (socketHandlers) => createPanelTunnelSocket(container, jwt, socketHandlers),
    createRequestId,
    buildConnectPlan: async () => ({
      role: 'operator',
      scopes: OPERATOR_SCOPES,
      caps: CONNECT_CAPS,
      token: bootstrapToken,
    }),
    // 对齐 tunnelProtocol.test：v4 握手参数（minProtocol/maxProtocol/client/role/scopes/caps/auth.token）
    buildConnectParams: (plan) => ({
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: 'webchat-ui', mode: 'webchat', platform: 'browser', version: '2026.7.2-beta.6' },
      role: plan.role,
      scopes: plan.scopes,
      caps: plan.caps,
      auth: { token: plan.token },
    }),
    // F10: 握手超时对齐隧道侧网关连接超时（server CONNECT_TIMEOUT_MS=5000）+ 余量。
    handshake: { mode: 'require-challenge', timeoutMs: HANDSHAKE_TIMEOUT_MS },
    reconnect: { initialMs: 1000, multiplier: 2, maxMs: 30000 },
    // F4: RPC 请求有界等待——缺省时 request() promise 无界（半开连接 UI 卡死，F4 根因之一）。
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    // close 决策：认证/归属/改密 = 非传输问题，不自动重连（前端 forceRefresh 或提示）；其余重连。
    // notify:true 让 onClose 上报 UI（断线提示）。
    resolveClose: (context) => {
      // F1: 网关 connect 阶段被拒（auth/pairing 拒绝，如 PAIRING_REQUIRED / AUTH_TOKEN_MISMATCH）→
      // 非传输问题，不自动重连（防 #369「退避重连空转」）。context.connectFailure 携带网关错误详情
      // （协议机在 sendConnectPlan 的 request reject 时设置）；用官方 shouldPauseGatewayReconnect
      // 判定（与顶层 GatewayClient 同源）——浏览器侧裸协议机此前不设此防护。
      const connErr = context.connectFailure?.error
      if (connErr instanceof GatewayProtocolRequestError && connErr.details !== undefined) {
        if (
          shouldPauseGatewayReconnect({
            details: connErr.details,
            deviceTokenRetryPending: false,
            tokenMismatchIsTerminal: true,
            clientVersionMismatchIsTerminal: true,
          })
        ) {
          return { retry: false, notify: true }
        }
      }
      if (NO_RETRY_CLOSE_CODES.has(context.code)) return { retry: false, notify: true }
      // F2: 省略 reconnectDelayMs 交协议机 RetrySupervisor 指数退避（1000→2000→4000→…→30s 上限）。
      // 显式 reconnectDelayMs 是一次性 override（attempts 不递增），恒固定间隔重试且退避成死代码。
      // 连续失败达阈值 → 停止自动重连（协议机 maxAttempts 恒 Infinity，只能前端计数 give-up），
      // 转 ChatView 手动重连（disconnected 条）。
      // P1（code review）：仅「未达 hello 的失败」计费（连接从未建立即断）；hello 后稳定存活过的
      // 连接断开（含看门狗自发 closeSocket 的修复动作）不算故障，不消耗 give-up 预算。
      const stable = lastHelloAt !== 0 && Date.now() - lastHelloAt >= STABLE_CONNECTION_MS
      if (!stable) {
        consecutiveFailures++
        if (consecutiveFailures >= MAX_RECONNECT_FAILURES) return { retry: false, notify: true }
      }
      return { retry: true, notify: true }
    },
    onClose: (context, decision) => {
      // D2: 透传 retry 决策给 UI——协议机已 give-up / 非恢复错误（retry:false）时 ChatView 如实
      // 提示「自动重连已停止，请手动重连」，不再谎报「自动重连中…」。
      if (decision.notify) {
        // P1-7（code review）：握手被拒且详情为 PAIRING_REQUIRED（未配对）→ 随 onClose 传递，
        // UI 提示先完成设备配对（#369 配对是 chat 前置；通用「自动重连已停止」文案让用户无从
        // 得知正确路径）。用官方 readConnectErrorDetailCode 判定（不硬编码错误码字符串）。
        const connErr = context.connectFailure?.error
        const pairing =
          connErr instanceof GatewayProtocolRequestError &&
          readConnectErrorDetailCode(connErr.details) === ConnectErrorDetailCodes.PAIRING_REQUIRED
        handlers.onClose(context.code, context.reason, decision.retry, pairing)
      }
    },
    onConnectError: (error) => handlers.onError(error.message),
    onSocketFactoryError: (error) => handlers.onError(error.message),
    // 沉默看门狗数据源：收到任何网关帧刷新最后活动时间（黑洞链路唯一信号源）。
    onActivity: () => {
      lastActivityAt = Date.now()
    },
    // A2: 请求超时只 reject 该 promise（协议机行为，连接保持）——不再 closeSocket teardown 整条
    // 连接：慢 history/send 超 30s 不应触发全量重连 + 历史重下载循环（flapping 网络下成循环、每轮
    // 消耗重连失败预算）。黑洞链路自愈由沉默看门狗（onActivity 60s 无帧 → 强制重连）承担。
    onRequestTiming: () => {
      // 无操作——见上注释。保留回调以便未来接入请求级诊断。
    },
    onEvent: (event: GatewayEventFrame) => {
      for (const frame of translator.translate(event)) handlers.onFrame(frame)
    },
    onHello: () => {
      // F2: 重连成功（hello-ok）→ 重置连续失败计数。
      // P1-6（code review）：仅当「上次连接稳定存活过」才归零（距上次 hello 超过稳定阈值）——
      // crash-loop 型（hello 即崩，间隔 < 阈值）每次握手成功不得归零，否则永不 give-up、无限
      // 重连空转（违背 #369「退避重连空转」目标）；首次连接（lastHelloAt===0）归零。
      if (lastHelloAt === 0 || Date.now() - lastHelloAt >= STABLE_CONNECTION_MS) {
        consecutiveFailures = 0
      }
      lastHelloAt = Date.now() // 记录 hello 时刻，供「稳定存活」判定
      resetTranslator() // P2: 新连接生命周期边界清空 sent 累积（断线中断的 run 条目作废）
      handlers.onReady()
    },
  })

  return {
    start: () => {
      lastActivityAt = Date.now()
      // 沉默看门狗：连接期持续监控（黑洞链路自愈，A2）。
      if (!watchdogTimer) {
        watchdogTimer = setInterval(() => {
          // >=：interval 按 15s 周期对齐，fire 点 gap 恰为整 60s 也应触发（> 会让 60s 整被跳过）。
          if (client && Date.now() - lastActivityAt >= SILENCE_TIMEOUT_MS) {
            // 60s 无任何网关帧 → 连接疑似黑洞（半开 TCP 无 RST，WS 不触发 onclose）→ 主动关隧道
            // 触发协议机重连。正常连接网关侧 tick ≤30s 保证 60s 内有帧，不误杀。
            client.closeSocket(1000, 'silence timeout')
          }
        }, WATCHDOG_INTERVAL_MS)
      }
      client.start()
    },
    stop: () => {
      if (watchdogTimer) {
        clearInterval(watchdogTimer)
        watchdogTimer = null
      }
      client.stop()
    },
    // P1-5（code review）：连接期超时兜底——SYN 黑洞（socket 永不 open）下协议机无任何信号、
    // 不触发重连；主动关隧道让协议机走退避重连自愈（对齐已删 ws.ts 的连接超时自愈）。
    closeSocket: (code = 1000, reason = '') => {
      client.closeSocket(code, reason)
    },
    async listSessions(): Promise<SessionDTO[]> {
      const res = await client.request<{ sessions?: Array<Record<string, unknown>> }>('sessions.list', {
        includeDerivedTitles: true,
      })
      // 校准（对齐旧代理 _parse_sessions）：key 主取 key 回退 sessionKey；title 取 derivedTitle；
      // updatedAt 透传；非 dict 项跳过（对网关输入 0 信任）。
      const items = Array.isArray(res?.sessions) ? res.sessions : []
      const out: SessionDTO[] = []
      for (const item of items) {
        const key = typeof item.key === 'string' ? item.key : typeof item.sessionKey === 'string' ? item.sessionKey : ''
        if (!key) continue
        out.push({
          session_key: key,
          title: typeof item.derivedTitle === 'string' ? item.derivedTitle : '',
          updated_at: typeof item.updatedAt === 'string' ? item.updatedAt : '',
        })
      }
      return out
    },
    async createSession(label = ''): Promise<string> {
      // 幂等 key（网关写操作建议带 idempotency）；label 可空（网关后续派生标题）。
      // A3/P2: 幂等 key 用 createRequestId 兜底（非安全上下文 randomUUID 不可用）并统一 32-hex
      //（randomUUID 路径去连字符；getRandomValues 兜底本就 32-hex——跨路径格式一致，网关按
      // idempotencyKey 幂等去重不因格式分歧而失效）。
      const res = await client.request<{ key?: unknown; sessionKey?: unknown }>('sessions.create', {
        key: createRequestId().replace(/[^a-z0-9]/g, ''),
        label: label || undefined,
      })
      const key = typeof res?.key === 'string' ? res.key : typeof res?.sessionKey === 'string' ? res.sessionKey : ''
      if (!key) throw new Error('会话创建失败：网关未返回 session key')
      return key
    },
    async deleteSession(key: string): Promise<void> {
      // 不带 archivedOnly：官方网关 sessions-delete 对未归档会话带 archivedOnly:true 直接
      // INVALID_REQUEST（"Session X is not archived. Archive it first, then delete it."）——面板
      // 从不先归档，恒带 archivedOnly 会让所有正常会话删除失败（P0 code review）。对齐旧 wire
      // （wire_client.py sessions.delete {key}）与官方 webchat（仅 archived 行才带 archivedOnly）。
      // 缺失会话为 ok 无操作（幂等）。
      await client.request('sessions.delete', { key })
    },
    async getHistory(sessionKey: string, limit?: number, messageId?: string): Promise<SessionHistoryDTO> {
      const res = await client.request<{ messages?: unknown; hasMore?: unknown; nextOffset?: unknown }>(
        'chat.history',
        {
          sessionKey,
          ...(limit !== undefined ? { limit } : {}),
          ...(messageId !== undefined && messageId !== null ? { messageId } : {}),
        },
      )
      // 校准（对齐旧代理 _parse_history）：messages 原样透传（display-normalized），非 dict 项跳过
      const raw = res?.messages
      const messages = Array.isArray(raw) ? raw.filter((m) => m && typeof m === 'object') : []
      return {
        messages: messages as HistoryMessageDTO[],
        hasMore: typeof res?.hasMore === 'boolean' ? res.hasMore : false,
        nextOffset: typeof res?.nextOffset === 'string' || typeof res?.nextOffset === 'number' ? res.nextOffset : null,
      }
    },
    async send(sessionKey: string, message: string): Promise<void> {
      // chat.send 幂等（schema 必填 idempotencyKey）；返回后流式 delta/final 事件经 onEvent 到达。
      // A3/P2: 幂等 key 与 createSession 统一 32-hex 格式（randomUUID 去连字符——跨路径 key 规范
      // 一致，网关幂等去重不因格式分歧而失效）。
      await client.request('chat.send', {
        sessionKey,
        message,
        idempotencyKey: createRequestId().replace(/[^a-z0-9]/g, ''),
      })
    },
    async listCommands(): Promise<CommandDTO[]> {
      const res = await client.request<{ commands?: Array<Record<string, unknown>> }>('commands.list', {})
      // 校准（对齐旧代理 CommandListView）：commands 外层键；aliases 取 textAliases，缺省回退 /{name}
      const items = Array.isArray(res?.commands) ? res.commands : []
      const out: CommandDTO[] = []
      for (const item of items) {
        const name = typeof item.name === 'string' ? item.name : ''
        if (!name) continue
        const aliases = Array.isArray(item.textAliases)
          ? item.textAliases.filter((a): a is string => typeof a === 'string')
          : [`/${name}`]
        out.push({
          name,
          description: typeof item.description === 'string' ? item.description : '',
          aliases: aliases.length > 0 ? aliases : [`/${name}`],
        })
      }
      return out
    },
    async resolveApproval(id: string, kind: string, decision: string): Promise<void> {
      // kind 派生 method 名（{kind}.approval.resolve，实测校准 backend/chat/serializers.py）：
      // exec→exec.approval.resolve / plugin→plugin.approval.resolve；params 仅 id/decision
      // （kind 已含于 method 名，不入 params——ExecApprovalResolveParams 校验无 kind 字段）。
      await client.request(`${kind}.approval.resolve`, { id, decision })
    },
  }
}
