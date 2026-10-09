import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Prisma, PrismaClient, TextTraceStatus } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { config } from '../config'

export const TRACE_TEXT_MAX = 20000

export interface TextTraceInput {
  user: AuthUser
  ipAddress: string
  containerName: string | null
  sessionKey: string | null
  runId: string | null
  inputText: string
  outputText: string
  status: TextTraceStatus
}

/** 快照截断 20k（TRACE_TEXT_MAX）——单一实现，跨域消费方（sessions 双域 mapper 等）直引，
 * 禁复制（共享内核红线）。 */
export function trimTraceText(text: string): string {
  if (text.length <= TRACE_TEXT_MAX) return text
  return text.slice(0, TRACE_TEXT_MAX)
}

export function outputHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function createTraceId(input: Omit<TextTraceInput, 'status'> & { status: TextTraceStatus; outputHash: string }): string {
  const payload = JSON.stringify({
    userId: input.user.id,
    ipAddress: input.ipAddress,
    containerName: input.containerName,
    sessionKey: input.sessionKey,
    runId: input.runId,
    outputHash: input.outputHash,
    status: input.status,
    nonce: randomUUID(),
  })
  return createHmac('sha256', config.jwtSecret).update(payload).digest('hex')
}

export async function recordTextTrace(prisma: PrismaClient, input: TextTraceInput): Promise<void> {
  const hash = outputHash(input.outputText)
  const traceId = createTraceId({ ...input, outputHash: hash })
  await prisma.textTraceLog.create({
    data: {
      traceId,
      userId: input.user.id,
      username: input.user.username,
      ipAddress: input.ipAddress,
      containerName: input.containerName,
      sessionKey: input.sessionKey,
      runId: input.runId,
      inputText: trimTraceText(input.inputText),
      outputText: trimTraceText(input.outputText),
      outputHash: hash,
      status: input.status,
    },
  })
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (firstForwarded) {
    const first = firstForwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? ''
}

export interface TraceLogQuery {
  userId?: string
  ip?: string
  content?: string
  status?: TextTraceStatus
  page?: number
  pageSize?: number
}

export async function listTextTraceLogs(prisma: PrismaClient, query: TraceLogQuery) {
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 10))
  const where: Prisma.TextTraceLogWhereInput = {
    ...(query.userId ? { userId: { contains: query.userId } } : {}),
    ...(query.ip ? { ipAddress: { contains: query.ip } } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.content
      ? {
          OR: [
            { inputText: { contains: query.content } },
            { outputText: { contains: query.content } },
            { traceId: { contains: query.content } },
          ],
        }
      : {}),
  }
  const [total, rows] = await Promise.all([
    prisma.textTraceLog.count({ where }),
    prisma.textTraceLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return {
    logs: rows.map((r) => ({
      id: r.id,
      traceId: r.traceId,
      userId: r.userId,
      username: r.username,
      ipAddress: r.ipAddress,
      containerName: r.containerName,
      sessionKey: r.sessionKey,
      runId: r.runId,
      inputText: r.inputText,
      outputText: r.outputText,
      outputHash: r.outputHash,
      status: r.status,
      createdAt: r.createdAt,
    })),
    page,
    pageSize,
    total,
  }
}
