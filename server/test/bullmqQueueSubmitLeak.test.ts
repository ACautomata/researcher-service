// BullMqLifecycleQueue submit 入队失败清理（Codex 第六轮 P2）。
//
// submit 先把 task 写 tasks、把 {resolve,reject} 写 pending，再 await queue.add。生产下若 queue.add
// reject（Redis ACL / 只读 / 命令错误），worker 永不消费此 job，completed/failed listener 不会触发——
// 两表条目无人清理：持续 Redis 故障下每次 submit 泄漏一对条目，tasks/pending 无限增长。修复：add
// 失败时删除两表条目再 rethrow（caller 的 await 经此 reject 感知失败）。
//
// 复用 bullmqQueueErrors.test.ts 的占位 TCP 模式：不依赖真 Redis；submit 只走被 spy 的 queue.add。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net, { type AddressInfo, type Socket } from 'node:net'
import { BullMqLifecycleQueue } from '../src/containers/bullmqQueue'

describe('BullMqLifecycleQueue submit 入队失败清理 (Codex 第六轮 P2)', () => {
  const sockets = new Set<Socket>()
  let placeholder!: net.Server
  let q!: BullMqLifecycleQueue

  beforeAll(() => {
    placeholder = net.createServer((sock) => {
      sockets.add(sock)
      sock.on('close', () => sockets.delete(sock))
    }).listen(0)
    const port = (placeholder.address() as AddressInfo).port
    q = new BullMqLifecycleQueue({
      redisUrl: `redis://127.0.0.1:${port}`,
      concurrency: 1,
      queueName: `submit-leak-${port}`,
      workerCloseTimeoutMs: 500, // 占位 TCP 上 worker.close 挂起，小 timeout 防 afterAll 超 hookTimeout
    })
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    for (const s of sockets) s.destroy()
    sockets.clear()
    q.connection.disconnect()
    q.worker.close().catch(() => {}) // detach：占位 TCP 上 backend.close 挂，await 致 hookTimeout；vitest 进程退出回收 stalled timer
    await new Promise<void>((r) => placeholder.close(() => r()))
  })

  it('queue.add reject → tasks/pending 清理（修前两表残留，持续故障下无限增长）', async () => {
    // 入队前两表为空
    expect(q.tasks.size).toBe(0)
    expect(q.pending.size).toBe(0)
    // 模拟 Redis ACL / 只读：queue.add 直接 reject，task 永不被 worker 消费。
    vi.spyOn(q.queue, 'add').mockRejectedValue(new Error('simulated Redis ACL / read-only'))
    await expect(q.submit(async () => {})).rejects.toThrow(/Redis ACL/)
    // 修前：两表各残留 1 条（泄漏）；修后：清理为 0。
    expect(q.tasks.size).toBe(0)
    expect(q.pending.size).toBe(0)
  })
})

// ---- #1 BullMQ producer 提交无有限 Redis 重试预算（Codex 第七轮 P1）----
// bullmqQueue.ts:40 connection 的 maxRetriesPerRequest:null（为 worker 崩溃重连而设）被 Queue
// （producer）共享。Redis 不可达时 producer 的 queue.add() 不 reject 而永久 pending → submit 永挂 →
// detached create 的 name lease 永不释放、行卡 creating；后续 DELETE 排在同 name serializer 链后
// 无法清理。复现：连占位 TCP（接受连接但不讲 Redis 协议），断言 submit 在有限时间内未 settle。
describe('#1 BullMQ producer 提交无有限重试预算 (Codex 第七轮 P1)', () => {
  const sockets = new Set<Socket>()
  let placeholder!: net.Server
  let q!: BullMqLifecycleQueue

  beforeAll(() => {
    placeholder = net
      .createServer((s) => {
        sockets.add(s)
        s.on('close', () => sockets.delete(s))
      })
      .listen(0)
    const port = (placeholder.address() as AddressInfo).port
    q = new BullMqLifecycleQueue({
      redisUrl: `redis://127.0.0.1:${port}`,
      concurrency: 1,
      queueName: `r7-retry-${port}`,
      addTimeoutMs: 200, // 快速复现：超时兜底触发（修前永挂）
      workerCloseTimeoutMs: 500, // 占位 TCP 上 worker.close 挂起，小 timeout 防 afterAll 超 hookTimeout
    })
  })
  afterAll(async () => {
    for (const s of sockets) s.destroy()
    sockets.clear()
    q.connection.disconnect()
    q.worker.close().catch(() => {}) // detach：占位 TCP 上 backend.close 挂，await 致 hookTimeout；vitest 进程退出回收 stalled timer
    await new Promise<void>((r) => placeholder.close(() => r()))
  })

  it('Redis 不可达 → submit 在有限时间内失败（修前永挂致 lease/行卡死）', async () => {
    const submitP = q.submit(async () => {})
    const verdict = await Promise.race([
      submitP.then(
        () => 'settled' as const,
        () => 'rejected' as const,
      ),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 1500)),
    ])
    // 修前：maxRetriesPerRequest:null 致 queue.add 永挂 → 1.5s 后仍 pending（红）。
    // 修后：addTimeoutMs 兜底 → 200ms 内 reject → submit reject（绿）。
    expect(verdict).not.toBe('pending')
    // 超时后两表清理（不泄漏，对齐第六轮 submit-leak 兜底）。
    expect(q.tasks.size).toBe(0)
    expect(q.pending.size).toBe(0)
  })
})
