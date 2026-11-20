import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest from 'supertest'
import { AIMessage } from '@langchain/core/messages'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { BackgroundExecService, resultMessageId } from '../src/runner/background/service'
import type { BackgroundRuntime, ProcessSnapshot, ProcessSpec } from '../src/runner/background/dockerRuntime'
import { RunService, type RunCommand } from '../src/runner/runtime/runService'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { ScriptedChatModel, fakePrimitives, toolCallAi, type ScriptEntry } from './runnerFakes'
import { seedUser, waitFor } from './helpers'
import { createApp } from '../src/app'
import { SessionService } from '../src/sessions/service'
import { signAccessToken } from '../src/auth/tokens'

class FakeRuntime implements BackgroundRuntime {
  processes = new Map<string, ProcessSnapshot>()
  starts: string[] = []
  immediate = false
  async start(spec: ProcessSpec) {
    this.starts.push(spec.id)
    if (!this.processes.has(spec.id)) this.processes.set(spec.id, {
      state: this.immediate ? 'succeeded' : 'running', stdout: 'partial', stderr: '', exitCode: this.immediate ? 0 : null, truncated: false,
    })
  }
  async read(spec: ProcessSpec) { return this.processes.get(spec.id)! }
  async cancel(spec: ProcessSpec) {
    this.processes.set(spec.id, { state: 'cancelled', stdout: '', stderr: '', exitCode: 137, truncated: false })
  }
  finish(id: string, state: ProcessSnapshot['state'] = 'succeeded') {
    this.processes.set(id, { state, stdout: 'finished result', stderr: 'diagnostic', exitCode: state === 'succeeded' ? 0 : 124, truncated: false })
  }
}

