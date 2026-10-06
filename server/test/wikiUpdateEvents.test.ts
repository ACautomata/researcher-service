// wiki_run 五类事件映射单测（#790 · S3 纯逻辑）：OpenWikiRunEvent → CatalogEvent 薄投影。
// 五类（progress/text/tool_start/tool_end/finished）落 SSE；debug 类不落（映射丢弃）；tool
// input ≤1k 截断 + 标记（对齐 projector 事件纪律）；finished 由执行体构造（outcome 三值）。
// 契约面不跑 LLM——锁死防漂移（#789 schema 键集锁定先例）。

import { describe, expect, it } from 'vitest'
import {
  buildWikiRunFinished,
  mapOpenWikiRunEvent,
} from '../src/wiki/updateEvents'
import { WIKI_RUN_FINISHED, WIKI_RUN_PROGRESS, WIKI_RUN_TEXT, WIKI_RUN_TOOL_END, WIKI_RUN_TOOL_START } from '../src/runner/wikigen/values'

const RUN = 'run-1'

describe('mapOpenWikiRunEvent（#790 五类映射）', () => {
  it('repository_progress → wiki_run.progress：planning/generating/finalizing 阶段原样进 payload，字段保真', () => {
    const planning = mapOpenWikiRunEvent({ type: 'repository_progress', stage: 'planning' }, RUN)
    expect(planning).toEqual([{ type: WIKI_RUN_PROGRESS, runId: RUN, payload: { stage: 'planning' } }])

    const generating = mapOpenWikiRunEvent(
      {
        type: 'repository_progress',
        stage: 'generating',
        resumed: true,
        page: 'openwiki/concepts/demo.md',
        pageIndex: 1,
        pageCount: 3,
        completedCount: 2,
        inFlightPages: ['openwiki/concepts/demo.md'],
      },
      RUN,
    )
    expect(generating).toEqual([
      {
        type: WIKI_RUN_PROGRESS,
        runId: RUN,
        payload: {
          stage: 'generating',
          resumed: true,
          page: 'openwiki/concepts/demo.md',
          pageIndex: 1,
          pageCount: 3,
          completedCount: 2,
          inFlightPages: ['openwiki/concepts/demo.md'],
        },
      },
    ])

    const finalizing = mapOpenWikiRunEvent({ type: 'repository_progress', stage: 'finalizing', pageCount: 3 }, RUN)
    expect(finalizing[0]!.payload).toEqual({ stage: 'finalizing', pageCount: 3 })
  })

  it('text → wiki_run.text', () => {
    expect(mapOpenWikiRunEvent({ type: 'text', source: 'main', text: 'hello\n' }, RUN)).toEqual([
      { type: WIKI_RUN_TEXT, runId: RUN, payload: { text: 'hello\n' } },
    ])
  })

  it('tool_start/tool_end → 对应 wiki_run.*：id/name/page/status 保真，input 序列化 ≤1k', () => {
    const start = mapOpenWikiRunEvent(
      { type: 'tool_start', call: 'write_file', id: 'tc1', input: { file_path: '/x.md' }, name: 'write_file', page: 'openwiki/x.md' },
      RUN,
    )
    expect(start).toEqual([
      {
        type: WIKI_RUN_TOOL_START,
        runId: RUN,
        payload: { id: 'tc1', name: 'write_file', page: 'openwiki/x.md', input: JSON.stringify({ file_path: '/x.md' }) },
      },
    ])
    expect(start[0]!.payload).not.toHaveProperty('call') // call（chunk 来源）不进事件面

    const end = mapOpenWikiRunEvent({ type: 'tool_end', id: 'tc1', name: 'write_file', status: 'finished' }, RUN)
    expect(end).toEqual([
      { type: WIKI_RUN_TOOL_END, runId: RUN, payload: { id: 'tc1', name: 'write_file', status: 'finished' } },
    ])
  })

  it('tool input >1k 截断 + truncated 标记（projector 纪律对齐）', () => {
    const events = mapOpenWikiRunEvent(
      { type: 'tool_start', call: 'grep', id: 'tc2', input: { pattern: '长'.repeat(2000) }, name: 'grep' },
      RUN,
    )
    const payload = events[0]!.payload as { input: string; truncated?: boolean }
    expect(payload.truncated).toBe(true)
    expect(Buffer.byteLength(payload.input, 'utf8')).toBeLessThanOrEqual(1024)
  })

  it('debug 事件不落 SSE（映射为空）', () => {
    expect(mapOpenWikiRunEvent({ type: 'debug', message: 'verbose internals' }, RUN)).toEqual([])
  })
})

describe('buildWikiRunFinished（#790 终帧）', () => {
  it('outcome 三值（completed/conflict/failed）+ runId 携带', () => {
    expect(buildWikiRunFinished(RUN, 'completed')).toEqual({ type: WIKI_RUN_FINISHED, runId: RUN, payload: { outcome: 'completed' } })
    expect(buildWikiRunFinished(RUN, 'conflict')).toEqual({ type: WIKI_RUN_FINISHED, runId: RUN, payload: { outcome: 'conflict' } })
    expect(buildWikiRunFinished(RUN, 'failed')).toEqual({ type: WIKI_RUN_FINISHED, runId: RUN, payload: { outcome: 'failed' } })
  })
})
