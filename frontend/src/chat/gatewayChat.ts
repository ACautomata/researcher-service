// #369 M5 前端接线：ChatView 走隧道 + 官方协议机的协议客户端 Facade。
// 内部 = GatewayProtocolClient（官方 ./browser 协议机）+ createPanelTunnelSocket（面板隧道 transport）。
// 对外 = ChatView 需要的高层 API：RPC（sessions/list-create-delete、chat/history-send、commands、
// exec.approval.resolve）+ 事件翻译路由（onEvent → ChatEventTranslator → onFrame）+ close 决策。
//
// B-直连（ADR 0006）：协议机握手/重连/帧状态机全在官方包，本模块只做编排与翻译。

import { GatewayProtocolClient } from '@openclaw/gateway-client/browser'
import { createPanelTunnelSocket } from './tunnelSocket'
import { ChatEventTranslator, type ChatFrame, type GatewayEventFrame } from './eventTranslate'

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
  // 4403 强制改密 / 其他传输断开）。retry 由协议机内部决策，这里只上报给 UI。
  onClose: (code: number, reason: string) => void
  // 连接级错误（非 run 级）：如 handshake 超时、socket 工厂失败
  onError: (message: string) => void
}

export interface GatewayChat {
  start(): void
  stop(): void
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

// 面板隧道 close code（对齐 server/src/chat/values.ts）：4401 认证失败 / 4404 容器归属 / 4402 网关不可达
// / 4403 强制改密。协议机对这些 code 的决策：认证/归属/改密 = 非传输问题，不自动重连（retry:false，
// 前端决定 forceRefresh 或提示）；其余（网络断开 1006/1005、网关 4402）→ 协议机内置指数退避重连。
const NO_RETRY_CLOSE_CODES = new Set([4401, 4404, 4403])
const GATEWAY_UNAVAILABLE_CLOSE = 4402

// 连接参数中的 operator scope（协议文档）：sessions/chat 需 read/write；exec.approval.resolve 需
// operator.approvals（审批回覆）。tool-events 声明该连接接收 run 的结构化工具事件。
const OPERATOR_SCOPES = ['operator.read', 'operator.write', 'operator.approvals']
const CONNECT_CAPS = ['tool-events']

export function createGatewayChat(params: CreateGatewayChatParams): GatewayChat {
  const { container, jwt, bootstrapToken, handlers } = params
  const translator = new ChatEventTranslator()

  const client = new GatewayProtocolClient<ConnectPlan>({
    createSocket: (socketHandlers) => createPanelTunnelSocket(container, jwt, socketHandlers),
    createRequestId: () => crypto.randomUUID(),
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
    handshake: { mode: 'require-challenge', timeoutMs: 3000 },
    reconnect: { initialMs: 1000, multiplier: 2, maxMs: 30000 },
    // close 决策：认证/归属/改密 = 非传输问题，不自动重连（前端 forceRefresh 或提示）；其余重连。
    // notify:true 让 onClose 上报 UI（断线提示）。
    resolveClose: (context) => {
      if (NO_RETRY_CLOSE_CODES.has(context.code)) return { retry: false, notify: true }
      // 网关不可达（容器不在 running/端口不通）→ 退避重连；其他传输断开（1006 等）同协议机默认。
      return context.code === GATEWAY_UNAVAILABLE_CLOSE
        ? { retry: true, notify: true, reconnectDelayMs: 2000 }
        : { retry: true, notify: true, reconnectDelayMs: 1000 }
    },
    onClose: (context, decision) => {
      if (decision.notify) handlers.onClose(context.code, context.reason)
    },
    onConnectError: (error) => handlers.onError(error.message),
    onSocketFactoryError: (error) => handlers.onError(error.message),
    onEvent: (event: GatewayEventFrame) => {
      for (const frame of translator.translate(event)) handlers.onFrame(frame)
    },
    onHello: () => handlers.onReady(),
  })

  return {
    start: () => client.start(),
    stop: () => client.stop(),
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
      // 幂等 key（网关写操作建议带 idempotency）；label 可空（网关后续派生标题）
      const res = await client.request<{ key?: unknown; sessionKey?: unknown }>('sessions.create', {
        key: crypto.randomUUID().replace(/[^a-z0-9]/g, ''),
        label: label || undefined,
      })
      const key = typeof res?.key === 'string' ? res.key : typeof res?.sessionKey === 'string' ? res.sessionKey : ''
      if (!key) throw new Error('会话创建失败：网关未返回 session key')
      return key
    },
    async deleteSession(key: string): Promise<void> {
      // archivedOnly:true —— operator.write 删会话须置位（archive-then-delete，可恢复；ADR 事实 4）
      await client.request('sessions.delete', { key, archivedOnly: true })
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
      // chat.send 幂等（schema 必填 idempotencyKey）；返回后流式 delta/final 事件经 onEvent 到达
      await client.request('chat.send', { sessionKey, message, idempotencyKey: crypto.randomUUID() })
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
