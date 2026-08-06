import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Prisma, PrismaClient, TextTraceStatus } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { config } from '../config'

export const TRACE_TEXT_MAX = 20000

export interface PendingChatSend {
  requestId: string
  sessionKey: string | null
  inputText: string
}

export interface ChatRunContext {
  sessionKey: string | null
  inputText: string
}

export interface ChatFinalOutput {
  runId: string
  sessionKey: string | null
  outputText: string
}

export interface ChatErrorOutput {
  runId: string
  sessionKey: string | null
  message: string
}

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function trimTraceText(text: string): string {
  if (text.length <= TRACE_TEXT_MAX) return text
  return text.slice(0, TRACE_TEXT_MAX)
}

export function extractMessageText(message: unknown): string {
  if (!message) return ''
  if (typeof message === 'string') return message
  const obj = asRecord(message)
  const content = obj.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (asRecord(b).type === 'text' && typeof asRecord(b).text === 'string' ? (asRecord(b).text as string) : ''))
      .join('')
  }
  return ''
}

function parseJsonFrame(data: string | Buffer): Record<string, unknown> | null {
  if (Buffer.isBuffer(data)) return null
  try {
    const parsed = JSON.parse(data) as unknown
    return asRecord(parsed)
  } catch {
    return null
  }
}

export function extractChatSend(data: string | Buffer): PendingChatSend | null {
  const frame = parseJsonFrame(data)
  if (!frame || frame.type !== 'req' || frame.method !== 'chat.send') return null
  const requestId = typeof frame.id === 'string' ? frame.id : ''
  if (!requestId) return null
  const params = asRecord(frame.params)
  const inputText = typeof params.message === 'string' ? params.message : ''
  if (!inputText) return null
  return {
    requestId,
    sessionKey: typeof params.sessionKey === 'string' ? params.sessionKey : null,
    inputText: trimTraceText(inputText),
  }
}

function extractRunId(value: unknown): string {
  const rec = asRecord(value)
  const candidates = [
    rec.runId,
    asRecord(rec.payload).runId,
    asRecord(rec.result).runId,
    asRecord(rec.data).runId,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
  }
  return ''
}

export function extractChatSendAck(data: string | Buffer): { requestId: string; runId: string } | null {
  const frame = parseJsonFrame(data)
  if (!frame || frame.type !== 'res') return null
  const requestId = typeof frame.id === 'string' ? frame.id : ''
  const runId = extractRunId(frame)
  return requestId && runId ? { requestId, runId } : null
}

export function extractChatFinal(data: string | Buffer): ChatFinalOutput | null {
  const frame = parseJsonFrame(data)
  if (!frame || frame.type !== 'event' || frame.event !== 'chat') return null
  const payload = asRecord(frame.payload)
  if (payload.state !== 'final') return null
  const runId = typeof payload.runId === 'string' ? payload.runId : ''
  if (!runId) return null
  const outputText = trimTraceText(extractMessageText(payload.message))
  if (!outputText) return null
  return {
    runId,
    sessionKey: typeof payload.sessionKey === 'string' ? payload.sessionKey : null,
    outputText,
  }
}

export function extractChatError(data: string | Buffer): ChatErrorOutput | null {
  const frame = parseJsonFrame(data)
  if (!frame || frame.type !== 'event' || frame.event !== 'chat') return null
  const payload = asRecord(frame.payload)
  if (payload.state !== 'error') return null
  const runId = typeof payload.runId === 'string' ? payload.runId : ''
  if (!runId) return null
  const message = String(payload.errorMessage ?? payload.errorKind ?? '')
  return {
    runId,
    sessionKey: typeof payload.sessionKey === 'string' ? payload.sessionKey : null,
    message: trimTraceText(message),
  }
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
