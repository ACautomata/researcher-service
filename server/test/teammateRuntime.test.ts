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
    ownerId: owner.id, providerId: 'team-provider', lcProvider: 'openai', baseUrl: 'https://llm.example.edu/v1',
    credentialEnvId: 'LLM_API_KEY', authHeader: true, modelsJson: JSON.stringify([{ id: 'model-x' }]),
  } })
  await prisma.providerEndpoint.create({ data: { scheme: 'https', host: 'llm.example.edu', port: null, createdBy: 'seed' } })
  const hub = new StreamHub()
  const events: CatalogEvent[] = []
  hub.register(owner.id, { send: frame => {
    const data = /^data: (.+)$/m.exec(frame)?.[1]
    if (data) events.push(JSON.parse(data) as CatalogEvent)
    return true
  }, close: () => {} })
  const gate = new ConcurrencyGate({ globalLimit: 1, loadUserLimit: async () => 1 })
  const teammates = new TeammateService(prisma)
  const service = new RunService({
    prisma, hub, gate, teammates, saver: new PrismaCheckpointSaver(prisma),
    approvals: judge ? new ApprovalFunnel({ judge, audit: createPrismaApprovalAuditSink(prisma) }) : undefined,
    registry: new ProviderRegistry(prisma, { llmApiKey: 'fake', modelFactory: async () => new TeamModel(replies) }),
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
  return { prisma, owner, teammates, service, gate, events, delayed, request, auth, sessionId, dispatch,
    send: async (content: string) => request.post(`/api/v1/sessions/${sessionId}/messages`).set(auth).set('Idempotency-Key', 'a'.repeat(32)).send({ content }),
    settle: async () => { let n = 0; while (n < executions.length) { const current = executions.slice(n); n = executions.length; await Promise.all(current) } },
  }
}

function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

describe('#786 teammate runtime acceptance (S1/S2)', () => {
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
    h.service.sweepSuspensions(Date.now() + 49 * 60 * 60 * 1000)
    expect(h.events.find(event => event.type === 'run.suspended')).toMatchObject({ sessionId: h.sessionId, teammateId: worker.id })
    const escalationId = (requested.payload as { escalation: { id: string } }).escalation.id
    await h.service.resolveApproval({ sessionId: h.sessionId, ownerId: h.owner.id, username: h.owner.username, escalationId, decision: 'allow' })
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
})
