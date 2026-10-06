import { randomUUID } from 'node:crypto'
import { interrupt } from '@langchain/langgraph'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import {
  DEFAULT_MAIL_WAIT_MS,
  MAX_MAIL_WAIT_MS,
  TeammateService,
  type MailSummary,
  type TeammateKind,
  type TeammateSummary,
} from './service'
import { WIKI_UPDATE_TEAMMATE_KIND } from '../wikigen/values'

export interface TeammateToolContext {
  readonly parentSessionId: string
  readonly actorTeammateId: string | null
  readonly service: TeammateService
  readonly checkpointId: () => Promise<string | null>
  readonly start: (teammate: TeammateSummary) => Promise<void>
  readonly scheduleTimeout: (input: {
    readonly waitId: string
    readonly recipientTeammateId: string | null
    readonly delayMs: number
    readonly broadcastOnTimeout: boolean
  }) => Promise<void>
  readonly abort: (teammate: TeammateSummary) => Promise<void>
}

function renderMail(messages: readonly MailSummary[]): string {
  return JSON.stringify(messages.map((message) => ({
    id: message.id,
    from: message.senderTeammateId ?? 'leader',
    kind: message.kind,
    content: message.content,
    createdAt: message.createdAt,
  })))
}

export function createTeammateTools(ctx: TeammateToolContext) {
  const spawn = tool(
    async ({ name, task, kind, modelProviderId }) => {
      if (ctx.actorTeammateId !== null) {
        return 'Only the leader can start a teammate. Use request_teammate to ask the leader.'
      }
      const teammate = await ctx.service.spawn({
        parentSessionId: ctx.parentSessionId,
        name,
        task,
        kind: (kind ?? 'generic') as TeammateKind,
        modelProviderId,
        spawnedAtCheckpointId: await ctx.checkpointId(),
      })
      await ctx.start(teammate)
      return JSON.stringify({ id: teammate.id, name: teammate.name, status: teammate.status })
    },
    {
      name: 'spawn_teammate',
      description: 'Start a named teammate to work independently on a task. Only the leader may call this.',
      schema: z.object({
        name: z.string().trim().min(1).max(80),
        task: z.string().trim().min(1).max(8000),
        // kind 显式值 V1 只有 wiki-update（治理生成；generic = 缺省不出现在 schema——
        // 保留名单防模型杜撰类别，扩展随发版）。
        kind: z.enum([WIKI_UPDATE_TEAMMATE_KIND]).optional().describe('Spawn a "wiki-update" teammate to regenerate the knowledge wiki with the OpenWiki lifecycle tools. Omit for a generic teammate.'),
        modelProviderId: z.string().trim().min(1).optional().describe('Optional provider id; defaults to the leader model.'),
      }),
    },
  )

  const request = tool(
    async ({ name, task }) => {
      if (ctx.actorTeammateId === null) return 'The leader can start teammates directly.'
      const message = await ctx.service.requestSpawn({
        parentSessionId: ctx.parentSessionId,
        requesterTeammateId: ctx.actorTeammateId,
        name,
        task,
      })
      return JSON.stringify({ requestId: message.id, status: 'sent_to_leader' })
    },
    {
      name: 'request_teammate',
      description: 'Ask the leader to start another teammate. Teammates cannot start teammates directly.',
      schema: z.object({ name: z.string().trim().min(1).max(80), task: z.string().trim().min(1).max(8000) }),
    },
  )

  const send = tool(
    async ({ to, message }) => {
      const recipient = to === 'leader' ? null : await ctx.service.findByName(ctx.parentSessionId, to)
      if (to !== 'leader' && !recipient) return 'No active teammate named "' + to + '". Use list_teammates to see active names.'
      if (recipient?.id === ctx.actorTeammateId) return 'A teammate cannot send mail to itself.'
      const saved = await ctx.service.sendMail({
        parentSessionId: ctx.parentSessionId,
        senderTeammateId: ctx.actorTeammateId,
        recipientTeammateId: recipient?.id ?? null,
        content: message,
      })
      return JSON.stringify({ messageId: saved.id, to: recipient?.name ?? 'leader', status: 'delivered_to_mailbox' })
    },
    {
      name: 'send_teammate_mail',
      description: 'Send a durable point-to-point message to the leader or a named teammate.',
      schema: z.object({
        to: z.string().trim().min(1).describe('Use "leader" or an active teammate name.'),
        message: z.string().trim().min(1).max(8000),
      }),
    },
  )

  const broadcast = tool(
    async ({ message }) => {
      const teammates = await ctx.service.list(ctx.parentSessionId)
      const recipients = teammates.filter((teammate) => teammate.id !== ctx.actorTeammateId && teammate.status !== 'archived')
      const saved = await Promise.all(recipients.map((recipient) => ctx.service.sendMail({
        parentSessionId: ctx.parentSessionId,
        senderTeammateId: ctx.actorTeammateId,
        recipientTeammateId: recipient.id,
        kind: 'broadcast',
        content: message,
      })))
      return JSON.stringify({ delivered: saved.length, recipients: recipients.map((row) => row.name) })
    },
    {
      name: 'broadcast_teammate_mail',
      description: 'Send the same durable message to every other active teammate.',
      schema: z.object({ message: z.string().trim().min(1).max(8000) }),
    },
  )

  const wait = tool(
    async ({ timeoutMs, broadcastOnTimeout }) => {
      const recipientId = ctx.actorTeammateId
      const existing = await ctx.service.receiveMail(ctx.parentSessionId, recipientId)
      if (existing.length > 0) {
        await ctx.service.clearWait(recipientId ? (await ctx.service.get(ctx.parentSessionId, recipientId)).threadId : ctx.parentSessionId)
        if (recipientId) await ctx.service.updateStatus(ctx.parentSessionId, recipientId, 'running')
        return renderMail(existing)
      }

      const waitId = randomUUID()
      const threadId = recipientId
        ? (await ctx.service.get(ctx.parentSessionId, recipientId)).threadId
        : ctx.parentSessionId
      await ctx.service.registerWait({
        waitId,
        parentSessionId: ctx.parentSessionId,
        threadId,
        recipientTeammateId: recipientId,
      })
      const arrivedDuringRegistration = await ctx.service.receiveMail(ctx.parentSessionId, recipientId)
      if (arrivedDuringRegistration.length > 0) {
        await ctx.service.clearWait(threadId, waitId)
        if (recipientId) await ctx.service.updateStatus(ctx.parentSessionId, recipientId, 'running')
        return renderMail(arrivedDuringRegistration)
      }
      if (recipientId) await ctx.service.updateStatus(ctx.parentSessionId, recipientId, 'waiting')
      const delayMs = Math.min(timeoutMs ?? DEFAULT_MAIL_WAIT_MS, MAX_MAIL_WAIT_MS)
      try {
        await ctx.scheduleTimeout({
          waitId, recipientTeammateId: recipientId, delayMs,
          broadcastOnTimeout: broadcastOnTimeout ?? false,
        })
      } catch (error) {
        await ctx.service.clearWait(threadId, waitId)
        if (recipientId) await ctx.service.updateStatus(ctx.parentSessionId, recipientId, 'running')
        throw error
      }
      await interrupt({
        kind: 'teammate-mail-wait',
        waitId,
        parentSessionId: ctx.parentSessionId,
        recipientTeammateId: recipientId,
      })
      await ctx.service.clearWait(threadId, waitId)
      if (recipientId) await ctx.service.updateStatus(ctx.parentSessionId, recipientId, 'running')
      return renderMail(await ctx.service.receiveMail(ctx.parentSessionId, recipientId))
    },
    {
      name: 'wait_for_teammate_mail',
      description: 'Park this thread until new mailbox messages arrive or the persistent wait deadline is reached.',
      schema: z.object({
        timeoutMs: z.number().int().positive().max(MAX_MAIL_WAIT_MS).optional(),
        broadcastOnTimeout: z.boolean().optional().describe('Ask peer teammates for updates when this wait times out.'),
      }),
    },
  )

  const list = tool(
    async () => JSON.stringify((await ctx.service.list(ctx.parentSessionId)).map((row) => ({
      id: row.id,
      name: row.name,
      task: row.task,
      status: row.status,
    }))),
    {
      name: 'list_teammates',
      description: 'List the names and current states of teammates in this session.',
      schema: z.object({}),
    },
  )

  const close = tool(
    async ({ name }) => {
      if (ctx.actorTeammateId !== null) return 'Only the leader can close a teammate.'
      const teammate = await ctx.service.findByName(ctx.parentSessionId, name)
      if (!teammate) return 'No active teammate named "' + name + '".'
      await ctx.service.archive(ctx.parentSessionId, teammate.id)
      await ctx.abort(teammate)
      return JSON.stringify({ id: teammate.id, name: teammate.name, status: 'archived' })
    },
    {
      name: 'close_teammate',
      description: 'Stop a teammate and archive its thread without deleting its history.',
      schema: z.object({ name: z.string().trim().min(1) }),
    },
  )

  return [spawn, request, send, broadcast, wait, list, close]
}
