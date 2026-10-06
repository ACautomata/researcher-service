// AutoFigure 域服务（#791 · #744 v2 §5 换轨后形状）。
//
// GenerationJob 退役（#744 §5.2）：执行状态机/超时/reconcile 归会话 run 域统一机制，figures 域
// 不自建第二套。Figure 行 = 产物聚合（pipeline graph 成功终态一次性 create，无状态列）；
// REST 创建端点与 Idempotency-Key 幂等随之退役（工具侧去重身份活在 run 机制数据里，#744 §5.3）。
//
// 本文件职责：
//   - 读面：list / detail / PNG / SVG 下载（共享单点归属门，70040 同码防探测，admin 跨用户可见）
//   - 写面：createFigure 终态一次性 create（#744 §11.1 ctx.figures 单写方法的核心实现；
//     插件 execute 包装的接线归 #744 §10 票 4）

import { CODE } from '../codes'
import { fail } from '../envelope'
import type { PrismaClient } from '../generated/prisma/client'
import type { AuthUser } from '../types'

// ---------------------------------------------------------------------------
// 写面：终态一次性 create（#744 §5.1/§11.1）
// ---------------------------------------------------------------------------

// Figure 行写契约：create 必带 final SVG（png 可缺省——渲染失败不致命，meta.previewReady=false
// 标记，#744 §3.1）；meta = EvaluationMeta pipeline 元数据（#744 §5.1，JSON 序列化落 evaluation 列，
// 绝不落 raw provider 响应/栈/凭证）。input.meta 的结构校验归插件侧 EvaluationMeta 构造，
// 本层只保证「可 JSON 序列化」——序列化失败原样上抛（无静默吞错）。
export interface CreateFigureInput {
  ownerId: string // 只由认证的 researcher-service 身份派生（run 装配注入，#744 §11.1 run.ownerId）
  prompt: string // method_text
  svg: string // final SVG 文本
  pngBytes?: Uint8Array // 预览 PNG（缺省 = 渲染失败缺省语义）
  meta: unknown // EvaluationMeta（pipeline 元数据对象）
  sessionId?: string | null // 溯源列（#744 §5.1；null = 机器面/未来其他入口）
}

export async function createFigure(
  prisma: PrismaClient,
  input: CreateFigureInput,
): Promise<{ figureId: string }> {
  const row = await prisma.figure.create({
    data: {
      ownerId: input.ownerId,
      prompt: input.prompt,
      svg: input.svg,
      ...(input.pngBytes !== undefined ? { png: Buffer.from(input.pngBytes) } : {}),
      evaluation: JSON.stringify(input.meta),
      sessionId: input.sessionId ?? null,
    },
    select: { id: true },
  })
  return { figureId: row.id }
}

// ---------------------------------------------------------------------------
// 读面（list / detail / PNG / SVG 共享单点归属门）
// ---------------------------------------------------------------------------

// 列表项：Figure 行恒为成功产物（无执行状态），公开投影只含资产元数据。
export interface FigureSummary {
  figureId: string
  prompt: string
  sessionId: string | null
  createdAt: string
}

// 详情：在列表项之上追加预览可用性与更新时间。previewReady = png 非空（渲染失败的产物行
// png 缺省，#744 §3.1「预览缺失标记进元数据」）。
export interface FigureDetail extends FigureSummary {
  previewReady: boolean
  updatedAt: string
}

// 历史列表（排序规则沿用已验证资产）：当前认证用户自己的 Figure（admin = 所有用户）；
// createdAt DESC + id DESC 稳定 tiebreaker（确定性；无分页/过滤/搜索/用户排序）。
// select 只取列表投影所需标量列，排除 svg/png/evaluation 产物列（列表 N 行时不拉大文本/BLOB）。
export async function listFigures(prisma: PrismaClient, user: AuthUser): Promise<FigureSummary[]> {
  const where = user.role === 'admin' ? {} : { ownerId: user.id }
  const rows = await prisma.figure.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, prompt: true, sessionId: true, createdAt: true },
  })
  return rows.map((r) => ({
    figureId: r.id,
    prompt: r.prompt,
    sessionId: r.sessionId,
    createdAt: r.createdAt.toISOString(),
  }))
}

