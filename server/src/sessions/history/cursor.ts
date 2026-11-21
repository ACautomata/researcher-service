// 服务级不透明书签：绑定 owner/调用会话/原条件/绝对到期；内容只在内存元数据，重启即失效。
// 通用原语见 utils/opaqueCursorStore.ts（反思记录检索 #1082 复用同一实现、独立配额）。
import type { SegmentOffset } from './evidence'
import type { HistoryGroupStatus, HistoryPosition, HistoryRange } from './model'
import { OpaqueCursorStore, type OpaqueCursorLimits, type OpaqueCursorPutResult } from '../../utils/opaqueCursorStore'

export interface ReadTargetProgress {
  sessionId: string
  range?: HistoryRange
  status: HistoryGroupStatus
  version: number
  upper?: HistoryPosition
  position?: HistoryPosition
  segment?: { messageId: string; offset: SegmentOffset }
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
  // 候选会话查询在冻结上限处被截断：显式停止，不把未扫描范围报成完整。
  limited: boolean
}

export interface CursorStateBase {
  ownerId: string
  currentSessionId: string
  requestHash: string
  deadline: number
  page: number
}

export type CursorState =
  | (CursorStateBase & { operation: 'read'; targets: ReadTargetProgress[] })
  | (CursorStateBase & { operation: 'search'; search: SearchCursorData })

export type CursorLimits = OpaqueCursorLimits
export type CursorPutResult = OpaqueCursorPutResult

export class HistoryCursorStore extends OpaqueCursorStore<CursorState> {
  put(state: Omit<CursorStateBase, 'deadline'> & { operation: CursorState['operation']; targets?: ReadTargetProgress[]; search?: SearchCursorData }): CursorPutResult {
    return super.put(state as Omit<CursorState, 'deadline'>)
  }
}
