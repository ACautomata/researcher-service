// chatStore —— 对话页响应式投影（#316 候选 B / #340：Pinia 纯 mutation，贴 useWikiStore 形态）。
// 渲染状态与连接解耦：messages/approvals/sessions/instances/commands/selectedContainer/
// selectedSession/input + 历史分页态 全在此；连接生命周期 × runId 路由 × 非响应式簇
// （gateway/定时器/请求代）归 useChatConnection 同宿主（#340 关键约束）。
import { defineStore } from 'pinia'
import type { InstanceDTO } from '@/api/containers'
import type { CommandDTO, SessionDTO } from '@/chat/gatewayChat'

export interface ToolRow {
  id: string | null // 工具调用 id（codex P2：同名并发调用按 id 配对 result，无 id 退 name）
  name: string
  state: 'running' | 'done' | 'error'
  title: unknown // 网关 toolTitles 用途短标题（待实测），有则优先显示
  input: unknown
  result: unknown
}

export interface Msg {
  role: 'user' | 'assistant'
  raw: string // 原始累积文本（含 <thinking> 标签）；user 与 text 相同。thinking 由此剥离
  text: string // 展示正文（已剥离 thinking）
  thinking: string // T08 思考链（spec §8.3 (a)）：从 raw 内 <thinking> 标签剥离出的思考内容，折叠卡渲染
  thinkingOpen: boolean // 流式中 <thinking> 未闭合（思考中）
  streaming: boolean
  tools: ToolRow[] // T08 工具行（仅 assistant 会有，user 恒空；保持接口统一）
}

// T06 审批卡（连接级，无 runId）：独立列表渲染，不混入 messages——避免破坏流式锚定/finalizeLast
// （审查 #5），并可独立按 sessionKey 过滤、随会话/容器切换清空（codex P1 / 审查 #6）。
export interface ApprovalItem {
  id: string
  kind: string
  command: string
  sessionKey: string | null
  status: 'pending' | 'resolving' | 'resolved' // pending 待处理 / resolving 已点击等回执 / resolved 已处理
  decision: '' | 'allow-once' | 'allow-always' | 'deny' | 'unknown' // codex P1 (issue #154)：网关权威值 allow-once/allow-always/deny
  detailOpen: boolean
}

export function newMsg(role: 'user' | 'assistant', text = ''): Msg {
  return {
    role,
    raw: text,
    text,
    thinking: '',
    thinkingOpen: false,
    streaming: role === 'assistant',
    tools: [],
  }
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    instances: [] as InstanceDTO[],
    sessions: [] as SessionDTO[],
    selectedContainer: '' as string,
    selectedSession: '' as string,
    messages: [] as Msg[],
    approvals: [] as ApprovalItem[],
    commands: [] as CommandDTO[],
    input: '' as string,
    // T3 会话历史回看（issue #82 / spec #76）：分页态——hasMore 标记可向回翻更旧消息，
    // historyAnchor=nextOffset 为下一更旧页的 messageId 锚点；historyLoading 控「加载更多」禁用。
    historyHasMore: false as boolean,
    historyAnchor: null as string | number | null,
    historyLoading: false as boolean,
    // T07 斜杠命令补全：菜单选中项 + Esc 关闭态
    slashIndex: 0 as number,
    slashDismissed: false as boolean,
  }),
  actions: {
    // ---- 容器 / 会话 ----
    setInstances(list: InstanceDTO[]): void {
      this.instances = list
    },
    setSessions(list: SessionDTO[]): void {
      this.sessions = list
    },
    setSelectedContainer(name: string): void {
      this.selectedContainer = name
    },
    setSelectedSession(key: string): void {
      this.selectedSession = key
    },
    prependSession(s: SessionDTO): void {
      this.sessions = [s, ...this.sessions]
    },
    removeSession(key: string): void {
      this.sessions = this.sessions.filter((s) => s.session_key !== key)
    },

    // ---- 消息投影（纯 mutation，供 useChatConnection 的 handle* 调用）----
    pushMessage(m: Msg): void {
      this.messages.push(m)
    },
    setMessages(list: Msg[]): void {
      this.messages = list
    },
    // 最后一条助手消息：仅当仍是占位/流式时落定（done/error/断线收尾共用）
    finalizeLast(): void {
      const last = this.messages[this.messages.length - 1]
      if (last && last.streaming) {
        last.streaming = false
        last.thinkingOpen = false
      }
    },
    setInput(v: string): void {
      this.input = v
    },

    // ---- 审批卡（T06）----
    addApproval(card: { id: string; kind: string; command: string; sessionKey: string | null }): void {
      // codex R2 P1：按 id 去重后**留存全部**（含其它会话的），仅渲染时按 sessionKey 过滤
      if (this.approvals.some((a) => a.id === card.id)) return // 幂等（重连补拉 + 实时推送去重）
      this.approvals.push({
        id: card.id,
        kind: card.kind,
        command: card.command || '（网关未提供命令详情）',
        sessionKey: card.sessionKey,
        status: 'pending',
        decision: '',
        detailOpen: false,
      })
    },
    // 网关回执：以权威 decision 落定（first-answer-wins，codex P1，可能与请求不同）
    resolveApproval(id: string, decision: string): void {
      const a = this.approvals.find((x) => x.id === id)
      if (a) {
        a.status = 'resolved'
        a.decision =
          decision === 'allow-once' || decision === 'allow-always' || decision === 'deny'
            ? decision
            : 'unknown'
      }
    },
    // resolve 失败（带 approval id 的 RPC 错误）或断线（无 id → 全部）：恢复 resolving 卡为 pending 可重试
    // （codex R2 P2：仅复位匹配卡，不误复位并发在途的其它卡）
    recoverPendingApprovals(id?: string): void {
      for (const a of this.approvals) {
        if (a.status === 'resolving' && (id === undefined || a.id === id)) a.status = 'pending'
      }
    },
    toggleApprovalDetail(id: string): void {
      const a = this.approvals.find((x) => x.id === id)
      if (a) a.detailOpen = !a.detailOpen
    },
    clearApprovals(): void {
      this.approvals = []
    },

    // ---- 斜杠命令（T07）----
    setCommands(list: CommandDTO[]): void {
      this.commands = list
    },
    setSlashDismissed(v: boolean): void {
      this.slashDismissed = v
    },
    setSlashIndex(i: number): void {
      this.slashIndex = i
    },

    // ---- 历史分页（T3）----
    setHistoryState(hasMore: boolean, anchor: string | number | null, loading: boolean): void {
      this.historyHasMore = hasMore
      this.historyAnchor = anchor
      this.historyLoading = loading
    },
    setHistoryLoading(loading: boolean): void {
      this.historyLoading = loading
    },

    // ---- 切容器 / 切会话时清态（连接簇由 useChatConnection 负责）----
    resetForContainer(): void {
      this.sessions = []
      this.selectedSession = ''
      this.messages = []
      this.approvals = [] // 切容器：清空审批卡（审查 #6）
      this.commands = [] // 切容器：清空命令缓存（命令按容器隔离，T07）
      this.input = ''
      this.slashDismissed = false
      this.historyHasMore = false
      this.historyAnchor = null
      this.historyLoading = false
    },
    resetForSession(): void {
      this.messages = []
      this.historyHasMore = false
      this.historyAnchor = null
      this.historyLoading = false
    },
  },
})
