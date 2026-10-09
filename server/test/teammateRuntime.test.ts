// #786 S1/S2: REST + real graphs/checkpoints/mailboxes; only LLM, Docker and time are fake.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest from 'supertest'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { createPrismaClient } from '../src/prisma'
import { createApp } from '../src/app'
import { signAccessToken } from '../src/auth/tokens'
import { StreamHub } from '../src/events/hub'
import type { CatalogEvent } from '../src/events/logic'
import { RunService, type RunCommand } from '../src/runner/runtime/runService'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { TeammateService } from '../src/runner/teammates/service'
import { SessionService } from '../src/sessions/service'
import { ApprovalFunnel, type ApprovalFunnelDeps } from '../src/runner/approval/funnel'
import { createPrismaApprovalAuditSink } from '../src/runner/approval/audit'
import { listTextTraceLogs } from '../src/traceLogs/service'
import { ScriptedChatModel, fakePrimitives, toolCallAi } from './runnerFakes'
import { seedUser, waitFor } from './helpers'

type Reply = AIMessage | (() => Promise<AIMessage>)
class TeamModel extends ScriptedChatModel {
  private positions = new Map<string, number>()
  constructor(private readonly replies: Record<string, Reply[]>) { super([]) }
  override async _generate(messages: BaseMessage[]) {
    const input = messages.find(message => message.getType() === 'human')?.content
    const task = typeof input === 'string' ? input : ''
    const position = this.positions.get(task) ?? 0
    this.positions.set(task, position + 1)
    const reply = this.replies[task]?.[position]
    if (!reply) throw new Error(`No reply for ${task} at ${position}`)
    const message = typeof reply === 'function' ? await reply() : reply
    return { generations: [{ message, text: typeof message.content === 'string' ? message.content : '' }] }
  }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function harness(replies: Record<string, Reply[]>, judge?: ApprovalFunnelDeps['judge']) {
  const dir = mkdtempSync(path.join(tmpdir(), 'teammate-runtime-'))
  const dbPath = path.join(dir, 'test.db')
  const sqlite = new Database(dbPath)
  sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma/init.sql'), 'utf8'))
  sqlite.close()
  const prisma = createPrismaClient(`file:${dbPath}`)
  const owner = await seedUser(prisma, 'team-runtime-user', 'team-runtime-password')
  await prisma.modelProvider.create({ data: {
    ownerId: owner.id, providerId: 'team-provider', presetId: 'openai',
    modelsJson: JSON.stringify([{ id: 'model-x' }]),
  } })
  const hub = new StreamHub()
  const events: CatalogEvent[] = []
  hub.register(owner.id, { send: frame => {
    const data = /^data: (.+)$/m.exec(frame)?.[1]
    if (data) events.push(JSON.parse(data) as CatalogEvent)
    return true
  }, close: () => {} })
  const gate = new ConcurrencyGate({ globalLimit: 1, loadUserLimit: async () => 1 })
  const teammates = new TeammateService(prisma)
  const modelCalls: Array<{ task: string; metadata: Record<string, unknown>; system: string }> = []
  const service = new RunService({
    prisma, hub, gate, teammates, saver: new PrismaCheckpointSaver(prisma),
    approvals: judge ? new ApprovalFunnel({ judge, audit: createPrismaApprovalAuditSink(prisma) }) : undefined,
    registry: new ProviderRegistry(prisma, { llmApiKey: 'fake', modelFactory: async () => {
      const model = new TeamModel(replies)
      model.callbacks = [{ name: 'FakeLLMTransport', handleChatModelStart: (_model, batches, _run, _parent, _extra, _tags, metadata) => {
        const messages = batches[0] ?? []
        const human = messages.find(message => message.getType() === 'human')?.content
        modelCalls.push({ task: typeof human === 'string' ? human : '', metadata: metadata ?? {}, system: JSON.stringify(messages.filter(message => message.getType() === 'system').map(message => message.content)) })
      } }]
      return model
    } }),
    primitives: fakePrimitives().primitives, resolveWikiContainer: () => 'researcher-wiki-team',
  })
  const executions: Promise<void>[] = []
  const delayed: Array<{ command: RunCommand; delayMs: number }> = []
  const dispatch = async (command: RunCommand, delayMs = 0) => {
    if (delayMs > 0) { delayed.push({ command, delayMs }); return }
    const execution = service.execute(command)
    execution.catch(() => {})
    executions.push(execution)
  }
  service.setTeammateDispatcher(dispatch)
  teammates.setWakeHandler((threadId, teammateId, waitId) => service.wakeMailbox(threadId, teammateId, waitId))
  const sessions = new SessionService({ prisma, hub, runService: service, dispatch })
  service.setRecordTurn(payload => sessions.recordTurn(payload))
  const request = supertest(createApp({ prisma, events: { hub }, sessions: { service: sessions } }))
  const access = await signAccessToken(owner.id)
  const auth = { Authorization: `Bearer ${access}` }
  const created = await request.post('/api/v1/sessions').set(auth).send({ title: 'Team research' })
  const sessionId = created.body.data.id as string
  cleanups.push(async () => { service.dispose(); await prisma.$disconnect() })
  return { prisma, owner, teammates, service, gate, hub, events, delayed, request, auth, sessionId, dispatch, modelCalls,
    send: async (content: string) => request.post(`/api/v1/sessions/${sessionId}/messages`).set(auth).set('Idempotency-Key', 'a'.repeat(32)).send({ content }),
    settle: async () => { let n = 0; while (n < executions.length) { const current = executions.slice(n); n = executions.length; await Promise.all(current) } },
  }
}

function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

describe('#786 teammate runtime acceptance (S1/S2)', () => {
  it('approval REST acknowledges dispatch without waiting for the teammate to finish', async () => {
    const release = latch()
    const h = await harness({
      leader: [toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }), new AIMessage({ content: 'Leader done' })],
      'worker-task': [toolCallAi('approval', 'execute', { command: 'echo needs-human' }), async () => { await release.promise; return new AIMessage({ content: 'Worker done' }) }],
    }, { run: async input => input.rendered.includes('echo needs-human')
      ? { kind: 'malformed', inputHash: input.inputHash, latencyMs: 1, tokens: 1 }
      : { kind: 'verdict', inputHash: input.inputHash, latencyMs: 1, tokens: 1, verdict: { decision: 'approve', policy_class: null, reason: '' } } })
    await h.send('leader'); await h.settle()
    const approval = (await h.request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data.approvals[0]
    let responseCode: number | undefined
    const response = h.request.post(`/api/v1/sessions/${h.sessionId}/approvals/${approval.escalation.id}`).set(h.auth).send({ decision: 'allow' }).then(result => { responseCode = result.body.code })
    try {
      await waitFor(() => responseCode !== undefined, 1000)
      expect(responseCode).toBe(0)
      const [worker] = await h.teammates.list(h.sessionId)
      expect(h.service.stateOf(worker.threadId)?.state).toBe('running')
    } finally { release.release(); await response; await h.settle() }
  }, 15_000)

  it('restores pending approvals after restart and retains them when queue submission fails', async () => {
    const judge: ApprovalFunnelDeps['judge'] = { run: async input => input.rendered.includes('echo needs-human')
      ? { kind: 'malformed', inputHash: input.inputHash, latencyMs: 1, tokens: 1 }
      : { kind: 'verdict', inputHash: input.inputHash, latencyMs: 1, tokens: 1, verdict: { decision: 'approve', policy_class: null, reason: '' } } }
    const h = await harness({ leader: [toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }), new AIMessage({ content: 'Leader done' })], 'worker-task': [toolCallAi('approval', 'execute', { command: 'echo needs-human' })] }, judge)
    await h.send('leader'); await h.settle(); h.service.dispose()
    const restarted = new RunService({ prisma: h.prisma, hub: h.hub, gate: h.gate, teammates: h.teammates, saver: new PrismaCheckpointSaver(h.prisma), approvals: new ApprovalFunnel({ judge, audit: createPrismaApprovalAuditSink(h.prisma) }), registry: new ProviderRegistry(h.prisma, { llmApiKey: 'fake', modelFactory: async () => new ScriptedChatModel([]) }), primitives: fakePrimitives().primitives, resolveWikiContainer: () => 'researcher-wiki-team' })
    cleanups.push(async () => restarted.dispose())
    let failQueue = true
    restarted.setTeammateDispatcher(async () => { if (failQueue) throw new Error('Queue unavailable') })
    const service = new SessionService({ prisma: h.prisma, hub: h.hub, runService: restarted, dispatch: async () => {} })
    const request = supertest(createApp({ prisma: h.prisma, events: { hub: h.hub }, sessions: { service } }))
    const projection = (await request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data
    const id = projection.approvals[0].escalation.id as string
    const endpoint = `/api/v1/sessions/${h.sessionId}/approvals/`
    expect((await request.post(endpoint + 'wrong-id').set(h.auth).send({ decision: 'allow' })).body.code).toBe(50004)
    expect((await request.post(endpoint + id).set(h.auth).send({ decision: 'allow' })).body.code).not.toBe(0)
    expect(h.events.filter(event => event.type === 'approval.resolved')).toEqual([])
    expect((await request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data.approvals[0].escalation.id).toBe(id)
    failQueue = false
    expect((await request.post(endpoint + id).set(h.auth).send({ decision: 'allow' })).body.code).toBe(0)
    expect((await request.post(endpoint + id).set(h.auth).send({ decision: 'allow' })).body.code).toBe(50001)
  }, 15_000)

  it('leader and peers inherit owner capabilities per run; disabling affects only later runs', async () => {
    let h: Awaited<ReturnType<typeof harness>>
    h = await harness({
      leader: [toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }), async () => {
        await waitFor(() => h.modelCalls.some(call => call.task === 'worker-task'))
        await h.prisma.pluginEnablement.update({ where: { ownerId_pluginId: { ownerId: h.owner.id, pluginId: 'autofigure' } }, data: { enabled: false } })
        return new AIMessage({ content: 'Leader done' })
      }],
      'worker-task': [toolCallAi('skill', 'read_official_skill', { name: 'research' }), new AIMessage({ content: 'Worker done' })],
      next: [new AIMessage({ content: 'Next run done' })],
    })
    await h.prisma.pluginEnablement.create({ data: { ownerId: h.owner.id, pluginId: 'autofigure', enabled: true, enabledAt: new Date() } })
    expect((await h.send('leader')).body.code).toBe(0)
    await h.settle()
    for (const call of h.modelCalls) expect(call.metadata.ownerPluginIds).toEqual(['autofigure'])
    expect(h.modelCalls.filter(call => call.task === 'worker-task').every(call => call.system.includes('research'))).toBe(true)
    const session = (await h.request.post('/api/v1/sessions').set(h.auth).send({})).body.data.id as string
    expect((await h.request.post(`/api/v1/sessions/${session}/messages`).set(h.auth).set('Idempotency-Key', 'b'.repeat(32)).send({ content: 'next' })).body.code).toBe(0)
    await h.settle()
    expect(h.modelCalls.find(call => call.task === 'next')?.metadata.ownerPluginIds).toEqual([])
  }, 15_000)

  it('charges one session lease until the last concurrently running teammate finishes', async () => {
    const release = latch()
    const h = await harness({
      leader: [toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }), new AIMessage({ content: 'Leader done' })],
      'worker-task': [async () => { await release.promise; return new AIMessage({ content: 'Worker done' }) }],
    })
    try {
      expect((await h.send('leader')).body.code).toBe(0)
      await waitFor(() => h.service.stateOf(h.sessionId)?.state === 'completed')
      expect(h.gate.inFlight(h.owner.id)).toBe(1)
      const other = (await h.request.post('/api/v1/sessions').set(h.auth).send({})).body.data.id as string
      expect((await h.request.post(`/api/v1/sessions/${other}/messages`).set(h.auth).set('Idempotency-Key', 'b'.repeat(32)).send({ content: 'another session' })).body.code).toBe(40043)
    } finally { release.release(); await h.settle() }
    expect(h.gate.inFlight(h.owner.id)).toBe(0)
  }, 15_000)

  it('rewind across a spawn checkpoint retires its thread and invalidates unread mail', async () => {
    const h = await harness({
      leader: [toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }), new AIMessage({ content: 'Leader done' })],
      'worker-task': [toolCallAi('wait', 'wait_for_teammate_mail', { timeoutMs: 5000 })],
    })
    expect((await h.send('leader')).body.code).toBe(0)
    await h.settle()
    const [worker] = await h.teammates.list(h.sessionId)
    const spawned = await new PrismaCheckpointSaver(h.prisma).getTuple({ configurable: { thread_id: h.sessionId, checkpoint_id: worker.spawnedAtCheckpointId } })
    const before = spawned?.parentConfig?.configurable?.checkpoint_id as string
    expect(before).toBeTruthy()
    await h.teammates.sendMail({ parentSessionId: h.sessionId, senderTeammateId: worker.id, content: 'discarded branch evidence' })
    await h.service.teammatesForRewind(h.sessionId, before)
    expect(await h.teammates.list(h.sessionId)).toEqual([expect.objectContaining({ status: 'archived' })])
    expect(h.service.stateOf(worker.threadId)?.state).toBe('aborted')
    expect(await h.teammates.receiveMail(h.sessionId, null)).toEqual([])
    expect((await listTextTraceLogs(h.prisma, { userId: h.owner.id, content: 'discarded branch evidence' })).total).toBe(1)
  }, 15_000)

  it('teammates request delegation through the leader and cannot bypass it through builtin task', async () => {
    const h = await harness({
      leader: [toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }), new AIMessage({ content: 'Leader done' })],
      'worker-task': [
        toolCallAi('nested', 'task', { description: 'nested-task', subagent_type: 'general-purpose' }),
        toolCallAi('forbidden-spawn', 'spawn_teammate', { name: 'nested', task: 'nested-task' }),
        toolCallAi('request', 'request_teammate', { name: 'nested', task: 'nested-task' }),
        new AIMessage({ content: 'Requested help' }),
      ],
    })
    expect((await h.send('leader')).body.code).toBe(0)
    await h.settle()
    expect(await h.teammates.list(h.sessionId)).toEqual([expect.objectContaining({ name: 'worker', status: 'completed' })])
    expect(await h.teammates.mailboxHistory(h.sessionId)).toEqual([expect.objectContaining({ kind: 'request', recipientTeammateId: null })])
  }, 15_000)

  it('leader close archives a parked thread and rejects its later delayed wake', async () => {
    let h: Awaited<ReturnType<typeof harness>>
    h = await harness({
      leader: [toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }), async () => {
        await waitFor(async () => (await h.teammates.list(h.sessionId))[0]?.status === 'waiting')
        return toolCallAi('close', 'close_teammate', { name: 'worker' })
      }, new AIMessage({ content: 'Closed' })],
      'worker-task': [toolCallAi('wait', 'wait_for_teammate_mail', { timeoutMs: 5000 })],
    })
    expect((await h.send('leader')).body.code).toBe(0)
    await h.settle()
    const [worker] = await h.teammates.list(h.sessionId)
    expect(worker.status).toBe('archived')
    const checkpoint = await new PrismaCheckpointSaver(h.prisma).getTuple({ configurable: { thread_id: worker.threadId } })
    expect(checkpoint).toBeDefined()
    expect(await h.teammates.updateStatus(h.sessionId, worker.id, 'completed')).toMatchObject({ status: 'archived' })
    await h.dispatch(h.delayed[0]!.command)
    await expect(h.settle()).rejects.toMatchObject({ code: 50001 })
    const projection = (await h.request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data
    expect(projection.teammates).toEqual([expect.objectContaining({ name: 'worker', status: 'archived' })])
    expect((await h.request.delete(`/api/v1/sessions/${h.sessionId}`).set(h.auth)).body.code).toBe(0)
  }, 15_000)

  it('expired mail cannot be consumed, but its communication audit survives session deletion', async () => {
    const h = await harness({})
    const worker = await h.teammates.spawn({ parentSessionId: h.sessionId, name: 'archivist', task: 'archive evidence' })
    await h.teammates.sendMail({ parentSessionId: h.sessionId, recipientTeammateId: worker.id, content: 'durable evidence' })
    const restarted = new TeammateService(h.prisma, () => new Date(Date.now() + 49 * 60 * 60 * 1000))
    expect(await restarted.receiveMail(h.sessionId, worker.id)).toEqual([])
    await h.teammates.archive(h.sessionId, worker.id)
    expect((await h.request.delete(`/api/v1/sessions/${h.sessionId}`).set(h.auth)).body.code).toBe(0)
    const audit = await listTextTraceLogs(h.prisma, { userId: h.owner.id, content: 'durable evidence' })
    expect(audit.logs).toEqual([expect.objectContaining({ outputText: 'durable evidence', sessionKey: h.sessionId })])
  })

  it('the folded REST projection excludes expired unread mail', async () => {
    const h = await harness({})
    const worker = await h.teammates.spawn({ parentSessionId: h.sessionId, name: 'worker', task: 'research' })
    await h.teammates.sendMail({ parentSessionId: h.sessionId, recipientTeammateId: worker.id, content: 'expired evidence', ttlMs: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    const projection = (await h.request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data
    expect(projection.teammates[0].mailbox).toEqual([])
    expect((await listTextTraceLogs(h.prisma, { userId: h.owner.id, content: 'expired evidence' })).total).toBe(1)
  })

  it('approval suspends only the teammate and keeps timeout events on the parent timeline', async () => {
    const h = await harness({
      leader: [toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }), new AIMessage({ content: 'Leader done' })],
      'worker-task': [toolCallAi('needs-approval', 'execute', { command: 'echo needs-human' }), new AIMessage({ content: 'Worker done' })],
    }, { run: async input => input.rendered.includes('echo needs-human')
      ? { kind: 'malformed', inputHash: input.inputHash, latencyMs: 1, tokens: 1 }
      : { kind: 'verdict', inputHash: input.inputHash, latencyMs: 1, tokens: 1, verdict: { decision: 'approve', policy_class: null, reason: '' } } })
    expect((await h.send('leader')).body.code).toBe(0)
    await h.settle()
    const [worker] = await h.teammates.list(h.sessionId)
    expect(h.service.stateOf(h.sessionId)?.state).toBe('completed')
    expect(h.service.stateOf(worker.threadId)?.state).toBe('interrupted')
    const requested = h.events.find(event => event.type === 'approval.requested')!
    expect(requested).toMatchObject({ sessionId: h.sessionId, teammateId: worker.id })
    const projection = (await h.request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data
    expect(projection.approvals).toEqual([expect.objectContaining({ teammateId: worker.id, escalation: expect.objectContaining({ id: (requested.payload as { escalation: { id: string } }).escalation.id }) })])
    h.service.sweepSuspensions(Date.now() + 49 * 60 * 60 * 1000)
    expect(h.events.find(event => event.type === 'run.suspended')).toMatchObject({ sessionId: h.sessionId, teammateId: worker.id })
    const escalationId = (requested.payload as { escalation: { id: string } }).escalation.id
    expect((await h.request.post(`/api/v1/sessions/${h.sessionId}/approvals/${escalationId}`).set(h.auth).send({ decision: 'allow' })).body.code).toBe(0)
    await h.settle()
    expect(h.service.stateOf(worker.threadId)?.state).toBe('completed')
    expect(h.service.stateOf(h.sessionId)?.state).toBe('completed')
  }, 15_000)

  it('a delayed mailbox timeout resumes only its waiter and broadcasts a follow-up', async () => {
    const h = await harness({
      leader: [toolCallAi('spawn-waiter', 'spawn_teammate', { name: 'waiter', task: 'wait-task' }), new AIMessage({ content: 'Leader done' })],
      'wait-task': [toolCallAi('wait', 'wait_for_teammate_mail', { timeoutMs: 5000, broadcastOnTimeout: true }), new AIMessage({ content: 'Waiter done' })],
    })
    expect((await h.send('leader')).body.code).toBe(0)
    await h.settle()
    const [waiter] = await h.teammates.list(h.sessionId)
    expect(waiter.status).toBe('waiting')
    expect((await h.request.delete(`/api/v1/sessions/${h.sessionId}`).set(h.auth)).body.code).toBe(50005)
    expect(h.delayed).toHaveLength(1)
    const delayed = h.delayed[0]!
    expect(delayed.delayMs).toBe(5000)
    expect(delayed.command).toMatchObject({ parentSessionId: h.sessionId, teammateId: waiter.id, mailWakeReason: 'timeout' })
    await h.dispatch(JSON.parse(JSON.stringify(delayed.command)) as RunCommand)
    await h.settle()
    expect((await h.teammates.list(h.sessionId))[0]?.status).toBe('completed')
    expect((await h.teammates.mailboxHistory(h.sessionId)).map(mail => mail.kind)).toEqual(['timeout', 'timeout-follow-up'])
    await h.dispatch(delayed.command)
    await expect(h.settle()).rejects.toMatchObject({ code: 50001 })
    expect(await h.teammates.mailboxHistory(h.sessionId)).toHaveLength(2)
  }, 15_000)

  it('leader spawns concurrent peers at quota one; peer mail resumes a parked teammate', async () => {
    const releaseWriter = latch()
    let h: Awaited<ReturnType<typeof harness>>
    h = await harness({
      leader: [new AIMessage({ content: '', tool_calls: [
        { id: 'spawn-reader', name: 'spawn_teammate', args: { name: 'reader', task: 'reader-task' }, type: 'tool_call' },
        { id: 'spawn-writer', name: 'spawn_teammate', args: { name: 'writer', task: 'writer-task' }, type: 'tool_call' },
      ] }), async () => {
        await waitFor(async () => {
          const rows = await h.teammates.list(h.sessionId)
          return rows.some(row => row.name === 'reader' && row.status === 'waiting') && rows.some(row => row.name === 'writer' && h.service.stateOf(row.threadId)?.state === 'running')
        })
        expect(h.gate.inFlight(h.owner.id)).toBe(1)
        releaseWriter.release()
        return new AIMessage({ content: 'Leader result' })
      }],
      'reader-task': [toolCallAi('wait-reader', 'wait_for_teammate_mail', { timeoutMs: 5000 }), new AIMessage({ content: 'Reader result' })],
      'writer-task': [async () => { await releaseWriter.promise; return toolCallAi('send-reader', 'send_teammate_mail', { to: 'reader', message: 'Peer evidence' }) }, new AIMessage({ content: 'Writer result' })],
    })
    try {
      expect((await h.send('leader')).body.code).toBe(0)
      await waitFor(() => h.service.stateOf(h.sessionId)?.state === 'completed' || h.service.stateOf(h.sessionId)?.state === 'failed')
      if (h.service.stateOf(h.sessionId)?.state === 'failed') { releaseWriter.release(); throw new Error('Leader failed') }
      await h.settle()
      expect(await h.teammates.list(h.sessionId)).toMatchObject([{ name: 'reader', status: 'completed' }, { name: 'writer', status: 'completed' }])
      expect(h.events.filter(event => event.type === 'run.resumed')).toHaveLength(1)
      expect((await h.teammates.mailboxHistory(h.sessionId)).map(mail => mail.content)).toEqual(['Peer evidence'])
      expect(h.events.filter(event => event.type === 'text.delta' && event.teammateId).every(event => event.sessionId === h.sessionId)).toBe(true)
      const projection = (await h.request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data
      expect(projection.messages.map((message: { content: string }) => message.content)).toEqual(['leader', 'Leader result'])
      expect(projection.teammates).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'reader', messages: expect.arrayContaining([expect.objectContaining({ content: 'Reader result' })]) }),
        expect.objectContaining({ name: 'writer', messages: expect.arrayContaining([expect.objectContaining({ content: 'Writer result' })]) }),
      ]))
    } finally { releaseWriter.release() }
  }, 15_000)

  it('rest rewind across a spawn checkpoint retires teammates and invalidates their unread mail', async () => {
    const h = await harness({
      leader: [new AIMessage({ content: 'First done' }), toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }), new AIMessage({ content: 'Second done' })],
      'worker-task': [toolCallAi('wait', 'wait_for_teammate_mail', { timeoutMs: 5000 })],
    })
    expect((await h.send('leader')).body.code).toBe(0)
    await h.settle()
    expect((await h.request.post(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth).set('Idempotency-Key', 'c'.repeat(32)).send({ content: 'spawn the worker' })).body.code).toBe(0)
    await h.settle()
    const [worker] = await h.teammates.list(h.sessionId)
    expect(worker.status).toBe('waiting')
    await h.teammates.sendMail({ parentSessionId: h.sessionId, senderTeammateId: worker.id, content: 'pre-rewind evidence' })
    const projection = (await h.request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data
    const anchorRow = projection.messages.find((message: { role: string; content: string }) => message.role === 'assistant' && message.content === 'First done')
    expect((await h.request.post(`/api/v1/sessions/${h.sessionId}/rewind`).set(h.auth).send({ messageId: anchorRow.id })).body.code).toBe(0)
    await h.settle()
    expect(await h.teammates.list(h.sessionId)).toEqual([expect.objectContaining({ name: 'worker', status: 'archived' })])
    expect(h.service.stateOf(worker.threadId)?.state).toBe('aborted')
    expect(h.events.find(event => event.type === 'run.aborted' && event.teammateId === worker.id)).toMatchObject({ payload: { by: 'system' } })
    expect(h.events.find(event => event.type === 'session.invalidated')).toMatchObject({ sessionId: h.sessionId, payload: { reason: 'rewind' } })
    expect(await h.teammates.receiveMail(h.sessionId, null)).toEqual([])
    const after = (await h.request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data
    expect(after.teammates).toEqual([expect.objectContaining({ name: 'worker', status: 'archived', mailbox: [] })])
  }, 15_000)

  it('fork starts the new session without teammates and leaves the source untouched', async () => {
    const h = await harness({
      leader: [toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }), new AIMessage({ content: 'Leader done' })],
      'worker-task': [toolCallAi('wait', 'wait_for_teammate_mail', { timeoutMs: 5000 })],
    })
    expect((await h.send('leader')).body.code).toBe(0)
    await h.settle()
    const forked = await h.request.post(`/api/v1/sessions/${h.sessionId}/fork`).set(h.auth).send({})
    expect(forked.body.code).toBe(0)
    const forkId = forked.body.data.session.id as string
    expect((await h.request.get(`/api/v1/sessions/${forkId}/messages`).set(h.auth)).body.data.teammates).toBeUndefined()
    expect(await h.teammates.list(h.sessionId)).toEqual([expect.objectContaining({ name: 'worker', status: 'waiting' })])
    expect((await h.request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data.teammates)
      .toEqual([expect.objectContaining({ name: 'worker' })])
  }, 15_000)

  it('a teammate request read by the leader results in a leader-spawned teammate', async () => {
    const h = await harness({
      leader: [
        toolCallAi('spawn', 'spawn_teammate', { name: 'worker', task: 'worker-task' }),
        toolCallAi('wait', 'wait_for_teammate_mail', { timeoutMs: 5000 }),
        toolCallAi('grant', 'spawn_teammate', { name: 'nested', task: 'nested-task' }),
        new AIMessage({ content: 'Leader done' }),
      ],
      'worker-task': [toolCallAi('request', 'request_teammate', { name: 'nested', task: 'nested-task' }), new AIMessage({ content: 'Worker done' })],
      'nested-task': [new AIMessage({ content: 'Nested done' })],
    })
    expect((await h.send('leader')).body.code).toBe(0)
    await h.settle()
    expect(await h.teammates.list(h.sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'worker', status: 'completed' }),
      expect.objectContaining({ name: 'nested', status: 'completed' }),
    ]))
    expect(await h.teammates.mailboxHistory(h.sessionId)).toEqual([expect.objectContaining({ kind: 'request', recipientTeammateId: null })])
  }, 15_000)

  it('broadcast_teammate_mail delivers to every other active teammate and wakes a parked peer', async () => {
    let h: Awaited<ReturnType<typeof harness>>
    h = await harness({
      leader: [
        toolCallAi('spawn-bob', 'spawn_teammate', { name: 'bob', task: 'bob-task' }),
        async () => {
          await waitFor(async () => (await h.teammates.list(h.sessionId)).some(row => row.name === 'bob' && row.status === 'waiting'))
          return toolCallAi('spawn-alice', 'spawn_teammate', { name: 'alice', task: 'alice-task' })
        },
        new AIMessage({ content: 'Leader done' }),
      ],
      'bob-task': [toolCallAi('wait', 'wait_for_teammate_mail', { timeoutMs: 5000 }), new AIMessage({ content: 'Bob done' })],
      'alice-task': [toolCallAi('bcast', 'broadcast_teammate_mail', { message: 'status check' }), new AIMessage({ content: 'Alice done' })],
    })
    expect((await h.send('leader')).body.code).toBe(0)
    await h.settle()
    const rows = await h.teammates.list(h.sessionId)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'bob', status: 'completed' }),
      expect.objectContaining({ name: 'alice', status: 'completed' }),
    ]))
    const bob = rows.find(row => row.name === 'bob')!
    expect(await h.teammates.mailboxHistory(h.sessionId)).toEqual([expect.objectContaining({ kind: 'broadcast', content: 'status check', recipientTeammateId: bob.id })])
    expect(h.events.filter(event => event.type === 'run.resumed')).toHaveLength(1)
  }, 15_000)
})
