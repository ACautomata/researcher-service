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
    })
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    for (const s of sockets) s.destroy()
    sockets.clear()
    await q.close().catch(() => {})
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
