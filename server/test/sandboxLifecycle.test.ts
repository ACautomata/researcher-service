// SandboxLifecycle 单测（#776 · S2「编排器 Port 延伸」：注入 FakeSandboxRuntime + 假时钟）。
// 验收面：惰性创建幂等（running 不重建 / stopped 复启文件保留）、闲置 30min 自动 stop、
// 删 session 级联删（容器 + 网络）、per-session 并发 ensure 单次落地、sweeper daemon
// 故障容忍、未知沙箱（控制面重启）grace 基线。

import { describe, it, expect } from 'vitest'
import { SandboxLifecycle } from '../src/sandboxes/lifecycle'
import { FakeSandboxRuntime } from './fakeSandboxRuntime'
import { SANDBOX_LIMITS } from '../src/sandboxes/values'

// 假时钟：可推进的毫秒值
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

function makeLifecycle(opts: { idleMs?: number } = {}) {
  const clock = makeClock()
  const runtime = new FakeSandboxRuntime()
  const lifecycle = new SandboxLifecycle(runtime, {
    image: 'busybox:1.36',
    now: clock.now,
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
  })
  return { clock, runtime, lifecycle }
}

const SESSION = 'csession0001'

describe('惰性创建（story 58 · #766 D5）', () => {
  it('不存在 → create（网络 + 容器 + start）并返回 running 快照', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    const info = await lifecycle.ensure(SESSION)
    expect(info).toMatchObject({ sessionId: SESSION, running: true, image: 'busybox:1.36' })
    expect(runtime.containers.has(SESSION)).toBe(true)
    expect(runtime.networks.has(SESSION)).toBe(true)
    // 时序：先网络后容器后启动（容器建在网络上）
    expect(runtime.calls.map((c) => c.kind)).toEqual(['createNetwork', 'createSandbox', 'startSandbox'])
  })

  it('spec 透传：镜像 + limits（缺省规格初值 / 覆盖值生效）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(SESSION)
    expect(runtime.containers.get(SESSION)?.spec).toMatchObject({
      sessionId: SESSION,
      image: 'busybox:1.36',
      limits: SANDBOX_LIMITS,
    })
    const rt2 = new FakeSandboxRuntime()
    const lc2 = new SandboxLifecycle(rt2, {
      image: 'img:test',
      limits: { memoryBytes: 1, nanoCpus: 2, pidsLimit: 3 },
    })
    await lc2.ensure('csession0002')
    expect(rt2.containers.get('csession0002')?.spec.limits).toEqual({ memoryBytes: 1, nanoCpus: 2, pidsLimit: 3 })
  })

  it('已 running → 幂等返回，不重建不复启', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(SESSION)
    const first = runtime.containers.get(SESSION)!.info.containerId
    runtime.calls.length = 0
    const again = await lifecycle.ensure(SESSION)
    expect(again.containerId).toBe(first)
    expect(runtime.calls).toEqual([]) // 无任何 runtime 调用（get 命中即返）
  })

  it('stopped（闲置回收后/外部 stop）→ 复启，容器不重建（文件保留语义）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(SESSION)
    const first = runtime.containers.get(SESSION)!.info.containerId
    await runtime.stopSandbox(SESSION) // 模拟闲置 stop / 外部 stop
    const info = await lifecycle.ensure(SESSION)
    expect(info.containerId).toBe(first) // 同一容器——可写层 /lab 跨 stop/start 存续
    expect(runtime.calls.at(-1)?.kind).toBe('startSandbox')
  })

  it('并发 ensure 同 session → 单次落地（per-session 串行）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await Promise.all([lifecycle.ensure(SESSION), lifecycle.ensure(SESSION), lifecycle.ensure(SESSION)])
    expect(runtime.calls.filter((c) => c.kind === 'createSandbox')).toHaveLength(1)
  })

  it('create 失败不落活动时间、可重试', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    runtime.failCreateFor.add(SESSION)
    await expect(lifecycle.ensure(SESSION)).rejects.toThrow('simulated sandbox create failure')
    runtime.failCreateFor.delete(SESSION)
    await expect(lifecycle.ensure(SESSION)).resolves.toMatchObject({ running: true })
  })
})

