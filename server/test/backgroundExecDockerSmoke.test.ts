import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import Docker from 'dockerode'
import { createHash, randomUUID } from 'node:crypto'
import { DockerBackgroundRuntime, type ProcessSpec, type ProcessSnapshot } from '../src/runner/background/dockerRuntime'
import { probeDockerAvailable } from './smokeGating'
import { ensureImageAvailable } from './smokeDocker'
import { waitFor } from './helpers'

const available = probeDockerAvailable()
describe.skipIf(!available)('background exec real Docker process lifecycle', () => {
  const docker = new Docker()
  const container = `researcher-background-smoke-${process.pid}`
  let runtime: DockerBackgroundRuntime
  beforeAll(async () => {
    if (!available) return
    await ensureImageAvailable('busybox:1.36')
    const c = await docker.createContainer({ name: container, Image: 'busybox:1.36', Cmd: ['sleep', '3600'] })
    await c.start()
    runtime = new DockerBackgroundRuntime(docker)
  }, 120000)
  afterAll(async () => {
    if (available) await docker.getContainer(container).remove({ force: true })
  })
  function spec(command: string, hardTimeoutMs = 10000): ProcessSpec {
    return { id: createHash('sha256').update(randomUUID()).digest('hex'), container, command, hardTimeoutMs, logBytes: 4096 }
  }
  async function terminal(task: ProcessSpec): Promise<ProcessSnapshot> {
    let result: ProcessSnapshot
    await waitFor(async () => {
      result = await runtime.read(task)
      return result.state !== 'running' && result.state !== 'interrupted'
    }, 15000, 50)
    return result!
  }
  it('survives controller replacement, fences repeated launch, and bounds both streams', async () => {
    const task = spec('echo marker; sleep 1; yes x | head -c 10000; echo diagnostic >&2')
    await runtime.start(task)
    runtime = new DockerBackgroundRuntime(docker)
    await runtime.start(task)
    const result = await terminal(task)
    expect(result).toMatchObject({ state: 'succeeded', exitCode: 0, truncated: true, stderr: 'diagnostic\n' })
    expect(Buffer.byteLength(result.stdout)).toBe(2048)
    expect(result.stdout.match(/marker/g)).toHaveLength(1)
  }, 20000)
  it('kills a command process group on hard timeout', async () => {
    const task = spec('sleep 600 & wait', 1000)
    await runtime.start(task)
    expect((await terminal(task)).state).toBe('timed_out')
  }, 20000)
  it('cancels without restarting and detects a sandbox restart', async () => {
    const task = spec('sleep 600 & wait')
    await runtime.start(task)
    await waitFor(async () => (await runtime.read(task)).state === 'running')
    await runtime.cancel(task)
    expect((await terminal(task)).state).toBe('cancelled')
    const lost = spec('sleep 600')
    await runtime.start(lost)
    await waitFor(async () => (await runtime.read(lost)).state === 'running')
    await docker.getContainer(container).restart({ t: 0 })
    expect((await runtime.read(lost)).state).toBe('interrupted')
  }, 20000)
})