describe('durable background exec', () => {
  let prisma: PrismaClient, runtime: FakeRuntime, jobs: BackgroundExecService, cmd: RunCommand
  let runner: RunService | undefined
  const hub = { publish: vi.fn() }
  const settings = { foregroundMs: 30, hardTimeoutMs: 86400000, logBytes: 20 * 1024 * 1024, maxActive: 4, pollMs: 5 }
  beforeEach(async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'background-exec-')), 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma/init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma)
    const session = await prisma.session.create({ data: { ownerId: user.id, containerId: 'lab', title: 'test' } })
    cmd = { ownerId: user.id, username: user.username, sessionId: session.id, runId: 'original-run', kind: 'message', content: 'execute' }
    runtime = new FakeRuntime()
    jobs = new BackgroundExecService(prisma, runtime, settings, hub)
    hub.publish.mockClear()
  })
  afterEach(async () => { jobs.close(); runner?.dispose(); runner = undefined; await prisma.$disconnect() })

  function makeRunner(script: ScriptEntry[], interrupt = false) {
    const model = new ScriptedChatModel(script)
    const saver = new PrismaCheckpointSaver(prisma)
    runner = new RunService({ prisma, background: jobs, saver, hub,
      registry: new ProviderRegistry(prisma, { llmApiKey: 'test-key', modelFactory: async () => model }),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      primitives: fakePrimitives().primitives, resolveWikiContainer: () => 'wiki',
      ...(interrupt ? { interruptPolicyFor: () => ({ tools: ['execute'] }) } : {}),
    })
    return { service: runner, model, saver }
  }

  it('returns synchronous results without a background notification and replays without relaunching', async () => {
    runtime.immediate = true
    expect(JSON.parse(await jobs.execute(cmd, 'lab', 'tc', 'echo hi')).state).toBe('succeeded')
    await jobs.execute(cmd, 'lab', 'tc', 'echo hi')
    expect(runtime.starts).toHaveLength(1)
    expect(await jobs.list(cmd.ownerId, cmd.sessionId)).toEqual([])
  })

  it('hands off at the foreground deadline, recovers in a new service and retains both output streams', async () => {
    const response = JSON.parse(await jobs.execute(cmd, 'lab', 'tc', 'sleep 900'))
    expect(response.background).toBe(true)
    expect(await jobs.output(cmd.ownerId, cmd.sessionId, response.taskId)).toMatchObject({ state: 'running', stdout: 'partial' })
    jobs = new BackgroundExecService(prisma, runtime, settings, hub)
    runtime.finish(response.taskId)
    await jobs.tick()
    expect(await jobs.output(cmd.ownerId, cmd.sessionId, response.taskId, 0, 4)).toMatchObject({ stdout: 'fini', stderr: 'diag', nextOffset: 4 })
    expect(runtime.starts).toHaveLength(1)
    expect(await jobs.pending(cmd.sessionId)).toHaveLength(1)
  })

  it('enforces the shared session limit across concurrent starts', async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => jobs.execute(cmd, 'lab', `tc-${i}`, 'sleep 999')))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(4)
    expect(runtime.starts).toHaveLength(4)
  })

  it('cancels leader and teammate work and suppresses late results', async () => {
    await jobs.execute(cmd, 'lab', 'tc', 'sleep 999')
    await jobs.execute({ ...cmd, sessionId: 'child-thread', parentSessionId: cmd.sessionId }, 'lab', 'child-tc', 'sleep 999')
    await jobs.cancel(cmd.ownerId, cmd.sessionId)
    expect((await jobs.list(cmd.ownerId, cmd.sessionId)).every(t => t.state === 'cancelled' && t.delivery === 'suppressed')).toBe(true)
    await jobs.tick()
    expect(await jobs.pending(cmd.sessionId)).toEqual([])
  })

  it.each(['timed_out', 'interrupted', 'failed'] as const)('persists %s as a result to deliver', async (state) => {
    const r = JSON.parse(await jobs.execute(cmd, 'lab', 'tc', 'command'))
    runtime.finish(r.taskId, state)
    if (state === 'interrupted') await prisma.backgroundExec.update({ where: { id: r.taskId }, data: { createdAt: new Date(Date.now() - 11000) } })
    await jobs.tick()
    expect((await jobs.pending(cmd.sessionId))[0]?.state).toBe(state)
  })

  it('continues the ReAct loop immediately, then wakes a completed loop exactly once from persisted results', async () => {
    const { service, model, saver } = makeRunner([
      toolCallAi('tc', 'execute', { command: 'sleep 900' }), new AIMessage('I can do other work.'), new AIMessage('Processed the result.'),
    ])
    await service.execute(cmd)
    expect(service.stateOf(cmd.sessionId)?.state).toBe('completed')
    expect(model.invokeCount).toBe(2)
    const task = (await jobs.list(cmd.ownerId, cmd.sessionId))[0]!
    expect(task).toBeDefined()
    runtime.finish(task.id)
    await jobs.tick()
    await service.wakeBackground(await jobs.pending(cmd.sessionId))
    await waitFor(() => model.invokeCount === 3 && service.stateOf(cmd.sessionId)?.state === 'completed')
    await service.wakeBackground(await jobs.pending(cmd.sessionId))
    expect(model.invokeCount).toBe(3)
    expect(await jobs.pending(cmd.sessionId)).toEqual([])
    const tuple = await saver.getTuple({ configurable: { thread_id: cmd.sessionId } })
    expect(JSON.stringify(tuple?.checkpoint.channel_values.messages)).toContain(resultMessageId(task.id))
    expect(JSON.stringify(model.receivedMessages.at(-1))).toContain('finished result')
  })

  it('injects completion at the next model boundary while the loop is running', async () => {
    const { service, model } = makeRunner([
      toolCallAi('tc', 'execute', { command: 'sleep 900' }),
      toolCallAi('query', 'background_exec_status', {}),
      new AIMessage('processed while running'),
    ])
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const generate = model._generate.bind(model)
    let waiting = false
    model._generate = async (...args) => {
      if (model.invokeCount === 1) { waiting = true; await held }
      return generate(...args)
    }
    const running = service.execute(cmd)
    await waitFor(() => waiting)
    const task = (await jobs.list(cmd.ownerId, cmd.sessionId))[0]!
    runtime.finish(task.id)
    await jobs.tick()
    await service.wakeBackground(await jobs.pending(cmd.sessionId))
    expect(service.stateOf(cmd.sessionId)?.state).toBe('running')
    release()
    await running
    expect(model.invokeCount).toBe(3)
    expect(JSON.stringify(model.receivedMessages.at(-1))).toContain('finished result')
    expect(hub.publish.mock.calls.some(call => call[1].type === 'tool.start')).toBe(true)
    expect(hub.publish.mock.calls.some(call => call[1].type === 'tool.end')).toBe(true)
  })

  it('keeps completed results pending during approval suspension', async () => {
    const task = JSON.parse(await jobs.execute(cmd, 'lab', 'earlier', 'long command'))
    const { service, model } = makeRunner([toolCallAi('approval', 'execute', { command: 'sleep 900' })], true)
    await service.execute(cmd)
    runtime.finish(task.taskId)
    await jobs.tick()
    await service.wakeBackground(await jobs.pending(cmd.sessionId))
    expect(service.stateOf(cmd.sessionId)?.state).toBe('interrupted')
    expect(model.invokeCount).toBe(1)
    expect(await jobs.pending(cmd.sessionId)).toHaveLength(1)
  })

  it('does not bypass tool approval', async () => {
    const { service } = makeRunner([toolCallAi('tc', 'execute', { command: 'sleep 900' })], true)
    await service.execute(cmd)
    expect(service.stateOf(cmd.sessionId)?.state).toBe('interrupted')
    expect(runtime.starts).toEqual([])
  })

  it('recovers an unsettled original checkpoint after restart without relaunching its shell command', async () => {
    const original = makeRunner([
      toolCallAi('tc', 'execute', { command: 'sleep 900' }),
      () => { throw new Error('simulated controller loss at the next model node') },
    ])
    await original.service.execute(cmd)
    const task = (await jobs.list(cmd.ownerId, cmd.sessionId))[0]!
    // A killed controller does not execute finally; recreate that durable state.
    await prisma.backgroundExec.update({ where: { id: task.id }, data: { loopState: null } })
    original.service.dispose()
    runtime.finish(task.id)
    await jobs.tick()
    const reborn = makeRunner([new AIMessage('Recovered the interrupted model node.'), new AIMessage('Processed the background result.')])
    const dispatch = vi.fn((next: RunCommand) => reborn.service.execute(next))
    reborn.service.setTeammateDispatcher(dispatch)
    await reborn.service.wakeBackground(await jobs.pending(cmd.sessionId))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'recover', runId: cmd.runId, backgroundRecoveryTaskId: task.id }))
    expect(reborn.service.stateOf(cmd.sessionId)?.state).toBe('completed')
    expect(runtime.starts).toHaveLength(1)
    // A checkpoint retry can resume directly inside the model node, after beforeModel.
    // The result stays pending and is delivered by a subsequent normal continuation.
    await reborn.service.wakeBackground(await jobs.pending(cmd.sessionId))
    expect(JSON.stringify(reborn.model.receivedMessages)).toContain('finished result')
    await reborn.service.wakeBackground(await jobs.pending(cmd.sessionId))
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(reborn.service.stateOf(cmd.sessionId)?.state).toBe('completed')
  })

  it('authenticates REST, rejects cross-owner access, validates pagination and cascades task deletion', async () => {
    const r = JSON.parse(await jobs.execute(cmd, 'lab', 'tc', 'sleep 999'))
    const { service } = makeRunner([new AIMessage('done')])
    const sessions = new SessionService({ prisma, hub, runService: service, dispatch: c => service.execute(c), background: jobs })
    const request = supertest(createApp({ prisma, sessions: { service: sessions, background: jobs } }))
    const user = await prisma.user.findUniqueOrThrow({ where: { id: cmd.ownerId } })
    const token = await signAccessToken(user.id)
    const url = `/api/v1/sessions/${cmd.sessionId}/background-tasks`
    expect((await request.get(url)).body.code).not.toBe(0)
    expect((await request.get(url).set('Authorization', `Bearer ${token}`)).body.data).toHaveLength(1)
    expect((await request.get(`${url}/${r.taskId}?offset=-1`).set('Authorization', `Bearer ${token}`)).body.code).toBe(90002)
    await expect(jobs.output('another-user', cmd.sessionId, r.taskId)).rejects.toMatchObject({ code: 50002 })
    expect((await request.post(`${url}/${r.taskId}/cancel`).set('Authorization', `Bearer ${token}`).send({ extra: true })).body.code).toBe(90002)
    await jobs.cancel(cmd.ownerId, cmd.sessionId)
    await prisma.session.delete({ where: { id: cmd.sessionId } })
    expect(await prisma.backgroundExec.count()).toBe(0)
  })

  it('stops background tasks even after the main loop ended, and never wakes suppressed results', async () => {
    const task = JSON.parse(await jobs.execute(cmd, 'lab', 'tc', 'sleep 999'))
    const { service, model } = makeRunner([new AIMessage('done')])
    const sessions = new SessionService({ prisma, hub, runService: service, dispatch: c => service.execute(c), background: jobs })
    expect(await sessions.abortRun({ id: cmd.ownerId, role: 'user' }, cmd.sessionId)).toEqual({ runId: cmd.runId })
    runtime.finish(task.taskId)
    await jobs.tick()
    await service.wakeBackground(await jobs.pending(cmd.sessionId))
    expect(model.invokeCount).toBe(0)
    expect((await jobs.list(cmd.ownerId, cmd.sessionId))[0]?.delivery).toBe('suppressed')
  })

  it('refuses deletion if termination fails, then cancels before deleting on retry', async () => {
    const task = JSON.parse(await jobs.execute(cmd, 'lab', 'tc', 'sleep 999'))
    const { service } = makeRunner([new AIMessage('done')])
    const sessions = new SessionService({ prisma, hub, runService: service, dispatch: c => service.execute(c), background: jobs })
    const cancel = vi.spyOn(runtime, 'cancel').mockRejectedValueOnce(new Error('daemon unavailable'))
    await expect(sessions.deleteSession({ id: cmd.ownerId, role: 'user' }, cmd.sessionId)).rejects.toThrow('daemon unavailable')
    expect(await prisma.session.findUnique({ where: { id: cmd.sessionId } })).not.toBeNull()
    expect((await jobs.list(cmd.ownerId, cmd.sessionId))[0]?.delivery).toBe('suppressed')
    await sessions.deleteSession({ id: cmd.ownerId, role: 'user' }, cmd.sessionId)
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(runtime.processes.get(task.taskId)?.state).toBe('cancelled')
    expect(await prisma.backgroundExec.count()).toBe(0)
  })
})
