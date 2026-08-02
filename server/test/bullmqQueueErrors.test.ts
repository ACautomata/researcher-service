// BullMqLifecycleQueue error listener 注册校验（Codex C7）。
// Worker/Queue/IORedis connection 均为 EventEmitter；Redis 断连 / 协议错误 / 命令失败会 emit('error')。
// Node 规则：EventEmitter 的 'error' 事件无 listener 即抛 uncaughtException → 整个 API 进程崩溃
// （一次 Redis 抖动即致命）。此测试验证三者构造期都注册了 error listener，且 onError 钩子实际被调用。
//
// 不依赖真 Redis：本地 TCP 占位（accept 但不响应 Redis 协议）让 ioredis 握手挂起、不立即 emit error，
// 使构造期同步断言 listenerCount 不被网络时序干扰；单实例共享避免 BullMQ worker.close() 多次卡顿。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net, { type AddressInfo, type Socket } from 'node:net'
import { BullMqLifecycleQueue } from '../src/containers/bullmqQueue'

describe('BullMqLifecycleQueue error listener (Codex C7)', () => {
  const sockets = new Set<Socket>()
  let placeholder!: net.Server
  let q!: BullMqLifecycleQueue
  const errors: Error[] = []

  beforeAll(() => {
    placeholder = net.createServer((sock) => {
      sockets.add(sock)
      sock.on('close', () => sockets.delete(sock))
    }).listen(0)
    const port = (placeholder.address() as AddressInfo).port
    q = new BullMqLifecycleQueue({
      redisUrl: `redis://127.0.0.1:${port}`,
      concurrency: 1,
      queueName: `err-test-${port}`,
      onError: (e) => errors.push(e),
      workerCloseTimeoutMs: 500, // 占位 TCP 上 worker.close 挂起，小 timeout 防 afterAll 超 hookTimeout
    })
  })

  afterAll(async () => {
    // 先销毁占位 socket，让 ioredis 连接立即 reset（避免 worker.close 卡在握手挂起的 connection）。
    for (const s of sockets) s.destroy()
    sockets.clear()
    q.connection.disconnect() // 先断 ioredis
    q.worker.close().catch(() => {}) // detach：占位 TCP 上 backend.close 挂，await 致 hookTimeout；vitest 进程退出回收 stalled timer
    await new Promise<void>((r) => placeholder.close(() => r()))
  })

  it('worker 注册了 error listener（修前 listenerCount=0 → Redis 抖动即崩进程）', () => {
    expect(q.worker.listenerCount('error')).toBeGreaterThan(0)
  })

  it('queue 注册了 error listener', () => {
    expect(q.queue.listenerCount('error')).toBeGreaterThan(0)
  })

  it('connection 注册了 error listener', () => {
    expect(q.connection.listenerCount('error')).toBeGreaterThan(0)
  })

  it('onError 钩子收到 worker emit 的 error（接线断言，不依赖网络时序）', () => {
    const before = errors.length
    q.worker.emit('error', new Error('simulated worker error'))
    expect(errors.slice(before).some((e) => e.message === 'simulated worker error')).toBe(true)
  })

  it('connection emit error 时 onError 被调用（模拟 Redis 断连）', () => {
    const before = errors.length
    q.connection.emit('error', new Error('ECONNRESET'))
    expect(errors.slice(before).some((e) => e.message === 'ECONNRESET')).toBe(true)
  })
})

// ---- #3 shutdown 未 await worker（Codex 第七轮 P2）----
// bullmqQueue.ts close() 的 worker.close() 不 await（detach，原意防坏 Redis 上 worker.close 挂死须 SIGKILL）。
// 但 fleet.close() resolve 后 server.close() 即可 process.exit(0)，中断仍在跑的生命周期 job——每次滚动
// 重启都丢在跑 provisioning/deletion（非仅 Redis 故障路径）。修法：await worker.close，套有界超时兜底，
// 兼顾 drain 与防卡死。验证 close() 是否真的等 worker.close settle。
describe('#3 shutdown await worker (Codex 第七轮 P2)', () => {
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
      queueName: `r7-close-${port}`,
    })
  })
  afterAll(async () => {
    for (const s of sockets) s.destroy()
    sockets.clear()
    q.connection.disconnect()
    q.worker.close().catch(() => {}) // detach：占位 TCP 上 backend.close 挂，await 致 hookTimeout；vitest 进程退出回收 stalled timer
    await new Promise<void>((r) => placeholder.close(() => r()))
  })

  it('close() await worker.close（修前 detach 致 process.exit 中断在跑 job）', async () => {
    let releaseWorkerClose!: () => void
    const gate = new Promise<void>((r) => {
      releaseWorkerClose = r
    })
    const queueCloseSpy = vi.spyOn(q.queue, 'close').mockResolvedValue(undefined as never)
    const workerCloseSpy = vi.spyOn(q.worker, 'close').mockReturnValue(gate as never)

    const closeP = q.close()
    const verdict = await Promise.race([
      closeP.then(
        () => 'closed' as const,
        () => 'rejected' as const,
      ),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 100)),
    ])
    // 修前：worker.close detach → closeP 立即 resolve → 'closed'（process.exit 中断在跑 job）。
    // 修后：await worker.close（有界超时兜底）→ closeP 等 worker.close → 'pending'。
    expect(verdict).toBe('pending')

    releaseWorkerClose() // 放行 worker.close，让 closeP 收尾防 afterAll 卡
    await closeP.catch(() => {})
    queueCloseSpy.mockRestore()
    workerCloseSpy.mockRestore() // 恢复真实 worker.close，供 afterAll 停 stalled timer
  })
})
