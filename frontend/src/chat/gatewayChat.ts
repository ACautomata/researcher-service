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
  type GatewayBrowserDeviceAuthLifecycle,
  type GatewayBrowserDeviceAuthPlan,
  type GatewayProtocolCloseContext,
} from '@openclaw/gateway-client/browser'
import { readConnectErrorDetailCode, readPairingConnectErrorDetails } from '@openclaw/gateway-protocol/connect-error-details'
import { createPanelTunnelSocket } from './tunnelSocket'
import { ChatEventTranslator, type ChatFrame, type GatewayEventFrame } from './eventTranslate'
import { NO_RETRY_CLOSE_CODES, WS_GATEWAY_UNAVAILABLE } from './closeCodes'
import { createDeviceAuthLifecycle, hasStoredDeviceTokenFor } from './deviceAuth'
import { approvePairing } from '@/api/chat'
import type { Attachment } from './attachments'

export type { ChatFrame, GatewayEventFrame } from './eventTranslate'
export type { Attachment } from './attachments'

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
  //   - false：协议机已决策不再重连（非恢复错误 / 连续失败 give-up / #376 4402 预算超限），UI 应
  //     如实提示手动重连，而非继续谎报「自动重连中…」
  // pairingRequired = 自动设备配对失败（approve HTTP 错误 / requestId 无效 / 预算用尽）——#377 自动
  // 配对接管 PAIRING_REQUIRED（未配对自动 approve → 重连 → 拿 deviceToken），UI 仅在自动配对失败时
  // 收到 pairingRequired=true，如实提示重试（不误导「去详情页手动配对」）
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
  // chat.send RPC 响应携带网关分配的 runId（ackPayload = {runId, status:"started"}，
  // 官方 chat-send-handler）——供 ChatView 首帧归属判别（#53：pendingSend 期间外来/旧 run
  // 首帧与自己的 run 区分，防抢 activeRunId 吞回复）。ack 无 runId（旧网关/异常形状）→ undefined。
  // #459-T1 #462：可选 attachments（官方 chat.send 字段，附件经 WS 隧道帧内透传，1MiB 帧上限内）——
  // 形状由 chat/attachments.ts 组装（类型过滤 + 体积校验在采集层完成，本层原样透传）。不带/空数组
  // 不携带该字段（不带附件输入时与既有文本发送路径一致，回归无差）。
  send(sessionKey: string, message: string, attachments?: Attachment[]): Promise<string | undefined>
  listCommands(): Promise<CommandDTO[]>
  resolveApproval(id: string, kind: string, decision: string): Promise<void>
  // B0: 补拉待处理审批（exec.approval.list，协议 schema exec-approval 域）——切页/断线重连后
  // 恢复审批卡：审批事件是连接级广播，切页期间 WS 已断、网关 push 的 exec.approval.requested
  // 收不到；不补拉则 agent 卡在 exec 审批时前端无卡可回，agent 卡死被网关 stuck-session
  // recovery abort（生产实测：330s 卡死 → abort_embedded_run）。返回 addApproval 同形状的
  // 卡片（id/kind/command/sessionKey），上层直接 chat.addApproval（幂等去重，与实时 push 不冲突）。
  listPendingApprovals(): Promise<ApprovalCardDTO[]>
}

// B0: 审批卡 DTO（对齐 chat.addApproval 入参形状；kind/command 由网关 exec.approval.list
// 返回的 request 解析，缺省 kind=exec——exec 审批是面板唯一入口，plugin 审批走同类事件）
export interface ApprovalCardDTO {
  id: string
  kind: string
  command: string
  sessionKey: string | null
  // #405-T1：发起方 agentId（补拉路径与 requested 事件同构——#394 实测 request 内含
  // agentId 入参原样回显；缺省 null = 主会话审批）
  agentId?: string | null
}