describe('闲置自动 stop（story 58：30 分钟，文件保留）', () => {
  it('最后活动 ≥ 阈值 → stop；未满 → 不动', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 30 * 60 * 1000 })
    await lifecycle.ensure(SESSION)
    clock.advance(29 * 60 * 1000)
    expect(await lifecycle.sweepIdle()).toEqual([])
    expect(runtime.containers.get(SESSION)!.info.running).toBe(true)
    clock.advance(2 * 60 * 1000) // 合计 31min
    expect(await lifecycle.sweepIdle()).toEqual([SESSION])
    expect(runtime.containers.get(SESSION)!.info.running).toBe(false)
    expect(runtime.containers.has(SESSION)).toBe(true) // stop ≠ remove：文件保留
  })

  it('touch 刷新闲置计时', async () => {
    const { clock, lifecycle } = makeLifecycle({ idleMs: 1000 })
    await lifecycle.ensure(SESSION)
    clock.advance(900)
    lifecycle.touch(SESSION)
    clock.advance(900)
    expect(await lifecycle.sweepIdle()).toEqual([])
    clock.advance(200)
    expect(await lifecycle.sweepIdle()).toEqual([SESSION])
  })

  it('ensure 即活动：复启后重新计时', async () => {
    const { clock, lifecycle } = makeLifecycle({ idleMs: 1000 })
    await lifecycle.ensure(SESSION)
    clock.advance(1500)
    await lifecycle.sweepIdle()
    await lifecycle.ensure(SESSION) // 复启 = 新活动
    clock.advance(500)
    expect(await lifecycle.sweepIdle()).toEqual([])
  })

  it('未知沙箱（控制面重启后 daemon 残留 running）→ 以服务启动时刻为闲置基线（grace）', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    // daemon 上已有沙箱（非本进程 ensure——模拟重启前残留）
    await runtime.createNetwork('cold0001')
    await runtime.createSandbox({ sessionId: 'cold0001', image: 'busybox:1.36', limits: SANDBOX_LIMITS })
    await runtime.startSandbox('cold0001')
    clock.advance(500)
    expect(await lifecycle.sweepIdle()).toEqual([]) // 未满阈值（boot 基线）
    clock.advance(600)
    expect(await lifecycle.sweepIdle()).toEqual(['cold0001'])
  })

  it('已停沙箱不重复 stop（OOM 后 exited / 已回收）', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    await lifecycle.ensure(SESSION)
    await runtime.stopSandbox(SESSION)
    clock.advance(5000)
    runtime.calls.length = 0
    expect(await lifecycle.sweepIdle()).toEqual([])
    expect(runtime.calls.filter((c) => c.kind === 'stopSandbox')).toHaveLength(0)
  })

  it('sweeper 周期回调内 daemon 故障被吞（不炸进程，下轮重试）', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    await lifecycle.ensure(SESSION)
    runtime.failList = true
    clock.advance(5000)
    // sweeper 的 catch 由 startIdleSweeper 包装；sweepIdle 本体如实抛（调用方决策）
    await expect(lifecycle.sweepIdle()).rejects.toThrow('simulated daemon unreachable')
    const stop = lifecycle.startIdleSweeper(10)
    await new Promise((r) => setTimeout(r, 30)) // 故障轮不抛出未处理 rejection 即通过
    stop()
  })
})

