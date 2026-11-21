// 服务级不透明游标原语（历史 #1079 / 反思 #1082 共用）：随机令牌 + 内存状态 + 绝对到期。
//
// 绑定 owner/调用会话/操作/请求条件散列；篡改、跨用户、跨会话、换条件、过期、重启一律同形拒绝。
// 状态上限与每用户/全局数量上限由调用方传入（两个域各自独立配额）。

import { randomBytes } from 'node:crypto'

export interface OpaqueCursorStateBase {
  ownerId: string
  currentSessionId: string
  requestHash: string
  deadline: number
  page: number
}

export interface OpaqueCursorLimits {
  ttlMs: number
  maxPerUser: number
  maxGlobal: number
  maxStateBytes: number
}

export type OpaqueCursorPutResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: 'busy' | 'state_limit' }

export class OpaqueCursorStore<T extends OpaqueCursorStateBase & { operation: string }> {
  private readonly states = new Map<string, T>()

  constructor(private readonly clock: () => number, private readonly limits: OpaqueCursorLimits) {}

  put(state: Omit<T, 'deadline'>): OpaqueCursorPutResult {
    const now = this.clock()
    this.sweep(now)
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > this.limits.maxStateBytes) return { ok: false, reason: 'state_limit' }
    let userCount = 0
    for (const entry of this.states.values()) if (entry.ownerId === state.ownerId) userCount++
    if (userCount >= this.limits.maxPerUser || this.states.size >= this.limits.maxGlobal) return { ok: false, reason: 'busy' }
    const deadline = now + this.limits.ttlMs
    const token = randomBytes(24).toString('base64url')
    this.states.set(token, { ...state, deadline } as T)
    return { ok: true, token, expiresAt: deadline }
  }

  get(token: string, context: { ownerId: string; currentSessionId: string; operation: string }, requestHash: string): T | undefined {
    const now = this.clock()
    this.sweep(now)
    const state = this.states.get(token)
    if (!state) return undefined
    if (state.deadline < now || state.ownerId !== context.ownerId || state.currentSessionId !== context.currentSessionId ||
      state.operation !== context.operation || state.requestHash !== requestHash) return undefined
    return state
  }

  /** 续读时更新状态但保留原绝对到期（不续期）。 */
  update(token: string, patch: Partial<Omit<T, 'deadline'>>): boolean {
    const state = this.states.get(token)
    if (!state || state.deadline < this.clock()) return false
    this.states.set(token, { ...state, ...patch, deadline: state.deadline } as T)
    return true
  }

  delete(token: string): void {
    this.states.delete(token)
  }

  sweep(now: number): void {
    for (const [token, state] of this.states) if (state.deadline < now) this.states.delete(token)
  }

  clear(): void {
    this.states.clear()
  }
}