// #377: ConnectPlan = 官方设备认证 lifecycle plan（role/scopes/auth/device）+ 面板 caps 声明。
// buildConnectParams 透传 lifecycle 的 auth（bootstrapToken/deviceToken）与 device 签名块；凭证选择
// （首连 bootstrap / 已配对 deviceToken）归官方 lifecycle（ADR 决定 3/6，deviceAuth.test.ts 已覆盖）。
type ConnectPlan = GatewayBrowserDeviceAuthPlan & { caps: string[] }

export interface CreateGatewayChatParams {
  container: string
  jwt: string
  bootstrapToken: string
  handlers: GatewayChatHandlers
  // #377: 设备配对 lifecycle（ADR 0006 决定 3/6）——缺省 createDeviceAuthLifecycle()（真实 localStorage
  // 身份 + tokenStore）；测试注入假 lifecycle（假 tokenStore / 内存 storage）断言配对编排（#377 acceptance）。
  deviceAuth?: GatewayBrowserDeviceAuthLifecycle
  // 真网关 2026.7.1 适配（实测）：凭证选择「首连 auth.token / 重连 deviceToken」需要判断「该设备已持有
  // deviceToken」。官方 lifecycle 不暴露 tokenStore，缺省经 hasStoredDeviceTokenFor 读 localStorage
  //（与 deviceAuth 同源）；测试注入确定性替身（首连 false / 已配对 true）。
  hasStoredDeviceToken?: () => boolean | Promise<boolean>
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
// #376: 该阈值同时是 4402 网关不可达重试预算的上限（独立计数器，见 gatewayUnavailableCount）。
const MAX_RECONNECT_FAILURES = 5
// 沉默看门狗（对齐已删 ws.ts 的 60s 静默超时）：黑洞链路（Wi-Fi 漫游无 RST）下浏览器 WS 不触发
// onclose、协议机不重连。onActivity 每次收到网关帧刷新 lastActivityAt；超过 SILENCE_TIMEOUT_MS
// 无任何帧 → 主动关隧道触发协议机重连自愈（网关侧 hello-ok 承诺 tickIntervalMs≤30s，正常连接
// 60s 内必有帧，不会误杀）。
const SILENCE_TIMEOUT_MS = 60_000
const WATCHDOG_INTERVAL_MS = 15_000

// 连接参数中的 operator scope（协议文档）：sessions/chat 需 read/write；exec.approval.resolve 需
// operator.approvals（审批回覆）。tool-events 声明该连接接收 run 的结构化工具事件。
// operator.admin（PR #370 第四轮 R4-2 P1）：sessions.delete 不带 archivedOnly（面板从不先归档，
// 带 archivedOnly 反被网关对未归档会话恒拒 INVALID_REQUEST）——协议 schema 明示「deletes without
// [archivedOnly] require operator.admin」。旧 backend wire SCOPES 含 admin，前端移植时漏掉 → 删除
// 被 scope 拒。安全：operator.admin = full host access；面板作为容器所有者全权代理，UI 不暴露
// terminal/worktree 等高危方法。真网关验证 ADR 0006 实测项 ③ 已完成（#461）：webchat 客户端删除
// 被网关硬拒（rejectWebchatSessionMutation），豁免仅 openclaw-control-ui 身份——面板客户端 ID
// 因此从 webchat-ui 改为 openclaw-control-ui（见 CLIENT_INFO）。
const OPERATOR_ROLE = 'operator'
const OPERATOR_SCOPES = ['operator.read', 'operator.write', 'operator.approvals', 'operator.admin']
const CONNECT_CAPS = ['tool-events']
// 连接 client 声明（buildConnectParams 与 lifecycle.buildPlan 共用，防两处漂移）。
// #461 真网关实测（ADR 0006 实测项③）：sessions.delete/patch/compact/restore 对 webchat 客户端
//（webchat-ui 或 mode=webchat）硬拒「webchat clients cannot delete sessions」，豁免仅
// client.id === 'openclaw-control-ui'（官方 control-ui 页面身份）。面板改 control-ui 身份：
// 删除可用；配对不受影响（网关 BROWSER_DEVICE_CLIENT_IDS 含 control-ui；生产远程非 loopback
// 仍要求配对，本地 loopback 下被 isControlUiBrowserContainerLocalEquivalent 判为本地等价免配对）。
const CLIENT_INFO = { id: 'openclaw-control-ui', mode: 'webchat', platform: 'browser', version: '2026.7.2-beta.6' } as const
// version 对齐官方 @openclaw/gateway-client 包版本（2026.7.2-beta.6）；升级官方包时须同步 bump。
// 真网关 2026.7.1 接受该 version 字段（未校验版本匹配，仅记录）。

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
  // #377: 设备配对 lifecycle——缺省 createDeviceAuthLifecycle(container)（localStorage 身份 + 服务端
  // DB tokenStore，多容器修复）；测试注入假 lifecycle（假 tokenStore）断言配对编排（#377 acceptance）。
  const lifecycle = params.deviceAuth ?? createDeviceAuthLifecycle(container)
  const translator = new ChatEventTranslator()
  // F2: 连续重连失败计数（闭包）——重连成功（hello）时重置；达阈值 stop 自动重连转手动。
  // P1（code review）：计数器语义改为「按连接存活时长」——只有「未达 hello 的失败」（连接从未
  // 建立即断）累加；hello 后稳定存活过阈值再断（含沉默看门狗自发 closeSocket 的修复动作）不算
  // 故障、不消耗 give-up 预算。反向：crash-loop 型（hello 即崩，存活极短）每次握手成功不得归零
  // ——否则永远到不了 give-up，无限重连空转（违背 #369「退避重连空转」目标）。
  let consecutiveFailures = 0
  // #376: 4402 网关不可达重试预算——独立于通用传输失败计数（consecutiveFailures）。容器网关不可达
  //（stopped/重启中/端口不通）是「容器恢复前重试无益」的信号：连续 4402 达预算 → 停自动重连 +
  // ChatView 提示「容器网关不可用」。与网络抖动（1006 等）预算互相独立——抖动不消耗 4402 预算、
  // 反之亦然（否则偶发断网会让容器恢复后的自动重连提前 give-up）。PAIRING_REQUIRED / 4401/4403/4404
  //（非传输问题）在 resolveClose 上方分支先行拦截，不消耗本预算。
  // 手动重连 / 切换容器 = ChatView openGateway 新建 GatewayChat 实例（全新闭包）→ 预算随之重置。
  let gatewayUnavailableCount = 0
  // 跨连接的上次 hello-ok 时刻——仅供 onHello 归零计数时的 crash-loop 判定（距上次 hello ≥阈值
  // 才归零，hello 即崩的 crash-loop 不归零）。不用于 close 计费（见 thisConnHelloAt）。
  let lastHelloAt = 0
  // 本次连接的 hello-ok 时刻（R4-9 第四轮）：close 时 stable 计费基准——只有「本次连接 hello 后存活
  // 过阈值」的断开才算稳定（不计费，P1-6）。retry（新连接尝试）/ start 重置为 0，防稳定连接历史
  // （lastHelloAt）让此后无 hello 的连续重连失败永远 stable=true、永不 give-up（无限 30s 退避）。
  let thisConnHelloAt = 0
  const STABLE_CONNECTION_MS = 30_000
  // #377 自动设备配对编排状态机（ADR 0006 B-直连 / issue #377）：首连 bootstrap → PAIRING_REQUIRED
  // {requestId} → 自动 approve → 重连 → hello-ok 下发 deviceToken → acceptHello 持久化（localStorage）→
  // 后续 buildConnectPlan 用 deviceToken。网关重置（token 失效）再遇 PAIRING_REQUIRED → 自动重配对
  // （clearStoredToken 清失效 token → 回 bootstrap 首连闭环）。预算防无限循环：approve 反复无效
  // （requestId 过期/网关不可达）达阈值 → 停止自动配对、转 UI 手动处理。
  let pairingState: 'idle' | 'pairing' | 'paired' = 'idle'
  let pairingAttempts = 0
  const MAX_PAIRING_ATTEMPTS = 3
  // 最近一次 buildConnectPlan 的 lifecycle plan——clearStoredToken 需要 plan.clientId/identity/role
  // （onClose context 不含 plan，闭包缓存供「token 失效重配对」清除路径）。
  let lastAuthPlan: GatewayBrowserDeviceAuthPlan | null = null
  // stop 标志：切容器 stop() 后配对编排（approve HTTP 在途）不得再 client.start() 重建已停协议机的
  // 连接（否则旧 gateway 在后台建连接、无人管理，ws 泄漏）。
  let isStopped = false
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
    buildConnectPlan: async ({ nonce }) => {
      // #377: 接入官方设备认证生命周期。真网关 2026.7.1-browser 实测（pairingSmoke.test.ts 同款适配）：
      // 首连 auth 必须用 `token` 字段（GATEWAY_TOKEN，即 bootstrapToken 参数值），官方 lifecycle 的
      // bootstrapToken 参数输出 `bootstrapToken` 字段被 2026.7.1 当「setup code」拒
      // （AUTH_BOOTSTRAP_TOKEN_INVALID）——官方 gateway-client 2026.7.2-beta.6 面向 2026.7.2 网关，
      // 无 2026.7.2-browser 镜像可升，故凭证选择适配：
      //   - 有 deviceToken（tokenStore 持久化过）→ 不传 token/bootstrapToken 凭证，官方 lifecycle 的
      //     selectGatewayConnectAuth 从 tokenStore 选 deviceToken（重连复用，不再走 bootstrap/配对）
      //   - 无（首连/网关重置清 token 后）→ 传 `token` 参数 → lifecycle 输出 auth:{token} + 设备签名块
      //        （签名 payload 含 GATEWAY_TOKEN，与 auth 一致；官方 bootstrapToken 参数会签名含
      //        bootstrapToken 的 payload 而输出 bootstrapToken 字段——两处都须改，不能只改 auth）
      // beta.6 打包版 buildPlan 无 challengeTs 参数（signedAtMs = nowMs ?? Date.now），只传 nonce。
      const stored = await (params.hasStoredDeviceToken ?? (() => hasStoredDeviceTokenFor(container, CLIENT_INFO.id, OPERATOR_ROLE)))()
      const authPlan = await lifecycle.buildPlan({
        client: CLIENT_INFO,
        role: OPERATOR_ROLE,
        defaultScopes: OPERATOR_SCOPES,
        ...(stored ? {} : { token: bootstrapToken }),
        nonce,
      })
      lastAuthPlan = authPlan
      return { ...authPlan, caps: CONNECT_CAPS }
    },
    // 对齐 tunnelProtocol.test：v4 握手参数（minProtocol/maxProtocol/client/role/scopes/caps/auth/device）
    buildConnectParams: (plan) => ({
      minProtocol: 4,
      maxProtocol: 4,
      client: CLIENT_INFO,
      role: plan.role,
      scopes: plan.scopes,
      caps: plan.caps,
      ...(plan.auth ? { auth: plan.auth } : {}),
      ...(plan.device ? { device: plan.device } : {}),
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
      // R4-9（第四轮）：stable 基准 thisConnHelloAt（本次连接），非历史 lastHelloAt——否则稳定连接一次
      // 后 lastHelloAt 永久存在，此后无 hello 的连续重连失败恒 stable=true、永不 give-up。
      const stable = thisConnHelloAt !== 0 && Date.now() - thisConnHelloAt >= STABLE_CONNECTION_MS
      if (!stable) {
        // #376: 4402 网关不可达走独立预算（容器恢复前重试无益，达预算即提示「容器网关不可用」）；
        // 其余传输失败（1006 等）走通用预算——两者互不干扰。
        if (context.code === WS_GATEWAY_UNAVAILABLE) {
          gatewayUnavailableCount++
          if (gatewayUnavailableCount >= MAX_RECONNECT_FAILURES) return { retry: false, notify: true }
        } else {
          consecutiveFailures++
          if (consecutiveFailures >= MAX_RECONNECT_FAILURES) return { retry: false, notify: true }
        }
      }
      thisConnHelloAt = 0 // retry = 新连接尝试，本次 hello 作废（下次 stable 判定基于新连接）
      return { retry: true, notify: true }
    },
    onClose: (context, decision) => {
      // D2: 透传 retry 决策给 UI——协议机已 give-up / 非恢复错误（retry:false）时 ChatView 如实
      // 提示「自动重连已停止，请手动重连」，不再谎报「自动重连中…」。
      if (decision.notify) {
        const connErr = context.connectFailure?.error
        const pairing =
          connErr instanceof GatewayProtocolRequestError
            ? readPairingConnectErrorDetails(connErr.details)
            : null
        if (pairing) {
          // #377 自动配对编排：PAIRING_REQUIRED{requestId} → 清失效 token → approve → 重连（bootstrap
          // 首连）→ hello-ok 下发 deviceToken。编排进行中不向 UI 报 pairingRequired（自动在跑，UI 提示
          // 「去容器详情页手动配对」会误导）；预算用尽（approve 反复无效）才转 UI 手动处理。
          if (pairingState === 'pairing') return
          if (pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
            notifyPairingFailed(context)
            return
          }
          pairingAttempts++
          pairingState = 'pairing'
          void runAutoPairing(context, pairing.requestId)
          return
        }
        // 多容器配对 bug 二段修复（生产实锤 gamma）：token MISMATCH 自愈。
        // 断连重连用失效 deviceToken → 网关 AUTH_DEVICE_TOKEN_MISMATCH（NON_RECOVERABLE，官方
        // retry:false；tokenMismatchIsTerminal 只对 AUTH_TOKEN_MISMATCH 生效、对 _DEVICE_ 变体无豁免）
        // → 原实现只捕获 PAIRING_REQUIRED，对 token-mismatch 无分支 → 落 retry:false「连接即停」。
        // 自愈：清失效 token → client.start() 重连（bootstrap 首连 → PAIRING_REQUIRED → 上方既有
        // 配对编排 approve → hello-ok 拿新 token）。复用配对预算防「清 token 重连仍 MISMATCH」死循环
        // （如网关侧 token 轮换与面板持久化持续失同步），预算用尽转 UI 手动重连。
        const detailCode =
          connErr instanceof GatewayProtocolRequestError ? readConnectErrorDetailCode(connErr.details) : null
        if (detailCode === 'AUTH_DEVICE_TOKEN_MISMATCH' || detailCode === 'AUTH_TOKEN_MISMATCH') {
          if (pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
            handlers.onClose(context.code, context.reason, false, false) // 预算用尽：如实报连接即停
            return
          }
          pairingAttempts++
          void recoverTokenMismatch(context)
          return
        }
        handlers.onClose(context.code, context.reason, decision.retry, false)
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
    onConnectHello: (hello, context) => {
      // #377: hello-ok 下发 deviceToken → acceptHello 持久化（tokenStore）→ 配对完成。此后
      // buildConnectPlan 用 deviceToken（不再走 bootstrap/配对）。
      // **仅当 hello 携带 deviceToken 且本连接有设备身份才算配对完成**——官方 acceptHello 在无
      // token / identity null 时静默 return（不持久化）。若无条件重置预算，storage 不可用或网关
      // 异常时每次 hello 都清零 pairingAttempts，网关持续 PAIRING_REQUIRED 则无限 approve 循环
      // （预算失效）。acceptHello 失败（localStorage 配额满）静默降级（catch 吞 rejection），
      // 下次连接走 bootstrap/重配对自愈。
      const helloToken = hello.auth?.deviceToken
      if (context.plan.identity && helloToken) {
        void lifecycle
          .acceptHello(hello, context.plan)
          .then(() => {
            pairingState = 'paired'
            pairingAttempts = 0
          })
          .catch(() => {})
      }
    },
    onHello: () => {
      // F2: 重连成功（hello-ok）→ 重置连续失败计数。
      // P1-6（code review）：仅当「上次连接稳定存活过」才归零（距上次 hello 超过稳定阈值）——
      // crash-loop 型（hello 即崩，间隔 < 阈值）每次握手成功不得归零，否则永不 give-up、无限
      // 重连空转（违背 #369「退避重连空转」目标）；首次连接（lastHelloAt===0）归零。
      if (lastHelloAt === 0 || Date.now() - lastHelloAt >= STABLE_CONNECTION_MS) {
        consecutiveFailures = 0
        gatewayUnavailableCount = 0 // #376: 稳定存活后 hello 重置 4402 预算（crash-loop 不重置，同通用预算）
      }
      lastHelloAt = Date.now() // 记录 hello 时刻，供「稳定存活」判定
      thisConnHelloAt = Date.now() // R4-9: 本次连接 hello 时刻（close stable 计费基准）
      resetTranslator() // P2: 新连接生命周期边界清空 sent 累积（断线中断的 run 条目作废）
      handlers.onReady()
    },
  })

  // 配对失败（approve HTTP 错误 / requestId 无效 / 预算用尽）→ 复位状态并如实上报 UI（可手动重试 /
  // 切容器重置预算）。onClose 预算分支与 runAutoPairing catch 共用（code-review 去重）。
  const notifyPairingFailed = (context: GatewayProtocolCloseContext) => {
    pairingState = 'idle'
    pairingAttempts = 0
    handlers.onClose(context.code, context.reason, false, true)
  }

  // #377 自动设备配对编排：approve 落库（容器内 exec 完成）后重连——buildConnectPlan 走 bootstrap 首连
  // → 网关接受（设备已 approve）→ hello-ok 下发 deviceToken → acceptHello 持久化（onConnectHello）。
  // approve 失败（HTTP/网络错误、requestId 过期）→ notifyPairingFailed 让 UI 如实提示。
  const runAutoPairing = async (context: GatewayProtocolCloseContext, requestId?: string) => {
    try {
      // 先校验 requestId（无 requestId 的畸形 PAIRING_REQUIRED 无法 approve）再清失效 token——
      // 避免对畸形输入先执行清 token 副作用（code-review guard ordering）。
      if (!requestId) throw new Error('网关未返回配对 requestId')
      // 失效/残留 deviceToken 清除（paired 后网关重置场景）——清掉让重连 buildConnectPlan 回 bootstrap。
      if (lastAuthPlan) await lifecycle.clearStoredToken(lastAuthPlan)
      await approvePairing(container, requestId)
      // 切容器已 stop()：approve 在途时旧 gateway 被弃，不得再 start() 重建连接（ws 泄漏）。
      if (isStopped) return
      pairingState = 'idle'
      client.start()
    } catch {
      notifyPairingFailed(context)
    }
  }

  // token MISMATCH 自愈（多容器配对 bug 二段）：失效 deviceToken 清除 → client.start() 重连。
  // 清 token 后 buildConnectPlan 回 bootstrap 首连（hasStoredDeviceToken=false），网关对未配对设备回
  // PAIRING_REQUIRED → 上方既有配对编排 approve → hello-ok 下发新 deviceToken。不 directly approve——
  // MISMATCH 时网关无 pending 配对请求、无 requestId 可 approve，须经 bootstrap 重新触发配对。
  const recoverTokenMismatch = async (context: GatewayProtocolCloseContext) => {
    try {
      if (lastAuthPlan) await lifecycle.clearStoredToken(lastAuthPlan)
      // 切容器已 stop()：清 token 在途时旧 gateway 被弃，不得再 start() 重建连接（ws 泄漏）。
      if (isStopped) return
      client.start()
    } catch {
      // 清 token 失败（localStorage/网络异常）：如实报连接即停，转 UI 手动重连
      handlers.onClose(context.code, context.reason, false, false)
    }
  }

  return {
    start: () => {
      lastActivityAt = Date.now()
      thisConnHelloAt = 0 // R4-9: 首次连接尝试，尚未 hello（close 计费基准复位）
      isStopped = false
      // #377: 新连接生命周期开始，配对状态复位——防 stop() 落在 approve 中途残留 'pairing' 吞掉
      // 后续 PAIRING_REQUIRED（code-review）。已配对凭据在 localStorage，buildConnectPlan 仍走
      // deviceToken（配对状态由 lifecycle 的 token 选择反映，非本标志）。
      pairingState = 'idle'
      pairingAttempts = 0
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
      isStopped = true
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
      // 缺失会话为 ok 无操作（幂等）。不带 archivedOnly 需 operator.admin scope（见 OPERATOR_SCOPES，
      // R4-2）——否则删除被 scope 拒。
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
    async send(sessionKey: string, message: string, attachments?: Attachment[]): Promise<string | undefined> {
      // chat.send 幂等（schema 必填 idempotencyKey）；返回后流式 delta/final 事件经 onEvent 到达。
      // A3/P2: 幂等 key 与 createSession 统一 32-hex 格式（randomUUID 去连字符——跨路径 key 规范
      // 一致，网关幂等去重不因格式分歧而失效）。
      // #53: RPC 响应 = ackPayload {runId, status:"started"}（官方 chat-send-handler）——返回
      // runId 供 ChatView 首帧归属判别；ack 无 runId（异常形状）返回 undefined。
      // #459-T1 #462：attachments 仅在非空时携带（官方可选字段，空数组/不带与既有文本路径同形状，
      // 回归无差）；附件体积/类型已由 chat/attachments.ts 校验，本层原样透传（帧内 1MiB 上限内）。
      const res = await client.request<{ runId?: unknown }>('chat.send', {
        sessionKey,
        message,
        idempotencyKey: createRequestId().replace(/[^a-z0-9]/g, ''),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      })
      return typeof res?.runId === 'string' && res.runId ? res.runId : undefined
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
    // B0: 补拉待处理审批（exec.approval.list）——见接口注释。实测校准（生产网关
    // exec-approval dist）：listVisiblePendingApprovalRequests 返回 [{id, request, createdAtMs,
    // expiresAtMs}]，request 内含 command/sessionKey（与 exec.approval.requested 事件 payload 的
    // request 同构）。list 只回 pending（终态由 exec.approval.resolved 事件收敛）。返回空数组
    // 视为无可补拉（含网关版本不支持该方法——请求超时/INVALID_REQUEST 均 catch 降级）。
    async listPendingApprovals(): Promise<ApprovalCardDTO[]> {
      try {
        const res = await client.request<{ items?: unknown; approvals?: unknown }>('exec.approval.list', {})
        // 0 信任：优先 items（ApprovalHistoryResult 形状），回退 approvals；非对象项跳过
        const raw = Array.isArray(res?.items) ? res.items : Array.isArray(res?.approvals) ? res.approvals : []
        const out: ApprovalCardDTO[] = []
        for (const item of raw) {
          if (!item || typeof item !== 'object') continue
          const rec = item as Record<string, unknown>
          const id = typeof rec.id === 'string' && rec.id ? rec.id : ''
          if (!id) continue
          const req = rec.request && typeof rec.request === 'object' ? (rec.request as Record<string, unknown>) : {}
          const kind = typeof rec.kind === 'string' && rec.kind ? (rec.kind as string) : 'exec'
          const command = typeof req.command === 'string' ? req.command : ''
          const sessionKey = typeof req.sessionKey === 'string' ? req.sessionKey : null
          // #405-T1：补拉与 requested 事件同构（#394 实测），request.agentId string 才取（0 信任）
          const agentId = typeof req.agentId === 'string' ? req.agentId : null
          out.push({ id, kind, command, sessionKey, agentId })
        }
        return out
      } catch {
        return [] // 网关不支持/超时：静默降级（实时 push 仍工作）
      }
    },
  }
}
