// #1082（RF-T06）记录检索游标：10 分钟绝对到期、不续期；绑定 owner/调用会话/purpose/查询条件。
// 复用 utils/opaqueCursorStore.ts 的通用原语，但使用独立配额（每用户 4 / 全局 64 / 状态 256KiB）。

import { OpaqueCursorStore, type OpaqueCursorPutResult, type OpaqueCursorStateBase } from '../utils/opaqueCursorStore'
import type { ReflectionPurpose } from './model'

export interface SnapshotEntry {
  readonly record_id: string
  readonly version: number
  readonly status: string
  readonly evidence_status: string
  readonly updated_at: string
}

export interface DraftSnapshotEntry {
  readonly draft_id: string
  readonly version: number
  readonly status: string
}

export interface ReflectionCursorStateBase extends OpaqueCursorStateBase {
  operation: 'search'
  purpose: ReflectionPurpose
  kind: 'records' | 'drafts'
}

export type ReflectionCursorState =
  | (ReflectionCursorStateBase & { kind: 'records'; entries: SnapshotEntry[]; index: number })
  | (ReflectionCursorStateBase & { kind: 'drafts'; entries: DraftSnapshotEntry[]; index: number })

export type ReflectionCursorPutResult = OpaqueCursorPutResult

export class ReflectionCursorStore extends OpaqueCursorStore<ReflectionCursorState> {
  put(state: Omit<ReflectionCursorState, 'deadline'>): ReflectionCursorPutResult {
    return super.put(state)
  }
}
