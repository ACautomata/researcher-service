import { describe, it, expect } from 'vitest'
import {
  encodeFrame,
  encodePing,
  parseLastEventId,
  detectGap,
  isDuplicateInStream,
  type CatalogEvent,
} from '../src/events/logic'
import { HEARTBEAT_MS, SSE_PROTOCOL_V } from '../src/events/values'

// 接缝 S3（纯逻辑，issue #773）：SSE 帧编码与 Last-Event-ID/gap 语义。
// 帧格式准据 = #747 C 节 / #726 resolution：id:=seq / event:=type /
// data:=JSON {type, sessionId?, runId?, payload}；心跳 :ping 20s（routes 层定间隔）。
describe('SSE 帧编码（#726 帧格式）', () => {
  it('encodeFrame：id/event/data 三行 + 空行收尾，data 为 {type, payload} JSON', () => {
    const e: CatalogEvent = {
      type: 'stream.opened',
      payload: { protocolV: 1, serverSeq: 0, serverTime: '2026-10-01T00:00:00.000Z' },
    }
    const wire = encodeFrame(7, e)
    expect(wire).toBe(
      `id: 7\nevent: stream.opened\ndata: ${JSON.stringify({
        type: 'stream.opened',
        payload: e.payload,
      })}\n\n`,
    )
  })

  it('encodeFrame：sessionId/runId 缺省不进 data（JSON 无 undefined 键）', () => {
    const wire = encodeFrame(1, { type: 'session.terminated', payload: { reason: 'logout' } })
    const dataLine = /^data: (.+)$/m.exec(wire)![1]
    const parsed = JSON.parse(dataLine)
    expect(parsed).toEqual({ type: 'session.terminated', payload: { reason: 'logout' } })
  })

  it('encodeFrame：sessionId/runId 存在时原样进 data', () => {
    const wire = encodeFrame(9, {
      type: 'text.delta',
      sessionId: 'sess-1',
      runId: 'run-1',
      payload: { delta: '你好' },
    })
    const parsed = JSON.parse(/^data: (.+)$/m.exec(wire)![1])
    expect(parsed).toEqual({
      type: 'text.delta',
      sessionId: 'sess-1',
      runId: 'run-1',
      payload: { delta: '你好' },
    })
  })

  it('encodePing：SSE 注释帧 :ping（双换行收尾，无 id/event/data）', () => {
    expect(encodePing()).toBe(':ping\n\n')
  })
})

describe('Last-Event-ID 解析（输入 0 信任：非法值一律视为无）', () => {
  it('非负整数字符串 → 数值', () => {
    expect(parseLastEventId('42')).toBe(42)
    expect(parseLastEventId('0')).toBe(0)
  })

  it('undefined / 空串 / 非数值 / 负数 / 小数 → null（不回溯、不抛错）', () => {
    expect(parseLastEventId(undefined)).toBeNull()
    expect(parseLastEventId('')).toBeNull()
    expect(parseLastEventId('abc')).toBeNull()
    expect(parseLastEventId('-1')).toBeNull()
    expect(parseLastEventId('1.5')).toBeNull()
    expect(parseLastEventId(' 12')).toBeNull()
    expect(parseLastEventId('12 ')).toBeNull()
    expect(parseLastEventId('999999999999999999999999')).toBeNull() // 超 Number.MAX_SAFE_INTEGER
  })
})

describe('gap 检测（只检测不重放，#726：无缓冲可重放）', () => {
  it('lastSeen < serverSeq → gap（断线期间有事件发布）', () => {
    expect(detectGap(5, 7)).toBe('gap')
  })

  it('lastSeen === serverSeq → contiguous（无缝衔接）', () => {
    expect(detectGap(7, 7)).toBe('contiguous')
  })

  it('lastSeen > serverSeq → gap（serverSeq 回退 = 重启/换实例，状态不可信）', () => {
    expect(detectGap(100, 3)).toBe('gap')
  })

  it('无 lastSeen（首连/新标签页）→ fresh（客户端无线索，走常规投影加载）', () => {
    expect(detectGap(null, 3)).toBe('fresh')
    expect(detectGap(null, 0)).toBe('fresh')
  })
})

describe('流内去重（seq 单调前提下的幂等消费）', () => {
  it('seq ≤ lastApplied → 重复帧（丢弃）', () => {
    expect(isDuplicateInStream(5, 5)).toBe(true)
    expect(isDuplicateInStream(4, 5)).toBe(true)
  })

  it('seq > lastApplied → 新帧（应用并推进游标）', () => {
    expect(isDuplicateInStream(6, 5)).toBe(false)
  })
})

describe('协议常量静态锁定（AC③：心跳 20s 钉住生产值）', () => {
  it('HEARTBEAT_MS = 20_000（#747 C 节锁；测试注入缩短不改默认值来源）', () => {
    expect(HEARTBEAT_MS).toBe(20_000)
  })

  it('SSE_PROTOCOL_V = 1（stream.opened.protocolV 协议版本）', () => {
    expect(SSE_PROTOCOL_V).toBe(1)
  })
})