describe('删 session 级联删（story 58：容器 + 独立网络）', () => {
  it('存在 → 容器与网络都删、活动记录清除', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(SESSION)
    expect(await lifecycle.remove(SESSION)).toBe('removed')
    expect(runtime.containers.has(SESSION)).toBe(false)
    expect(runtime.networks.has(SESSION)).toBe(false)
    expect(runtime.removedNetworks).toEqual([SESSION])
  })

  it('不存在 → not-found 幂等；残留网络仍清（外部删容器不删网络的泄漏面）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    expect(await lifecycle.remove(SESSION)).toBe('not-found')
    runtime.networks.add(SESSION) // 模拟容器已外部删、网络残留
    expect(await lifecycle.remove(SESSION)).toBe('not-found')
    expect(runtime.removedNetworks).toEqual([SESSION, SESSION])
  })

  it('remove 后再 ensure → 全新容器（新代系）', async () => {
    const { lifecycle } = makeLifecycle()
    const first = await lifecycle.ensure(SESSION)
    await lifecycle.remove(SESSION)
    const second = await lifecycle.ensure(SESSION)
    expect(second.containerId).not.toBe(first.containerId)
  })

  it('remove 与 ensure 同 session 串行（排队执行，不交错）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(SESSION)
    const [rm, en] = await Promise.all([lifecycle.remove(SESSION), lifecycle.ensure(SESSION)])
    // 串行后终态确定：要么先删后建（新容器在），要么先建后删（不在）——不应有半态
    expect(rm).toBe('removed')
    expect(en.running).toBe(true)
    expect(runtime.containers.has(SESSION)).toBe(true)
  })
})

describe('fork 沙箱（#781 · #768 D7：源字面复制 / 源删空起步 / 故障传播）', () => {
  const TARGET = 'csession-fork-1'

  it('源存在 → copied：目标容器落位（forkedFrom 记录）、网络 + start 时序、规格透传', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(SESSION)
    expect(await lifecycle.forkSandbox(SESSION, TARGET)).toBe('copied')
    expect(runtime.forkedFrom.get(TARGET)).toBe(SESSION)
    expect(runtime.containers.get(TARGET)?.info).toMatchObject({ running: true, image: 'busybox:1.36' })
    expect(runtime.calls.filter((c) => c.sessionId === TARGET).map((c) => c.kind)).toEqual([
      'createNetwork',
      'createSandboxFromSource',
      'startSandbox',
    ])
  })

  it('源已删 → source-missing：目标空起步（常规 create 兜底 + start）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    expect(await lifecycle.forkSandbox('csession-gone', TARGET)).toBe('source-missing')
    expect(runtime.forkedFrom.has(TARGET)).toBe(false)
    expect(runtime.containers.has(TARGET)).toBe(true) // 空容器已建（/lab 空树语义在 runtime 侧）
    expect(runtime.calls.filter((c) => c.sessionId === TARGET).map((c) => c.kind)).toEqual([
      'createNetwork',
      'createSandboxFromSource',
      'createSandbox',
      'startSandbox',
    ])
  })

  it('复制原语故障 → 抛错上传播（调用方 fork 补偿面），目标容器不落位', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(SESSION)
    runtime.failForkFor.add(TARGET)
    await expect(lifecycle.forkSandbox(SESSION, TARGET)).rejects.toThrow(/fork failure/)
    expect(runtime.containers.has(TARGET)).toBe(false)
  })
})

