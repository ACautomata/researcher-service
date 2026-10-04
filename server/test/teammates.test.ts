import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { TeammateService } from '../src/runner/teammates/service'
import { seedUser } from './helpers'

describe('TeammateService', () => {
  let prisma: PrismaClient
  let owner: { id: string; username: string }
  const rootSessionId = 'team-root'

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'teammates-test-'))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient('file:' + dbPath)
    const user = await seedUser(prisma, 'teammate-user', 'pw-teammate-secure')
    owner = { id: user.id, username: user.username }
  }, 30_000)

  beforeEach(async () => {
    const existing = await prisma.teammate.findMany({
      where: { parentSessionId: rootSessionId },
      select: { threadId: true },
    })
    if (existing.length) {
      await prisma.session.deleteMany({ where: { id: { in: existing.map((row) => row.threadId) } } })
    }
    await prisma.session.deleteMany({ where: { id: rootSessionId } })
    await prisma.session.create({
      data: { id: rootSessionId, ownerId: owner.id, containerId: 'sandbox-root', title: 'Research' },
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a named teammate with an independent checkpoint thread', async () => {
    const teammates = new TeammateService(prisma)
    const created = await teammates.spawn({
      parentSessionId: rootSessionId,
      name: 'literature-review',
      task: 'Find prior work on graph learning.',
    })

    expect(created).toMatchObject({
      name: 'literature-review',
      task: 'Find prior work on graph learning.',
      status: 'queued',
    })
    expect(created.threadId).not.toBe(rootSessionId)
    expect(await prisma.session.findUnique({ where: { id: created.threadId } })).toMatchObject({
      ownerId: owner.id,
      containerId: 'sandbox-root',
      isTeammate: true,
    })
    expect(await teammates.list(rootSessionId)).toHaveLength(1)
  })

  it('persists point-to-point mail and returns it only to its recipient', async () => {
    const teammates = new TeammateService(prisma)
    const first = await teammates.spawn({ parentSessionId: rootSessionId, name: 'first', task: 'One' })
    const second = await teammates.spawn({ parentSessionId: rootSessionId, name: 'second', task: 'Two' })

    const sent = await teammates.sendMail({
      parentSessionId: rootSessionId,
      senderTeammateId: first.id,
      recipientTeammateId: second.id,
      content: 'I found a useful paper.',
    })

    expect(await teammates.receiveMail(rootSessionId, second.id)).toMatchObject([
      { id: sent.id, senderTeammateId: first.id, content: 'I found a useful paper.' },
    ])
    expect(await teammates.receiveMail(rootSessionId, first.id)).toEqual([])
    expect(await teammates.receiveMail(rootSessionId, second.id)).toEqual([])
    expect(await prisma.teammateMailboxMessage.findUnique({ where: { id: sent.id } })).toMatchObject({
      readAt: expect.any(Date),
      invalidatedAt: null,
    })
  })

  it('wakes the exact persisted mailbox wait when mail arrives', async () => {
    const wakes: Array<{ threadId: string; teammateId: string | null; waitId: string }> = []
    const teammates = new TeammateService(prisma, () => new Date(), async (threadId, teammateId, waitId) => {
      wakes.push({ threadId, teammateId, waitId })
    })
    const recipient = await teammates.spawn({ parentSessionId: rootSessionId, name: 'waiting', task: 'Wait' })
    await teammates.registerWait({
      waitId: 'wait-123', parentSessionId: rootSessionId,
      threadId: recipient.threadId, recipientTeammateId: recipient.id,
    })

    await teammates.sendMail({ parentSessionId: rootSessionId, recipientTeammateId: recipient.id, content: 'Wake up' })

    expect(wakes).toEqual([{ threadId: recipient.threadId, teammateId: recipient.id, waitId: 'wait-123' }])
    await teammates.clearWait(recipient.threadId, 'wait-123')
    expect(await prisma.teammateMailboxWait.findUnique({ where: { threadId: recipient.threadId } })).toBeNull()
  })

  it('archives a teammate without deleting its checkpoint thread or mailbox history', async () => {
    const teammates = new TeammateService(prisma)
    const created = await teammates.spawn({ parentSessionId: rootSessionId, name: 'archivable', task: 'Retain me' })
    const mail = await teammates.sendMail({
      parentSessionId: rootSessionId,
      recipientTeammateId: created.id,
      content: 'Keep this audit record.',
    })

    await teammates.archive(rootSessionId, created.id)

    expect(await prisma.session.findUnique({ where: { id: created.threadId } })).not.toBeNull()
    expect(await prisma.teammateMailboxMessage.findUnique({ where: { id: mail.id } })).not.toBeNull()
    expect(await teammates.list(rootSessionId)).toMatchObject([{ id: created.id, status: 'archived' }])
  })

  it('archives teammates and invalidates unread mail when rewinding across their spawn checkpoint', async () => {
    const teammates = new TeammateService(prisma)
    const created = await teammates.spawn({
      parentSessionId: rootSessionId,
      name: 'future-branch',
      task: 'Work after the anchor',
      spawnedAtCheckpointId: 'cp-after',
    })
    await prisma.checkpoint.createMany({
      data: [
        { threadId: rootSessionId, checkpointNs: '', checkpointId: 'cp-before', parentCheckpointId: null, type: 'json', blob: new Uint8Array(), metadataJson: '{}' },
        { threadId: rootSessionId, checkpointNs: '', checkpointId: 'cp-after', parentCheckpointId: 'cp-before', type: 'json', blob: new Uint8Array(), metadataJson: '{}' },
      ],
    })
    const mail = await teammates.sendMail({
      parentSessionId: rootSessionId,
      recipientTeammateId: created.id,
      content: 'Unread branch mail',
    })

    expect(await teammates.rewind(rootSessionId, 'cp-before')).toEqual([created.id])
    expect(await teammates.list(rootSessionId)).toMatchObject([{ id: created.id, status: 'archived' }])
    expect(await prisma.teammateMailboxMessage.findUnique({ where: { id: mail.id } })).toMatchObject({
      readAt: null,
      invalidatedAt: expect.any(Date),
    })
  })
})
