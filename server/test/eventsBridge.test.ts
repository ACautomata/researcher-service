import { describe, it, expect } from 'vitest'
import { buildStreamEventsInvocation } from '../src/events/bridge'

// 接缝 S3（纯逻辑，issue #773）：streamEvents 调用参数基座。
// version+configurable 必须同一参数对象（PoC 坑 2，resume 时参数不同会静默 no-op 假
// done——#747 A 节生产硬约束）。v2 经典形态翻译（#773 骨架期产物）用例已随其实现物理
// 删除（#747 R1 Standards④：#777 实测 v3 后生产零消费，退役票 #801 已落地）。

describe('streamEvents 调用参数（PoC 坑 2 锁定）', () => {
  it('version + configurable 同一参数对象，构造一次 resume 复用（version v3：#777 实测修正）', () => {
    const params = buildStreamEventsInvocation('thread-1')
    expect(params.version).toBe('v3')
    expect(params.configurable).toEqual({ thread_id: 'thread-1' })
    // 同一对象引用（非深拷贝等价）——resume/首次调用必须传同一引用语义，
    // 防「重新构造一个相等但不同源的对象」在后续演进中漂移。
    const again = buildStreamEventsInvocation('thread-1')
    expect(again).not.toBe(params)
    expect(again).toEqual(params)
  })

  it('参数对象冻结（调用方不能就地改 configurable）', () => {
    const params = buildStreamEventsInvocation('thread-1')
    expect(Object.isFrozen(params)).toBe(true)
    expect(Object.isFrozen(params.configurable)).toBe(true)
  })
})
