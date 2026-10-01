import { describe, it, expect } from 'vitest'
import { StreamHub, type StreamSink } from '../src/events/hub'
import { encodeFrame, type CatalogEvent } from '../src/events/logic'
import { parseSseFrame } from './helpers'

// 接缝 S3（纯逻辑，issue #773）：StreamHub 连接注册表 + per-user 连续单调 serverSeq
// 分配（#726「per-session 连续单调」语义）+ per-user 扇出 + terminate（session.terminated
// 后关连接）。StreamSink 为 Port：hub 只面向接口，express Response 适配在路由层
// （wiki Port 先例）。

function fakeSink() {
  const frames: string[] = []
  let closed = false
  const sink: StreamSink = {
    send: (wire: string) => {
      frames.push(wire)
      return true
    },
    close: () => {
      closed = true
    },
  }
  return { sink, frames, isClosed: () => closed }
}

const frameId = (wire: string): number => Number(parseSseFrame(wire).id)

const evt = (type: string, payload: unknown): CatalogEvent => ({ type, payload })

describe('StreamHub（事件扇出注册表）', () => {
  it('publish：分配 per-user 连续单调 seq，帧 id 严格递增', () => {
    const hub = new StreamHub()
    const a = fakeSink()
    const b = fakeSink()
    hub.register('user-1', a.sink)
    hub.register('user-1', b.sink)
    hub.publish('user-1', evt('run.started', { turn: 1 }))
    hub.publish('user-1', evt('text.delta', { delta: 'x' }))
    const idsA = a.frames.map(frameId)
    const idsB = b.frames.map(frameId)
    expect(idsA).toEqual([1, 2])
    expect(idsB).toEqual([1, 2]) // 同事件同 seq（多端广播语义）
  })

  it('publish：各 user 独立编号，互不占号（#726 per-session 连续单调）', () => {
    const hub = new StreamHub()
    const a = fakeSink()
    const b = fakeSink()
    hub.register('user-1', a.sink)
    hub.register('user-2', b.sink)
    hub.publish('user-1', evt('text.delta', { delta: '1st' }))
    hub.publish('user-1', evt('text.delta', { delta: '2nd' }))
    hub.publish('user-2', evt('text.delta', { delta: 'x' }))
    expect(a.frames.map(frameId)).toEqual([1, 2]) // user-1 视角连续
    expect(b.frames.map(frameId)).toEqual([1]) // user-2 首事件仍是 id 1，不被 user-1 占号
  })

  it('publish：只扇出目标 user 的连接（隔离性）', () => {
    const hub = new StreamHub()
    const mine = fakeSink()
    const other = fakeSink()
    hub.register('user-1', mine.sink)
    hub.register('user-2', other.sink)
    hub.publish('user-1', evt('text.delta', { delta: 'hi' }))
    expect(mine.frames).toHaveLength(1)
    expect(other.frames).toHaveLength(0)
  })

  it('publish：未注册 user 无连接 → 静默成功（事件即焚，无缓冲可重放）', () => {
    const hub = new StreamHub()
    expect(() => hub.publish('nobody', evt('text.delta', { delta: 'x' }))).not.toThrow()
    expect(hub.currentSeq('nobody')).toBe(1) // 该 user 游标仍推进（gap 检测靠它）
    expect(hub.currentSeq('user-1')).toBe(0) // 互不占号
  })

  it('unregister 后不再扇出', () => {
    const hub = new StreamHub()
    const a = fakeSink()
    hub.register('user-1', a.sink)
    hub.unregister('user-1', a.sink)
    hub.publish('user-1', evt('text.delta', { delta: 'x' }))
    expect(a.frames).toHaveLength(0)
  })

  it('terminate：广播 session.terminated{reason} 后关闭该 user 全部连接并注销', () => {
    const hub = new StreamHub()
    const a = fakeSink()
    const b = fakeSink()
    const other = fakeSink()
    hub.register('user-1', a.sink)
    hub.register('user-1', b.sink)
    hub.register('user-2', other.sink)
    hub.terminate('user-1', 'revoked')
    for (const f of a.frames) {
      const parsed = parseSseFrame(f)
      expect(parsed.event).toBe('session.terminated')
      expect(parsed.data).toMatchObject({ type: 'session.terminated', payload: { reason: 'revoked' } })
    }
    expect(a.isClosed()).toBe(true)
    expect(b.isClosed()).toBe(true)
    expect(other.isClosed()).toBe(false) // 其他 user 不受影响
    expect(other.frames).toHaveLength(0)
    // 已注销：后续 publish 不再送达
    hub.publish('user-1', evt('text.delta', { delta: 'x' }))
    expect(a.frames.filter((f) => f.includes('text.delta'))).toHaveLength(0)
  })

  it('terminate 帧本身占用一个 seq（serverSeq 游标对客户端连续）', () => {
    const hub = new StreamHub()
    const a = fakeSink()
    hub.register('user-1', a.sink)
    hub.terminate('user-1', 'logout')
    expect(hub.currentSeq('user-1')).toBe(1)
    expect(hub.currentSeq('user-2')).toBe(0)
  })

  it('frames 内容经 encodeFrame 线格式（hub 不另造编码路径）', () => {
    const hub = new StreamHub()
    const a = fakeSink()
    hub.register('u', a.sink)
    hub.publish('u', evt('error', { code: 50002 }))
    expect(a.frames[0]).toBe(encodeFrame(1, evt('error', { code: 50002 })))
  })
})