describe('独立网络地址池回收（生产事故：每沙箱占一整个 /16|/20，daemon 默认池耗尽）', () => {
  // 事故面：闲置只 stop 不删网络 → 22 个已停沙箱占满默认地址池 → 新会话 createNetwork 报
  // "could not find an available, non-overlapping IPv4 address pool among the defaults"。
  // 回收的另一半约束：网络可删 ≠ 可直接删——stopped 复启必须先重建，否则改报 network not found。

  it('闲置 stop 同时释放独立网络；容器保留（文件不丢）', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    await lifecycle.ensure(SESSION)
    clock.advance(1500)
    expect(await lifecycle.sweepIdle()).toEqual([SESSION])
    expect(runtime.networks.has(SESSION)).toBe(false)
    expect(runtime.containers.has(SESSION)).toBe(true) // stop ≠ remove：可写层 /lab 保留
  })

  it('回收后 ensure 复启：先重建网络再 start，容器不重建（文件保留语义不回归）', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    const first = (await lifecycle.ensure(SESSION)).containerId
    clock.advance(1500)
    await lifecycle.sweepIdle()
    // 旧实现此处抛 network not found（fake 镜像 daemon start 语义）
    const info = await lifecycle.ensure(SESSION)
    expect(info.containerId).toBe(first)
    expect(info.running).toBe(true)
    expect(runtime.networks.has(SESSION)).toBe(true)
  })

  it('存量已停沙箱（部署前闲置残留 / OOM exited）→ sweep 回收其网络，不重复 stop', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    await lifecycle.ensure(SESSION)
    await runtime.stopSandbox(SESSION) // 模拟部署前已 stop、网络仍占池
    clock.advance(5000)
    runtime.calls.length = 0
    expect(await lifecycle.sweepIdle()).toEqual([])
    expect(runtime.calls.filter((c) => c.kind === 'stopSandbox')).toHaveLength(0)
    expect(runtime.networks.has(SESSION)).toBe(false)
  })

  it('已回收沙箱不被每轮重复 DELETE；复启后可再次回收', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    await lifecycle.ensure(SESSION)
    clock.advance(1500)
    await lifecycle.sweepIdle()
    runtime.calls.length = 0
    clock.advance(1500)
    await lifecycle.sweepIdle()
    expect(runtime.calls.filter((c) => c.kind === 'removeNetwork')).toHaveLength(0)
    await lifecycle.ensure(SESSION) // 复启重建 → 回收标记须失效
    clock.advance(1500)
    await lifecycle.sweepIdle()
    expect(runtime.networks.has(SESSION)).toBe(false)
  })

  it('单沙箱删网失败不阻断本轮其余回收，下轮重试', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    const OTHER = 'csession0002'
    await lifecycle.ensure(SESSION)
    await lifecycle.ensure(OTHER)
    clock.advance(1500)
    runtime.failRemoveNetworkFor.add(SESSION)
    expect((await lifecycle.sweepIdle()).sort()).toEqual([SESSION, OTHER].sort())
    expect(runtime.networks.has(SESSION)).toBe(true) // 失败：保留待重试，不吞成成功
    expect(runtime.networks.has(OTHER)).toBe(false)
    runtime.failRemoveNetworkFor.delete(SESSION)
    await lifecycle.sweepIdle()
    expect(runtime.networks.has(SESSION)).toBe(false)
  })

  it('复启与 sweep 并发：终态 running 且网络在（不被陈旧快照删网）', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    await lifecycle.ensure(SESSION)
    clock.advance(1500)
    await lifecycle.sweepIdle() // 停 + 删网
    const [info] = await Promise.all([lifecycle.ensure(SESSION), lifecycle.sweepIdle()])
    expect(info.running).toBe(true)
    expect(runtime.networks.has(SESSION)).toBe(true)
    expect(runtime.containers.get(SESSION)!.info.running).toBe(true)
  })

  it('sweep 期间被 remove 的沙箱：不再报网络操作，标记作废', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    await lifecycle.ensure(SESSION)
    clock.advance(1500)
    await lifecycle.sweepIdle()
    await lifecycle.remove(SESSION)
    expect(await lifecycle.sweepIdle()).toEqual([]) // list 已不含它 → 完全无处置
    expect(runtime.networks.has(SESSION)).toBe(false)
  })

  it('running 且未闲置的沙箱：网络不动', async () => {
    const { clock, runtime, lifecycle } = makeLifecycle({ idleMs: 1000 })
    await lifecycle.ensure(SESSION)
    clock.advance(500)
    expect(await lifecycle.sweepIdle()).toEqual([])
    expect(runtime.networks.has(SESSION)).toBe(true)
  })
})
