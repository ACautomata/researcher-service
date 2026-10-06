// 审批审计检索 REST（#783 · ADR 0015 / 729 §4.3）：admin 全量审计面（tool_approval_logs）。
//
// GET /api/v1/approval-logs：
//   过滤 userId / runId / layer(rule|judge|human) / decision(allow|deny) / from / to(ISO)，
//   分页 page/pageSize（pageSize ≤ 200）；createdAt 降序。
//
// GET /api/v1/file-overwrite-logs（#785 · #747 E 节锁方案「合法覆盖审计计数进审计域」）：
//   同款 admin 审计面（file_overwrite_logs）；过滤 sessionId / path / from / to + 分页；
//   行 = 一次 write-after-write 覆盖（path/覆盖者 thread/被覆盖者 thread/触发 run）。
//
// 中间件与 traceLogs 同款：requireAuth → mustChangePasswordGate → admin 门（非 admin → 10004
// ——面板级运营资源无存在性敏感面，直用角色码）。终端用户可见面（judge 理由对本人可见）
// 属会话读面（#778 投影），不在本路由。

import { Router, type Request, type Response, type NextFunction } from 'express'
import { ok, fail } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import type { Prisma, ToolApprovalDecision, ToolApprovalLayer } from '../generated/prisma/client'

export const approvalLogsRouter = Router()

approvalLogsRouter.use(requireAuth, mustChangePasswordGate)

approvalLogsRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.role !== 'admin') {
    // eslint-disable-next-line no-console
    console.warn(`[approval-logs] denied: non-admin uid=${req.user?.id} path=${req.baseUrl}${req.path}`)
    return next(fail(CODE.FORBIDDEN))
  }
  next()
})

function textParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function layerParam(value: unknown): ToolApprovalLayer | undefined {
  return value === 'rule' || value === 'judge' || value === 'human' ? value : undefined
}

function decisionParam(value: unknown): ToolApprovalDecision | undefined {
  return value === 'allow' || value === 'deny' ? value : undefined
}

function dateParam(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export interface ApprovalLogQuery {
  readonly userId?: string
  readonly runId?: string
  readonly layer?: ToolApprovalLayer
  readonly decision?: ToolApprovalDecision
  readonly from?: Date
  readonly to?: Date
  readonly page: number
  readonly pageSize: number
}

export async function listApprovalLogs(
  prisma: {
    toolApprovalLog: {
      count(args: { where: Prisma.ToolApprovalLogWhereInput }): Promise<number>
      findMany(args: {
        where: Prisma.ToolApprovalLogWhereInput
        orderBy: Prisma.ToolApprovalLogOrderByWithRelationInput[]
        take: number
        skip: number
      }): Promise<
        Array<{
          id: string
          traceId: string
          runId: string
          userId: string
          layer: string
          decision: string
          toolName: string
          toolCall: string
          policyClass: string | null
          reason: string | null
          judgeInputHash: string | null
          latencyMs: number | null
          judgeTokens: number | null
          createdAt: Date
        }>
      >
    }
  },
  query: ApprovalLogQuery,
): Promise<{ total: number; page: number; pageSize: number; items: unknown[] }> {
  const where: Prisma.ToolApprovalLogWhereInput = {
    ...(query.userId !== undefined ? { userId: query.userId } : {}),
    ...(query.runId !== undefined ? { runId: query.runId } : {}),
    ...(query.layer !== undefined ? { layer: query.layer } : {}),
    ...(query.decision !== undefined ? { decision: query.decision } : {}),
    ...(query.from !== undefined || query.to !== undefined
      ? {
          createdAt: {
            ...(query.from !== undefined ? { gte: query.from } : {}),
            ...(query.to !== undefined ? { lt: query.to } : {}),
          },
        }
      : {}),
  }
  const [total, rows] = await Promise.all([
    prisma.toolApprovalLog.count({ where }),
    prisma.toolApprovalLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.pageSize,
      skip: (query.page - 1) * query.pageSize,
    }),
  ])
  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    items: rows.map((r) => ({
      id: r.id,
      trace_id: r.traceId,
      run_id: r.runId,
      user_id: r.userId,
      layer: r.layer,
      decision: r.decision,
      tool_name: r.toolName,
      tool_call: r.toolCall,
      policy_class: r.policyClass,
      reason: r.reason,
      judge_input_hash: r.judgeInputHash,
      latency_ms: r.latencyMs,
      judge_tokens: r.judgeTokens,
      created_at: r.createdAt,
    })),
  }
}

