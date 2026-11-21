// 服务级不透明书签：绑定 owner/调用会话/原条件/绝对到期；内容只在内存元数据，重启即失效。
import { randomBytes } from 'node:crypto'
import type { EvidenceCursor } from './evidence'
import type { HistoryPosition, HistoryRange } from './model'

export interface ReadTargetCursor {
  sessionId: string
  range?: HistoryRange
  status: 'pending' | 'reading' | 'complete' | 'incomplete'
  version: number
  upper?: HistoryPosition
  position?: HistoryPosition
  segment?: { messageId: string; cursor: EvidenceCursor }
  error?: { code: string; message: string }
}

export interface FrozenSearchSession {
  id: string
  version: number
  upper?: HistoryPosition
}

export interface SearchCursorData {
  sessions: FrozenSearchSession[]
  index: number
  position?: HistoryPosition
  pendingAfter: number
  started: boolean
}

export interface CursorStateBase {
  ownerId: string
  currentSessionId: string
  requestHash: string
  deadline: number
  page: number
}

export type CursorState =
  | (CursorStateBase & { operation: 'read'; targets: ReadTargetCursor[] })
  | (CursorStateBase & { operation: 'search'; search: SearchCursorData })

export interface CursorLimits {
  ttlMs: number
  maxPerUser: number
  maxGlobal: number
  maxStateBytes: number
}

export type CursorPutResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: 'busy' | 'state_limit' }

export class HistoryCursorStore {
  private readonly states = new Map<string, CursorState>()

  constructor(private readonly clock: () => number, private readonly limits: CursorLimits) {}

  put(state: Omit<CursorStateBase, 'deadline'> & { operation: CursorState['operation']; targets?: ReadTargetCursor[]; search?: SearchCursorData }): CursorPutResult {
    const now = this.clock()
    this.cleanup(now)
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > this.limits.maxStateBytes) return { ok: false, reason: 'state_limit' }
    let userCount = 0
    for (const entry of this.states.values()) if (entry.ownerId === state.ownerId) userCount++
    if (userCount >= this.limits.maxPerUser || this.states.size >= this.limits.maxGlobal) return { ok: false, reason: 'busy' }
    const deadline = now + this.limits.ttlMs
    const token = randomBytes(24).toString('base64url')
    const full = { ...state, deadline } as CursorState
    this.states.set(token, full)
    return { ok: true, token, expiresAt: deadline }
  }

  // 篡改 / 跨用户 / 跨会话 / 换条件 / 过期 / 重启 → 同形拒绝。
  get(token: string, context: { ownerId: string; currentSessionId: string; operation: string }, requestHash: string): CursorState | undefined {
    const now = this.clock()
    this.cleanup(now)
    const state = this.states.get(token)
    if (!state) return undefined
    if (state.deadline < now || state.ownerId !== context.ownerId || state.currentSessionId !== context.currentSessionId ||
      state.operation !== context.operation || state.requestHash !== requestHash) return undefined
    return state
  }

  delete(token: string): void {
    this.states.delete(token)
  }

  private cleanup(now: number): void {
    for (const [token, state] of this.states) if (state.deadline < now) this.states.delete(token)
  }
}
