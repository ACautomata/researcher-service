// wiki_run 域事件映射（#790 · #747 G 节通道③独立 run 的 SSE 事件面）。
//
// OpenWikiRunEvent（openwiki dist/agent/types.js）→ CatalogEvent 薄投影——纯函数零 IO，
// S3 锁定（wikiUpdateEvents.test.ts）。映射面：
//   repository_progress → wiki_run.progress（planning/generating/finalizing/replanning/noop
//     阶段原样进 payload；page/pageIndex/pageCount/completedCount/inFlightPages/resumed 保真）
//   text                → wiki_run.text
//   tool_start          → wiki_run.tool_start（input 序列化 ≤1k 截断 + truncated 标记，对齐
//     runner/runtime/projector 的事件截断纪律；tool_call chunk 来源字段 `call` 不进事件面）
//   tool_end            → wiki_run.tool_end（status: finished|error）
//   debug               → **不产事件**（调试内部面不落 SSE——issue 正文钉死）
//   finished            → 不来自 OpenWikiRunEvent：由执行体构造（buildWikiRunFinished，
//     outcome 三值 completed/conflict/failed）
//
// 事件即焚不落盘（#726 语义）：控制面崩溃后永无 finished 帧——客户端靠 SSE gap 检测感知
// 断流并重拉投影。sessionId 省略（独立 run 无会话行），runId = 本次更新 run。

import type { OpenWikiRunEvent, RepositoryGenerationProgressEvent } from 'openwiki/dist/agent/types.js'
import type { CatalogEvent } from '../events/logic'
import { TOOL_INPUT_MAX_BYTES, TRUNCATED_FLAG } from '../runner/runtime/values'
import { truncateUtf8 } from '../runner/runtime/projector'
import {
  WIKI_RUN_FINISHED,
  WIKI_RUN_PROGRESS,
  WIKI_RUN_TEXT,
  WIKI_RUN_TOOL_END,
  WIKI_RUN_TOOL_START,
  type WikiRunOutcome,
} from '../runner/wikigen/values'

function progressPayload(ev: RepositoryGenerationProgressEvent): Record<string, unknown> {
  return {
    stage: ev.stage,
    ...(ev.resumed === true ? { resumed: true } : {}),
    ...(ev.page !== undefined ? { page: ev.page } : {}),
    ...(ev.pageIndex !== undefined ? { pageIndex: ev.pageIndex } : {}),
    ...(ev.pageCount !== undefined ? { pageCount: ev.pageCount } : {}),
    ...(ev.completedCount !== undefined ? { completedCount: ev.completedCount } : {}),
    ...(ev.inFlightPages !== undefined ? { inFlightPages: ev.inFlightPages } : {}),
  }
}

function serializeToolInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (input === undefined) return ''
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

export function mapOpenWikiRunEvent(ev: OpenWikiRunEvent, runId: string): CatalogEvent[] {
  switch (ev.type) {
    case 'repository_progress':
      return [{ type: WIKI_RUN_PROGRESS, runId, payload: progressPayload(ev) }]
    case 'text':
      return [{ type: WIKI_RUN_TEXT, runId, payload: { text: ev.text } }]
    case 'tool_start': {
      const { text, truncated } = truncateUtf8(serializeToolInput(ev.input), TOOL_INPUT_MAX_BYTES)
      return [
        {
          type: WIKI_RUN_TOOL_START,
          runId,
          payload: {
            id: ev.id,
            name: ev.name,
            ...(ev.page !== undefined ? { page: ev.page } : {}),
            input: text,
            ...(truncated ? { [TRUNCATED_FLAG]: true } : {}),
          },
        },
      ]
    }
    case 'tool_end':
      return [
        {
          type: WIKI_RUN_TOOL_END,
          runId,
          payload: {
            id: ev.id,
            name: ev.name,
            status: ev.status,
            ...(ev.page !== undefined ? { page: ev.page } : {}),
          },
        },
      ]
    case 'debug':
      return [] // 调试内部面不落 SSE
  }
}

// 终帧（执行体 finally 单点发布）：completed = 推回落容器；conflict = base-hash 冲突弃镜像；
// failed = 异常/中断作废。
export function buildWikiRunFinished(runId: string, outcome: WikiRunOutcome): CatalogEvent {
  return { type: WIKI_RUN_FINISHED, runId, payload: { outcome } }
}