const PAGE_DEFAULT = 1
const PAGE_SIZE_DEFAULT = 50
const PAGE_SIZE_MAX = 200

function pagingParams(req: Request): { page: number; pageSize: number } {
  const pageRaw = Number(req.query.page)
  const sizeRaw = Number(req.query.pageSize)
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : PAGE_DEFAULT
  const pageSize =
    Number.isInteger(sizeRaw) && sizeRaw >= 1 ? Math.min(sizeRaw, PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT
  return { page, pageSize }
}

approvalLogsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listApprovalLogs(req.prisma, {
      userId: textParam(req.query.userId),
      runId: textParam(req.query.runId),
      layer: layerParam(req.query.layer),
      decision: decisionParam(req.query.decision),
      from: dateParam(req.query.from),
      to: dateParam(req.query.to),
      ...pagingParams(req),
    })
    ok(res, data)
  } catch (e) {
    next(e)
  }
})

// ---------------------------------------------------------------------------
// #785 覆盖审计检索（file_overwrite_logs）：admin 全量审计面，同款 admin 门 + 分页。
// ---------------------------------------------------------------------------

export const fileOverwriteLogsRouter = Router()

fileOverwriteLogsRouter.use(requireAuth, mustChangePasswordGate)

fileOverwriteLogsRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.role !== 'admin') {
    // eslint-disable-next-line no-console
    console.warn(`[file-overwrite-logs] denied: non-admin uid=${req.user?.id} path=${req.baseUrl}${req.path}`)
    return next(fail(CODE.FORBIDDEN))
  }
  next()
})

export interface FileOverwriteLogQuery {
  readonly sessionId?: string
  readonly path?: string
  readonly from?: Date
  readonly to?: Date
  readonly page: number
  readonly pageSize: number
}

export async function listFileOverwriteLogs(
  prisma: {
    fileOverwriteLog: {
      count(args: { where: Prisma.FileOverwriteLogWhereInput }): Promise<number>
      findMany(args: {
        where: Prisma.FileOverwriteLogWhereInput
        orderBy: Prisma.FileOverwriteLogOrderByWithRelationInput[]
        take: number
        skip: number
      }): Promise<
        Array<{
          id: string
          sessionId: string
          path: string
          overwriterThreadId: string
          overwrittenThreadId: string
          runId: string
          createdAt: Date
        }>
      >
    }
  },
  query: FileOverwriteLogQuery,
): Promise<{ total: number; page: number; pageSize: number; items: unknown[] }> {
  const where: Prisma.FileOverwriteLogWhereInput = {
    ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
    ...(query.path !== undefined ? { path: query.path } : {}),
    ...(query.from !== undefined || query.to !== undefined
      ? {
          createdAt: {
            ...(query.from !== undefined ? { gte: query.from } : {}),
            ...(query.to !== undefined ? { lt: query.to } : {}),
          },
        }
      : {}),
  }
  const [total, rows] = await Promise.all([
    prisma.fileOverwriteLog.count({ where }),
    prisma.fileOverwriteLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.pageSize,
      skip: (query.page - 1) * query.pageSize,
    }),
  ])
  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    items: rows.map((r) => ({
      id: r.id,
      session_id: r.sessionId,
      path: r.path,
      overwriter_thread_id: r.overwriterThreadId,
      overwritten_thread_id: r.overwrittenThreadId,
      run_id: r.runId,
      created_at: r.createdAt,
    })),
  }
}

fileOverwriteLogsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listFileOverwriteLogs(req.prisma, {
      sessionId: textParam(req.query.sessionId),
      path: textParam(req.query.path),
      from: dateParam(req.query.from),
      to: dateParam(req.query.to),
      ...pagingParams(req),
    })
    ok(res, data)
  } catch (e) {
    next(e)
  }
})