// 共享归属门（单点）：figure 域单点归属前置，镜像 getInstanceForUser（containers/orchestrator.ts）
// ——admin 全放行 / user 仅本人；「不存在 vs 越权」同码 70040，对外逐字节一致，区分仅进服务端
// 日志（not_found vs owner_mismatch）。detail / png / svg 三读路径共用同一实现——不建第二套归属
// 逻辑（已验证资产原样保留，#744 §5.1）。ownerId 只由认证身份派生：本函数只按 id 查行，不接收
// 任何客户端 userId 作为授权覆写。
// select 含 svg/png 产物列（下载路径本就需回读产物；detail 投影不用但同一查询——列只在内部
// 消费，公开投影不含产物本体）。
interface FigureOwnedRow {
  id: string
  ownerId: string
  prompt: string
  sessionId: string | null
  createdAt: Date
  updatedAt: Date
  svg: string | null
  png: Uint8Array<ArrayBuffer> | null
}

async function findFigureForUser(
  prisma: PrismaClient,
  user: AuthUser,
  id: string,
): Promise<FigureOwnedRow> {
  const figure = await prisma.figure.findUnique({
    where: { id },
    select: {
      id: true,
      ownerId: true,
      prompt: true,
      sessionId: true,
      createdAt: true,
      updatedAt: true,
      svg: true,
      png: true,
    },
  })
  if (!figure) {
    // eslint-disable-next-line no-console
    console.warn(`[figures] not_found: id=${id} uid=${user.id}`)
    throw fail(CODE.FIGURE_NOT_FOUND)
  }
  if (user.role !== 'admin' && figure.ownerId !== user.id) {
    // eslint-disable-next-line no-console
    console.warn(`[figures] owner_mismatch: id=${id} uid=${user.id} owner=${figure.ownerId}`)
    throw fail(CODE.FIGURE_NOT_FOUND)
  }
  return figure
}

export async function getFigureForUser(
  prisma: PrismaClient,
  user: AuthUser,
  id: string,
): Promise<FigureDetail> {
  const figure = await findFigureForUser(prisma, user, id)
  return {
    figureId: figure.id,
    prompt: figure.prompt,
    sessionId: figure.sessionId,
    createdAt: figure.createdAt.toISOString(),
    previewReady: figure.png !== null,
    updatedAt: figure.updatedAt.toISOString(),
  }
}

// PNG 下载（资产读面）：复用共享归属门（70040 同码防探测）。行恒为成功产物；png 为 null
//（渲染失败缺省产物 / 数据完整性防御）→ 70043 确定性「不可用」，不模糊 500。
// 返回 PNG 字节（Uint8Array 对齐 Prisma Bytes；路由层 Buffer.from 后按既有下载契约直发字节）。
export async function getFigurePngForUser(
  prisma: PrismaClient,
  user: AuthUser,
  id: string,
): Promise<Uint8Array> {
  const figure = await findFigureForUser(prisma, user, id)
  if (!figure.png) throw fail(CODE.FIGURE_ARTIFACT_NOT_AVAILABLE)
  return figure.png
}

// SVG 读/下载（#744 §4.2/§7）：前端经 <img> blob URL 渲染（脚本不执行）；同端点下载参数由
// 路由层映射 Content-Disposition。svg 为 null（数据完整性防御——create 契约必带 final SVG）
// → 70043 确定性「不可用」。
export async function getFigureSvgForUser(
  prisma: PrismaClient,
  user: AuthUser,
  id: string,
): Promise<string> {
  const figure = await findFigureForUser(prisma, user, id)
  if (figure.svg === null) throw fail(CODE.FIGURE_ARTIFACT_NOT_AVAILABLE)
  return figure.svg
}
